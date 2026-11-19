//! Скачивание трека.
//!
//! Отдельный путь от sc-fetch: тот читает тело целиком и для бинарника в
//! 10МБ это съело бы память и испортило файл. Здесь поток пишется на диск
//! по кускам, с прогрессом в рендерер.
//!
//! Два пути. Если soundcloud отдал progressive-transcoding — это обычный mp3,
//! его и качаем. Если только hls (так сейчас у большинства треков), собираем
//! файл из сегментов плейлиста: init.mp4 + dataNNN.m4s подряд дают валидный
//! fragmented mp4. Это AAC, а не mp3, поэтому дальше он перекодируется
//! ffmpeg'ом (если он найден); без ffmpeg остаётся `.m4a` с mp4-атомами
//! вместо id3 — и пользователь узнаёт об этом из тоста, а не по расширению.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use futures_util::StreamExt;
use lofty::config::WriteOptions;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::tag::{Tag, TagType};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

const DL_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
/// Провайдер рвёт соединение после ~16 КБ: в одном соединении успевает пройти
/// примерно столько, дальше висит до таймаута — снаружи это «загрузка на 0%».
/// Поэтому качаем кусками по 16 КБ, каждый в новом соединении (см. dl_http):
/// такой кусок приходит за ~0.12 с, и ответ закрывается сам.
const DL_CHUNK: u64 = 16 * 1024;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DownloadReq {
    pub id: Option<Value>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub comment: Option<String>,
    pub track_no: Option<Value>,
    pub cover_url: Option<String>,
    pub stream_url: Option<String>,
    /* true — stream_url это m3u8-плейлист, а не готовый mp3. Ставит рендерер:
       он один знает, что у трека не было progressive и он резолвил hls. */
    pub hls: Option<bool>,
    pub dir: Option<String>,
    pub token: Option<String>,
    pub base_name: Option<String>,
}

fn emit(app: &AppHandle, payload: Value) {
    let _ = app.emit("download-progress", payload);
}

/// Диагностика в общий sewer.log: у загрузки нет своего окна, а «не удалось
/// скачать» без причины бесполезно и пользователю, и мне.
fn dlog(msg: impl std::fmt::Display) {
    crate::settings::log(&format!("[dl] {msg}"));
}

/// Windows не любит эти символы и зарезервированные имена
fn is_illegal(c: char) -> bool {
    matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 0x20
}

fn is_reserved(name: &str) -> bool {
    const RESERVED: [&str; 22] = [
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7",
        "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    let lower = name.to_ascii_lowercase();
    RESERVED.iter().any(|r| {
        lower == *r
            || (lower.len() > r.len() && lower.starts_with(r) && lower.as_bytes()[r.len()] == b'.')
    })
}

fn sanitize_file_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if is_illegal(c) { '_' } else { c })
        .collect();
    let mut s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    s = s.trim_end_matches(['.', ' ']).trim().to_string();
    if s.is_empty() {
        s = "track".to_string();
    }
    if is_reserved(&s) {
        s.insert(0, '_');
    }
    if s.chars().count() > 140 {
        s = s.chars().take(140).collect::<String>();
        s = s.trim_end_matches(['.', ' ']).to_string();
    }
    s
}

/// не перезаписываем: `Artist - Song.mp3` → `Artist - Song (2).mp3`
fn unique_path(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let mut p = dir.join(format!("{base}{ext}"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{base} ({n}){ext}"));
        n += 1;
        if n > 999 {
            break;
        }
    }
    p
}

/// ГЛАВНОЕ, что здесь есть: проверка, что пришло АУДИО, а не мусор.
/// mp3 начинается либо с 'ID3' (id3v2-заголовок), либо с кадра MPEG —
/// байт 0xFF и следующий с 0xE0-битным вторым битом (0xE0 маска: 111xxxxx).
/// Всё остальное — не mp3: '{' — json-манифест (streamUrl отдаёт json, а не
/// звук, и он раньше молча писался как .mp3 на 1кб), '#' — m3u8-манифест.
/// Ловим это ДО того, как файл дописан до конца.
fn looks_like_audio(head: &[u8]) -> bool {
    if head.len() < 2 {
        return false;
    }
    if head.len() >= 3 && head[0] == 0x49 && head[1] == 0x44 && head[2] == 0x33 {
        return true; /* ID3 */
    }
    head[0] == 0xff && (head[1] & 0xe0) == 0xe0 /* MPEG sync */
}

fn bad_payload(head: &[u8]) -> &'static str {
    match head.first() {
        Some(0x7b) | Some(0x5b) => "not_audio_json", /* { или [ */
        Some(0x23) => "not_audio_m3u8",             /* # */
        Some(0x3c) => "not_audio_html",             /* < */
        _ => "not_audio",
    }
}

