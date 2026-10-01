//! Скачивание трека.
//!
//! Отдельный путь от sc-fetch: тот читает тело целиком и для бинарника в
//! 10МБ это съело бы память и испортило файл. Здесь поток пишется на диск
//! по кускам, с прогрессом в рендерер.
//!
//! Поддерживается только progressive-transcoding (обычный mp3). Для треков,
//! у которых soundcloud отдаёт лишь hls, нужен ffmpeg — его в проекте нет,
//! поэтому такие честно отвечают ошибкой, а не молча пишут мусор.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use lofty::config::WriteOptions;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::tag::{Tag, TagType};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use url::Url;

const DL_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const DL_REDIRECT_LIMIT: usize = 5;

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
    pub dir: Option<String>,
    pub token: Option<String>,
    pub base_name: Option<String>,
}

fn emit(app: &AppHandle, payload: Value) {
    let _ = app.emit("download-progress", payload);
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

fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

fn drop_file(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// GET с редиректами, тело пишется в dest. Отдаёт total.
async fn download_to_file(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    token: Option<&str>,
    app: &AppHandle,
    id: &Value,
) -> Result<u64, String> {
    let mut hops = 0usize;
    let mut current = url.to_string();
    let mut current_token = token.map(str::to_string);

    loop {
        let mut req = client
            .get(&current)
            .header("User-Agent", DL_UA)
            .header("Accept", "audio/*,*/*;q=0.8");
        if let Some(t) = current_token.as_deref() {
            req = req.header("Authorization", format!("OAuth {t}"));
        }
        let res = req.send().await.map_err(|e| e.to_string())?;
        let status = res.status().as_u16();

        if is_redirect(status) {
            let Some(location) = res
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
            else {
                return Err(format!("HTTP {status} без Location"));
            };
            hops += 1;
            if hops > DL_REDIRECT_LIMIT {
                return Err("too many redirects".into());
            }
            let next = Url::parse(&current)
                .and_then(|base| base.join(&location))
                .map_err(|e| e.to_string())?
                .to_string();
            /* на CDN токен не нужен и иногда мешает — рвём его на другом хосте */
            let same_host = match (Url::parse(&next), Url::parse(&current)) {
                (Ok(a), Ok(b)) => a.host_str() == b.host_str(),
                _ => false,
            };
            if !same_host {
                current_token = None;
            }
            current = next;
            continue;
        }

        if status != 200 {
            return Err(format!("HTTP {status}"));
        }

        let total = res.content_length().unwrap_or(0);
        let mut file = tokio::fs::File::create(dest)
            .await
            .map_err(|e| e.to_string())?;
        use tokio::io::AsyncWriteExt;

        let mut got: u64 = 0;
        let mut head: Vec<u8> = Vec::with_capacity(3);
        let mut last_report = 0u64;
        let mut stream = res.bytes_stream();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            if head.len() < 3 {
                let take = 3usize - head.len();
                head.extend_from_slice(&chunk[..chunk.len().min(take)]);
                if head.len() == 3 && !looks_like_audio(&head) {
                    drop_file(dest);
                    return Err(bad_payload(&head).to_string());
                }
            }
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            got += chunk.len() as u64;
            /* прогресс шлём не на каждый чанк: emit на 64кб — это ipc-спам
               ради полосы, на которой разницу никто не увидит */
            if got - last_report >= 128 * 1024 {
                last_report = got;
                emit(app, json!({ "id": id, "got": got, "total": total }));
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;

        if got == 0 {
            drop_file(dest);
            return Err("empty".into());
        }
        if head.len() < 3 {
            /* файл короче 3 байт — точно не mp3 */
            drop_file(dest);
            return Err("too_small".into());
        }
        emit(app, json!({ "id": id, "got": got, "total": total }));
        return Ok(total);
    }
}

/// обложка в APIC: bytes, не путь. молча переживаем ошибку — теги важнее картинки
async fn fetch_cover_buffer(client: &reqwest::Client, url: Option<&str>) -> Option<Vec<u8>> {
    let mut current = url?.to_string();
    for _ in 0..5 {
        let res = client
            .get(&current)
            .header("User-Agent", "Mozilla/5.0")
            .send()
            .await
            .ok()?;
        let status = res.status().as_u16();
        if is_redirect(status) {
            let location = res
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())?;
            current = Url::parse(&current)
                .ok()?
                .join(location)
                .ok()?
                .to_string();
            continue;
        }
        if status != 200 {
            return None;
        }
        let bytes = res.bytes().await.ok()?;
        return if bytes.is_empty() { None } else { Some(bytes.to_vec()) };
    }
    None
}

fn write_tags(
    path: &Path,
    req: &DownloadReq,
    cover: Option<(MimeType, Vec<u8>)>,
) -> Result<(), String> {
    let mut tag = Tag::new(TagType::Id3v2);
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

/// streamUrl СЮДА ПРИХОДИТ УЖЕ РЕЗОЛВНУТЫМ (renderer вызывает sc-fetch и берёт
/// .data.url). Сам api-v2 /media/.../stream/progressive отдаёт JSON-манифест,
/// а не звук. client_id тоже НЕ дописывается: у CDN-ссылки он уже сидит в
/// policy-параметрах, и хвост после подписи ломает валидацию.
pub async fn sc_download_track(
    app: &AppHandle,
    client: &reqwest::Client,
    req: DownloadReq,
) -> Value {
    let Some(dir) = req.dir.clone().filter(|d| !d.is_empty()) else {
        return json!({ "error": "no_dir" });
    };
    let Some(stream_url) = req.stream_url.clone().filter(|u| !u.is_empty()) else {
        return json!({ "error": "no_progressive" }); /* hls-only: нужен ffmpeg */
    };

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
    let final_path = unique_path(Path::new(&dir), &base, ".mp3");
    let tmp = final_path.with_extension("mp3.tmp");
    let id = req.id.clone().unwrap_or(Value::Null);

    if let Err(e) = download_to_file(client, &stream_url, &tmp, req.token.as_deref(), app, &id).await
    {
        drop_file(&tmp);
        return json!({ "error": e });
    }

    /* переименование ДО записи тегов: lofty определяет формат по расширению,
       а `.tmp` для него — неизвестный формат. При ошибке тегов имя файла уже
       не меняется, файл остаётся playable — как и в electron-версии. */
    if let Err(e) = std::fs::rename(&tmp, &final_path) {
        drop_file(&tmp);
        return json!({ "error": format!("rename: {e}") });
    }

    /* тэги: сбой записи НЕ отменяет сам файл, но пользователь обязан узнать,
       что файл без обложки/тегов, иначе это выглядит как «приложение забыло» */
    let cover = fetch_cover_buffer(client, req.cover_url.as_deref())
        .await
        .map(|data| (guess_mime(req.cover_url.as_deref().unwrap_or("")), data));
    let tags_ok = match write_tags(&final_path, &req, cover) {
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
    json!({ "path": final_path.to_string_lossy(), "size": size, "tagsOk": tags_ok })
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
