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
//!
//! Формат кадра проверен разговором с живым `\\.\pipe\discord-ipc-0`, а не
//! чтением документации: тело кадра `op=1` — это ТОЛЬКО json, байта опкода
//! внутри нет, и `len` равен размеру тела. Если положить байт op в тело,
//! дискорд отвечает `{"code":1003,"message":"Unexpected token ''"}`. Ответы
//! приходят в том же формате, а тело `op=2` (CLOSE) — json
//! `{"code":N,"message":"…"}`, а не бинарный код с текстом. Полный разбор
//! с проверками — в docs/discord-rpc-audit.md.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use futures_util::FutureExt;
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
/// Третья строка карточки на паузе. Дискорд не знает про «paused» — у него
/// есть только `name`/`details`/`state` и таймер, — поэтому слово «пауза»
/// приходится выражать полем `state`. Проверено на живом канале: `state`
/// возвращается дискордом как есть, тогда как пустой `details` даёт ошибку
/// 4000. Английский, потому что это публичная строка в чужом клиенте.
const PAUSED_LABEL: &str = "Paused";

/* Обложек на приложение дискорд держит «up to 300» и обратно не отдаёт.
   Потолок держим заметно ниже и вытесняем по порядку: раньше код на 250
   просто переставал грузить обложки, молча и до конца сессии. */
const RPC_ASSET_LIMIT: usize = 200;

const OP_HANDSHAKE: u32 = 0;
const OP_FRAME: u32 = 1;
const OP_CLOSE: u32 = 2;
const OP_PING: u32 = 3;
const OP_PONG: u32 = 4;

const KEEPALIVE: Duration = Duration::from_secs(5);
const RPC_TIMEOUT: Duration = Duration::from_secs(8);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(15);
const UPLOAD_BOUNDARY: &str = "seWerUploadBoundary";

/* «Не чаще раза в …». Дискорд душит слишком частые SET_ACTIVITY, а код
   ошибки раньше игнорировался, поэтому превышение выглядело как «присутствие
   замерло» без единого следа в логе. Фронт дебаунсит 800 мс, но и это
   ~25 обновлений за 20 с. Смена play/pause мимо этого ограничения идёт
   (см. Rpc::tick) — это как раз тот переход, который обязан быть виден
   сразу, и он же единственный, где пауза и игра различаются словом. */
const ACTIVITY_MIN_GAP: Duration = Duration::from_millis(1000);

/* Границы ожидания в цикле run(): сверху — чтобы состояние соединения
   подхватывалось, даже когда команд нет; снизу — чтобы не крутить select{}
   вхолостую.

   IDLE_TICK — это период опроса pipe читателем. На живой канале дискорд
   молчит полностью: 40 с тишины не дали ни одного PING, так что клиентский
   keepalive и есть единственное, что держит соединение. Но читателю нужно
   просыпаться часто, потому что заблокированный на 30 с poll означал бы, что
   PONG на серверный PING уйдёт с получасовой задержкой — а дискорд считает
   соединение мёртвым намного раньше. 250 мс: писатель всё равно будит себя
   через recv_timeout с тем же периодом, то есть холостой работы нет. */
const IDLE_TICK: Duration = Duration::from_millis(250);
const MIN_TICK: Duration = Duration::from_millis(50);

/* В состоянии «дискорд отказал» ждать нечего: переподключение прекращено,
   и единственный способ продолжить — тумблер в настройках (он приходит
   отдельной командой и разбудит цикл). Поэтому опрос тут медленный, а не
   IDLE_TICK: иначе select! будился бы 4 раза в секунду вхолостую до конца
   работы приложения. */
const FATAL_TICK: Duration = Duration::from_secs(30);

/* Сколько ждём выхода потоков, прежде чем считать соединение закрытым.
   Читатель просыпается за 15 мс, писатель — за 250 мс (recv_timeout), так
   что это с запасом. Ждать именно обязательно: следующий connect() обязан
   увидеть канал свободным, иначе CreateFileW вернёт ERROR_PIPE_BUSY на
   канал, занятый нашими же потоками (см. Conn::shutdown). */
const SHUTDOWN_WAIT: Duration = Duration::from_millis(1200);

const MAX_FRAME: usize = 8 * 1024 * 1024;

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

// ── транспорт ─────────────────────────────────────────────────────────────

