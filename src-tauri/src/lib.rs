//! seWer на tauri: окно, трей, медиаклавиши и команды рендерера.
//!
//! Имена команд — те же строки, что были каналами ipcMain в electron-версии
//! (`#[tauri::command(rename = "…")]`), поэтому фасад src/bridge.js не мог
//! разойтись с логикой ui: 64 вызова window.electronAPI переехали как есть.

mod discord;
mod download;
mod ipc_pipe;
mod library;
mod netcmd;
mod settings;
mod soundcloud;

use std::collections::HashMap;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt as AutoLaunchExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;
const COVER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

/// состояние, общее для всех команд
pub struct AppState {
    http: reqwest::Client,
    sc: soundcloud::ScState,
    rpc: tokio::sync::mpsc::UnboundedSender<discord::Cmd>,
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        /* 45с — это «тишина», а не «всё скачивание»: столько же ждал
           socket в electron-версии. общего total-timeout у reqwest нет,
           и он снёс бы крупные треки */
        .read_timeout(Duration::from_secs(45))
        .connect_timeout(Duration::from_secs(20))
        .user_agent(COVER_UA)
        .build()
        .expect("http client")
}

fn minimize_to_tray() -> bool {
    settings::load_settings()
        .get("minimizeToTray")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Выход с очисткой присутствия. Electron делал это в before-quit с
/// preventDefault: библиотека discord не имеет таймаута на запрос, и
/// висящий клиент (pipe полуоткрыт) держал закрытие навсегда.
fn exit_now(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(state) = handle.try_state::<AppState>() {
            let _ = state.rpc.send(discord::Cmd::SetEnabled(false));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        handle.exit(0);
    });
}

