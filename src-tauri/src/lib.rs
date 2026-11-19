//! seWer на tauri: окно, трей, медиаклавиши и команды рендерера.
//!
//! Имена команд — те же строки, что были каналами ipcMain в electron-версии
//! (`#[tauri::command(rename = "…")]`), поэтому фасад src/bridge.js не мог
//! разойтись с логикой ui: 64 вызова window.electronAPI переехали как есть.

mod backdrop;
mod discord;
mod download;
mod ipc_pipe;
mod library;
mod netcmd;
mod settings;
mod soundcloud;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use futures_util::stream::{FuturesUnordered, StreamExt};
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
    clock: Arc<tokio::sync::Mutex<ClockSync>>,
}

#[derive(Default)]
struct ClockSync {
    /// Успешная сверка. От неё настоящее время продолжается монотонно, даже
    /// если Windows-часы после этого поправили вручную или через NTP.
    checked_at: Option<Instant>,
    true_at_ms: Option<i64>,
    /// Неуспешную сверку повторяем не на каждый rpc-пульс, а через минуту.
    failed_at: Option<Instant>,
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

/* ⚠️ Про имя в tauri.conf.json. Приложение зовётся «seWer» (заголовок окна,
   подпись трея, тексты), но `productName` там остался «seWer Tauri» — и это
   обязательно, а не недосмотр.

   NSIS берёт имя программы для установки из `productName`, а НЕ из
   `identifier`. Это имя становится сразу тремя вещами: папкой установки
   (`%LOCALAPPDATA%\seWer Tauri`), ключом `Uninstall` в реестре и именем
   .exe-инсталлятора. По ключу установщик находит предыдущую копию и заменяет
   её. Стоило переименовать `productName` в «seWer» — установщик поставил бы
   вторую копию в другую папку, а старая осталась бы жить рядом.

   По той же причине `identifier` возвращён к `com.sewer.tauri`: с ним
   установщик узнаёт прежнюю сборку, а запись автозапуска в реестре остаётся
   по тому же ключу и не плодит нового. Настройки лежат в
   `%APPDATA%\sewer-tauri` (захардкожено в settings.rs, см. там), поэтому
   переименование их не тронуло. */
fn minimize_to_tray() -> bool {
    settings::load_settings()
        .get("minimizeToTray")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Выход уже пошёл. Ставится в [`exit_now`] первым делом: повторный крестик
/// или трей-«Выйти» во время очистки не должен запускать вторую задачу выхода
/// и второй `discord::Cmd::SetEnabled(false)`.
static EXITING: AtomicBool = AtomicBool::new(false);

/// Выход с очисткой присутствия. Electron делал это в before-quit с
/// preventDefault: библиотека discord не имеет таймаута на запрос, и
/// висящий клиент (pipe полуоткрыт) держал закрытие навсегда.
///
/// ⚠️ Раньше здесь стоял фиксированный `sleep(1500)` до `handle.exit`, и всё
/// это время окно оставалось на экране и не отвечало — фронтенд к моменту
/// закрытия уже не живёт, так что крестик выглядел как «приложение зависло на
/// секунду-две». Ждать действительно нужно (дискорд снимает карточку только
/// после настоящего `SET_ACTIVITY` с `activity: null` плюс выхода потоков
/// канала, см. `discord::drop_conn`), но ждать его ОКНОМ не обязательно:
/// окно убираем сразу, а процесс выходит, когда очистка закончилась.
///
/// Сигнал приходит из `discord::is_quiet()`. 1.5 с остались потолком на
/// случай, когда очередь дискорда занята чем-то долгим (например загрузкой
/// обложки), а нормой стал круг по локальному каналу и выход потоков — обычно
/// сотни миллисекунд, и окна к этому моменту на экране уже нет.
fn exit_now(app: &AppHandle) {
    if EXITING.swap(true, Ordering::SeqCst) {
        return;
    }
    /* приложение для пользователя закрыто здесь, одним кадром. остальное —
       уже его личные дела с discord, и они не должны держать окно */
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(state) = handle.try_state::<AppState>() {
            let _ = state.rpc.send(discord::Cmd::SetEnabled(false));
        }
        let deadline = Instant::now() + Duration::from_millis(1500);
        /* 20 мс — шаг опроса: сигнал выставляется в другой задаче, и ждать
           его событием здесь нечем (oneshot потребовал бы тащить ответ через
           очередь команд). полторы секунды такого опроса — это 75 проб */
        while !discord::is_quiet() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        handle.exit(0);
    });
}

