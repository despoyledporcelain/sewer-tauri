//! Discord RPC: свой клиент поверх именованого канала `discord-ipc-N`.
//!
//! Крейт не взят намеренно. Протокол локальный и стабильный: кадр — это
//! 4 байта LE длины, дальше байт-опкод и json. Требуется ровно то, что делал
//! `@xhayper/discord-rpc`: handshake, SET_ACTIVITY с ожиданием ответа по
//! nonce, INITIATE_IMAGE_UPLOAD + загрузка файла, reconnect с backoff и
//! сериализованная очередь присутствий. Своя реализация — значит можно
//! повторить семантику 1:1, включая «пока грузили обложку, пришёл свежий
//! payload — старый не шлём».
//!
//! На соединение три горутины: читатель, писатель и логика очереди (tokio).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc as tmpsc, oneshot};

use crate::ipc_pipe::{self, Pipe};
use crate::settings;

/// обрезка для логов: ответы discord короткие, но в поле data может прилететь
/// что угодно, и писать это целиком в sewer.log не надо
fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

const RPC_CLIENT_ID: &str = "1501214545136586792";
const RPC_APP_NAME: &str = "seWer";
/* дискорд держит ~300 активных ассетов на приложение (docs: «Up to 300
   custom assets»), и загруженные не исчезают — поэтому потолок на
   сессию, а не «грузим каждый трек заново» */
const RPC_ASSET_LIMIT: usize = 250;

const OP_HANDSHAKE: u8 = 0;
const OP_FRAME: u8 = 1;
const OP_CLOSE: u8 = 2;
const OP_PING: u8 = 3;
const OP_PONG: u8 = 4;

const KEEPALIVE: Duration = Duration::from_secs(5);
const RPC_TIMEOUT: Duration = Duration::from_secs(8);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(15);
const UPLOAD_BOUNDARY: &str = "seWerUploadBoundary";
const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

// ── транспорт ─────────────────────────────────────────────────────────────

enum Out {
    Frame { op: u8, json: Value },
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

/// живое соединение с discord. `pid` — id процесса discord, он обязателен
/// в args SET_ACTIVITY/CLEAR_ACTIVITY и приходит в событии READY.
#[derive(Clone)]
struct Conn {
    tx: Sender<Out>,
    pending: Pending,
    /// Пришёл ли READY. Раньше вместо этого держали `pid` из READY и
    /// требовали `pid > 0`, но проверенный ответ discord выглядит так:
    /// `{"cmd":"DISPATCH","data":{"v":1,"config":{…},"user":{…}},"evt":"READY"}`
    /// — поля `pid` в нём нет вообще. Значит ожидание было вечным: даже с
    /// правильным кадром соединение не признавалось живым и уходило в
    /// переподключение по таймауту. Присутствие шлётся с pid 0 и discord
    /// такое принимает.
    ready: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
}

/// Кадр: `[op: u32 LE][len: u32 LE][json]` — и json БЕЗ байта op внутри.
///
/// Проверено прямым разговором с каналом discord: если положить байт op в
/// тело, сервер отвечает кодом 1003 «Unexpected token '\u0001'». Раньше
/// именно так и было. Пишем одним write_all, чтобы кадр не мог порваться
/// между двумя вызовами.
fn write_frame(write: &Mutex<Pipe>, op: u8, payload: &Value) -> bool {
    let body = serde_json::to_vec(payload).unwrap_or_default();
    let mut frame = Vec::with_capacity(8 + body.len());
    frame.extend_from_slice(&(op as u32).to_le_bytes());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&body);
    let Ok(guard) = write.lock() else {
        return false;
    };
    guard.write_all(&frame).is_ok()
}

fn nonce() -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    format!(
        "{:x}-{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        n
    )
}