fn drop_file(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// Клиент для самой загрузки. Отличается от общего двумя вещами:
///   * только http/1.1: по h2 всё едет в одном соединении, а провайдер режет
///     соединение после ~16 КБ — второй кусок уходит в мёртвый сокет;
///   * пул выключен: каждая порция должна ехать в новом соединении, потому что
///     старое после ответа уже мертво. Проверено на живом CDN: 13 кусков по
///     16 КБ проходят за ~1.5 с, а через пул падает второй же.
fn dl_http() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .http1_only()
                .pool_max_idle_per_host(0)
                .connect_timeout(std::time::Duration::from_secs(20))
                .read_timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("dl client")
        })
        .clone()
}

/// Прогресс загрузки. Отдельной структурой, потому что куски шлют его из
/// середины цикла, а `base` (сколько уже легло на диск до текущего url) нужен,
/// чтобы полоса не прыгала назад на каждом новом сегменте.
struct Progress<'a> {
    app: &'a AppHandle,
    id: &'a Value,
    base: u64,
    /// суммарный размер, если известен заранее (у hls считаем по сегментам)
    hint: u64,
    last: u64,
}

impl<'a> Progress<'a> {
    fn new(app: &'a AppHandle, id: &'a Value, base: u64, hint: u64) -> Self {
        Self { app, id, base, hint, last: base }
    }

    fn report(&mut self, own_got: u64, total: u64) {
        let got = self.base + own_got;
        let total = if self.hint > 0 { self.hint } else { total };
        /* emit на каждый 16-килобайтный кусок — ipc-спам: 250 сообщений на
           трек ради полосы, на которой разницу не видно */
        if got.saturating_sub(self.last) < 128 * 1024 && (total == 0 || got < total) {
            return;
        }
        self.last = got;
        emit(self.app, json!({ "id": self.id, "got": got, "total": total }));
    }
}

/// Прогрессивная загрузка: один url, но всё равно кусками (см. append_url).
async fn download_to_file(
    url: &str,
    dest: &Path,
    token: Option<&str>,
    app: &AppHandle,
    id: &Value,
) -> Result<u64, String> {
    use tokio::io::AsyncWriteExt;

    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| e.to_string())?;
    let mut prog = Progress::new(app, id, 0, 0);
    let (got, total) = append_url(&dl_http(), url, token, &mut file, &mut prog).await?;
    file.flush().await.map_err(|e| e.to_string())?;

    if got == 0 {
        drop_file(dest);
        return Err("empty".into());
    }
    /* проверяем голову уже на диске: первые 3 байта отсекают json манифеста
       и html страницы провайдера от настоящего звука */
    let head = read_head(dest, 3);
    if head.len() < 3 {
        drop_file(dest);
        return Err("too_small".into());
    }
    if !looks_like_audio(&head) {
        drop_file(dest);
        return Err(bad_payload(&head).to_string());
    }
    emit(
        app,
        json!({ "id": id, "got": got, "total": total.unwrap_or(got) }),
    );
    Ok(got)
}

/* ── HLS ─────────────────────────────────────────────────────────────────── */

/// m3u8 как текст. Плейлисты small, поэтому целиком в память — не тот случай,
/// ради которого нужен поток.
async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let res = client
        .get(url)
        .header("User-Agent", DL_UA)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    if status != 200 {
        dlog(format!("плейлист: HTTP {status} {url}"));
        return Err(format!("HTTP {status}"));
    }
    res.text().await.map_err(|e| e.to_string())
}

