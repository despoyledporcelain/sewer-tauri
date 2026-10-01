//! Локальная библиотека: обход папки, метаданные, обложки, кэши.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::prelude::*;
use rayon::prelude::*;
use serde::Serialize;

use crate::settings;

/// то же множество, что в electron: `.mp3 .flac .ogg .wav .m4a .aac .opus .wma`
const AUDIO_EXTS: [&str; 8] = ["mp3", "flac", "ogg", "wav", "m4a", "aac", "opus", "wma"];

const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMeta {
    pub id: usize,
    pub title: String,
    pub artist: String,
    pub path: String,
    pub color: String,
    pub duration: u64,
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .is_some_and(|e| AUDIO_EXTS.contains(&e.as_str()))
}

/// рекурсивный обход. `read_dir` может отдать что угодно (битая ссылка,
/// отобранный каталог) — electron глотал это молча, здесь тоже.
pub fn scan_dir(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let full = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            scan_dir(&full, out);
        } else if is_audio(&full) {
            out.push(full);
        }
    }
}

/// `hsl(h,52%,40%)`, где h — тот же хеш, что в electron:
/// `h = ((h << 5) - h + charCodeAt(0)) | 0` по кодовым точкам строки.
/// `charCodeAt(0)` у сурогатной пары отдаёт старший сурогат, поэтому
/// не-BMP символы уводим на `cp - 0x10000` — иначе цвет уедет.
fn hash_color(s: &str) -> String {
    let mut h: i32 = 0;
    for c in s.chars() {
        let mut unit = c as u32;
        if unit > 0xFFFF {
            unit -= 0x10000;
        }
        h = h
            .wrapping_shl(5)
            .wrapping_sub(h)
            .wrapping_add(unit as i32);
    }
    let hue = h.unsigned_abs() % 360;
    format!("hsl({hue},52%,40%)")
}

struct Probe {
    title: String,
    artist: String,
    duration: u64,
}

fn probe(path: &Path) -> Probe {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("track")
        .to_string();

    let (mut title, mut artist) = match stem.split_once(" - ") {
        Some((a, rest)) => (rest.trim().to_string(), a.trim().to_string()),
        None => (stem.clone(), "Неизвестно".to_string()),
    };
    let mut duration = 0;

    if let Ok(tagged) = lofty::read_from_path(path) {
        duration = tagged.properties().duration().as_secs();
        if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
            /* title()/artist() отдают Cow<str>, а не &str: map(str::trim)
               здесь не подходит, нужен as_ref */
            if let Some(t) = tag.title().as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                title = t.to_string();
            }
            if let Some(a) = tag.artist().as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                artist = a.to_string();
            }
        }
    }

    Probe {
        title,
        artist,
        duration,
    }
}

/// Скан папки. electron гонял до 16 воркеров на файлы и выкидывал треки
/// короче min_duration (по умолчанию 30с) — здесь то же, через rayon.
/// `id` — индекс в полном списке найденных файлов, а не в выжившем:
/// иначе после фильтра id'ы «поедут» и обложки перепутаются.
pub fn scan_music_folder(folder: &str, min_duration: u64) -> Vec<TrackMeta> {
    let mut files = Vec::new();
    scan_dir(Path::new(folder), &mut files);

    files
        .par_iter()
        .enumerate()
        .filter_map(|(i, path)| {
            let Probe {
                title,
                artist,
                duration,
            } = probe(path);
            if duration < min_duration {
                return None;
            }
            /* цвет — от имени БЕЗ расширения: electron брал
               `path.basename(p, ext)`, и с расширеном хеш был бы другим */
            let stem = path.file_stem()?.to_str()?;
            Some(TrackMeta {
                id: i + 1,
                color: hash_color(stem),
                title,
                artist,
                path: path.to_string_lossy().into_owned(),
                duration,
            })
        })
        .collect()
}

/// data-url обложки из тегов. electron отдавал `{data};base64,{bytes}`.
/// lofty держит картинки на самом теге, а не на файле: у mp3 обложка лежит
/// в APIC конкретного id3-тега, и «первая картинка файла» — это первая
/// картинка основного тега.
pub fn cover_art(file_path: &str) -> Option<String> {
    let tagged = lofty::read_from_path(file_path).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let pic = tag.pictures().first()?;
    /* mime_type() -> Option<MimeType>: у mp3 без APIC-описания типа его
       не бывает, тогда отдаём jpeg — electron в том же случае тоже
       полагался на значение по умолчанию */
    let mime = pic
        .mime_type()
        .map(|m| m.to_string())
        .unwrap_or_else(|| "image/jpeg".to_string());
    Some(format!("data:{mime};base64,{}", B64.encode(pic.data())))
}