struct Out {
    op: u32,
    json: Value,
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

/// Сигнал «оба потока соединения вышли». Через него Conn::shutdown понимает,
/// что дескриптор уже закрыт: пока потоки живы, канал держит он, а дискорд
/// держит на канал ровно одного клиента.
struct Threads {
    alive: Arc<AtomicBool>,
    /// в Option, потому что Receiver одноразовый, а shutdown звать можно
    /// больше одного раза (сброс соединения + выключение)
    done: std::sync::Mutex<Option<oneshot::Receiver<()>>>,
}

/// Гасится при выходе потока. Последний из двух шлёт сигнал. Раньше выход
/// каждого потока просто стучал `alive = false`, и `Conn` при отбрасывании
/// отпускал только свою ссылку на дескриптор — потоки продолжали крутить
/// цикл и держать канал занятым навсегда.
#[derive(Clone)]
struct ExitGuard {
    left: Arc<AtomicUsize>,
    done: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

impl ExitGuard {
    fn new() -> (Self, Arc<Mutex<Option<oneshot::Sender<()>>>>) {
        let done = Arc::new(Mutex::new(None));
        (
            Self {
                left: Arc::new(AtomicUsize::new(2)),
                done: done.clone(),
            },
            done,
        )
    }
}

impl Drop for ExitGuard {
    fn drop(&mut self) {
        if self.left.fetch_sub(1, Ordering::AcqRel) == 1 {
            if let Ok(mut g) = self.done.lock() {
                if let Some(tx) = g.take() {
                    let _ = tx.send(());
                }
            }
        }
    }
}

/// живое соединение с discord.
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
    /// причина, по которой переподключение бессмысленно (см. reader_loop).
    /// Живёт в соединении, а не в Rpc: при снятии соединения он должен
    /// пережить его, иначе «дискорд не пускает» выглядело бы как обычное
    /// «переподключается» — то есть ровно то, от чего этот код и нужен.
    fatal: Arc<Mutex<Option<String>>>,
    threads: Arc<Threads>,
}

/// Кадр: `[op: u32 LE][len: u32 LE][json]` — и json БЕЗ байта op внутри.
///
/// Проверено прямым разговором с каналом discord: если положить байт op в
/// тело, сервер отвечает кодом 1003. Раньше именно так и было. Пишем одним
/// write_all, чтобы кадр не мог порваться между двумя вызовами.
fn write_frame(write: &Mutex<Pipe>, op: u32, payload: &Value) -> bool {
    let body = serde_json::to_vec(payload).unwrap_or_default();
    let mut frame = Vec::with_capacity(8 + body.len());
    frame.extend_from_slice(&op.to_le_bytes());
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

/// Гасит всех, кто ждёт ответа, иначе `request()` висит по своему таймауту
/// (8 с) на каждом вызове после обрыва. Отдаём ответ в форме ошибки
/// дискорда, чтобы `request()` вернул Err по единому пути.
fn fail_pending(pending: &Pending, why: &str) {
    let Ok(mut p) = pending.lock() else { return };
    let waiters: Vec<_> = p.drain().map(|(_, tx)| tx).collect();
    drop(p);
    for w in waiters {
        let _ = w.send(json!({
            "cmd": "LOCAL",
            "evt": "ERROR",
            "data": { "code": -1, "message": why }
        }));
    }
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
    let fatal: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let shared = Arc::new(Mutex::new(pipe));

    let (guard, slot) = ExitGuard::new();
    let (done_tx, done_rx) = oneshot::channel();
    if let Ok(mut g) = slot.lock() {
        *g = Some(done_tx);
    }
    /* копия на каждый поток: счётчик вышел бы за 2, и последний поток не
       признал бы себя последним */
    let g1 = guard.clone();
    let g2 = guard.clone();

    let reader_fatal = fatal.clone();
    std::thread::spawn({
        let alive = alive.clone();
        let shared = shared.clone();
        let pending = pending.clone();
        let ready = ready.clone();
        move || {
            let _guard = g1;
            reader_loop(shared, pending, ready, alive, reader_fatal)
        }
    });
    std::thread::spawn({
        let alive = alive.clone();
        move || {
            let _guard = g2;
            writer_loop(shared, rx, alive)
        }
    });

    Some(Conn {
        tx,
        pending,
        ready,
        alive: alive.clone(),
        fatal,
        threads: Arc::new(Threads {
            alive,
            done: std::sync::Mutex::new(Some(done_rx)),
        }),
    })
}

fn writer_loop(pipe: Arc<Mutex<Pipe>>, rx: mpsc::Receiver<Out>, alive: Arc<AtomicBool>) {
    let mut last_write = Instant::now();
    while alive.load(Ordering::Relaxed) {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(out) => {
                if !write_frame(&pipe, out.op, &out.json) {
                    break;
                }
                last_write = Instant::now();
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        /* Серверный пинг приходит не всегда: 40 с полной тишины на живом
           канале не дали ни одного PING от дискорда, так что соединение
           держит клиент. Свой PING раз в 5 с, ответный PONG не ждём —
           достаточно факта записи. */
        if last_write.elapsed() >= KEEPALIVE {
            if !write_frame(&pipe, OP_PING, &json!({ "nonce": nonce() })) {
                break;
            }
            last_write = Instant::now();
        }
    }
    alive.store(false, Ordering::Relaxed);
}

/// Ждёт, пока в буфере канала окажется ровно `need` байт, и забирает их.
///
/// Неблокирующая гарантия держится здесь: `available()` опрашивает канал под
/// блокировкой, а читать берёмся только когда данных точно хватает, то есть
/// ReadFile на синхронном дескрипторе НЕ блокируется. Раньше читатель брался за
/// тело кадра как только набиралось 8 байт заголовка — если тело ещё не
/// пришло, это блокирующее чтение, а блокировка чтения на дескрипторе
/// останавливает и запись тем же дескриптором, то есть писатель с PONG
/// зависал. Err — канал закрыт либо соединение гасят.
fn read_frame(pipe: &Mutex<Pipe>, need: usize, alive: &AtomicBool) -> Result<Vec<u8>, String> {
    if need == 0 {
        return Ok(Vec::new());
    }
    loop {
        if !alive.load(Ordering::Relaxed) {
            return Err("соединение гасится".into());
        }
        let Ok(guard) = pipe.lock() else {
            return Err("pipe poisoned".into());
        };
        let avail = guard.available().map_err(|e| format!("pipe: {e}"))?;
        if avail as usize >= need {
            let mut buf = vec![0u8; need];
            return guard
                .read_exact(&mut buf)
                .map(|_| buf)
                .map_err(|e| format!("read: {e}"));
        }
        /* дескриптор отпускается ДО сна: сон под блокировкой убил бы
           писателя, которому в этот момент может понадобиться PONG */
        drop(guard);
        ipc_pipe::pause();
    }
}

/// читает кадры опросом, а не блокировкой: см. комментарий в ipc_pipe.
/// при закрытом канале available() вернёт Err — это штатный повод
/// переподключиться, поэтому рвём цикл, а не паникуем.
fn reader_loop(
    pipe: Arc<Mutex<Pipe>>,
    pending: Pending,
    ready: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    fatal: Arc<Mutex<Option<String>>>,
) {
    /* причина обрыва — в лог и в текст ошибки ожидающим: «канал закрыт» и
       «дискорд закрыл соединение кодом 4000» чинить по-разному */
    let mut why = "канал закрыт".to_string();
    while alive.load(Ordering::Relaxed) {
        /* Кадр discord ipc: [op: u32 LE][len: u32 LE][data], где data —
           json целиком. Здесь раньше читались первые 4 байта и объявлялись
           длиной — то есть за длину принимался САМ op (0/1/2/8), а настоящее
           поле len не читалось вовсе. Поток сдвигался на 4 байта, первый же
           кадр разбирался как мусор, цикл рвался, и в логе это выглядело как
           «сервер закрыл соединение через 50 мс»: на самом деле Discord
           отвечал нормально, а мы не умели прочитать ответ. */
        let head = match read_frame(&pipe, 8, &alive) {
            Ok(b) => b,
            Err(e) => {
                why = e;
                break;
            }
        };
        let op = u32::from_le_bytes([head[0], head[1], head[2], head[3]]);
        let len = u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as usize;

        if len == 0 || len > MAX_FRAME {
            why = format!("в кадре op={op} неправдоподобная длина {len} байт");
            settings::log(&format!("[discord] {why}"));
            break;
        }

        let buf = match read_frame(&pipe, len, &alive) {
            Ok(b) => b,
            Err(e) => {
                why = e;
                break;
            }
        };

        let parsed = serde_json::from_slice::<Value>(&buf);

        if op == OP_CLOSE {
            /* Тело CLOSE — json {"code":N,"message":"…"}, проверено на живом
               канале. Раньше читался `buf[1..]`, то есть отбрасывался первый
               байт `{`: в лог уходило `"code":1003,…`, а сам код закрытия
               (4000 невалидный client_id, 4001 client_id не тот, 4003
               рейт-лимит) не извлекался вообще — а именно по нему понятно,
               надо ли ретраить. */
            let (code, msg) = match &parsed {
                Ok(v) => (
                    v.get("code").and_then(Value::as_i64).unwrap_or(0),
                    v.get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("без текста")
                        .to_string(),
                ),
                Err(_) => (0, String::from_utf8_lossy(&buf).into_owned()),
            };
            /* Коды, которые повторными попытками не лечатся: бессмысленно
               бить канал каждые 30 с вечно. 4000 — client_id не существует
               или невалиден, 4001 — существует, но не тот. Остальное (4003
               рейт-лимит, 1003 невалидный payload) — временное, ретраим. */
            if matches!(code, 4000 | 4001) {
                if let Ok(mut slot) = fatal.lock() {
                    *slot = Some(format!("{code} {msg}"));
                }
            }
            why = format!("сервер закрыл соединение: {code} {msg}");
            settings::log(&format!("[discord] {}", truncate(&why, 300)));
            break;
        }

        let Ok(packet) = parsed else {
            settings::log(&format!(
                "[discord] не разобрал json кадра (op={op}), {len} байт, начало {:?}",
                truncate(&String::from_utf8_lossy(&buf), 120)
            ));
            continue;
        };

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
                /* отдаём пакет целиком, а не data: признак ошибки (evt) живёт
                   на верхнем уровне, и раньше он отбрасывался */
                let _ = w.send(packet);
            }
        }
    }
    alive.store(false, Ordering::Relaxed);
    fail_pending(&pending, &why);
}

impl Conn {
    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed) && self.ready.load(Ordering::Relaxed)
    }

    /// Гасит соединение и ДОЖИДАЕТСЯ выхода потоков.
    ///
    /// Без этого шага труба: `Conn` при отбрасывании отпускал только свою
    /// ссылку на дескриптор, а читатель и писатель жили дальше по своему
    /// `while alive` и держали канал открытым. Дискорд держит на канал ровно
    /// одного клиента, поэтому следующий `connect()` получал ERROR_PIPE_BUSY от
    /// канала, занятого нашими же потоками, и RPC не поднимался до перезапуска
    /// приложения. Воспроизводится тривиально: включить RPC, выключить
    /// тумблер, включить обратно.
    async fn shutdown(self) {
        self.threads.alive.store(false, Ordering::SeqCst);
        /* ждём оба потока: пока жив хоть один, дескриптор ещё открыт */
        let done = self
            .threads
            .done
            .lock()
            .ok()
            .and_then(|mut d| d.take());
        let timed_out = match done {
            Some(rx) => tokio::time::timeout(SHUTDOWN_WAIT, rx).await.is_err(),
            /* сигнал уже забрали — потоки вышли */
            None => false,
        };
        if timed_out {
            settings::log(
                "[discord] потоки соединения не вышли за отведённое время, канал закроется сам",
            );
        }
        /* канал писателя рвём явно: иначе он ещё до 250 мс ждал бы recv_timeout,
           а мы уже считаем соединение закрытым */
        drop(self.tx);
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
        if self.tx.send(Out { op: OP_FRAME, json: payload }).is_err() {
            /* писатель мёртв: запись в pending осталась бы висеть до конца
               жизни соединения */
            if let Ok(mut p) = self.pending.lock() {
                p.remove(&n);
            }
            return Err("писатель мёртв".into());
        }

        let answer = tokio::time::timeout(timeout, rx).await;
        if let Ok(mut p) = self.pending.lock() {
            p.remove(&n);
        }
        /* Четыре исхода: ответ, ошибка дискорда, канал закрыт читателем
           (fail_pending) и таймаут */
        let packet = match answer {
            Ok(Ok(packet)) => packet,
            Ok(Err(_)) => return Err("читатель умер".into()),
            Err(_) => return Err("таймаут".into()),
        };

        /* Ответ с evt:"ERROR" — это не данные, а отказ. Раньше он уезжал в
           Ok(data), где data = {"code":4003,"message":"You are being rate
           limited"}, и вызывающий код ошибку не видел: рейт-лимит, 4000
           «invalid payload» и 4002 долетали молча, а присутствие при этом
           просто переставало обновляться. */
        if packet.get("evt").and_then(Value::as_str) == Some("ERROR") {
            let code = packet
                .get("data")
                .and_then(|d| d.get("code"))
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let msg = packet
                .get("data")
                .and_then(|d| d.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("без текста");
            return Err(format!("{cmd}: discord {code} {msg}"));
        }
        Ok(packet.get("data").cloned().unwrap_or(Value::Null))
    }
}