/// Значение `URI="…"` из строки атрибутов. Режем по кавычкам, а не по запятой:
/// подписанный CDN-url несёт base64 в Policy, и любое деление по разделителю
/// рано или поздно отрежет хвост.
fn attr_uri(line: &str) -> Option<String> {
    let start = line.find("URI=\"")? + 5;
    let rest = &line[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

#[derive(Default)]
struct HlsPlaylist {
    init: Option<String>,
    segments: Vec<String>,
    /// следующий плейлист, если это master (`#EXT-X-STREAM-INF`)
    variant: Option<String>,
}

/// Разбор m3u8. Поддерживаем ровно то, что отдаёт soundcloud: media-плейлист
/// с `#EXT-X-MAP` (fmp4) либо master со списком вариантов. Шифрования у них
/// нет; если появится `#EXT-X-KEY`, сегменты скачаются, но не расшифруются —
/// это честно провалится на проверке mp4, а не запишется мусором.
fn parse_playlist(text: &str, base: &Url) -> HlsPlaylist {
    let mut out = HlsPlaylist::default();
    let mut best_bw: f64 = -1.0;
    let mut pending_bw: Option<f64> = None;

    let abs = |u: &str| base.join(u).map(|x| x.to_string()).unwrap_or_else(|_| u.to_string());

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            let bw = rest
                .split(',')
                .find_map(|p| p.trim().strip_prefix("BANDWIDTH="))
                .and_then(|v| v.trim().parse::<f64>().ok())
                .unwrap_or(0.0);
            pending_bw = Some(bw);
            continue;
        }
        if line.starts_with("#EXT-X-MAP:") {
            if let Some(uri) = attr_uri(line) {
                out.init = Some(abs(&uri));
            }
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        /* не-комментарий: либо вариант master-плейлиста, либо сегмент */
        if let Some(bw) = pending_bw.take() {
            if bw >= best_bw {
                best_bw = bw;
                out.variant = Some(abs(line));
            }
        } else {
            out.segments.push(abs(line));
        }
    }
    out
}

/// fmp4 начинается с box-заголовка: 4 байта размера, затем `ftyp`. Это же
/// отсекает html-страницу провайдера и json с ошибкой.
fn looks_like_mp4(head: &[u8]) -> bool {
    head.len() >= 8 && &head[4..8] == b"ftyp"
}

fn read_head(path: &Path, n: usize) -> Vec<u8> {
    use std::io::Read;
    let mut buf = vec![0u8; n];
    let Ok(mut f) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let mut got = 0usize;
    while got < n {
        match f.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(k) => got += k,
            Err(_) => break,
        }
    }
    buf.truncate(got);
    buf
}

/// Полный размер файла из `Content-Range: bytes 0-0/202053`.
fn content_range_total(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let v = headers.get(reqwest::header::CONTENT_RANGE)?.to_str().ok()?;
    v.rsplit('/').next()?.trim().parse::<u64>().ok()
}

/// Скачать один url и дописать в файл. Возвращает число байт и полный размер,
/// если сервер его сообщил.
///
/// Почему кусками: см. DL_CHUNK и dl_http. Обычный поток на этой сети встаёт
/// на 15 КБ и висит до read-timeout'а, а через пул падает уже второй кусок.
/// Range-запросы по 16 КБ в новом соединении идут по 0.12 с каждый.
///
/// Повторы обязательны: кусков на трек сотни, и один капризный ответ CDN не
/// должен убивать всю загрузку.
async fn append_url(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
    file: &mut tokio::fs::File,
    prog: &mut Progress<'_>,
) -> Result<(u64, Option<u64>), String> {
    use tokio::io::AsyncWriteExt;

    const TRIES: u32 = 4;
    const CHUNK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

    let mut got = 0u64;
    let mut total: Option<u64> = None;
    let mut tries = 0u32;

    while total.map_or(true, |t| got < t) {
        let range = format!("bytes={got}-{}", got + DL_CHUNK - 1);
        let mut req = client
            .get(url)
            .header("User-Agent", DL_UA)
            .header("Accept", "audio/*,*/*;q=0.8")
            .header(reqwest::header::RANGE, &range);
        if let Some(t) = token {
            req = req.header("Authorization", format!("OAuth {t}"));
        }
        let res = req.send().await;

        let res = match res {
            Ok(r) => r,
            Err(e) => {
                tries += 1;
                dlog(format!("{range}: {e} (попытка {tries})"));
                if tries >= TRIES {
                    return Err(e.to_string());
                }
                tokio::time::sleep(std::time::Duration::from_millis(300 * tries as u64)).await;
                continue;
            }
        };
        let status = res.status().as_u16();

        /* сервер не понял Range и отдал файл целиком — забираем как раньше */
        if status == 200 && got == 0 {
            let len = res.content_length().unwrap_or(0);
            let mut stream = res.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| e.to_string())?;
                file.write_all(&chunk).await.map_err(|e| e.to_string())?;
                got += chunk.len() as u64;
                prog.report(got, len);
            }
            return Ok((got, None));
        }
        /* 416 — запросили за концом: значит уже всё скачано */
        if status == 416 {
            break;
        }
        if status != 206 {
            tries += 1;
            dlog(format!("{range}: HTTP {status} (попытка {tries})"));
            if tries >= TRIES {
                return Err(format!("HTTP {status}"));
            }
            tokio::time::sleep(std::time::Duration::from_millis(400 * tries as u64)).await;
            continue;
        }

        if total.is_none() {
            total = content_range_total(res.headers());
        }
        let chunk = match tokio::time::timeout(CHUNK_TIMEOUT, res.bytes()).await {
            Ok(Ok(b)) => b,
            Ok(Err(e)) => {
                tries += 1;
                dlog(format!("{range}: тело: {e} (попытка {tries})"));
                if tries >= TRIES {
                    return Err(e.to_string());
                }
                continue;
            }
            Err(_) => {
                tries += 1;
                dlog(format!("{range}: тело не пришло (попытка {tries})"));
                if tries >= TRIES {
                    return Err("chunk timeout".into());
                }
                continue;
            }
        };
        if chunk.is_empty() {
            break;
        }
        tries = 0;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        prog.report(got, total.unwrap_or(0));
        if total.is_none() && (chunk.len() as u64) < DL_CHUNK {
            break;
        }
    }
    Ok((got, total))
}

