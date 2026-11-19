//! Discord IPC transport and cancellable latest-state delivery.
//! Frames are [opcode: u32 LE][length: u32 LE][body].

use std::collections::{HashMap, VecDeque};
use std::future::pending;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};
use tokio::sync::{mpsc as tmpsc, oneshot};

use crate::discord_state::{Delivery, Snapshot};
pub use crate::discord_state::Presence;
use crate::{ipc_pipe, settings};

const CLIENT_ID: &str = "1501214545136586792";
const FRAME: u32 = 1;
const CLOSE: u32 = 2;
const PING: u32 = 3;
const PONG: u32 = 4;
const MAX_FRAME: usize = 8 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

static QUIET: AtomicBool = AtomicBool::new(false);
static CLOCK_READY: AtomicBool = AtomicBool::new(false);
static CLOCK: Mutex<Option<(Instant, i64)>> = Mutex::new(None);

pub fn is_quiet() -> bool { QUIET.load(Ordering::SeqCst) }
pub fn clock_ready() { CLOCK_READY.store(true, Ordering::Release); }
pub fn set_clock_offset_ms(offset: i64) {
    if let Ok(mut clock) = CLOCK.lock() { *clock = Some((Instant::now(), local_ms().saturating_sub(offset))); }
}
fn local_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|v| v.as_millis().min(i64::MAX as u128) as i64).unwrap_or(0)
}
fn true_ms() -> i64 {
    CLOCK.lock().ok().and_then(|clock| clock.map(|(at, value)| {
        value.saturating_add(at.elapsed().as_millis().min(i64::MAX as u128) as i64)
    })).unwrap_or_else(local_ms)
}

pub enum Cmd { SetEnabled(bool), Update(Box<Presence>), Clear }

#[derive(Clone, Debug)]
enum RpcError { Transport(String), Discord(i64, String) }
impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(message) => write!(f, "{message}"),
            Self::Discord(code, message) => write!(f, "discord {code}: {message}"),
        }
    }
}

type Waiters = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, RpcError>>>>>;
struct Out { opcode: u32, body: Vec<u8> }

struct Session {
    tx: mpsc::Sender<Out>,
    alive: Arc<AtomicBool>,
    ready: Arc<AtomicBool>,
    fatal: Arc<Mutex<Option<RpcError>>>,
    waiters: Waiters,
    done: Mutex<Option<oneshot::Receiver<()>>>,
}
impl Drop for Session {
    fn drop(&mut self) { self.alive.store(false, Ordering::Release); }
}

#[derive(Clone)]
struct Conn(Arc<Session>);

// Cancellation and timeout both remove the waiter, even if the future is dropped.
struct RequestGuard { nonce: String, waiters: Waiters }
impl Drop for RequestGuard {
    fn drop(&mut self) {
        if let Ok(mut waiters) = self.waiters.lock() { waiters.remove(&self.nonce); }
    }
}

fn frame(opcode: u32, body: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(8 + body.len());
    bytes.extend_from_slice(&opcode.to_le_bytes());
    bytes.extend_from_slice(&(body.len() as u32).to_le_bytes());
    bytes.extend_from_slice(body);
    bytes
}

fn fail_waiters(waiters: &Waiters, error: RpcError) {
    if let Ok(mut waiters) = waiters.lock() {
        for (_, tx) in waiters.drain() { let _ = tx.send(Err(error.clone())); }
    }
}