/// Снимает присутствие.
///
/// ⚠️ Именно так, а не `CLEAR_ACTIVITY`: проверено на живом канале —
/// `CLEAR_ACTIVITY` дискорд не знает и отвечает
/// `{"code":4002,"message":"Invalid command: CLEAR_ACTIVITY"}`. Раньше
/// вызывался он, результат не проверялся, и «скрывать на паузе» вместе с
/// очисткой при закрытии окна просто не работало: присутствие оставалось на
/// экране. Снятие — это `SET_ACTIVITY` с activity: null.
async fn clear_activity(conn: &Conn, timeout: Duration) -> Result<(), String> {
    conn.request(
        "SET_ACTIVITY",
        json!({ "pid": 0, "activity": Value::Null }),
        timeout,
    )
    .await
    .map(|_| ())
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
/// дописывает пробелы — ровно это и делал electron-вариант. Проверено на
/// живом канале: `details: ""` дискорд отклоняет кодом 4000.
fn pad2(s: &str) -> String {
    let t: String = s.chars().take(128).collect();
    if t.chars().count() >= 2 {
        t
    } else {
        format!("{t}  ")
    }
}

/// «1:07», для строки паузы. Дискорд не умеет показывать позицию на паузе
/// таймером (таймер считается на его стороне каждую секунду), поэтому
/// позиция уходит текстом.
fn mmss(secs: i64) -> String {
    let s = secs.max(0);
    format!("{}:{:02}", s / 60, s % 60)
}

/// Длительность трека в секундах, только если в неё можно верить.
///
/// `duration > 0.0` истинно и для бесконечности, и для 1e300: `as i64` на
/// таком даёт i64::MAX (насыщение), а не панику. Дальше `now_s() - i64::MAX`
/// уезжает в отрицательные unix-секунды, и discord получает timestamps от
/// 1969 года. Потолок в сутки — трек длиннее в музыкальном плеере не
/// бывает, а для строки паузы это ещё и формат «99:59:59».
const MAX_DURATION_S: i64 = 86_400;

fn sane_duration(d: f64) -> i64 {
    if !d.is_finite() || d <= 0.0 {
        return 0;
    }
    (d.round() as i64).clamp(0, MAX_DURATION_S)
}

/// Что показывать на паузе: слово плюс позиция, если она известна.
///
/// ⚠️ Пустая строка в `state` хуже, чем её отсутствие: у activity типа 2
/// карточка состоит из трёх строк, и без `state` третья строка просто пустая,
/// то есть «играет» и «на паузе» выглядят одинаково.
fn paused_state(p: &Presence) -> String {
    let dur = sane_duration(p.duration);
    if dur == 0 {
        return PAUSED_LABEL.to_string();
    }
    let pos = if p.progress.is_finite() {
        (p.progress.clamp(0.0, 1.0) * dur as f64).round() as i64
    } else {
        0
    };
    /* в начале трека позиция ещё не значима, а «Paused · 0:00 / 4:12» выглядит
       как баг, поэтому в нуле оставляем только слово */
    if pos <= 0 {
        return PAUSED_LABEL.to_string();
    }
    format!("{PAUSED_LABEL} · {} / {}", mmss(pos), mmss(dur))
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

    /* ПАУЗА. Ключевое отличие паузы от игры: дискорд не знает про «paused»,
       но у activity есть третья строка `state`. На паузе timestamps не
       отправляем (таймер на паузе заморозить нельзя — discord пересчитывает
       прошедшее на своей стороне каждую секунду, только убрать можно), и
       вместо этого заполняем `state`: «Paused», а позицию добавляем текстом.
       Проверено на живом канале — state возвращается дискордом как есть. */
    if !p.is_playing {
        activity["state"] = json!(paused_state(p));
    }

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
    if p.is_playing && p.timestamp != "none" {
        /* ⚠️ Проверки именно такие (sane_duration). Раньше стояло только
           `duration > 0.0`, а это истина и для бесконечности: `inf.round()
           as i64` даёт i64::MAX, и `start + dur_s` на этом паникует с
           overflow. Паника в этой горутине убивала не только обновление, но и
           всю машину состояний — присутствие переставало обновляться до
           перезапуска. `num_field` в lib.rs отсекает не-конечные значения, но
           полагаться на один фильтр на границе IPC нельзя. */
        let dur_s = sane_duration(p.duration);
        if dur_s > 0 {
            /* progress тоже в [0,1]: иначе start уезжает в будущее и discord
               рисует таймер с минусом */
            let progress = if p.progress.is_finite() {
                p.progress.clamp(0.0, 1.0)
            } else {
                0.0
            };
            let elapsed = ((progress * dur_s as f64).round() as i64).min(dur_s);
            let start = now_s().saturating_sub(elapsed);
            let mut ts = json!({ "start": start });
            if p.timestamp == "progress" {
                /* saturating_add, а не `+`: start+b dur_s может переполнить
                   i64 на осмысленном по протоколу, но огромном duration */
                ts["end"] = json!(start.saturating_add(dur_s));
            }
            activity["timestamps"] = ts;
        }
    }
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
    /* base64 из canvas приходит без переводов строк, но с ними STANDARD
       декодер падает — чистим, иначе молча пропадала бы обложка */
    let payload: String = data_url
        .get(comma + 1..)?
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let bytes = B64.decode(payload.as_bytes()).ok()?;
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
    /// что уже отправили — чтобы повторное обновление не жечь рейт-лимит
    /// (смена play/pause сюда тоже попадает: state меняет сам payload)
    sent: Option<String>,
    /// ждём снятия присутствия. Раньше Cmd::Clear выполнялся прямо в apply,
    /// но команда могла прийти во время await внутри asset_key (пока грузится
    /// обложка) — и тогда её проглатывал absorb, ничего не снимая, то есть
    /// «скрывать на паузе» на больших обложках не работало. Теперь Clear — это
    /// флаг, а запрос уходит в tick, где очередь уже не может быть занята
    want_clear: bool,
    /// когда последний раз отправляли. ограничение частоты, кроме смены
    /// play-состояния и смены трека
    last_sent: Option<Instant>,
    /// какой трек показываем сейчас. сверяется с cover_key, чтобы смена трека
    /// проходила мимо троттлинга: по тексту activity сравнивать нельзя, там
    /// ещё и позиция, которая меняется каждую секунду
    sent_cover_key: Option<String>,
    /// последнее известное состояние игры/паузы: по нему решаем, можно ли
    /// проскочить мимо ACTIVITY_MIN_GAP
    sent_playing: Option<bool>,
    retry_at: Option<Instant>,
    retry_delay: Duration,
    /// код закрытия соединения дискордом: 4000 «невалидный client_id» и 4001
    /// «client_id не тот» повторными попытками не лечатся, поэтому после
    /// такого кода переподключение прекращаем и показываем ошибку, вместо
    /// того чтобы бесконечно долбить канал. Носим текст, а не bool: в
    /// настройках показывается он же.
    fatal: Option<String>,
}

/// Кэш загруженных обложек: ключ трека → `external:<name>`.
///
/// С вытеснением. Раньше на `RPC_ASSET_LIMIT` код просто возвращал None, то
/// есть после 250 треков ни одна новая обложка не загружалась до конца
/// сессии — и это молча, потому что отсутствие картинки дискорд тоже
/// проглатывает без ошибки.
struct Assets {
    map: HashMap<String, String>,
    order: VecDeque<String>,
}

impl Assets {
    fn new() -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn get(&self, key: &str) -> Option<String> {
        self.map.get(key).cloned()
    }

    fn has_room(&self) -> bool {
        self.map.len() < RPC_ASSET_LIMIT
    }

    fn put(&mut self, key: String, value: String) {
        if self.map.insert(key.clone(), value).is_none() {
            self.order.push_back(key);
        }
        while self.map.len() > RPC_ASSET_LIMIT {
            match self.order.pop_front() {
                Some(old) => {
                    self.map.remove(&old);
                }
                None => break,
            }
        }
    }

    /// Сброс на переподключении: `external:<name>` — имя, выданное конкретной
    /// сессии IPC, и после её обрыва оно может больше не резолвиться. Дискорд
    /// при этом такой ассет просто молча выкидывает из activity (проверено:
    /// неизвестный `large_image` даёт ответ с пустыми `assets`), то есть
    /// после реконнекта обложки исчезают «сами». Держать кэш нужно только
    /// пока живо то же соединение.
    fn clear(&mut self) {
        self.map.clear();
        self.order.clear();
    }
}

struct Rpc {
    app: AppHandle,
    http: reqwest::Client,
    assets: Arc<Mutex<Assets>>,
    /// код закрытия соединения, оставшийся после неудачного handshake.
    /// handshake() соединение уже снял, а причина живёт в нём — если не
    /// перенести её сюда, «дискорд не пускает» выглядело бы как обычное
    /// «переподключается», то есть ровно то, что аудит и чинит.
    last_conn_fatal: Arc<Mutex<Option<String>>>,
}

fn c_fatal(slot: &Mutex<Option<String>>) -> Option<String> {
    slot.lock().ok().and_then(|v| v.clone())
}

pub fn spawn(app: AppHandle, http: reqwest::Client) -> tmpsc::UnboundedSender<Cmd> {
    let (cmd_tx, cmd_rx) = tmpsc::unbounded_channel();
    let rpc = Rpc {
        app,
        http,
        assets: Arc::new(Mutex::new(Assets::new())),
        last_conn_fatal: Arc::new(Mutex::new(None)),
    };
    /* ⚠️ Паника в run() — молчаливая смерть RPC: горутина просто умирает,
       соединение остаётся висеть занятым, присутствие перестаёт
       обновляться, и в логе нет ни единой записи. Поэтому ловим панику и
       отдаём её в лог: пользователь видит, что произошло, вместо
       неработающего молча. */
    tauri::async_runtime::spawn(async move {
        if let Err(why) = std::panic::AssertUnwindSafe(rpc.run(cmd_rx)).catch_unwind().await {
            let text = why
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| why.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "без описания".into());
            settings::log(&format!("[discord] ПАНИКА в машине присутствий: {text}"));
            settings::log("[discord] присутствие перестанет обновляться до перезапуска приложения");
        }
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

    /// Сбрасывает соединение: снимает присутствие, гасит потоки, отпускает
    /// канал. Вызывается и при выключении, и при обрыве.
    async fn drop_conn(&self, st: &mut St, clear: bool, timeout: Duration) {
        if let Some(c) = st.conn.take() {
            if clear && c.is_alive() {
                /* ⚠️ Даже если снятие не вышло, канал закрываем. Иначе
                   присутствие осталось бы висеть на экране discord, а
                   соединение — висеть занятым: два неприятных исхода вместо
                   одного. Плюс close канала сам по себе снимает присутствие в
                   discord, то есть шанс есть даже после ошибки round-trip */
                if let Err(e) = clear_activity(&c, timeout).await {
                    settings::log(&format!(
                        "[discord] снять присутствие не вышло, канал всё равно закрываем: {e}"
                    ));
                }
            }
            /* ждём освобождения канала ДО следующего connect(): иначе тот
               получит ERROR_PIPE_BUSY от канала, занятого нашими же потоками */
            c.shutdown().await;
        }
        st.sent = None;
        st.sent_playing = None;
        st.sent_cover_key = None;
        st.last_sent = None;
        /* обложки выданного прошлым соединением имена после его обрыва
           могут не резолвиться — дискорд отбрасывает такой asset молча */
        if let Ok(mut a) = self.assets.lock() {
            a.clear();
        }
    }

    async fn run(self, mut rx: tmpsc::UnboundedReceiver<Cmd>) {
        let mut st = St {
            wanted: false,
            conn: None,
            queued: None,
            sent: None,
            want_clear: false,
            last_sent: None,
            sent_playing: None,
            sent_cover_key: None,
            retry_at: None,
            retry_delay: Duration::from_millis(1500),
            fatal: None,
        };

        /* ⚠️ Главное отличие от прежней версии: раньше цикл ждал
           `rx.recv().await`, а `tick()` — единственное место, где
           проверяется `retry_at` — вызывался только после команды. Без
           команд он висел вечно: после рестарта Discord статус навсегда
           оставался `disconnected`, а переподключение случалось лишь когда
           пользователь случайно что-то нажмёт. Теперь ход часов не зависит от
           активности. */
        loop {
            let wait = next_wait(&st);
            let mut batch: Vec<Cmd> = Vec::new();
            tokio::select! {
                first = rx.recv() => {
                    match first {
                        Some(cmd) => batch.push(cmd),
                        None => break,
                    }
                    /* пачка: за время await внутри apply очередь могла
                       наполниться, и промежуточные Update терять нельзя — но и
                       обрабатывать их по одному с ожиданием между ними смысла
                       нет */
                    while let Ok(cmd) = rx.try_recv() {
                        batch.push(cmd);
                    }
                }
                _ = tokio::time::sleep(wait) => {}
            }
            for cmd in batch {
                self.apply(&mut st, cmd).await;
            }
            self.tick(&mut st, &mut rx).await;
        }

        /* канал команд закрыли (нас снесли) — присутствие снимаем и канал
           отпускаем, иначе он останется занятым до конца процесса */
        settings::log("[discord] очередь команд закрыта, гасим соединение");
        self.drop_conn(&mut st, true, Duration::from_millis(800)).await;
        if st.wanted {
            self.status("off");
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
                    /* новый запуск руками снимает «дискорд закрыл соединение
                       кодом 4000»: вдруг приложение перезарегистрировали */
                    st.fatal = None;
                    st.retry_delay = Duration::from_millis(1500);
                    self.status("connecting");
                } else {
                    st.queued = None;
                    st.retry_at = None;
                    st.retry_delay = Duration::from_millis(1500);
                    st.fatal = None;
                    /* флаг снятия сбрасываем: снятие сейчас сделает
                       drop_conn, и оно же снимет флаг, а оставить его значило
                       бы, что tick потом повторит снятие вхолостую */
                    st.want_clear = false;
                    /* присутствие снимается ДО закрытия канала: пока канал
                       открыт, дискорд держит нашу карточку на экране */
                    self.drop_conn(st, true, Duration::from_millis(800)).await;
                    self.status("off");
                }
            }
            Cmd::Update(p) => st.queued = Some(*p),
            Cmd::Clear => {
                /* присутствие снято → следующий Update должен уйти даже если
                   payload совпадёт с предыдущим. Сам запрос уходит в tick, а
                   не здесь: команда может прийти во время await внутри asset_key
                   (пока грузится обложка), и снятие тогда ушло бы в пустоту */
                st.queued = None;
                st.sent = None;
                /* трек тоже забываем: присутствие снято, значит ничего не
                   показываем, и следующий Update — это новый трек, который
                   должен пройти мимо троттлинга */
                st.sent_cover_key = None;
                st.last_sent = None;
                st.want_clear = true;
            }
        }
    }

    /// подключение + handshake + ожидание READY. None — не удалось.
    async fn handshake(&self) -> Option<Conn> {
        if let Ok(mut f) = self.last_conn_fatal.lock() {
            *f = None;
        }
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
        if c.tx.send(Out { op: OP_HANDSHAKE, json: hello }).is_err() {
            settings::log("[discord] handshake: не отправить HANDSHAKE (поток мёртв)");
            return None;
        }

        /* Ждём именно READY: is_alive() требует и живой канал, и ready от
           читателя. pid в ответе нет (проверено на живом канале), поэтому
           ориентир — сам факт READY, а не значение счётчика. */
        let deadline = Instant::now() + RPC_TIMEOUT;
        let mut waited = Duration::ZERO;
        while Instant::now() < deadline {
            if c.is_alive() {
                settings::log(&format!("[discord] handshake: READY получен за {waited:?}"));
                return Some(c);
            }
            if !c.alive.load(Ordering::Relaxed) {
                /* ⚠️ и гасим соединение. Раньше здесь просто возвращали None,
                   и Conn отбрасывался — но читатель и писатель продолжали
                   крутить цикл и держать канал открытым. Дискорд держит на
                   канал одного клиента, поэтому следующая попытка
                   подключения получала ERROR_PIPE_BUSY от канала, занятого
                   нашими же потоками, и RPC не поднимался до перезапуска */
                let why = c_fatal(&c.fatal);
                settings::log(&format!(
                    "[discord] handshake: канал закрыт через {waited:?}, READY не пришёл{}",
                    why.as_deref().map(|w| format!(": {w}")).unwrap_or_default()
                ));
                c.shutdown().await;
                if let Ok(mut f) = self.last_conn_fatal.lock() {
                    *f = why;
                }
                return None;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            waited += Duration::from_millis(50);
        }
        /* ⚠️ Та же поправка, что и выше: соединение обязано быть снято перед
           возвратом. Раньше Conn просто отбрасывался, а читатель с писателем
           продолжали крутить цикл и держать канал занятым — дискорд держит на
           канал одного клиента, поэтому следующая попытка получала
           ERROR_PIPE_BUSY от канала, занятого нашими же потоками, и RPC не
           поднимался до перезапуска приложения. */
        settings::log(&format!("[discord] handshake: таймаут {RPC_TIMEOUT:?}, READY не пришёл"));
        let why = c_fatal(&c.fatal);
        c.shutdown().await;
        if let Ok(mut f) = self.last_conn_fatal.lock() {
            *f = why;
        }
        None
    }

    /// обложка → ключ для assets.large_image.
    /// https — поддерживаемый путь, дискорд тянет её сам (он переписывает
    /// такой ключ в `mp:external/<хэш>/<url>` — проверено на живом канале).
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
                return Some(k);
            }
            if !cache.has_room() {
                /* вытеснения уже некуда делать: дискорд держит ~300 ассетов на
                   приложение, обложка без ключа лучше, чем молчаливая
                   пропажа всех картинок */
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
            settings::log("[discord] asset upload не удался, обложка не будет");
            return None;
        }

        let key = format!("external:{remote}");
        if let Ok(mut cache) = self.assets.lock() {
            cache.put(p.cover_key.clone(), key.clone());
        }
        Some(key)
    }

    async fn tick(&self, st: &mut St, rx: &mut tmpsc::UnboundedReceiver<Cmd>) {
        /* Снятие присутствия — до всего остального и до проверки соединения.
           Именно здесь, а не в apply: команда могла прийти во время await
           внутри asset_key, и раньше её в этот момент проглатывал absorb.
           Флаг снимаем только после успеха, иначе на неудачном снятии мы бы
           слали SET_ACTIVITY в соединение, которое только что не ответило */
        if st.want_clear {
            st.queued = None;
            match st.conn.as_ref() {
                Some(c) if c.is_alive() => match clear_activity(c, Duration::from_millis(2000))
                    .await
                {
                    Ok(()) => {
                        settings::log("[discord] присутствие снято");
                        st.want_clear = false;
                    }
                    Err(e) => {
                        settings::log(&format!(
                            "[discord] снять присутствие не вышло, повторим: {e}"
                        ));
                        return;
                    }
                },
                /* канала нет — снимать нечего, но флаг гасим: иначе он висел бы
                   и подавлял следующий Update */
                _ => st.want_clear = false,
            }
        }

        /* переподключение: рестарт дискорда, сон ноутбука, сеть */
        if let Some(c) = st.conn.as_ref() {
            if !c.is_alive() {
                /* код закрытия читаем ДО drop_conn: тот снимает соединение,
                   а вместе с ним и причину */
                let f = c_fatal(&c.fatal);
                let line = match f.as_deref() {
                    Some(why) => format!("[discord] соединение умерло: {why}"),
                    None => "[discord] соединение умерло, переподключаемся".to_string(),
                };
                settings::log(&line);
                self.drop_conn(st, false, Duration::ZERO).await;
                st.retry_at = Some(Instant::now() + st.retry_delay);
                st.retry_delay = (st.retry_delay * 2).min(Duration::from_secs(30));
                if f.is_some() {
                    /* ретрай тут только мешал: следующая попытка получит тот
                       же код, а интервал вырастет до 30 с бессмысленного
                       ожидания */
                    st.fatal = f;
                    self.status("error");
                } else {
                    self.status("disconnected");
                }
            }
        }

        if st.conn.is_none()
            && st.wanted
            && st.fatal.is_none()
            && st.retry_at.is_none_or(|t| Instant::now() >= t)
        {
            st.retry_at = None;
            self.status("connecting");
            match self.handshake().await {
                Some(c) => {
                    st.retry_delay = Duration::from_millis(1500);
                    st.fatal = None;
                    self.status("connected");
                    st.conn = Some(c);
                }
                None => {
                    st.retry_at = Some(Instant::now() + st.retry_delay);
                    st.retry_delay = (st.retry_delay * 2).min(Duration::from_secs(30));
                    /* закрыл канал дискорд своим кодом, а не молчание
                       в канале — тогда это ошибка, а не «переподключаемся» */
                    match c_fatal(&self.last_conn_fatal) {
                        Some(why) => {
                            st.fatal = Some(why);
                            self.status("error");
                        }
                        None => self.status("disconnected"),
                    }
                }
            }
        }

        /* отправка. цикл, а не раз: пока грузилась обложка, мог прийти
           свежий payload — старый не шлём, берём новый */
        while let Some(c) = st.conn.clone() {
            if !c.is_alive() {
                self.drop_conn(st, false, Duration::ZERO).await;
                st.retry_at = Some(Instant::now() + st.retry_delay);
                st.retry_delay = (st.retry_delay * 2).min(Duration::from_secs(30));
                self.status("disconnected");
                break;
            }
            let Some(p) = st.queued.clone() else { break };
            st.queued = None;

            let key = self.asset_key(&c, &p).await;
            absorb(st, rx);
            if st.queued.is_some() {
                continue; /* пришёл свежий payload — этот не отправляем */
            }
            let Some(c) = st.conn.as_ref() else { break };

            /* Собираем payload ДО проверки частоты. Раньше эти проверки стояли
               в обратном порядке, и это ломало главное: одинаковое обновление
               отбрасывалось как «нечего слать», а если payload менялся — ждало
               минуту, потому что последняя отправка была только что. Хуже
               всего: пересчёт start каждую секунду означает, что на игре
               payload НИКОГДА не совпадает с предыдущим, то есть ограничение
               частоты не спасало от дублей, но ломало смену обложки и seek. */
            let activity = build_activity(&p, key.as_deref());
            let payload = json!({ "pid": 0, "activity": activity });
            let fingerprint = payload.to_string();

            /* повтор ровно того же не шлём: одинаковый Update прилетает и от
               смены обложки, и от фокуса окна, и каждый раз жег бы лимит */
            if st.sent.as_deref() == Some(fingerprint.as_str()) {
                st.sent_playing = Some(p.is_playing);
                st.sent_cover_key = Some(p.cover_key.clone());
                break;
            }

            /* ограничение частоты. Смена play/pause и СМЕНА ТРЕКА идут вне
               очереди: это ровно те изменения, ради которых присутствие и
               нужно, и ждать секунду незачем. Смена трека минует троттлинг
               ещё и потому, что сравнивается по cover_key, а не по тексту
               activity: в payload попадает позиция, которая на игре меняется
               каждую секунду, так что по строке «трек тот же» не определить. */
            let track_changed = !p.cover_key.is_empty()
                && st.sent_cover_key.as_deref() != Some(p.cover_key.as_str());
            let too_soon = !track_changed
                && st.sent_playing == Some(p.is_playing)
                && st
                    .last_sent
                    .is_some_and(|t| t.elapsed() < ACTIVITY_MIN_GAP);
            if too_soon {
                /* возвращаем в очередь, а не выбрасываем: обновление дойдёт на
                   следующем шаге, когда интервал выйдет */
                st.queued = Some(p);
                break;
            }

            match c.request("SET_ACTIVITY", payload, RPC_TIMEOUT).await {
                Ok(_) => {
                    /* Что реально ушло в discord. Без этого «в присутствии нет
                       таймера» приходилось вычислять умозрительно: подходит
                       пять причин, и все они выглядят одинаково — тишина в
                       интерфейсе. Только итог, а не весь json: полный payload
                       на каждый пульс позиции забивал sewer.log */
                    settings::log(&format!(
                        "[discord] activity: play={} dur={} progress={} ts={} img={} → {}",
                        p.is_playing,
                        p.duration,
                        p.progress,
                        p.timestamp,
                        key.as_deref()
                            .map(|k| truncate(k, 40))
                            .unwrap_or_else(|| "нет".into()),
                        if p.is_playing {
                            "игра, таймер считает дискорд".to_string()
                        } else {
                            format!("пауза, state={}", paused_state(&p))
                        }
                    ));
                    st.sent = Some(fingerprint);
                    st.sent_playing = Some(p.is_playing);
                    st.sent_cover_key = Some(p.cover_key.clone());
                    st.last_sent = Some(Instant::now());
                }
                Err(e) => {
                    settings::log(&format!("[discord] SET_ACTIVITY не прошёл: {e}"));
                    /* 4003 — рейт-лимит: ждать и повторить, не рвать связь.
                       всё остальное (таймаут, оборванный канал) разбирает
                       проверка живости соединения выше */
                    st.queued = Some(p);
                    break;
                }
            }
            absorb(st, rx);
        }
    }
}