/// Размер одного сегмента без скачивания: `Range: bytes=0-0` отдаёт
/// `Content-Range` с полным размером. url берём владеемый: заимствованный
/// ломает buffer_unordered (футура должна быть 'static), а строк тут десятки.
async fn probe_size(client: reqwest::Client, url: String) -> Option<u64> {
    let res = client
        .get(&url)
        .header("User-Agent", DL_UA)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .send()
        .await
        .ok()?;
    if res.status().as_u16() != 206 {
        return None;
    }
    content_range_total(res.headers())
}

/// Суммарный размер всех частей: прогноз, а не чтение. Параллельно, иначе на
/// длинном треке это десятки последовательных round-trip'ов ради одной полосы.
/// Любой сбой = `None`: тогда прогресс честно идёт в мегабайтах без процентов.
async fn segment_sizes(
    client: &reqwest::Client,
    init: Option<&String>,
    segs: &[String],
) -> Option<u64> {
    let mut all: Vec<String> = Vec::with_capacity(segs.len() + 1);
    if let Some(i) = init {
        all.push(i.clone());
    }
    all.extend(segs.iter().cloned());

    let futs = all.into_iter().map(|u| probe_size(client.clone(), u));
    let sizes = futures_util::stream::iter(futs)
        .buffer_unordered(8)
        .collect::<Vec<Option<u64>>>()
        .await;

    sizes
        .into_iter()
        .collect::<Option<Vec<u64>>>()
        .map(|v| v.iter().sum())
}