/// открывает соединение и поднимает читателя с писателем.
/// None — discord не запущен или все каналы заняты.
///
/// Один дескриптор на оба потока: читатель не блокируется (см. ipc_pipe),
/// поэтому блокировкой Mutex они не конфликтуют.
fn connect() -> Option<Conn> {
    let pipe = ipc_pipe::first_available().ok()?;
    let (tx, rx) = mpsc::channel::<Out>();
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let ready = Arc::new(AtomicBool::new(false));
    let alive = Arc::new(AtomicBool::new(true));
    let shared = Arc::new(Mutex::new(pipe));

    std::thread::spawn({
        let alive = alive.clone();
        let shared = shared.clone();
        let pending = pending.clone();
        let ready = ready.clone();
        move || reader_loop(shared, pending, ready, alive)
    });
    std::thread::spawn({
        let alive = alive.clone();
        move || writer_loop(shared, rx, alive)
    });

    Some(Conn {
        tx,
        pending,
        ready,
        alive,
    })
}

fn writer_loop(pipe: Arc<Mutex<Pipe>>, rx: mpsc::Receiver<Out>, alive: Arc<AtomicBool>) {
    let mut last_write = Instant::now();
    while alive.load(Ordering::Relaxed) {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Out::Frame { op, json }) => {
                if !write_frame(&pipe, op, &json) {
                    break;
                }
                last_write = Instant::now();
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        /* сервер рвёт молчащее соединение — пингуем, как это делает
           discord-rpc: ответный PONG не ждём, достаточно факта записи */
        if last_write.elapsed() >= KEEPALIVE {
            if !write_frame(&pipe, OP_PING, &json!({ "nonce": nonce() })) {
                break;
            }
            last_write = Instant::now();
        }
    }
    alive.store(false, Ordering::Relaxed);
}

/// читает кадры опросом, а не блокировкой: см. комментарий в ipc_pipe.
/// при закрытом канале available() вернёт Err — это штатный повод
/// переподключиться, поэтому рвём цикл, а не паникуем.
fn reader_loop(
    pipe: Arc<Mutex<Pipe>>,
    pending: Pending,
    ready: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
) {
    while alive.load(Ordering::Relaxed) {
        let Ok(read) = pipe.lock() else { break };

        let Ok(avail) = read.available() else {
            drop(read);
            break;
        };
        /* Кадр discord ipc: [op: u32 LE][len: u32 LE][data], где data
           начинается с того же байта op, дальше json.
           Здесь раньше читались первые 4 байта и объявлялись длиной — то
           есть за длину принимался САМ op (0/1/2/8), а настоящее поле len
           не читалось вовсе. Поток сдвигался на 4 байта, первый же кадр
           разбирался как мусор, цикл рвался, и в логе это выглядело как
           «сервер закрыл соединение через 50 мс»: на самом деле Discord
           отвечал нормально, а мы не умели прочитать ответ. */
        if avail < 8 {
            drop(read);
            ipc_pipe::pause();
            continue;
        }

        let mut op_buf = [0u8; 4];
        if read.read_exact(&mut op_buf).is_err() {
            drop(read);
            break;
        }
        let mut len_buf = [0u8; 4];
        if read.read_exact(&mut len_buf).is_err() {
            drop(read);
            break;
        }
        let len = u32::from_le_bytes(len_buf) as usize;
        if len == 0 || len > 8 * 1024 * 1024 {
            drop(read);
            break;
        }

        let mut buf = vec![0u8; len];
        if read.read_exact(&mut buf).is_err() {
            drop(read);
            break;
        }
        drop(read);

        /* op берём из заголовка, а json — это всё тело целиком: байта op
           внутри тела нет, раньше json читался из buf[1..] и первым символом
           всегда отбрасывался первый байт payload. */
        let op = op_buf[0];
        let Ok(packet) = serde_json::from_slice::<Value>(&buf) else {
            settings::log(&format!(
                "[discord] не разобрал json кадра, {len} байт, начало {:?}",
                truncate(&String::from_utf8_lossy(&buf[..len.min(120)]), 120)
            ));
            continue;
        };

        if op == OP_CLOSE {
            /* Сервер закрывает соединение с кодом и текстом. Именно здесь
               видно «невалидный client_id» или «соединение занято другим
               клиентом с тем же client_id» — раньше это просто рвало цикл
               и выглядело как «переподключается». */
            settings::log(&format!(
                "[discord] сервер закрыл соединение: {}",
                truncate(&String::from_utf8_lossy(&buf[1..]), 300)
            ));
            break;
        }
        if op == OP_PING {
            write_frame(&pipe, OP_PONG, &json!({ "nonce": packet.get("nonce") }));
            continue;
        }
        if op != OP_FRAME && op != OP_HANDSHAKE {
            continue;
        }

        let evt = packet.get("evt").and_then(Value::as_str).unwrap_or("");
        let cmd = packet.get("cmd").and_then(Value::as_str).unwrap_or("");

        if evt == "READY" {
            ready.store(true, Ordering::Relaxed);
            settings::log("[discord] READY получен, соединение живое");
            continue;
        }
        /* серверный пинг: ответ тем же nonce, иначе соединение считается
           мёртвым примерно через 15 секунд простоя */
        if evt == "PING" || cmd == "PING" {
            let reply = json!({
                "cmd": "PING",
                "evt": "PING",
                "nonce": packet.get("nonce").cloned().unwrap_or(Value::Null)
            });
            write_frame(&pipe, OP_FRAME, &reply);
            continue;
        }

        if let Some(n) = packet.get("nonce").and_then(Value::as_str) {
            let waiter = pending.lock().ok().and_then(|mut p| p.remove(n));
            if let Some(w) = waiter {
                let _ = w.send(packet.get("data").cloned().unwrap_or(Value::Null));
            }
        }
    }
    alive.store(false, Ordering::Relaxed);
}