/// подтягивает в очередь всё, что пришло во время await внутри apply.
/// Принимает &mut: try_recv забирает из канала, то есть мутирует его.
/// Свободная функция, а не метод: `self` ей не нужен, а так её можно
/// тестировать без поднятия `AppHandle` (в тестах tauri::test выключен).
fn absorb(st: &mut St, rx: &mut tmpsc::UnboundedReceiver<Cmd>) {
    while let Ok(cmd) = rx.try_recv() {
        match cmd {
            Cmd::Update(p) => st.queued = Some(*p),
            Cmd::Clear => {
                /* снятие присутствия произойдёт в tick: здесь мы только гасим
                   очередь. Раньше Clear обрабатывался прямо здесь, и если он
                   прилетал во время await (пока грузилась обложка), absorb
                   проглатывал его, ничего не снимая — то есть присутствие
                   оставалось на экране */
                st.queued = None;
                st.sent = None;
                st.sent_cover_key = None;
                st.last_sent = None;
                st.want_clear = true;
            }
            Cmd::SetEnabled(on) => {
                st.wanted = on;
                if !on {
                    /* выключаем во время ожидания: снятие всё равно нужно,
                       его сделает drop_conn в apply */
                    st.queued = None;
                } else {
                    /* включили: пока rpc был выключен, накопленное не нужно.
                       want_clear не трогаем — если при выключении снятие не
                       удалось, повторять его при включении незачем */
                    st.want_clear = false;
                }
            }
        }
    }
}