/// HLS → один файл. init-сегмент идёт первым: без него у fmp4 нет `moov`, и
/// получился бы набор несвязанных фрагментов. Прогресс шлём по сегментам:
/// размеры узнаём заранее (segment_sizes), а если не вышло — показываем честные
/// мегабайты без процентов, врать долями хуже.
async fn download_hls(
    url: &str,
    dest: &Path,
    app: &AppHandle,
    id: &Value,
) -> Result<u64, String> {
    use tokio::io::AsyncWriteExt;

    let dl = dl_http();
    let base = Url::parse(url).map_err(|e| e.to_string())?;
    let text = fetch_text(&dl, url).await?;
    let mut pl = parse_playlist(&text, &base);
    if let Some(variant) = pl.variant.take() {
        let vbase = Url::parse(&variant).map_err(|e| e.to_string())?;
        let vtext = fetch_text(&dl, &variant).await?;
        pl = parse_playlist(&vtext, &vbase);
    }
    if pl.segments.is_empty() {
        dlog("hls: в плейлисте нет сегментов");
        return Err("hls_empty".into());
    }

    /* прогноз размера — необязательное украшение: если сеть отвечает вяло,
       не держим из-за него начало загрузки */
    let total = tokio::time::timeout(
        std::time::Duration::from_secs(6),
        segment_sizes(&dl, pl.init.as_ref(), &pl.segments),
    )
    .await
    .ok()
    .flatten()
    .unwrap_or(0);
    dlog(format!(
        "hls: сегментов {}, init={}, прогноз {total} байт",
        pl.segments.len(),
        pl.init.is_some()
    ));

    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| e.to_string())?;
    let mut got = 0u64;

    if let Some(init) = pl.init.as_deref() {
        let mut prog = Progress::new(app, id, got, total);
        got += append_url(&dl, init, None, &mut file, &mut prog).await?.0;
    }
    for seg in &pl.segments {
        let mut prog = Progress::new(app, id, got, total);
        got += match append_url(&dl, seg, None, &mut file, &mut prog).await {
            Ok(v) => v.0,
            Err(e) => {
                dlog(format!(
                    "hls: сегмент {} ({got} байт уже на диске): {e}",
                    seg.rsplit('/').next().unwrap_or(seg)
                ));
                return Err(e);
            }
        };
        emit(app, json!({ "id": id, "got": got, "total": total }));
    }
    file.flush().await.map_err(|e| e.to_string())?;

    if got == 0 {
        drop_file(dest);
        return Err("empty".into());
    }
    Ok(got)
}

/// обложка целиком в память. Кусками и в новых соединениях по той же причине,
/// что и звук (см. dl_http): обычным потоком картинка приходит наполовину и
/// тег остаётся без обложки. Молча переживаем ошибку — теги важнее картинки.
async fn fetch_cover_buffer(url: Option<&str>) -> Option<Vec<u8>> {
    let url = url?.to_string();
    let client = dl_http();
    let mut out: Vec<u8> = Vec::new();
    let mut got = 0u64;

    loop {
        let range = format!("bytes={got}-{}", got + DL_CHUNK - 1);
        let res = client
            .get(&url)
            .header("User-Agent", DL_UA)
            .header(reqwest::header::RANGE, &range)
            .send()
            .await
            .ok()?;
        let status = res.status().as_u16();

        /* Range не поддержан: пробуем забрать целиком, вдруг сервер не режет */
        if status == 200 && got == 0 {
            let bytes = res.bytes().await.ok()?;
            return if bytes.is_empty() { None } else { Some(bytes.to_vec()) };
        }
        if status != 206 {
            return None;
        }

        let total = content_range_total(res.headers());
        let chunk = res.bytes().await.ok()?;
        if chunk.is_empty() {
            break;
        }
        out.extend_from_slice(&chunk);
        got += chunk.len() as u64;
        if total.map_or((chunk.len() as u64) < DL_CHUNK, |t| got >= t) {
            break;
        }
    }

    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Обложка, уже лежащая в кэше приложения (`sc_covers/{id}.jpg`). Это тот же
/// файл, который рисуется в списках: он скачан с soundcloud и проверен на
/// непустоту. Нужен как запасной путь — sndcdn то и дело отвечает ошибкой
/// сети, и скачанный трек иначе остался бы без картинки, хотя она под рукой.
fn cached_cover(id: &Value) -> Option<Vec<u8>> {
    let name = match id {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    let path = crate::settings::data_dir()
        .join("sc_covers")
        .join(format!("{name}.jpg"));
    let data = std::fs::read(path).ok()?;
    if data.is_empty() {
        None
    } else {
        Some(data)
    }
}

fn write_tags(
    path: &Path,
    req: &DownloadReq,
    cover: Option<(MimeType, Vec<u8>)>,
    mp4: bool,
) -> Result<(), String> {
    /* у m4a теги — это атомы ilst, а не id3: lofty выбирает формат по
       расширению, но тип тега задаём явно, иначе id3 в mp4 не запишется */
    let mut tag = Tag::new(if mp4 { TagType::Mp4Ilst } else { TagType::Id3v2 });
    if let Some(v) = req.title.as_deref().filter(|s| !s.is_empty()) {
        tag.set_title(v.to_string());
    }
    if let Some(v) = req.artist.as_deref().filter(|s| !s.is_empty()) {
        tag.set_artist(v.to_string());
    }
    if let Some(v) = req.album.as_deref().filter(|s| !s.is_empty()) {
        tag.set_album(v.to_string());
    }
    if let Some(v) = req.comment.as_deref().filter(|s| !s.is_empty()) {
        tag.set_comment(v.to_string());
    }
    if let Some(n) = req.track_no.as_ref().and_then(Value::as_u64) {
        tag.set_track(n as u32);
    }
    if let Some((mime, data)) = cover {
        /* поля Picture приватные — только через конструктор. new_unchecked
           не проверяет, что данные действительно картинка: мы их только что
           скачали с soundcloud, и electron тоже не проверял. */
        tag.push_picture(Picture::new_unchecked(
            PictureType::CoverFront,
            Some(mime),
            None,
            data,
        ));
    }
    tag.save_to_path(path, WriteOptions::default())
        .map_err(|e| e.to_string())
}

/// ffmpeg ищем рядом с приложением (его можно положить в ресурсы), в PATH и в
/// типовых местах установки. Внешний энкодер — единственный способ отдать mp3:
/// hls у soundcloud это AAC, а AAC в mp3 не переименовывается.
pub fn find_ffmpeg(app: &AppHandle) -> Option<PathBuf> {
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join(name));
        candidates.push(dir.join("bin").join(name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(name));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join(name));
        }
    }
    if cfg!(windows) {
        candidates.push(PathBuf::from(r"C:\ffmpeg\bin\ffmpeg.exe"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

pub fn has_ffmpeg(app: &AppHandle) -> bool {
    find_ffmpeg(app).is_some()
}

/// fmp4/aac → mp3. 256k: источник у soundcloud — 160k aac, выше смысла нет.
async fn transcode_mp3(ffmpeg: &Path, src: &Path, dest: &Path) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(src)
        .arg("-vn")
        .arg("-map")
        .arg("0:a:0")
        .arg("-c:a")
        .arg("libmp3lame")
        .arg("-b:a")
        .arg("256k")
        .arg("-id3v2_version")
        .arg("3")
        .arg(dest);
    /* консоль ffmpeg не должна мигать поверх плеера */
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); /* CREATE_NO_WINDOW */
    }
    let out = cmd.output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.lines().last().unwrap_or("ffmpeg failed").to_string());
    }
    Ok(())
}