pub fn run() {
    let http = http_client();
    let clock = Arc::new(tokio::sync::Mutex::new(ClockSync::default()));

    tauri::Builder::default()
        /* порядок плагинов значим: single-instance должен быть первым */
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            /* второй запуск просто поднимает уже открытое окно. Но если мы в
               этот момент уже выходим (окно скрыто, ждём очистку discord), то
               показывать его нельзя: через доли секунды процесс умрёт, и
               пользователь увидит окно, которое тут же исчезло само */
            if EXITING.load(Ordering::SeqCst) {
                return;
            }
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
                clock: clock.clone(),
            });

            /* Сверяемся сразу при старте. Если первый discord-update придёт
               раньше, он подождёт этот же mutex и уйдёт уже с поправкой. */
            let clock_http = http.clone();
            let clock_state = clock.clone();
            tauri::async_runtime::spawn(async move {
                refresh_clock(&clock_http, &clock_state).await;
            });

            build_tray(&handle)?;
            register_media_keys(&handle);
            /* Материал окна — до загрузки страницы, иначе окно мигнёт
               непрозрачным: настройка читается фронтендом асинхронно, а
               полупрозрачной оболочку он делает уже после первого рендера */
            if let Some(w) = handle.get_webview_window("main") {
                /* Рамку окна снимаем всегда и до всего остального: она
                   рисуется DWM поверх окна и никуда не девается, даже если
                   панель скруглена своим радиусом. Именно её видно по углам
                   — белой в неактивном окне и чёрной в активном. */
                backdrop::hide_border(&w);
                let on = settings::load_settings()
                    .get("windowEffect")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s == "mica");
                if !backdrop::apply(&w, on) {
                    /* система не умеет. молча оставлять включённым нельзя —
                       фронтенд откатит настройку сам, но и здесь пишем в лог,
                       иначе причина «ничего не изменилось» не видна нигде */
                    eprintln!("[backdrop] mica недоступна");
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            /* DWM пересчитывает цвет рамки при активации окна, и после
               включённого материала (он сбрасывает DWMWA_BORDER_COLOR при
               установке — см. backdrop::apply) система успевает вернуть рамку
               по умолчанию: белую в неактивном, чёрную в активном. Поэтому на
               каждом фокусе рамку снимаем заново. Вызов идемпотентный и дешёвый,
               окно приходит в фокус часто, но это один DwmSetWindowAttribute. */
            if matches!(event, WindowEvent::Focused(_)) {
                /* on_window_event отдаёт &Window, а backdrop работает с
                   &WebviewWindow (нужен hwnd). Берём нужное окно по label. */
                if let Some(w) = window.get_webview_window(window.label()) {
                    backdrop::hide_border(&w);
                }
            }
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
            sc_logout,
            sc_fetch,
            net_fetch,
            sc_check_covers,
            sc_cache_cover,
            sc_clear_covers_cache,
            sc_clear_likes_cache,
            sc_load_likes_cache,
            sc_save_likes_cache,
            sc_download_track,
            sc_has_ffmpeg,
            discord_update,
            discord_clear,
            discord_rpc_enabled,
            set_window_effect,
            system_accent,
        ])
        .run(tauri::generate_context!())
        .expect("seWer: запуск tauri");
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Открыть", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let items: [&dyn IsMenuItem<tauri::Wry>; 3] = [&open, &sep, &quit];
    let menu = Menu::with_items(app, &items)?;

    /* id трея — служебный, его видит только сам tauri. Возвращён к «sewer-tauri»
       от оригинальной сборки: новая ставится поверх старой (тот же
       identifier), и если бы id остался «sewer-prism», старая копия, если
       она ещё где-то запущена, делила бы с новой один трей иконку */
    let mut builder = TrayIconBuilder::with_id("sewer-tauri")
        .tooltip("seWer")
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

/// Материал окна из настроек. Отвечает, получилось ли: на windows 10 и на 11
/// ниже 22H2 DWM принимает вызов и не рисует ничего, поэтому «включилось» без
/// проверки означало бы тумблер, который ничего не делает (см. backdrop.rs).
#[tauri::command(rename = "set-window-effect")]
fn set_window_effect(window: tauri::WebviewWindow, effect: String) -> bool {
    backdrop::apply(&window, effect == "mica")
}

/// Акцент Windows для тонировки обложек. `None` — система не отдала цвет;
/// рендерер в этом случае держит нейтральный серый, а не красит всё в чёрный.
#[tauri::command(rename = "system-accent")]
fn system_accent() -> Option<String> {
    backdrop::accent_hex()
}

// ── сверка часов ──────────────────────────────────────────────────────────