impl Conn {
    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed) && self.ready.load(Ordering::Relaxed)
    }

    /// заявка-ответ по nonce. Единственное место, где ждём ответа discord.
    async fn request(&self, cmd: &str, args: Value, timeout: Duration) -> Result<Value, String> {
        if !self.alive.load(Ordering::Relaxed) {
            return Err("pipe закрыт".into());
        }
        let n = nonce();
        let (tx, rx) = oneshot::channel();
        {
            let mut p = self
                .pending
                .lock()
                .map_err(|_| "pending poisoned".to_string())?;
            p.insert(n.clone(), tx);
        }
        let payload = json!({ "cmd": cmd, "args": args, "nonce": n });
        if self
            .tx
            .send(Out::Frame { op: OP_FRAME, json: payload })
            .is_err()
        {
            return Err("писатель мёртв".into());
        }

        let answer = tokio::time::timeout(timeout, rx).await;
        if let Ok(mut p) = self.pending.lock() {
            p.remove(&n);
        }
        /* три исхода: таймаут, канал закрыт читателем (ответа не будет
           уже никогда), и сам ответ. Флatten разворачивает всё в один Result */
        match answer {
            Ok(Ok(data)) => Ok(data),
            Ok(Err(_)) => Err("читатель умер".into()),
            Err(_) => Err("timeout".into()),
        }
    }
}

// ── присутствие ───────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default)]
pub struct Presence {
    pub title: String,
    pub artist: String,
    pub duration: f64,
    pub progress: f64,
    pub cover_url: String,
    pub cover_key: String,
    pub is_playing: bool,
    pub timestamp: String,
}

/// discord требует минимум два символа в name/details, иначе клиент сам
/// дописывает пробелы — ровно это и делал electron-вариант
fn pad2(s: &str) -> String {
    let t: String = s.chars().take(128).collect();
    if t.chars().count() >= 2 {
        t
    } else {
        format!("{t}  ")
    }
}