/// streamUrl СЮДА ПРИХОДИТ УЖЕ РЕЗОЛВНУТЫМ (renderer вызывает sc-fetch и берёт
/// .data.url). Сам api-v2 /media/.../stream/progressive отдаёт JSON-манифест,
/// а не звук. client_id тоже НЕ дописывается: у CDN-ссылки он уже сидит в
/// policy-параметрах, и хвост после подписи ломает валидацию.
pub async fn sc_download_track(app: &AppHandle, req: DownloadReq) -> Value {
    let Some(dir) = req.dir.clone().filter(|d| !d.is_empty()) else {
        return json!({ "error": "no_dir" });
    };
    let Some(stream_url) = req.stream_url.clone().filter(|u| !u.is_empty()) else {
        return json!({ "error": "no_progressive" }); /* нет ни mp3, ни hls */
    };
    let hls = req.hls.unwrap_or(false);
    dlog(format!("старт: hls={hls} url={stream_url}"));

    if let Err(e) = std::fs::create_dir_all(&dir) {
        if e.kind() != ErrorKind::AlreadyExists {
            return json!({ "error": e.to_string() });
        }
    }

    let artist = req.artist.as_deref().unwrap_or("").trim();
    let title = req.title.as_deref().unwrap_or("").trim();
    let fallback = if artist.is_empty() {
        title.to_string()
    } else {
        format!("{artist} - {title}")
    };
    let base = sanitize_file_name(req.base_name.as_deref().unwrap_or(&fallback));
    let id = req.id.clone().unwrap_or(Value::Null);

    /* hls — это aac в fmp4: mp3 из него получается только перекодированием.
       без ffmpeg честно остаёмся в m4a, а не называем aac файлом .mp3 */
    let ffmpeg = if hls { find_ffmpeg(app) } else { None };
    if hls {
        dlog(format!(
            "ffmpeg: {}",
            ffmpeg
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "не найден".into())
        ));
    }
    let mut mp3 = !hls || ffmpeg.is_some();
    let mut final_path = unique_path(
        Path::new(&dir),
        &base,
        if mp3 { ".mp3" } else { ".m4a" },
    );
    /* качаем в `.part`: расширение финального файла может поменяться, если
       конвертация сорвётся */
    let tmp = final_path.with_extension("part");

    let dl = if hls {
        download_hls(&stream_url, &tmp, app, &id).await
    } else {
        download_to_file(&stream_url, &tmp, req.token.as_deref(), app, &id).await
    };
    if let Err(e) = dl {
        dlog(format!("загрузка провалилась: {e}"));
        drop_file(&tmp);
        return json!({ "error": e });
    }

    /* fmp4 начинается с ftyp — это единственная дешёвая проверка, что склейка
       сегментов дала файл, а не html от провайдера. mp3 проверяется по ходу
       загрузки (looks_like_audio), здесь — только hls-ветка */
    if hls {
        let head = read_head(&tmp, 8);
        if !looks_like_mp4(&head) {
            drop_file(&tmp);
            return json!({ "error": bad_payload(&head).to_string() });
        }
        match ffmpeg.as_deref() {
            Some(ff) => {
                if let Err(e) = transcode_mp3(ff, &tmp, &final_path).await {
                    /* конвертация сорвалась — отдаём валидный m4a, а не мусор */
                    drop_file(&final_path);
                    mp3 = false;
                    final_path = unique_path(Path::new(&dir), &base, ".m4a");
                    if let Err(e2) = std::fs::rename(&tmp, &final_path) {
                        drop_file(&tmp);
                        return json!({ "error": format!("rename: {e2}") });
                    }
                    emit(app, json!({ "id": id, "warn": format!("ffmpeg: {e}") }));
                } else {
                    drop_file(&tmp);
                }
            }
            None => {
                if let Err(e) = std::fs::rename(&tmp, &final_path) {
                    drop_file(&tmp);
                    return json!({ "error": format!("rename: {e}") });
                }
            }
        }
    } else if let Err(e) = std::fs::rename(&tmp, &final_path) {
        /* переименование ДО записи тегов: lofty определяет формат по
           расширению, а `.part` для него — неизвестный формат */
        drop_file(&tmp);
        return json!({ "error": format!("rename: {e}") });
    }

    /* обложку берём сначала из кэша приложения: это тот же файл, что уже
       нарисован в списке, и он не зависит от того, ответит ли sndcdn сейчас */
    let cover_url = req.cover_url.as_deref().filter(|u| !u.is_empty());
    let cover = match cached_cover(&id) {
        /* mime по сигнатуре: в кэше лежат и png, и jpeg, а имя у всех .jpg */
        Some(data) => {
            let mime = if data.starts_with(b"\x89PNG\r\n\x1a\n") {
                MimeType::Png
            } else {
                MimeType::Jpeg
            };
            Some((mime, data))
        }
        None => fetch_cover_buffer(cover_url)
            .await
            .map(|data| (guess_mime(cover_url.unwrap_or("")), data)),
    };
    /* непустой url и ни одной картинки — это не норма, о ней говорим вслух */
    let cover_ok = cover.is_some() || cover_url.is_none();
    /* тэги: сбой записи НЕ отменяет сам файл, но пользователь обязан узнать,
       что файл без обложки/тегов, иначе это выглядит как «приложение забыло» */
    let tags_ok = match write_tags(&final_path, &req, cover, !mp3) {
        Ok(()) => true,
        Err(e) => {
            emit(app, json!({ "id": id, "warn": format!("tags_failed: {e}") }));
            false
        }
    };

    let size = std::fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0);
    emit(
        app,
        json!({ "id": id, "done": true, "path": final_path.to_string_lossy() }),
    );
    json!({
        "path": final_path.to_string_lossy(),
        "size": size,
        "tagsOk": tags_ok,
        "coverOk": cover_ok,
        "format": if mp3 { "mp3" } else { "m4a" },
    })
}

/// lofty хранит mime как закрытый перечислитель, а не строкой: webp и gif
/// в нём нет, и для них честно отдаём jpeg — apic всё равно хранит байты,
/// а тип нужен лишь другим читалкам.
fn guess_mime(url: &str) -> MimeType {
    let lower = url.to_ascii_lowercase();
    if lower.contains(".png") {
        MimeType::Png
    } else if lower.contains(".bmp") {
        MimeType::Bmp
    } else if lower.contains(".tiff") || lower.contains(".tif") {
        MimeType::Tiff
    } else {
        MimeType::Jpeg
    }
}