/// Сколько ждать до следующего шага. Ноль быть не должен — иначе `select!`
/// крутится вхолостую. Свободная функция по той же причине, что и `absorb`.
fn next_wait(st: &St) -> Duration {
    /* ⚠️ Здесь нужен НЕ IDLE_TICK. В состоянии fatal переподключение
       прекращено осознанно (код 4000/4001 повторными попытками не лечится),
       и ждать больше нечего: tick() всё равно ничего не сделает. С IDLE_TICK
       цикл будился бы 4 раза в секунду до конца работы приложения — то есть
       крутился вхолостую. */
    if st.fatal.is_some() {
        return FATAL_TICK;
    }
    if !st.wanted {
        return IDLE_TICK;
    }
    match st.retry_at {
        Some(t) => t
            .saturating_duration_since(Instant::now())
            .max(MIN_TICK)
            .min(IDLE_TICK),
        None => IDLE_TICK,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn presence(playing: bool, progress: f64, duration: f64) -> Presence {
        Presence {
            title: "Song".into(),
            artist: "Artist".into(),
            duration,
            progress,
            is_playing: playing,
            timestamp: "progress".into(),
            ..Default::default()
        }
    }

    fn st_blank() -> St {
        St {
            wanted: true,
            conn: None,
            queued: None,
            sent: None,
            want_clear: false,
            last_sent: None,
            sent_playing: None,
            sent_cover_key: None,
            retry_at: None,
            retry_delay: Duration::from_millis(1500),
            fatal: None,
        }
    }

    #[test]
    fn на_паузе_в_state_есть_слово_paused() {
        let a = build_activity(&presence(false, 0.4, 252.0), None);
        assert_eq!(a["state"], json!("Paused · 1:41 / 4:12"));
        /* на паузе таймер убран: дискорд считает его сам каждую секунду и
           заморозить не даёт */
        assert!(a.get("timestamps").is_none());
    }

    #[test]
    fn на_паузе_в_начале_трека_только_слово() {
        let a = build_activity(&presence(false, 0.0, 252.0), None);
        assert_eq!(a["state"], json!(PAUSED_LABEL));
        /* «Paused · 0:00 / 4:12» выглядело бы как баг, поэтому нулевую
           позицию не пишем */
        let a = build_activity(&presence(false, 0.0, 0.0), None);
        assert_eq!(a["state"], json!(PAUSED_LABEL));
    }

    #[test]
    fn при_игре_state_нет_и_есть_таймер() {
        let a = build_activity(&presence(true, 0.5, 252.0), None);
        assert!(a.get("state").is_none(), "при игре state лишний");
        let ts = &a["timestamps"];
        assert!(ts["start"].is_i64());
        assert!(ts["end"].is_i64());
        /* начало = середина трека назад от сейчас */
        let expected = now_s() - 126;
        assert!((ts["start"].as_i64().unwrap() - expected).abs() <= 2);
    }

    #[test]
    fn пустой_details_не_уходит_в_дискорд() {
        /* дискорд отклоняет details:"" кодом 4000, поэтому pad2 обязателен */
        let p = Presence {
            title: String::new(),
            artist: String::new(),
            ..presence(true, 0.0, 100.0)
        };
        let a = build_activity(&p, None);
        assert_eq!(a["details"], json!("  "));
        /* имя приложения уже длиннее двух символов, подстановка не нужна */
        assert_eq!(a["name"], json!(RPC_APP_NAME));
    }

    #[test]
    fn progress_не_уходит_за_единицу() {
        let a = build_activity(&presence(true, 1.9, 100.0), None);
        let start = a["timestamps"]["start"].as_i64().unwrap();
        assert!(start <= now_s(), "progress=1.9 не должен уводить в будущее");
    }

    #[test]
    fn non_finite_не_ломает_сборку() {
        /* игра с не-конечными числами: таймер уходит (длительности нет),
           state не появляется — оно только для паузы */
        let a = build_activity(&presence(true, f64::NAN, f64::INFINITY), None);
        assert!(a.get("timestamps").is_none());
        assert!(a.get("state").is_none());
        /* пауза с теми же числами: state есть и это просто слово, без
           бессмысленного «0:00 / 0:00» */
        let a = build_activity(&presence(false, f64::NAN, f64::INFINITY), None);
        assert_eq!(a["state"], json!(PAUSED_LABEL));
        assert!(a["details"].as_str().unwrap().len() >= 2);
    }

    #[test]
    fn длительность_берётся_только_разумная() {
        assert_eq!(sane_duration(f64::INFINITY), 0);
        assert_eq!(sane_duration(f64::NAN), 0);
        assert_eq!(sane_duration(-5.0), 0);
        assert_eq!(sane_duration(0.0), 0);
        /* 1e300 насыщается в i64::MAX, а не паникует — и такой трек должен
           превратиться в потолок, а не в timestamps от 1969 года */
        assert_eq!(sane_duration(1e300), MAX_DURATION_S);
        assert_eq!(sane_duration(f64::MAX), MAX_DURATION_S);
        assert_eq!(sane_duration(252.4), 252);
    }

    /// Регрессия: `duration > 0.0` истинно и для бесконечности,
    /// `inf.round() as i64` даёт i64::MAX, и `start + dur_s` паникует с
    /// overflow. Паника убивала всю машину состояний, а не только одно
    /// обновление, и соединение оставалось висеть занятым.
    #[test]
    fn огромная_длительность_не_паникует() {
        for dur in [f64::INFINITY, f64::NAN, -1.0, 0.0, 1e300, f64::MAX] {
            let p = presence(true, 0.5, dur);
            let a = build_activity(&p, None);
            if let Some(ts) = a.get("timestamps") {
                let start = ts["start"].as_i64().unwrap();
                let end = ts["end"].as_i64().unwrap();
                assert!(end >= start, "duration={dur}: end меньше start");
                assert!(start > 0, "duration={dur}: start не в unix-секундах");
            }
        }
        let a = build_activity(&presence(false, 0.5, f64::INFINITY), None);
        assert_eq!(a["state"], json!(PAUSED_LABEL));
    }

    #[test]
    fn кэш_обложек_вытесняет_по_порогу() {
        let mut a = Assets::new();
        for i in 0..RPC_ASSET_LIMIT {
            a.put(format!("k{i}"), format!("external:{i}"));
        }
        assert!(!a.has_room());
        /* заполненный кэш принимает ещё одну запись и вытесняет самое старое.
           Раньше на этом месте код возвращал None, то есть после 250 треков
           ни одна новая обложка не грузилась до конца сессии — и молча,
           потому что отсутствие картинки дискорд тоже проглатывает без
           ошибки */
        a.put("новый".into(), "external:x".into());
        assert!(a.get("k0").is_none(), "самое старое не вытеснено");
        assert_eq!(a.get("k1").as_deref(), Some("external:1"), "сосед вытеснен зря");
        assert_eq!(a.get("новый").as_deref(), Some("external:x"));
        assert!(!a.has_room(), "после вытеснения места для следующей нет");

        /* цикл вытеснения обязан завершаться: если order разойдётся с map,
           while в put зациклится */
        for i in 0..RPC_ASSET_LIMIT * 2 {
            a.put(format!("ещё{i}"), format!("external:e{i}"));
        }
        assert!(a.map.len() <= RPC_ASSET_LIMIT);
        assert!(a.order.len() <= RPC_ASSET_LIMIT);
        a.clear();
        assert!(a.map.is_empty() && a.order.is_empty());
        assert!(a.has_room(), "после сброса место снова есть");
    }

    #[test]
    fn data_url_с_переводами_строк_разбирается() {
        let b = B64.encode(b"\xff\xd8\xff\xe0 payload");
        let url = format!("data:image/jpeg;base64,{b}");
        assert!(data_url_to_bytes(&url).is_some());
        /* base64 с переносами — обычное дело для длинных картинок; STANDARD
           декодер на таком падает, и обложка молча пропадала бы */
        let wrapped = url
            .as_bytes()
            .chunks(8)
            .map(|c| String::from_utf8_lossy(c).into_owned())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(data_url_to_bytes(&wrapped).is_some());
    }

    #[test]
    fn ключ_ассета_очищается() {
        assert_eq!(sanitize_key("a/b c?d.jpg"), "a_b_c_d_jpg");
        assert_eq!(sanitize_key(&"я".repeat(100)).len(), 64);
    }

    /// Регрессия на Cmd::Clear. Раньше снятие присутствия выполнялось прямо в
    /// `apply`, а `absorb` (который вызывается после await внутри `asset_key`,
    /// то есть пока грузится обложка) глотал `Clear` молча. Итог: «скрывать на
    /// паузе» не работало на треках с обложкой — самый частый случай.
    #[test]
    fn clear_ставит_флаг_а_не_теряется() {
        let (tx, mut rx) = tmpsc::unbounded_channel::<Cmd>();
        let mut st = st_blank();
        st.queued = Some(presence(true, 0.5, 252.0));
        st.sent = Some("было".into());
        st.last_sent = Some(Instant::now());
        st.sent_playing = Some(true);

        /* Clear приходит в очередь, пока «грузятся обложки» */
        tx.send(Cmd::Clear).unwrap();
        absorb(&mut st, &mut rx);

        assert!(st.want_clear, "Clear обязан выставить флаг снятия");
        assert!(st.queued.is_none(), "очередь обновлений должна быть сброшена");
        /* sent сброшен, иначе следующий Update с тем же payload считался бы
           «уже отправленным» и присутствие не появилось бы */
        assert!(st.sent.is_none());
        assert!(st.last_sent.is_none(), "ограничение частоты тоже сбрасывается");
    }

    /// Регрессия на смену трека. Троттлинг (ACTIVITY_MIN_GAP) срабатывал и
    /// при смене трека, если состояние игры не менялось: включили трек, через
    /// полсекунды нажали «следующий» — и карточка секунду показывала ПРЕДЫДУЩИЙ
    /// трек. При быстром переборе (next/next/next) это читалось как «переключил
    /// — дискорд завис».
    #[test]
    fn смена_трека_минует_троттлинг() {
        let mut st = st_blank();
        let a = presence(true, 0.5, 252.0);
        let a = Presence { cover_key: "трек-1".into(), ..a };
        let mut b = a.clone();
        b.cover_key = "трек-2".into();

        /* только что отправили трек-1, всё свежо */
        st.sent = Some("{\"старый\"}".into());
        st.sent_playing = Some(true);
        st.sent_cover_key = Some("трек-1".into());
        st.last_sent = Some(Instant::now());

        let track_changed = !b.cover_key.is_empty()
            && st.sent_cover_key.as_deref() != Some(b.cover_key.as_str());
        assert!(track_changed, "смена трека обязана определяться как смена");

        /* тот же троттлинг для play/pause на том же треке остаётся */
        let same_track_changed = !a.cover_key.is_empty()
            && st.sent_cover_key.as_deref() != Some(a.cover_key.as_str());
        assert!(!same_track_changed, "тот же трек — не смена");

        /* и пустой cover_key не должен считаться сменой: иначе треки без
           ключа (у которых он пуст) проходили бы мимо троттлинга
           бесконечно, и лимит обновлений в дискорд улетел бы */
        let mut nokey = a.clone();
        nokey.cover_key = String::new();
        st.sent_cover_key = None;
        let empty_changed = !nokey.cover_key.is_empty()
            && st.sent_cover_key.as_deref() != Some(nokey.cover_key.as_str());
        assert!(!empty_changed, "пустой cover_key — не смена трека");
    }

    /// Регрессия: в состоянии fatal цикл ждал IDLE_TICK (250 мс) и будился
    /// 4 раза в секунду вхолостую, хотя переподключение прекращено осознанно.
    #[test]
    fn в_состоянии_fatal_цикл_не_крутится_вхолостую() {
        let mut st = st_blank();
        st.fatal = Some("4000 невалидный client_id".into());
        assert!(
            next_wait(&st) >= Duration::from_secs(1),
            "в fatal ждать нечего — ждём редко, а не 4 раза в секунду"
        );
        /* и наоборот: при живой попытке ждём часто, иначе переподключение
           будет медленным */
        st.fatal = None;
        st.wanted = false;
        assert!(next_wait(&st) < Duration::from_secs(1));
    }

    /// ⚠️ Тест по ЖИВОМУ каналу дискорда, запускается только при
    /// SEWER_DISCORD_LIVE=1: нужен запущенный клиент дискорда, а канал
    /// занимает ровно один клиент, так что тест и приложение одновременно
    /// работать не могут.
    ///
    /// ⚠️ Именно этот, а не «цикл с handshake»: по замерам дискорд отвечает
    /// на 2-3 быстрых HANDSHAKE подряд, а потом перестаёт отвечать на handshake
    /// вообще — на 5+ минут, даже с заведомо невалидным client_id (проверено
    /// пробой с несуществующим id: первые два раза приходит CLOSE 4000, дальше
    /// тишина). Это троттлинг дискорда, а не наш код. Поэтому проверяем ровно
    /// то, что чинили: канал освобождается после shutdown.
    #[tokio::test]
    #[ignore = "нужен запущенный Discord; запускать вручную"]
    async fn живой_канал_освобождается_после_shutdown() {
        if std::env::var("SEWER_DISCORD_LIVE").is_err() {
            return;
        }
        for round in 1..4u32 {
            let c = connect().unwrap_or_else(|| {
                panic!(
                    "раунд {round}: канал не открылся — его держит кто-то, \
                     и после shutdown() это уже не мы"
                )
            });
            /* handshake шлём всегда: он же держит читателя в работе, а ответ
               может не прийти из-за троттлинга дискорда (см. выше) — на
               освобождение канала это не влияет */
            c.tx.send(Out {
                op: OP_HANDSHAKE,
                json: json!({ "v": 1, "client_id": RPC_CLIENT_ID }),
            })
            .expect("писатель жив");
            tokio::time::sleep(Duration::from_millis(300)).await;
            c.shutdown().await;

            /* канал обязан быть свободен сразу после shutdown. Небольшая
               пауза — на случай, если CloseHandle ещё не доехал до дискорда,
               но проверка именно на ERROR_PIPE_BUSY, а не на «ответил ли
               handshake» */
            tokio::time::sleep(Duration::from_millis(150)).await;
            match ipc_pipe::Pipe::open(0) {
                Ok(p) => drop(p),
                Err(e) if ipc_pipe::is_busy(&e) => panic!(
                    "раунд {round}: после shutdown канал всё ещё занят \
                     нашими же потоками (ERROR_PIPE_BUSY)"
                ),
                Err(e) => settings::log(&format!("[тест] discord-ipc-0: {e}")),
            }
        }
    }

    /// Проверка снятия присутствия и полного цикла активности — но ОДНИМ
    /// подключением, потому что повторные handshake'ы дискорд троттлит (см.
    /// выше). Требует, чтобы дискорд ещё не был заблокирован предыдущими
    /// прогонами.
    #[tokio::test]
    #[ignore = "нужен запущенный Discord; запускать вручную"]
    async fn живое_присутствие_и_снятие() {
        if std::env::var("SEWER_DISCORD_LIVE").is_err() {
            return;
        }
        let c = connect().expect("канал discord-ipc-0 занят");
        c.tx.send(Out {
            op: OP_HANDSHAKE,
            json: json!({ "v": 1, "client_id": RPC_CLIENT_ID }),
        })
        .expect("писатель жив");

        let mut ready = false;
        let deadline = Instant::now() + RPC_TIMEOUT;
        while Instant::now() < deadline {
            if c.is_alive() {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(ready, "READY не пришёл — возможно, дискорд троттлит handshake");

        /* ровно то, что уходит при игре и при паузе */
        for (label, p) in [
            ("игра", presence(true, 0.5, 252.0)),
            ("пауза с позицией", presence(false, 0.5, 252.0)),
            ("пауза в начале", presence(false, 0.0, 252.0)),
        ] {
            let activity = build_activity(&p, None);
            c.request(
                "SET_ACTIVITY",
                json!({ "pid": 0, "activity": activity }),
                RPC_TIMEOUT,
            )
            .await
            .unwrap_or_else(|e| panic!("{label}: SET_ACTIVITY не принят: {e}"));
        }

        /* снятие. Раньше здесь уходил CLEAR_ACTIVITY, а дискорд отвечал
           4002 «Invalid command» — то есть «скрывать на паузе» не делало
           ничего. */
        clear_activity(&c, RPC_TIMEOUT)
            .await
            .expect("снятие присутствия не принято");
        c.shutdown().await;
    }
}
