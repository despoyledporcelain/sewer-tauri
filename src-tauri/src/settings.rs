//! Пути файлов состояния.
//!
//! Папка данных — `%APPDATA%\sewer-tauri`, намеренно с суффиксом, чтобы
//! не делить файлы с electron-сборкой (`%APPDATA%\sewer`). Общая папка
//! означала бы общий settings.json: включённый в одной сборке автозапуск и
//! папка с музыкой из другой перетирали бы друг друга при каждом запуске.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

/// имя папки данных. Держим константой, потому что оно же попадает в
/// `productName`/`identifier` — разъезжаться им нельзя
const DATA_DIR: &str = "sewer-tauri";

/// `%APPDATA%\sewer-tauri`.
///
/// Имя с суффиксом `-tauri` — принципиально. Electron-версия писала в
/// `%APPDATA%\sewer`, и если бы мы продолжили тот же путь, две сборки делили
/// бы один settings.json: включённый в одной rpc/автозапуск и папка с
/// музыкой из другой перетирали бы друг друга, а логи и кэш обложек
/// смешивались. Здесь каждая сборка живёт в своей папке.
pub fn data_dir() -> PathBuf {
    match std::env::var_os("APPDATA") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir).join(DATA_DIR),
        _ => std::env::temp_dir().join(DATA_DIR),
    }
}

pub fn settings_file() -> PathBuf {
    data_dir().join("settings.json")
}

pub fn sc_covers_dir() -> PathBuf {
    data_dir().join("sc_covers")
}

pub fn sc_likes_file() -> PathBuf {
    data_dir().join("sc_likes.json")
}

/// пустой объект при любой проблеме — ровно как catch в electron-версии
pub fn load_settings() -> Value {
    fs::read_to_string(settings_file())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Default::default()))
}

pub fn save_settings(data: &Value) {
    if let Some(dir) = data_dir().parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(data) {
        let _ = fs::write(settings_file(), json);
    }
}

/// Диагностический лог в `%APPDATA%\sewer-tauri\sewer.log`.
///
/// Зачем: в установленном приложении консоли нет, а ошибки логина
/// (окно входа, перехват заголовков, webview) иначе негде увидеть —
/// рендерер получает только «ошибка подключения» и ничего не знает,
/// что произошло на самом деле. Пишем сами: в stderr экземпляра,
/// запущенного двойным кликом, смотреть некуда.
pub fn log(line: &str) {
    use std::io::Write;
    let stamp = {
        // без chrono: локальное время через SystemTime достаточно,
        // дата в тексте нужна для порядка, а не для красоты
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("[{secs}]")
    };
    let path = data_dir().join("sewer.log");
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{stamp} {line}");
    }
}