/// id → абсолютный путь кэшированной обложки. electron отдавал сразу
/// `file:///…`; webview такое не грузит, поэтому путь отдаётся наружу, а
/// фасад переводит его в asset-протокол (см. src/bridge.js).
pub fn sc_check_covers(ids: &[serde_json::Value]) -> HashMap<String, String> {
    let dir = settings::sc_covers_dir();
    let existing: Vec<String> = fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();

    let mut out = HashMap::new();
    for id in ids {
        let name = id.to_string().trim_matches('"').to_string();
        let file = format!("{name}.jpg");
        if existing.iter().any(|e| *e == file) {
            out.insert(name, dir.join(&file).to_string_lossy().into_owned());
        }
    }
    out
}

/// Скачивает обложку трека в `%APPDATA%\sewer\sc_covers\{id}.jpg` и
/// отдаёт путь. В electron это был `https.get` с пайпом в write-stream;
/// здесь тот же результат, но без «успели скачать не всё — оставляем
/// мусорный jpg»: пишем во временный файл и переименовываем.
///
/// Каждый отказ логируется. Молчаливый `None` здесь стоил нам диагностики:
/// обложки не грузились, папка кэша была пуста, а что именно сломалось —
/// не скачок сети, не запрет CSP, не пустой url — угадывать пришлось вслепую.
pub async fn cache_cover(
    client: &reqwest::Client,
    id: &serde_json::Value,
    url: &str,
) -> Option<String> {
    let dir = settings::sc_covers_dir();
    let name = id.to_string().trim_matches('"').to_string();
    let file = dir.join(format!("{name}.jpg"));
    if file.exists() {
        return Some(file.to_string_lossy().into_owned());
    }
    if url.is_empty() {
        settings::log(&format!("[cover] {name}: пустой url"));
        return None;
    }
    if fs::create_dir_all(&dir).is_err() {
        settings::log(&format!("[cover] {name}: не создать папку {}", dir.display()));
        return None;
    }

    let res = match client
        .get(url)
        .header("User-Agent", "Mozilla/5.0")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            settings::log(&format!("[cover] {name}: запрос не ушёл: {e}"));
            return None;
        }
    };
    if res.status() != reqwest::StatusCode::OK {
        settings::log(&format!("[cover] {name}: статус {}", res.status()));
        return None;
    }
    let bytes = match res.bytes().await {
        Ok(b) => b,
        Err(e) => {
            settings::log(&format!("[cover] {name}: тело не дочитано: {e}"));
            return None;
        }
    };
    if bytes.is_empty() {
        settings::log(&format!("[cover] {name}: пустой ответ"));
        return None;
    }

    let tmp = file.with_extension("jpg.part");
    if tokio::fs::write(&tmp, &bytes).await.is_err() {
        let _ = fs::remove_file(&tmp);
        settings::log(&format!("[cover] {name}: не записать {}", tmp.display()));
        return None;
    }
    if fs::rename(&tmp, &file).is_err() {
        let _ = fs::remove_file(&tmp);
        settings::log(&format!("[cover] {name}: не переименовать в {}", file.display()));
        return None;
    }
    Some(file.to_string_lossy().into_owned())
}

pub fn clear_covers_cache() -> usize {
    let dir = settings::sc_covers_dir();
    let mut n = 0;
    if let Ok(rd) = fs::read_dir(&dir) {
        for entry in rd.flatten() {
            if fs::remove_file(entry.path()).is_ok() {
                n += 1;
            }
        }
    }
    n
}

pub fn clear_likes_cache() -> bool {
    fs::remove_file(settings::sc_likes_file()).is_ok()
}

pub fn load_likes_cache() -> serde_json::Value {
    fs::read_to_string(settings::sc_likes_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::Value::Array(Vec::new()))
}

pub fn save_likes_cache(data: &serde_json::Value) {
    if let Some(dir) = settings::data_dir().parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(data) {
        let _ = fs::write(settings::sc_likes_file(), json);
    }
}