fn transport(
    pipe: ipc_pipe::Pipe, rx: mpsc::Receiver<Out>, alive: Arc<AtomicBool>,
    ready: Arc<AtomicBool>, fatal: Arc<Mutex<Option<RpcError>>>, waiters: Waiters,
) -> Result<(), RpcError> {
    let io = |e: std::io::Error| RpcError::Transport(e.to_string());
    let mut buffer = Vec::new();
    let mut last_write = Instant::now();
    while alive.load(Ordering::Acquire) {
        // A single thread owns the pipe. Reading cannot lock out a writer.
        for _ in 0..32 {
            match rx.try_recv() {
                Ok(out) => {
                    pipe.write_all(&frame(out.opcode, &out.body)).map_err(io)?;
                    last_write = Instant::now();
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
            }
        }
        let available = pipe.available().map_err(io)? as usize;
        if available > 0 {
            let count = available.min(64 * 1024);
            let old = buffer.len();
            if old.saturating_add(count) > MAX_FRAME + 8 {
                return Err(RpcError::Transport("слишком большой IPC-кадр".into()));
            }
            buffer.resize(old + count, 0);
            pipe.read_exact(&mut buffer[old..]).map_err(io)?;
        }
        let mut consumed = 0;
        while buffer.len() - consumed >= 8 {
            let head = &buffer[consumed..consumed + 8];
            let opcode = u32::from_le_bytes(head[..4].try_into().unwrap());
            let length = u32::from_le_bytes(head[4..].try_into().unwrap()) as usize;
            if length > MAX_FRAME { return Err(RpcError::Transport("невалидная длина IPC-кадра".into())); }
            if buffer.len() - consumed < length + 8 { break; }
            let body = &buffer[consumed + 8..consumed + 8 + length];
            match opcode {
                PING => {
                    // IPC pong must echo the entire payload, not just a nonce.
                    pipe.write_all(&frame(PONG, body)).map_err(io)?;
                    last_write = Instant::now();
                }
                PONG => {},
                CLOSE => {
                    let value: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
                    let code = value["code"].as_i64().unwrap_or(0);
                    let error = RpcError::Discord(code, value["message"].as_str().unwrap_or("канал закрыт").into());
                    if matches!(code, 4000 | 4001) {
                        if let Ok(mut slot) = fatal.lock() { *slot = Some(error.clone()); }
                    }
                    return Err(error);
                }
                FRAME => {
                    let packet: Value = serde_json::from_slice(body)
                        .map_err(|e| RpcError::Transport(format!("IPC JSON: {e}")))?;
                    if packet["evt"] == "READY" { ready.store(true, Ordering::Release); }
                    if let Some(nonce) = packet["nonce"].as_str() {
                        let tx = waiters.lock().ok().and_then(|mut w| w.remove(nonce));
                        if let Some(tx) = tx {
                            let result = if packet["evt"] == "ERROR" {
                                Err(RpcError::Discord(packet["data"]["code"].as_i64().unwrap_or(0),
                                    packet["data"]["message"].as_str().unwrap_or("без описания").into()))
                            } else { Ok(packet["data"].clone()) };
                            let _ = tx.send(result);
                        }
                    }
                }
                _ => return Err(RpcError::Transport(format!("неизвестный IPC opcode {opcode}"))),
            }
            consumed += length + 8;
        }
        if consumed > 0 { buffer.drain(..consumed); }
        if last_write.elapsed() >= Duration::from_secs(5) {
            pipe.write_all(&frame(PING, b"{}")).map_err(io)?;
            last_write = Instant::now();
        }
        ipc_pipe::pause();
    }
    Ok(())
}

impl Conn {
    fn open() -> Result<Self, RpcError> {
        let pipe = ipc_pipe::first_available().map_err(|e| RpcError::Transport(e.to_string()))?;
        let (tx, rx) = mpsc::channel();
        let (done_tx, done_rx) = oneshot::channel();
        let session = Arc::new(Session {
            tx, alive: Arc::new(AtomicBool::new(true)), ready: Arc::new(AtomicBool::new(false)),
            fatal: Arc::new(Mutex::new(None)), waiters: Arc::new(Mutex::new(HashMap::new())),
            done: Mutex::new(Some(done_rx)),
        });
        let alive = session.alive.clone();
        let ready = session.ready.clone();
        let fatal = session.fatal.clone();
        let waiters = session.waiters.clone();
        std::thread::Builder::new().name("discord-ipc".into()).spawn(move || {
            let result = transport(pipe, rx, alive.clone(), ready, fatal, waiters.clone());
            alive.store(false, Ordering::Release);
            fail_waiters(&waiters, result.err().unwrap_or_else(|| RpcError::Transport("канал закрыт".into())));
            let _ = done_tx.send(());
        }).map_err(|e| RpcError::Transport(e.to_string()))?;
        Ok(Self(session))
    }

    fn alive(&self) -> bool {
        self.0.alive.load(Ordering::Acquire) && self.0.ready.load(Ordering::Acquire)
    }

    async fn handshake() -> Result<Self, RpcError> {
        let conn = Self::open()?;
        conn.0.tx.send(Out { opcode: 0, body: serde_json::to_vec(&json!({ "v": 1, "client_id": CLIENT_ID })).unwrap() })
            .map_err(|_| RpcError::Transport("IPC-писатель закрыт".into()))?;
        let result = tokio::time::timeout(REQUEST_TIMEOUT, async {
            loop {
                if conn.alive() { return Ok(()); }
                if !conn.0.alive.load(Ordering::Acquire) {
                    return Err(conn.0.fatal.lock().ok().and_then(|v| v.clone())
                        .unwrap_or_else(|| RpcError::Transport("Discord закрыл handshake".into())));
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }).await.unwrap_or_else(|_| Err(RpcError::Transport("таймаут READY".into())));
        match result {
            Ok(()) => Ok(conn),
            Err(error) => { conn.shutdown().await; Err(error) }
        }
    }

    async fn request(&self, command: &str, args: Value, timeout: Duration) -> Result<Value, RpcError> {
        if !self.alive() { return Err(RpcError::Transport("IPC-соединение закрыто".into())); }
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let nonce = format!("{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.0.waiters.lock().map_err(|_| RpcError::Transport("waiters poisoned".into()))?.insert(nonce.clone(), tx);
        let _guard = RequestGuard { nonce: nonce.clone(), waiters: self.0.waiters.clone() };
        let body = serde_json::to_vec(&json!({ "cmd": command, "args": args, "nonce": nonce }))
            .map_err(|e| RpcError::Transport(e.to_string()))?;
        self.0.tx.send(Out { opcode: FRAME, body }).map_err(|_| RpcError::Transport("IPC-писатель закрыт".into()))?;
        tokio::time::timeout(timeout, rx).await
            .map_err(|_| RpcError::Transport(format!("{command}: таймаут")))?
            .map_err(|_| RpcError::Transport("IPC-читатель закрыт".into()))?
    }

    async fn set_activity(&self, activity: Value, timeout: Duration) -> Result<(), RpcError> {
        let reply = self.request("SET_ACTIVITY", json!({ "pid": std::process::id(), "activity": activity }), timeout).await?;
        if reply.is_object() {
            let accepted = reply.get("activity").unwrap_or(&reply);
            for field in ["timestamps", "assets"] {
                if activity.get(field).is_some() && accepted.get(field).is_none_or(|v| v.is_null() || v == &json!({})) {
                    settings::log(&format!("[discord] SET_ACTIVITY принят без {field}"));
                }
            }
        }
        Ok(())
    }

    async fn shutdown(self) {
        self.0.alive.store(false, Ordering::Release);
        let done = self.0.done.lock().ok().and_then(|mut v| v.take());
        if let Some(done) = done { let _ = tokio::time::timeout(Duration::from_millis(1200), done).await; }
    }
}

// Jobs are polled alongside commands. Dropping one aborts it, including HTTP
// uploads and nonce waiters; old track work cannot block a pause/clear.
struct Job<T>(tokio::task::JoinHandle<T>);
impl<T> Drop for Job<T> { fn drop(&mut self) { self.0.abort(); } }
async fn job<T>(slot: &mut Option<Job<T>>) -> Result<T, tokio::task::JoinError> {
    match slot { Some(job) => (&mut job.0).await, None => pending().await }
}

#[derive(Default)]
struct Assets { map: HashMap<String, String>, order: VecDeque<String> }
impl Assets {
    fn put(&mut self, source: String, image: String) {
        if self.map.insert(source.clone(), image).is_none() { self.order.push_back(source); }
        while self.order.len() > 200 {
            if let Some(old) = self.order.pop_front() { self.map.remove(&old); }
        }
    }
}

fn image_bytes(source: &str) -> Option<(String, Vec<u8>)> {
    if source.starts_with("data:image/") {
        let (head, bytes) = source.split_once(',')?;
        if !head.ends_with(";base64") { return None; }
        let mime = head.strip_prefix("data:")?.split(';').next()?.to_string();
        let bytes: String = bytes.chars().filter(|c| !c.is_whitespace()).collect();
        let bytes = B64.decode(bytes).ok()?;
        return (!bytes.is_empty() && bytes.len() <= MAX_FRAME).then_some((mime, bytes));
    }
    let url = url::Url::parse(source).ok()?;
    if url.host_str()? != "asset.localhost" { return None; }
    let encoded = url.path().trim_start_matches('/');
    let mut path = Vec::new();
    let bytes = encoded.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' && at + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[at + 1..at + 3]).ok()?;
            path.push(u8::from_str_radix(hex, 16).ok()?);
            at += 3;
        } else { path.push(bytes[at]); at += 1; }
    }
    let path = String::from_utf8(path).ok()?;
    if !std::path::Path::new(&path).is_absolute() { return None; }
    if std::fs::metadata(&path).ok()?.len() > MAX_FRAME as u64 { return None; }
    let mime = if path.to_ascii_lowercase().ends_with(".png") { "image/png" } else { "image/jpeg" };
    let bytes = std::fs::read(path).ok()?;
    (!bytes.is_empty()).then_some((mime.into(), bytes))
}

#[derive(Clone)]
struct Rpc { on_status: Arc<dyn Fn(&str) + Send + Sync>, http: reqwest::Client, assets: Arc<Mutex<Assets>> }

impl Rpc {
    async fn upload(&self, conn: Conn, source: String) -> Option<String> {
        let read_source = source.clone();
        let Some((mime, bytes)) = tokio::task::spawn_blocking(move || image_bytes(&read_source)).await.ok().flatten() else {
            settings::log("[discord] не удалось прочитать обложку для загрузки");
            return None;
        };
        let started = match conn.request("INITIATE_IMAGE_UPLOAD", json!({}), REQUEST_TIMEOUT).await {
            Ok(value) => value,
            Err(error) => { settings::log(&format!("[discord] INITIATE_IMAGE_UPLOAD: {error}")); return None; }
        };
        let (Some(upload_url), Some(filename)) = (started["upload_url"].as_str(), started["upload_filename"].as_str()) else {
            settings::log("[discord] INITIATE_IMAGE_UPLOAD не вернул адрес и имя файла");
            return None;
        };
        if !upload_url.starts_with("https://") { return None; }
        let ok = self.http.post(upload_url).header("Content-Type", &mime).body(bytes.clone())
            .timeout(Duration::from_secs(15)).send().await.is_ok_and(|r| r.status().is_success());
        if !ok {
            const BOUNDARY: &str = "seWerUploadBoundary";
            let mut form = format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"payload_json\"\r\n\r\n{{\"name\":\"seWer-cover\"}}\r\n--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"cover.jpg\"\r\nContent-Type: {mime}\r\n\r\n").into_bytes();
            form.extend_from_slice(&bytes);
            form.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
            if !self.http.post(upload_url).header("Content-Type", format!("multipart/form-data; boundary={BOUNDARY}"))
                .body(form).timeout(Duration::from_secs(15)).send().await.is_ok_and(|r| r.status().is_success()) {
                settings::log("[discord] обложка не загрузилась; presence отправлен без неё");
                return None;
            }
        }
        let image = format!("external:{filename}");
        if let Ok(mut assets) = self.assets.lock() { assets.put(source, image.clone()); }
        settings::log("[discord] обложка загружена");
        Some(image)
    }

    fn image(&self, snapshot: Option<&Snapshot>) -> Option<String> {
        let source = &snapshot?.presence.cover_url;
        if source.starts_with("https://") && url::Url::parse(source).ok()?.host_str() != Some("asset.localhost") {
            return Some(source.clone());
        }
        self.assets.lock().ok()?.map.get(source).cloned()
    }

    async fn run(self, rx: tmpsc::UnboundedReceiver<Cmd>) {
        self.run_with_connector(rx, Arc::new(|| Box::pin(Conn::handshake()))).await;
    }

    async fn run_with_connector(self, mut rx: tmpsc::UnboundedReceiver<Cmd>,
        connector: Arc<dyn Fn() -> futures_util::future::BoxFuture<'static, Result<Conn, RpcError>> + Send + Sync>) {
        let mut delivery = Delivery::default();
        let mut conn: Option<Conn> = None;
        let mut connecting: Option<Job<Result<Conn, RpcError>>> = None;
        let mut sending: Option<Job<(u64, Value, Result<(), RpcError>)>> = None;
        let mut uploading: Option<Job<(String, Option<String>)>> = None;
        let mut upload_source = String::new();
        let mut upload_failed: Option<(String, Instant)> = None;
        let mut reconnect_at = Instant::now();
        let mut reconnect_delay = Duration::from_millis(1500);
        let mut fatal = false;
        let mut status = String::new();
        loop {
            let tick = if delivery.enabled { Duration::from_millis(100) } else { Duration::from_secs(30) };
            tokio::select! {
                biased;
                command = rx.recv() => {
                    let Some(command) = command else { break; };
                    let mut commands = vec![command];
                    while let Ok(command) = rx.try_recv() { commands.push(command); }
                    for command in commands {
                        match command {
                            Cmd::Update(p) => {
                                let critical = delivery.current.as_ref().is_none_or(|s| {
                                    s.presence.is_playing != p.is_playing || s.presence.cover_key != p.cover_key
                                });
                                if critical { sending = None; }
                                delivery.update(*p, local_ms(), Instant::now());
                            }
                            Cmd::Clear => {
                                delivery.clear();
                                sending = None;
                                delivery.send_at = None;
                            }
                            Cmd::SetEnabled(on) => {
                                if on != delivery.enabled {
                                    fatal = false;
                                    reconnect_at = Instant::now();
                                    reconnect_delay = Duration::from_millis(1500);
                                }
                                delivery.enable(on);
                                if !on {
                                    sending = None;
                                    delivery.send_at = None;
                                } else { QUIET.store(false, Ordering::SeqCst); }
                            }
                        }
                    }
                }
                result = job(&mut connecting) => {
                    connecting = None;
                    match result {
                        Ok(Ok(connected)) => {
                            conn = Some(connected);
                            reconnect_delay = Duration::from_millis(1500);
                            delivery.reconnect();
                        }
                        result => {
                            let error = match result {
                                Ok(Err(error)) => error,
                                Err(error) => RpcError::Transport(error.to_string()),
                                _ => unreachable!(),
                            };
                            settings::log(&format!("[discord] подключение: {error}"));
                            fatal = matches!(error, RpcError::Discord(4000 | 4001, _));
                            reconnect_at = Instant::now() + reconnect_delay;
                            reconnect_delay = (reconnect_delay * 2).min(Duration::from_secs(30));
                        }
                    }
                }
                result = job(&mut uploading) => {
                    uploading = None;
                    if let Ok((source, image)) = result {
                        if image.is_some() { delivery.invalidate(); }
                        else { upload_failed = Some((source, Instant::now())); }
                    } else { upload_failed = Some((upload_source.clone(), Instant::now())); }
                }
                result = job(&mut sending) => {
                    sending = None;
                    match result {
                        Ok((revision, activity, Ok(()))) => delivery.acknowledge(revision, activity, Instant::now()),
                        Ok((_, _, Err(RpcError::Discord(4003, message)))) => {
                            settings::log(&format!("[discord] rate limit: {message}"));
                            delivery.send_at = Some(Instant::now() + Duration::from_secs(15));
                        }
                        Ok((revision, _, Err(RpcError::Discord(code, message)))) => {
                            settings::log(&format!("[discord] presence отклонён: {code} {message}"));
                            // Invalid payloads are not retried unchanged forever.
                            if delivery.revision == revision { delivery.dirty = false; }
                            delivery.send_at = Some(Instant::now() + Duration::from_secs(5));
                        }
                        result => {
                            settings::log(&format!("[discord] потеря IPC: {result:?}"));
                            if let Some(old) = conn.take() { old.shutdown().await; }
                            uploading = None;
                            if let Ok(mut assets) = self.assets.lock() { *assets = Assets::default(); }
                            upload_failed = None;
                            delivery.reconnect();
                            reconnect_at = Instant::now() + reconnect_delay;
                        }
                    }
                }
                _ = tokio::time::sleep(tick) => {},
            }

            let now = Instant::now();
            if !delivery.enabled {
                connecting = None;
                uploading = None;
                if let Some(old) = conn.take() {
                    let _ = old.set_activity(Value::Null, Duration::from_millis(800)).await;
                    old.shutdown().await;
                }
                if let Ok(mut assets) = self.assets.lock() { *assets = Assets::default(); }
                upload_failed = None;
                delivery.reconnect();
                delivery.dirty = false;
                QUIET.store(true, Ordering::SeqCst);
            } else {
                if conn.as_ref().is_some_and(|c| !c.alive()) {
                    if let Some(old) = conn.take() {
                        fatal = old.0.fatal.lock().ok().is_some_and(|v| v.is_some());
                        old.shutdown().await;
                    }
                    sending = None;
                    uploading = None;
                    if let Ok(mut assets) = self.assets.lock() { *assets = Assets::default(); }
                    upload_failed = None;
                    delivery.reconnect();
                    reconnect_at = now + reconnect_delay;
                }
                if conn.is_none() && connecting.is_none() && !fatal && now >= reconnect_at {
                    connecting = Some(Job(tokio::spawn(connector())));
                }
                if let Some(connected) = &conn {
                    let source = delivery.current.as_ref().map(|s| s.presence.cover_url.as_str()).unwrap_or("");
                    if source != upload_source { uploading = None; upload_source = source.into(); }
                    let image = self.image(delivery.current.as_ref());
                    let retry_image = upload_failed.as_ref().is_none_or(|(failed, at)| failed != source || at.elapsed() >= Duration::from_secs(60));
                    if image.is_none() && !source.is_empty() && uploading.is_none() && retry_image {
                        let rpc = self.clone();
                        let conn = connected.clone();
                        let source = source.to_string();
                        uploading = Some(Job(tokio::spawn(async move {
                            let image = rpc.upload(conn, source.clone()).await;
                            (source, image)
                        })));
                    }
                    if sending.is_none() && delivery.due(now)
                        && (delivery.current.is_none() || CLOCK_READY.load(Ordering::Acquire)) {
                        let activity = delivery.activity(image.as_deref(), true_ms(), now);
                        if delivery.sent.as_ref() == Some(&activity) { delivery.dirty = false; }
                        else {
                            let revision = delivery.revision;
                            if let Some(snapshot) = &delivery.current {
                                settings::log(&format!("[discord] activity: play={} pos={:.3} dur={:.3} ts={} start={} end={} img={}",
                                    snapshot.presence.is_playing, snapshot.presence.position.unwrap_or(0.0), snapshot.presence.duration,
                                    snapshot.presence.timestamp, activity["timestamps"]["start"], activity["timestamps"]["end"], image.is_some()));
                            }
                            let conn = connected.clone();
                            sending = Some(Job(tokio::spawn(async move {
                                let result = conn.set_activity(activity.clone(), REQUEST_TIMEOUT).await;
                                (revision, activity, result)
                            })));
                        }
                    }
                }
            }
            let next_status = if !delivery.enabled { "off" } else if fatal { "error" }
                else if conn.is_some() { "connected" } else if connecting.is_some() { "connecting" }
                else { "disconnected" };
            if status != next_status {
                status = next_status.into();
                settings::log(&format!("[discord] статус: {status}"));
                (self.on_status)(&status);
            }
        }
        drop(connecting);
        drop(uploading);
        drop(sending);
        if let Some(conn) = conn {
            let _ = conn.set_activity(Value::Null, Duration::from_millis(800)).await;
            conn.shutdown().await;
        }
        QUIET.store(true, Ordering::SeqCst);
    }
}

pub async fn run(http: reqwest::Client, on_status: impl Fn(&str) + Send + Sync + 'static, rx: tmpsc::UnboundedReceiver<Cmd>) {
    let rpc = Rpc { on_status: Arc::new(on_status), http, assets: Arc::new(Mutex::new(Assets::default())) };
    rpc.run(rx).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_connection() -> (Conn, mpsc::Receiver<Out>) {
        let (tx, rx) = mpsc::channel();
        (Conn(Arc::new(Session {
            tx, alive: Arc::new(AtomicBool::new(true)), ready: Arc::new(AtomicBool::new(true)),
            fatal: Arc::new(Mutex::new(None)), waiters: Arc::new(Mutex::new(HashMap::new())),
            done: Mutex::new(None),
        })), rx)
    }

    fn harness(connections: Vec<Conn>) -> (tmpsc::UnboundedSender<Cmd>, tokio::task::JoinHandle<()>) {
        clock_ready();
        let (tx, rx) = tmpsc::unbounded_channel();
        let queue = Arc::new(Mutex::new(VecDeque::from(connections)));
        let connector = Arc::new(move || {
            let result = queue.lock().unwrap().pop_front()
                .ok_or_else(|| RpcError::Transport("fake server unavailable".into()));
            Box::pin(async move { result }) as futures_util::future::BoxFuture<'static, Result<Conn, RpcError>>
        });
        let rpc = Rpc { on_status: Arc::new(|_| {}), http: reqwest::Client::new(), assets: Arc::new(Mutex::new(Assets::default())) };
        (tx, tokio::spawn(rpc.run_with_connector(rx, connector)))
    }

    fn track(playing: bool) -> Cmd {
        Cmd::Update(Box::new(Presence {
            title: "Song".into(), artist: "Artist".into(), cover_key: "one".into(),
            duration: 200.0, position: Some(20.0), sampled_at_ms: local_ms() as f64,
            timestamp: "progress".into(), is_playing: playing, ..Default::default()
        }))
    }

    async fn next_request(rx: &mpsc::Receiver<Out>) -> Value {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Ok(out) = rx.try_recv() { return serde_json::from_slice(&out.body).unwrap(); }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("RPC request did not arrive")
    }

    fn answer(conn: &Conn, packet: &Value, result: Result<Value, RpcError>) {
        if let Some(tx) = conn.0.waiters.lock().unwrap().remove(packet["nonce"].as_str().unwrap()) {
            let _ = tx.send(result);
        }
    }

    #[tokio::test]
    async fn pause_and_clear_overtake_a_pending_old_reply() {
        let (conn, outgoing) = fake_connection();
        let (tx, task) = harness(vec![conn.clone()]);
        tx.send(Cmd::SetEnabled(true)).unwrap();
        tx.send(track(true)).unwrap();
        let old = next_request(&outgoing).await;
        assert!(old["args"]["activity"].get("timestamps").is_some());
        // Deliberately leave the old request unanswered.
        tx.send(track(false)).unwrap();
        let paused = next_request(&outgoing).await;
        assert!(paused["args"]["activity"]["state"].as_str().unwrap().starts_with("Paused"));
        assert!(paused["args"]["activity"].get("timestamps").is_none());
        tx.send(Cmd::Clear).unwrap();
        let cleared = next_request(&outgoing).await;
        assert!(cleared["args"]["activity"].is_null());
        answer(&conn, &old, Ok(Value::Null));
        answer(&conn, &paused, Ok(Value::Null));
        answer(&conn, &cleared, Ok(Value::Null));
        task.abort();
    }

    #[tokio::test]
    async fn a_pending_cover_does_not_block_presence_or_clear() {
        let (conn, outgoing) = fake_connection();
        let (tx, task) = harness(vec![conn.clone()]);
        tx.send(Cmd::SetEnabled(true)).unwrap();
        let Cmd::Update(mut p) = track(true) else { unreachable!() };
        p.cover_url = format!("data:image/jpeg;base64,{}", B64.encode(b"image"));
        tx.send(Cmd::Update(p)).unwrap();
        let first = next_request(&outgoing).await;
        let second = next_request(&outgoing).await;
        let (activity, upload) = if first["cmd"] == "SET_ACTIVITY" { (first, second) } else { (second, first) };
        assert_eq!(upload["cmd"], "INITIATE_IMAGE_UPLOAD");
        assert_eq!(activity["args"]["activity"]["details"], "Song");
        answer(&conn, &activity, Ok(Value::Null));
        // INITIATE_IMAGE_UPLOAD still has no response.
        tx.send(Cmd::Clear).unwrap();
        let cleared = next_request(&outgoing).await;
        assert!(cleared["args"]["activity"].is_null());
        answer(&conn, &cleared, Ok(Value::Null));
        assert!(!conn.0.waiters.lock().unwrap().contains_key(upload["nonce"].as_str().unwrap()));
        task.abort();
    }

    #[tokio::test]
    async fn idle_disconnect_republishes_the_latest_track_without_a_new_command() {
        let (first, first_out) = fake_connection();
        let (second, second_out) = fake_connection();
        let (tx, task) = harness(vec![first.clone(), second.clone()]);
        tx.send(Cmd::SetEnabled(true)).unwrap();
        tx.send(track(true)).unwrap();
        let sent = next_request(&first_out).await;
        answer(&first, &sent, Ok(Value::Null));
        first.0.alive.store(false, Ordering::Release);
        let replayed = next_request(&second_out).await;
        assert_eq!(sent["args"]["activity"]["details"], replayed["args"]["activity"]["details"]);
        assert_eq!(sent["args"]["activity"]["timestamps"], replayed["args"]["activity"]["timestamps"]);
        answer(&second, &replayed, Ok(Value::Null));
        task.abort();
    }

    #[tokio::test]
    async fn rate_limit_is_not_retried_on_every_tick_or_update() {
        let (conn, outgoing) = fake_connection();
        let (tx, task) = harness(vec![conn.clone()]);
        tx.send(Cmd::SetEnabled(true)).unwrap();
        tx.send(track(true)).unwrap();
        let sent = next_request(&outgoing).await;
        answer(&conn, &sent, Err(RpcError::Discord(4003, "rate limited".into())));
        tokio::time::sleep(Duration::from_millis(30)).await;
        tx.send(track(true)).unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(200), next_request(&outgoing)).await.is_err());
        task.abort();
    }

    #[test]
    fn ipc_frame_has_separate_opcode_and_length() {
        let bytes = frame(FRAME, br#"{"cmd":"SET_ACTIVITY"}"#);
        assert_eq!(&bytes[..4], &1u32.to_le_bytes());
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize, bytes.len() - 8);
        assert_eq!(bytes[8], b'{');
        assert_eq!(frame(PONG, b""), [4, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn request_cancellation_removes_nonce() {
        let waiters: Waiters = Arc::new(Mutex::new(HashMap::new()));
        let (tx, _) = oneshot::channel();
        waiters.lock().unwrap().insert("test".into(), tx);
        drop(RequestGuard { nonce: "test".into(), waiters: waiters.clone() });
        assert!(waiters.lock().unwrap().is_empty());
    }

    #[test]
    fn data_image_and_bounded_cache() {
        let source = format!("data:image/jpeg;base64,{}", B64.encode(b"image"));
        assert_eq!(image_bytes(&source).unwrap().1, b"image");
        assert!(image_bytes("http://example.com/image.jpg").is_none());
        let mut cache = Assets::default();
        for i in 0..250 { cache.put(i.to_string(), format!("external:{i}")); }
        assert_eq!(cache.map.len(), 200);
        assert!(!cache.map.contains_key("0"));
        assert!(cache.map.contains_key("249"));
    }

    #[test]
    fn an_asset_url_is_read_locally_not_sent_to_discord_as_https() {
        let path = std::env::temp_dir().join(format!("sewer-rpc-cover-{}-{}.png", std::process::id(), local_ms()));
        std::fs::write(&path, b"image").unwrap();
        let encoded: String = url::form_urlencoded::byte_serialize(path.to_string_lossy().as_bytes()).collect();
        for scheme in ["http", "https"] {
            let source = format!("{scheme}://asset.localhost/{encoded}");
            assert_eq!(image_bytes(&source), Some(("image/png".into(), b"image".to_vec())));
            let rpc = Rpc { on_status: Arc::new(|_| {}), http: reqwest::Client::new(), assets: Arc::new(Mutex::new(Assets::default())) };
            let snapshot = Snapshot::new(Presence { cover_url: source.clone(), ..Default::default() }, 0, Instant::now());
            assert!(rpc.image(Some(&snapshot)).is_none());
            rpc.assets.lock().unwrap().put(source, "external:uploaded".into());
            assert_eq!(rpc.image(Some(&snapshot)).as_deref(), Some("external:uploaded"));
        }
        std::fs::remove_file(path).unwrap();
    }
}