pub fn run() {
    let http = http_client();

    tauri::Builder::default()
        /* порядок плагинов значим: single-instance должен быть первым */
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            /* второй запуск просто поднимает уже открытое окно */
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(move |app| {
            let handle = app.handle().clone();
            let rpc = discord::spawn(handle.clone(), http.clone());
            app.manage(AppState {
                http: http.clone(),
                sc: soundcloud::ScState::default(),
                rpc,
            });

            build_tray(&handle)?;
            register_media_keys(&handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                /* Только главное окно. Обработчик глобальный, а окон в
                   приложении два: второе — окно входа soundcloud, и его
                   закрывает sc_login сразу после получения токена. Без
                   этой проверки закрытие окна входа вызывало exit_now() и
                   убивало всё приложение — вылет ровно в момент успешного
                   логина. В electron окно входа было отдельным
                   BrowserWindow, и его закрытие никого не трогало. */
                if window.label() != "main" {
                    return;
                }
                api.prevent_close();
                if minimize_to_tray() {
                    let _ = window.hide();
                } else {
                    exit_now(window.app_handle());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            win_minimize,
            win_close,
            dialog_select_folder,
            dialog_select_image,
            scan_music_folder,
            get_cover_art,
            load_settings,
            save_settings,
            renderer_log,
            set_login_item,
            sc_login,
            sc_fetch,
            net_fetch,
            sc_check_covers,
            sc_cache_cover,
            sc_clear_covers_cache,
            sc_clear_likes_cache,
            sc_load_likes_cache,
            sc_save_likes_cache,
            sc_download_track,
            discord_update,
            discord_clear,
            discord_rpc_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("seWer Tauri: запуск tauri");
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Открыть", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let items: [&dyn IsMenuItem<tauri::Wry>; 3] = [&open, &sep, &quit];
    let menu = Menu::with_items(app, &items)?;

    let mut builder = TrayIconBuilder::with_id("sewer-tauri")
        .tooltip("seWer Tauri")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "quit" => exit_now(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/* Медиаклавиши: в electron это был globalShortcut.register на три Media*
   клавиши. Другие приложения (spotify, браузеры) могут держать их первыми —
   тогда регистрация падает, и это не повод ронять приложение. */
fn register_media_keys(app: &AppHandle) {
    /* имена в global-hotkey не совпадают с electron-овскими
       MediaNextTrack/MediaPreviousTrack — здесь MediaTrackNext и
       MediaTrackPrevious */
    let pairs = [
        (Code::MediaPlayPause, "media-play-pause"),
        (Code::MediaTrackNext, "media-next"),
        (Code::MediaTrackPrevious, "media-prev"),
    ];
    for (code, event) in pairs {
        let shortcut = Shortcut::new(None, code);
        let name = event.to_string();
        if let Err(e) = app.global_shortcut().on_shortcut(shortcut, move |app, _sc, e| {
            if e.state() == ShortcutState::Pressed {
                let _ = app.emit(&name, ());
            }
        }) {
            eprintln!("[hotkey] {event}: {e}");
        }
    }
}

// ── окно ──────────────────────────────────────────────────────────────────

#[tauri::command(rename = "win-minimize")]
fn win_minimize(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.minimize();
    }
}

#[tauri::command(rename = "win-close")]
fn win_close(app: AppHandle) {
    /* тот же путь, что и крестик: minimizeToTray решает, прячемся мы или
       закрываемся. close() сам вызвал бы CloseRequested ещё раз, поэтому
       решение принимаем здесь */
    if minimize_to_tray() {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
        }
    } else {
        exit_now(&app);
    }
}

// ── локальная библиотека ──────────────────────────────────────────────────

#[tauri::command(rename = "dialog-select-folder")]
async fn dialog_select_folder(app: AppHandle) -> Option<String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Выбрать папку с музыкой")
        .blocking_pick_folder()?;
    Some(picked.as_path()?.to_string_lossy().into_owned())
}

#[tauri::command(rename = "scan-music-folder")]
async fn scan_music_folder(folder_path: Option<String>, min_duration: Option<u64>) -> Vec<library::TrackMeta> {
    let Some(folder) = folder_path.filter(|f| !f.is_empty()) else {
        return Vec::new();
    };
    let min = min_duration.unwrap_or(30);
    /* обход и чтение тегов бьют по диску — уводим с async-потока, иначе
       один сканMusicFolder встанет в очередь ко всем сетевым запросам */
    tauri::async_runtime::spawn_blocking(move || library::scan_music_folder(&folder, min))
        .await
        .unwrap_or_default()
}

#[tauri::command(rename = "get-cover-art")]
async fn get_cover_art(file_path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || library::cover_art(&file_path))
        .await
        .ok()
        .flatten()
}

/// выбор картинки для обложки плейлиста: сразу читаем в data url,
/// renderer дальше сам уменьшает/кропает через canvas
#[tauri::command(rename = "dialog-select-image")]
async fn dialog_select_image(app: AppHandle) -> Option<Value> {
    let picked = app
        .dialog()
        .file()
        .set_title("Выбрать обложку")
        .add_filter("Изображения", &["jpg", "jpeg", "png", "webp", "bmp"])
        .blocking_pick_file()?;
    let path = picked.as_path()?.to_path_buf();

    let bytes = std::fs::read(&path).ok()?;
    if bytes.len() > 25 * 1024 * 1024 {
        return None;
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "image/jpeg",
    };
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("cover")
        .to_string();
    Some(json!({ "dataUrl": format!("data:{mime};base64,{}", B64.encode(&bytes)), "name": name }))
}

// ── настройки ─────────────────────────────────────────────────────────────

#[tauri::command(rename = "load-settings")]
fn load_settings() -> Value {
    settings::load_settings()
}

#[tauri::command(rename = "save-settings")]
fn save_settings(data: Value) {
    settings::save_settings(&data);
}

#[tauri::command(rename = "set-login-item")]
fn set_login_item(app: AppHandle, enable: bool) {
    let manager = app.autolaunch();
    let res = if enable {
        manager.enable()
    } else {
        manager.disable()
    };
    if let Err(e) = res {
        eprintln!("[autostart] {e}");
    }
}

/// Пишет строку рендерера в тот же sewer.log, что и вся rust-часть.
///
/// Без неё логин читался наполовину вслепую: rust писал «токен получен»,
/// а что сделал с токеном рендерер — запросил ли он /me, пришёл ли ответ и
/// почему настройки не сохранились — не было видно нигде. Ошибка рендерера
/// в консоль tauri dev попадает, в лог — нет, а консоли у собранного
/// приложения нет вообще.
#[tauri::command(rename = "log")]
fn renderer_log(msg: String) {
    settings::log(&format!("[ui] {msg}"));
}

// ── soundcloud ────────────────────────────────────────────────────────────

/* Async-команды, берущие State, обязаны возвращать Result: State — это
   ссылка, а ссылка не может жить через await, поэтому tauri требует
   явный Result. Наружу отдаём Ok всегда: ошибочные формы ({error}, null)
   рендерер ждёт в теле ответа, а не как reject промиса — иначе пришлось бы
   переписывать 38 вызовов scFetch в ui. */

#[tauri::command(rename = "sc-login")]
async fn sc_login(app: AppHandle) -> Result<Value, String> {
    Ok(soundcloud::sc_login(&app).await)
}

#[tauri::command(rename = "sc-fetch")]
async fn sc_fetch(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    token: String,
    client_id: String,
    method: Option<String>,
    body: Option<Value>,
    content_type: Option<String>,
) -> Result<Value, String> {
    Ok(soundcloud::sc_fetch(
        &app,
        &state.http,
        &state.sc,
        &url,
        &token,
        &client_id,
        method.as_deref().unwrap_or("GET"),
        body,
        content_type,
    )
    .await)
}

#[tauri::command(rename = "net-fetch")]
async fn net_fetch(
    state: State<'_, AppState>,
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<Value, String> {
    Ok(netcmd::net_fetch(&state.http, &url, headers.unwrap_or_default()).await)
}

#[tauri::command(rename = "sc-check-covers")]
fn sc_check_covers(ids: Vec<Value>) -> HashMap<String, String> {
    library::sc_check_covers(&ids)
}

#[tauri::command(rename = "sc-cache-cover")]
async fn sc_cache_cover(
    state: State<'_, AppState>,
    id: Value,
    url: String,
) -> Result<Option<String>, String> {
    Ok(library::cache_cover(&state.http, &id, &url).await)
}

#[tauri::command(rename = "sc-clear-covers-cache")]
fn sc_clear_covers_cache() -> usize {
    library::clear_covers_cache()
}

#[tauri::command(rename = "sc-clear-likes-cache")]
fn sc_clear_likes_cache() -> bool {
    library::clear_likes_cache()
}

#[tauri::command(rename = "sc-load-likes-cache")]
fn sc_load_likes_cache() -> Value {
    library::load_likes_cache()
}

#[tauri::command(rename = "sc-save-likes-cache")]
fn sc_save_likes_cache(data: Value) {
    library::save_likes_cache(&data);
}

#[tauri::command(rename = "sc-download-track")]
async fn sc_download_track(
    app: AppHandle,
    state: State<'_, AppState>,
    t: download::DownloadReq,
) -> Result<Value, String> {
    Ok(download::sc_download_track(&app, &state.http, t).await)
}

// ── discord ───────────────────────────────────────────────────────────────

#[tauri::command(rename = "discord-rpc-enabled")]
fn discord_rpc_enabled(state: State<'_, AppState>, r#on: bool) {
    let _ = state.rpc.send(discord::Cmd::SetEnabled(r#on));
}

#[tauri::command(rename = "discord-update")]
fn discord_update(state: State<'_, AppState>, data: Value) {
    let presence = discord::Presence {
        title: str_field(&data, "title"),
        artist: str_field(&data, "artist"),
        duration: num_field(&data, "duration"),
        progress: num_field(&data, "progress"),
        cover_url: str_field(&data, "coverUrl"),
        cover_key: str_field(&data, "coverKey"),
        is_playing: data.get("isPlaying").and_then(Value::as_bool).unwrap_or(false),
        timestamp: {
            let t = str_field(&data, "timestamp");
            if t.is_empty() { "progress".into() } else { t }
        },
    };
    let _ = state.rpc.send(discord::Cmd::Update(Box::new(presence)));
}

#[tauri::command(rename = "discord-clear")]
fn discord_clear(state: State<'_, AppState>) {
    let _ = state.rpc.send(discord::Cmd::Clear);
}

fn str_field(data: &Value, key: &str) -> String {
    data.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// Number(x) в js превращал в 0 и NaN, и non-finite — тоже; as_f64 на
/// не-числе даёт None, а json со значением NaN не сериализуется вовсе
fn num_field(data: &Value, key: &str) -> f64 {
    data.get(key)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .unwrap_or(0.0)
}