fn local_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `Thu, 19 Nov 2026 14:47:54 GMT` → unix-секунды. Разбор свой: формат у
/// `Date` фиксированный (IMF-fixdate), и тащить ради одной строки крейт незачем.
fn parse_http_date(s: &str) -> Option<i64> {
    /* «Thu, » отбрасываем: день недели нам не нужен, он только мешает */
    let rest = s.trim().splitn(2, ", ").nth(1)?;
    let mut parts = rest.split(' ');
    let day: i64 = parts.next()?.parse().ok()?;
    let month: i64 = match parts.next()? {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let year: i64 = parts.next()?.parse().ok()?;
    let mut hms = parts.next()?.split(':');
    let h: i64 = hms.next()?.parse().ok()?;
    let m: i64 = hms.next()?.parse().ok()?;
    let sec: i64 = hms.next()?.parse().ok()?;
    if hms.next().is_some()
        || parts.next()? != "GMT"
        || parts.next().is_some()
        || !(1..=31).contains(&day)
        || !(0..=23).contains(&h)
        || !(0..=59).contains(&m)
        || !(0..=60).contains(&sec)
    {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400 + h * 3_600 + m * 60 + sec)
}

/// Дни с 1970-01-01 по григорианскому календарю (алгоритм Хауарда Хиннанта).
/// Вычитание с константой вместо библиотеки дат: нужно ровно это, и только тут.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Одна проба сетевого времени. `Date` имеет точность только до секунды,
/// поэтому берём середину этой секунды и середину оборота запроса. `Age`
/// добавляется для кэшированного ответа: по HTTP текущее время такого ответа
/// приблизительно равно `Date + Age`.
async fn clock_sample(http: reqwest::Client, host: &'static str) -> Option<i64> {
    let t0 = local_ms();
    let res = tokio::time::timeout(Duration::from_secs(4), http.head(host).send())
        .await
        .ok()?
        .ok()?;
    let t1 = local_ms();
    let rtt = t1.checked_sub(t0)?;
    /* Если часы перевели прямо во время запроса либо сеть зависла, проба хуже
       отсутствующей. Внешний timeout — 4 с, 5 с оставлены с запасом округления. */
    if !(0..=5_000).contains(&rtt) {
        return None;
    }
    let headers = res.headers();
    let date_s = headers
        .get(reqwest::header::DATE)?
        .to_str()
        .ok()
        .and_then(parse_http_date)?;
    let age_s = headers
        .get(reqwest::header::AGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0)
        .clamp(0, 86_400);
    let server_ms = date_s
        .saturating_add(age_s)
        .saturating_mul(1000)
        .saturating_add(500);
    Some(t0.saturating_add(rtt / 2).saturating_sub(server_ms))
}

/// Насколько местные часы ушли вперёд относительно сети, в миллисекундах.
/// Все хосты и повторы идут параллельно: мёртвый Discord не должен задержать
/// живой SoundCloud. Медиана отсекает кэшированный или кривой одиночный ответ.
async fn measure_clock_offset(http: &reqwest::Client) -> Option<i64> {
    const HOSTS: [&str; 3] = [
        "https://api-v2.soundcloud.com/",
        "https://www.cloudflare.com/",
        "https://discord.com/api/v9/gateway",
    ];
    let mut pending = FuturesUnordered::new();
    for host in HOSTS {
        pending.push(clock_sample(http.clone(), host));
        pending.push(clock_sample(http.clone(), host));
    }
    let mut samples: Vec<i64> = Vec::with_capacity(4);
    while let Some(sample) = pending.next().await {
        if let Some(v) = sample {
            samples.push(v);
            /* Обычно это по две пробы SoundCloud и Cloudflare за 100–300 мс.
               Мёртвый Discord после этого ждать до timeout уже незачем. */
            if samples.len() >= 4 {
                break;
            }
        }
    }
    if samples.is_empty() {
        return None;
    }
    samples.sort_unstable();
    let mid = samples.len() / 2;
    Some(if samples.len() % 2 == 0 {
        samples[mid - 1].saturating_add(samples[mid]) / 2
    } else {
        samples[mid]
    })
}

/// Раз в десять минут сверяем часы: discord рисует прогресс на своей стороне
/// как `его сейчас − наш start`, поэтому наше отставание видно всем зрителям
/// (а владельцу нет — у него позиция из `currentTime`). Ошибка часов в
/// полминуты — это полминуты разъезда у каждого, кто смотрит профиль.
async fn refresh_clock(http: &reqwest::Client, state: &tokio::sync::Mutex<ClockSync>) {
    const EVERY: Duration = Duration::from_secs(10 * 60);
    const RETRY: Duration = Duration::from_secs(60);

    /* Mutex держится и во время сети намеренно: параллельный discord-update
       ждёт ту же сверку, а не успевает отправить activity с нулевой поправкой. */
    let mut sync = state.lock().await;
    if let (Some(at), Some(true_at_ms)) = (sync.checked_at, sync.true_at_ms) {
        /* Продолжаем последнее сетевое время через монотонный Instant. Так
           ручная правка Windows-часов не портит presence даже без новой сети. */
        let elapsed_ms = at.elapsed().as_millis().min(i64::MAX as u128) as i64;
        let true_now = true_at_ms.saturating_add(elapsed_ms);
        let live_offset = local_ms().saturating_sub(true_now);
        discord::set_clock_offset_ms(live_offset);
        if at.elapsed() < EVERY {
            return;
        }
    }
    if sync.failed_at.is_some_and(|t| t.elapsed() < RETRY) {
        return;
    }

    if let Some(offset) = measure_clock_offset(http).await {
        discord::set_clock_offset_ms(offset);
        sync.checked_at = Some(Instant::now());
        sync.true_at_ms = Some(local_ms().saturating_sub(offset));
        sync.failed_at = None;
        settings::log(&format!(
            "[clock] поправка времени для discord: {:+.3} с",
            -(offset as f64) / 1000.0
        ));
    } else {
        sync.failed_at = Some(Instant::now());
        settings::log("[clock] не удалось сверить время; повтор через минуту");
    }
}

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
async fn sc_login(app: AppHandle, proxy: Option<String>) -> Result<Value, String> {
    Ok(soundcloud::sc_login(&app, proxy).await)
}

/* Выход — отдельная команда, а не «стереть поле в настройках»: окно сессии
   надо закрыть, а куки soundcloud удалить, иначе следующий вход проходит без
   пароля и сменить аккаунт невозможно (см. soundcloud::sc_logout). */
#[tauri::command(rename = "sc-logout")]
async fn sc_logout(app: AppHandle) -> Result<Value, String> {
    Ok(soundcloud::sc_logout(&app).await)
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
async fn sc_download_track(app: AppHandle, t: download::DownloadReq) -> Result<Value, String> {
    Ok(download::sc_download_track(&app, t).await)
}

/// Есть ли ffmpeg: от этого зависит, будет ли hls-трек в mp3 или в m4a.
/// Спрашивает диалог скачивания, чтобы не обещать в имени файла одно,
/// а сохранить другое.
#[tauri::command(rename = "sc-has-ffmpeg")]
fn sc_has_ffmpeg(app: AppHandle) -> bool {
    download::has_ffmpeg(&app)
}

// ── discord ───────────────────────────────────────────────────────────────

#[tauri::command(rename = "discord-rpc-enabled")]
fn discord_rpc_enabled(state: State<'_, AppState>, r#on: bool) {
    let _ = state.rpc.send(discord::Cmd::SetEnabled(r#on));
}

#[tauri::command(rename = "discord-update")]
async fn discord_update(state: State<'_, AppState>, data: Value) -> Result<(), String> {
    /* перед сборкой presence: иначе первый апдейт уедет с часами этой машины.
       Обычно это заглушка за отметкой времени, запрос — раз в десять минут */
    refresh_clock(&state.http, &state.clock).await;
    let presence = discord::Presence {
        title: str_field(&data, "title"),
        artist: str_field(&data, "artist"),
        duration: num_field(&data, "duration"),
        progress: num_field(&data, "progress"),
        cover_url: str_field(&data, "coverUrl"),
        cover_key: str_field(&data, "coverKey"),
        is_playing: data.get("isPlaying").and_then(Value::as_bool).unwrap_or(false),
        /* момент замера позиции: в нём держится якорь timestamps. num_field
           отсечёт NaN и отсутствие поля — тогда discord.rs возьмёт now_s() */
        sampled_at_ms: num_field(&data, "sampledAt"),
        timestamp: {
            let t = str_field(&data, "timestamp");
            if t.is_empty() { "progress".into() } else { t }
        },
    };
    let _ = state.rpc.send(discord::Cmd::Update(Box::new(presence)));
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Сверка часов держится на этом разборе: ошибка в нём сдвинула бы таймеры
    /// у всех зрителей и была бы незаметной — поэтому даты проверяем явно.
    #[test]
    fn http_date_parses() {
        assert_eq!(parse_http_date("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0));
        /* пример из RFC 9110 */
        assert_eq!(
            parse_http_date("Wed, 21 Oct 2015 07:28:00 GMT"),
            Some(1_445_412_480)
        );
        /* настоящий ответ сервера, на котором это и всплыло */
        assert_eq!(
            parse_http_date("Thu, 19 Nov 2026 14:47:54 GMT"),
            Some(1_795_099_674)
        );
        /* 29 февраля: високосный год не должен уехать на сутки */
        assert_eq!(
            parse_http_date("Thu, 29 Feb 2024 23:59:59 GMT"),
            Some(1_709_251_199)
        );
        assert_eq!(parse_http_date("мусор"), None);
        assert_eq!(parse_http_date("Thu, 19 Nov 2026 14:47:54 CET"), None);
    }
}