fn build_activity(p: &Presence, large_image_key: Option<&str>) -> Value {
    let title = p.title.trim();
    let artist = p.artist.trim();
    /* type 2 = Listening: заголовок присутствия — «Слушает <name>».
       без name дискорд подставляет имя зарегистрированного приложения. */
    let name = if !artist.is_empty() {
        artist
    } else if !title.is_empty() {
        title
    } else {
        RPC_APP_NAME
    };

    let mut activity = json!({ "type": 2, "name": pad2(name), "details": pad2(title) });
    if let Some(key) = large_image_key {
        /* assets.large_image, а НЕ large_image_key. Проверено в живом канале
           и подтверждено скриншотом: с плоским `large_image_key` discord
           показывал серую заглушку «?», с `assets: {large_image: …}` —
           настоящую картинку. Плоские имена здесь не вызывали ошибки и
           молча терялись. */
        activity["assets"] = json!({ "large_image": key });
    }
    /* ТОЛЬКО на PLAYING, и это не «оптимизация»: discord считает прошедшее
       как Date.now() - start КАЖДУЮ секунду, на своей стороне. заморозить
       таймер на паузе нельзя — только убрать. режим 'none' убирает таймер
       и на игре — остаётся одно название трека.

       Имена и форма полей — как их клал на провод оригинальный electron,
       где всё это переводила библиотека discord-rpc. Плоские
       `startTimestamp`/`largeImageKey` discord не понимает: таймер
       показывался как 0:00, картинка — как серая заглушка. Работает
       вложенный `timestamps: {start, end}` и `assets: {large_image: …}`,
       и значения времени в СЕКУНДАХ unix. Всё это проверено запросами в
       живой канал discord, а не чтением документации. */
    if p.is_playing && p.duration > 0.0 && p.timestamp != "none" {
        let dur_s = p.duration.round() as i64;
        let progress = if p.progress.is_finite() { p.progress.max(0.0) } else { 0.0 };
        let start = now_s() - (progress * dur_s as f64).round() as i64;
        let mut ts = json!({ "start": start });
        if p.timestamp == "progress" {
            ts["end"] = json!(start + dur_s);
        }
        activity["timestamps"] = ts;
    }
    /* Что реально ушло в discord. Без этого «в присутствии нет таймера»
       приходилось вычислять умозрительно: подходит пять причин, и все они
       выглядят одинаково — тишина в интерфейсе. */
    settings::log(&format!(
        "[discord] activity: play={} dur={} progress={} ts={} img={} → {}",
        p.is_playing,
        p.duration,
        p.progress,
        p.timestamp,
        large_image_key
            .map(|k| truncate(k, 48))
            .unwrap_or_else(|| "нет".into()),
        truncate(&activity.to_string(), 260)
    ));
    activity
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Секунды unix — именно в них discord ждёт `timestamps.start/end`.
/// В миллисекундах таймер отображается как 0:00.
fn now_s() -> i64 {
    now_ms() / 1000
}

fn data_url_to_bytes(data_url: &str) -> Option<(String, Vec<u8>)> {
    let comma = data_url.find(',')?;
    let head = data_url.get(5..comma)?;
    if !head.contains("base64") {
        return None;
    }
    let mime = head.split(';').next().unwrap_or("image/jpeg").to_string();
    let bytes = B64.decode(data_url.get(comma + 1..)?.as_bytes()).ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some((mime, bytes))
}

fn sanitize_key(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect()
}

/// `http://asset.localhost/C%3A%5CUsers%5C…%5C123.jpg` → байты файла.
///
/// Мост отдаёт локальные пути через asset-протокол (convertFileSrc), и это
/// единственная форма, в которой sc-обложка доезжает до присутствия: после
/// скачивания в кэш её url перестаёт быть https-ссылкой. Такую ссылку сам
/// discord открыть не может — это локальный адрес, — поэтому читаем файл и
/// загружаем, как уже загружаются data-url.
fn asset_url_to_bytes(url: &str) -> Option<(String, Vec<u8>)> {
    /* url = http://asset.localhost/C%3A%5CUsers%5C…%5C123.jpg
       хост отделяем сразу, иначе в percent_decode попадёт и хост, и путь */
    let rest = url.split_once("://")?.1;
    let (host, encoded) = rest.split_once('/')?;
    if !host.eq_ignore_ascii_case("asset.localhost") {
        return None;
    }
    let file = percent_decode(encoded);
    if !file.contains('.') || !file.contains(':') {
        return None;
    }
    let bytes = std::fs::read(&file).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let mime = if file.to_ascii_lowercase().ends_with(".png") {
        "image/png"
    } else {
        "image/jpeg"
    };
    Some((mime.to_string(), bytes))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn multipart(mime: &str, filename: &str, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 256);
    out.extend_from_slice(
        format!(
            "--{UPLOAD_BOUNDARY}\r\nContent-Disposition: form-data; name=\"payload_json\"\r\n\r\n{{\"name\":\"seWer-cover\"}}\r\n"
        )
        .as_bytes(),
    );
    out.extend_from_slice(
        format!(
            "--{UPLOAD_BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n"
        )
        .as_bytes(),
    );
    out.extend_from_slice(data);
    out.extend_from_slice(format!("\r\n--{UPLOAD_BOUNDARY}--\r\n").as_bytes());
    out
}

// ── машина состояний ──────────────────────────────────────────────────────

pub enum Cmd {
    SetEnabled(bool),
    Update(Box<Presence>),
    Clear,
}

struct St {
    wanted: bool,
    conn: Option<Conn>,
    queued: Option<Presence>,
    retry_at: Option<Instant>,
    retry_delay: Duration,
}

struct Rpc {
    app: AppHandle,
    http: reqwest::Client,
    assets: Arc<Mutex<HashMap<String, String>>>,
}

pub fn spawn(app: AppHandle, http: reqwest::Client) -> tmpsc::UnboundedSender<Cmd> {
    let (cmd_tx, cmd_rx) = tmpsc::unbounded_channel();
    let rpc = Rpc {
        app,
        http,
        assets: Arc::new(Mutex::new(HashMap::new())),
    };
    tauri::async_runtime::spawn(async move {
        rpc.run(cmd_rx).await;
    });
    cmd_tx
}

impl Rpc {
    fn status(&self, s: &str) {
        /* Каждый переход статуса в лог. Модуль молчал целиком, а «discord
           не работает, переподключается» — это и есть переход
           connecting → disconnected по кругу, и без лога нельзя было
           отличить «канала нет» от «канал есть, но READY не пришёл» от
           «сервер закрыл соединение с кодом». */
        settings::log(&format!("[discord] статус: {s}"));
        let _ = self.app.emit("discord-status", s);
    }

    async fn run(self, mut rx: tmpsc::UnboundedReceiver<Cmd>) {
        let mut st = St {
            wanted: false,
            conn: None,
            queued: None,
            retry_at: None,
            retry_delay: Duration::from_millis(1500),
        };

        while let Some(first) = rx.recv().await {
            /* пачка: за время await внутри apply очередь могла наполниться,
               и промежуточные Update терять нельзя — но и обрабатывать их
               по одному с ожиданием между ними смысла нет */
            let mut batch = vec![first];
            while let Ok(cmd) = rx.try_recv() {
                batch.push(cmd);
            }
            for cmd in batch {
                self.apply(&mut st, cmd).await;
            }
            self.tick(&mut st, &mut rx).await;
        }
    }

    async fn apply(&self, st: &mut St, cmd: Cmd) {
        match cmd {
            Cmd::SetEnabled(on) => {
                if on == st.wanted {
                    return;
                }
                st.wanted = on;
                if on {
                    self.status("connecting");
                } else {
                    st.queued = None;
                    st.retry_at = None;
                    st.retry_delay = Duration::from_millis(1500);
                    if let Some(c) = st.conn.take() {
                        if c.is_alive() {
                            let _ = c
                                .request(
                                    "CLEAR_ACTIVITY",
                                    json!({ "pid": 0 }),
                                    Duration::from_millis(1500),
                                )
                                .await;
                        }
                    }
                    self.status("off");
                }
            }
            Cmd::Update(p) => st.queued = Some(*p),
            Cmd::Clear => {
                st.queued = None;
                if let Some(c) = st.conn.as_ref() {
                    if c.is_alive() {
                        let _ = c
                            .request(
                                "CLEAR_ACTIVITY",
                                json!({ "pid": 0 }),
                                Duration::from_millis(2000),
                            )
                            .await;
                    }
                }
            }
        }
    }

    /// подтягивает в очередь всё, что пришло во время await внутри apply.
    /// Принимает &mut: try_recv забирает из канала, то есть мутирует его.
    fn absorb(&self, st: &mut St, rx: &mut tmpsc::UnboundedReceiver<Cmd>) {
        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                Cmd::Update(p) => st.queued = Some(*p),
                Cmd::Clear => st.queued = None,
                Cmd::SetEnabled(on) => {
                    st.wanted = on;
                    if !on {
                        st.queued = None;
                    }
                }
            }
        }
    }

    async fn tick(&self, st: &mut St, rx: &mut tmpsc::UnboundedReceiver<Cmd>) {
        /* переподключение: рестарт дискорда, сон ноутбука, сеть */
        if let Some(c) = st.conn.as_ref() {
            if !c.is_alive() {
                st.conn = None;
                self.status("disconnected");
                st.retry_at = Some(Instant::now() + st.retry_delay);
                st.retry_delay = (st.retry_delay * 2).min(Duration::from_secs(30));
            }
        }

        if st.conn.is_none() && st.wanted && st.retry_at.is_none_or(|t| Instant::now() >= t) {
            st.retry_at = None;
            self.status("connecting");
            match self.handshake().await {
                Some(c) => {
                    st.retry_delay = Duration::from_millis(1500);
                    self.status("connected");
                    st.conn = Some(c);
                }
                None => {
                    self.status("disconnected");
                    st.retry_at = Some(Instant::now() + st.retry_delay);
                    st.retry_delay = (st.retry_delay * 2).min(Duration::from_secs(30));
                }
            }
        }

        /* отправка. цикл, а не раз: пока грузилась обложка, мог прийти
           свежий payload — старый не шлём, берём новый */
        while let Some(c) = st.conn.clone() {
            if !c.is_alive() {
                st.conn = None;
                self.status("disconnected");
                st.retry_at = Some(Instant::now() + st.retry_delay);
                st.retry_delay = (st.retry_delay * 2).min(Duration::from_secs(30));
                break;
            }
            let Some(p) = st.queued.clone() else { break };
            st.queued = None;

            let key = self.asset_key(&c, &p).await;
            self.absorb(st, rx);
            if st.queued.is_some() {
                continue; /* пришёл свежий payload — этот не отправляем */
            }
            let Some(c) = st.conn.as_ref() else { break };
            let activity = build_activity(&p, key.as_deref());
            if let Err(e) = c
                .request(
                    "SET_ACTIVITY",
                    json!({ "pid": 0, "activity": activity }),
                    RPC_TIMEOUT,
                )
                .await
            {
                eprintln!("[discord] setActivity: {e}");
            }
            self.absorb(st, rx);
        }
    }

    /// подключение + handshake + ожидание READY. None — не удалось.
    async fn handshake(&self) -> Option<Conn> {
        let c = match connect() {
            Some(c) => c,
            None => {
                settings::log(
                    "[discord] handshake: ни одного канала discord-ipc-* (клиент discord запущен?)",
                );
                return None;
            }
        };
        settings::log(&format!(
            "[discord] handshake: канал найден, шлём HANDSHAKE client_id={RPC_CLIENT_ID}"
        ));
        let hello = json!({ "v": 1, "client_id": RPC_CLIENT_ID });
        if c.tx.send(Out::Frame { op: OP_HANDSHAKE, json: hello }).is_err() {
            settings::log("[discord] handshake: не отправить HANDSHAKE (поток мёртв)");
            return None;
        }

        /* Ждём именно READY: is_alive() требует и живой канал, и ready от
           читателя. pid в ответе нет (проверено), поэтому ориентир — сам
           факт READY, а не значение счётчика. */
        let deadline = Instant::now() + RPC_TIMEOUT;
        let mut waited = Duration::ZERO;
        while Instant::now() < deadline {
            if c.is_alive() {
                settings::log(&format!("[discord] handshake: READY получен за {waited:?}"));
                return Some(c);
            }
            if !c.alive.load(Ordering::Relaxed) {
                settings::log(&format!(
                    "[discord] handshake: канал закрыт через {waited:?}, READY не пришёл"
                ));
                return None;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            waited += Duration::from_millis(50);
        }
        settings::log(&format!("[discord] handshake: таймаут {RPC_TIMEOUT:?}, READY не пришёл"));
        None
    }

    /// обложка → ключ для assets.large_image.
    /// https — поддерживаемый путь, дискорд тянет её сам.
    /// Остальное приходится загружать: на любом сбое возвращаем None — это
    /// ровно то же поведение, что было до поддержки картинок (просто нет
    /// картинки).
    ///
    /// Отдельно `http://asset.localhost/…`: это то, во что мост превращает
    /// локальный путь (см. fileSrc). Такие ссылки — sc-обложки, уже скачанные
    /// в кэш на диске, и раньше они молча терялись: рендерер берёт только
    /// `https://` и `data:image`, поэтому в присутствие уходил null и картинки
    /// не было. В оригинальной electron-сборке это не проявлялось только
    /// потому, что кэш обложек там не работал и url оставался https-ссылкой.
    async fn asset_key(&self, conn: &Conn, p: &Presence) -> Option<String> {
        if p.cover_url.is_empty() {
            return None;
        }
        if p.cover_url.starts_with("https://") {
            return Some(p.cover_url.clone());
        }

        let bytes_and_mime = if p.cover_url.starts_with("data:image") {
            data_url_to_bytes(&p.cover_url)
        } else {
            asset_url_to_bytes(&p.cover_url)
        };
        let (mime, bytes) = bytes_and_mime?;
        if p.cover_key.is_empty() {
            return None;
        }

        if let Ok(cache) = self.assets.lock() {
            if let Some(k) = cache.get(&p.cover_key) {
                return Some(k.clone());
            }
            if cache.len() >= RPC_ASSET_LIMIT {
                return None;
            }
        }

        let started = conn
            .request("INITIATE_IMAGE_UPLOAD", json!({}), RPC_TIMEOUT)
            .await
            .ok()?;
        let upload_url = started.get("upload_url").and_then(Value::as_str)?;
        let remote = started.get("upload_filename").and_then(Value::as_str)?;
        let filename = format!("{}.jpg", sanitize_key(&p.cover_key));

        /* сперва сырые байты, при не-2xx — multipart (так делает
           discord-rich-presence) */
        let raw = self
            .http
            .post(upload_url)
            .header("Content-Type", &mime)
            .body(bytes.clone())
            .timeout(UPLOAD_TIMEOUT)
            .send()
            .await;
        let mut ok = matches!(raw, Ok(r) if r.status().is_success());

        if !ok {
            let form = multipart(&mime, &filename, &bytes);
            ok = matches!(
                self.http
                    .post(upload_url)
                    .header("Content-Type", format!("multipart/form-data; boundary={UPLOAD_BOUNDARY}"))
                    .body(form)
                    .timeout(UPLOAD_TIMEOUT)
                    .send()
                    .await,
                Ok(r) if r.status().is_success()
            );
        }
        if !ok {
            eprintln!("[discord] asset upload не удался");
            return None;
        }

        let key = format!("external:{remote}");
        if let Ok(mut cache) = self.assets.lock() {
            cache.insert(p.cover_key.clone(), key.clone());
        }
        Some(key)
    }
}
