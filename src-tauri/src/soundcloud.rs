//! soundcloud: логин и запросы к api.
//!
//! ЛОГИН. Electron умел перехватывать заголовки запросов webview
//! (`webRequest.onBeforeSendHeaders`) и вытаскивать из них
//! `Authorization: OAuth <token>`, который шлёт сам сайт soundcloud своему
//! же api, плюс `client_id` из query. У webview2 такого API нет, а перехват
//! заголовков в tauri не публичен.
//!
//! Сначала здесь был вариант «implicit oauth + deep-link»: открыть
//! `/connect?client_id=…&redirect_uri=sewer-tauri://callback` в системном
//! браузере и поймать токен из редиректа. Он не работает, и это не
//! настройка: connect-эндпоинт soundcloud отвечает **410 Gone на любой**
//! redirect_uri, не зарегистрированный за их приложением. Проверено на
//! `sewer-tauri://`, `urn:ietf:wg:oauth:2.0:oob`, `http://localhost` —
//! везде 410. Свой client_id без регистрации на soundcloud.com/developers
//! не получить, поэтому этот путь закрыт.
//!
//! Рабочий путь — тот же, что был в electron, только перехват переехал
//! внутрь страницы: скрытое веб-вью грузит soundcloud.com, а в его
//! контексте мы ставим обёртки на XHR/fetch ДО загрузки сайта. Сайт сам
//! авторизует себя и сам ходит в api со своим client_id — мы снимаем
//! `Authorization: OAuth …` из его же запросов. Никакой сторонний oauth
//! не нужен, потому что мы не сторонний: мы тот же клиент, что и сайт.
//!
//! ⚠️ Дадома-кука берётся из set-cookie наших собственных запросов, а не
//! из сессии electron. Именно этот пункт и DataDome — самое хрупкое
//! место миграции; проверить можно только живым логином.

use std::sync::RwLock;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{Manager, WebviewUrl};
use tokio::sync::mpsc;
use url::Url;

use crate::settings;

const SC_WRITE_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const SC_API_ORIGIN: &str = "https://soundcloud.com";
const LOGIN_WINDOW: &str = "sc-login";
/// сколько ждём, пока пользователь авторизуется в открывшемся окне
const LOGIN_WAIT: Duration = Duration::from_secs(300);
/// период опроса: дёшево, но не чаще раза в 400мс
const LOGIN_POLL: Duration = Duration::from_millis(400);

/// анти-бот DataDome: write-запросы не чаще раза в 1.5с, а после 403/429 —
/// минутная пауза на ВСЕ write. иначе SC мягко блокирует сессию
const WRITE_MIN_GAP: Duration = Duration::from_millis(1500);
const WRITE_BLOCK: Duration = Duration::from_secs(60);

/// Отдельный профиль webview для окна soundcloud — ровно тогда, когда у окна
/// есть свой прокси. Причина техническая: webview2 требует РАЗНЫХ каталогов
/// данных для окон с разными аргументами браузера, а `--proxy-server` — как
/// раз такой аргумент. Побочный плюс: «выйти» становится честным — удалили
/// каталог, и куки soundcloud исчезли, а localStorage интерфейса цел.
fn sc_profile_dir() -> std::path::PathBuf {
    settings::data_dir().join("sc-webview")
}

/// Прокси из настроек (`scProxy`) для окна входа и записи.
///
/// Зачем вообще: провайдеры (в РФ — по реестру) отдают на `soundcloud.com`
/// подменённый сертификат, webview2 показывает `NET::ERR_CERT_AUTHORITY_INVALID`,
/// и логин не может даже открыть страницу входа. Через локальный прокси
/// (happ/xray/v2ray и подобные) сайт открывается, и вход проходит.
///
/// Формы записи: `127.0.0.1:10809` (считаем http), `http://…`, `socks5://…`.
pub fn sc_proxy() -> Option<Url> {
    let raw = settings::load_settings()
        .get("scProxy")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    parse_proxy(&raw)
}

/// Разбор строки прокси. Отдельно от настроек, потому что то же значение
/// приходит аргументом из интерфейса: настройки сохраняются с задержкой
/// 350 мс, и «вписал прокси → сразу нажал войти» иначе уходило бы напрямую.
fn parse_proxy(raw: &str) -> Option<Url> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let full = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    /* socks5h — это «dns на стороне прокси»; tauri принимает только socks5,
       а разница тут не важна: оба резолвят имя на прокси */
    let full = full.replacen("socks5h://", "socks5://", 1);
    /* Ровно те схемы, которые понимает tauri-runtime-wry: http и socks5.
       https-прокси он не умеет (parse_proxy_url вернёт InvalidProxyUrl),
       а без порта соберёт «--proxy-server=http://host:» — то есть пустой
       порт. Поэтому и то, и другое отсекаем здесь, а не в момент открытия
       окна: тогда причина видна в интерфейсе. */
    match Url::parse(&full) {
        Ok(u)
            if matches!(u.scheme(), "http" | "socks5")
                && u.host_str().map(|h| !h.is_empty()).unwrap_or(false)
                && u.port().is_some() =>
        {
            Some(u)
        }
        _ => {
            settings::log(&format!("[sc] прокси не разобрался: {raw}"));
            None
        }
    }
}

/// Открывается ли soundcloud.com из этой сети ВООБЩЕ (без прокси).
///
/// Проверка нужна до открытия окна: иначе подменённый сертификат виден только
/// как пустое окно с ошибкой, а логин молча ждёт таймаут. Здесь ошибка связи
/// отличается от «сайт ответил кодом»: любой HTTP-ответ означает, что хост
/// доступен, и логин продолжается — у soundcloud бывает 403 от DataDome, и
/// это не повод отказывать во входе.
async fn check_site_direct() -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(SC_WRITE_UA)
        .build()
        .map_err(|e| format!("client: {e}"))?;
    match client.get("https://soundcloud.com/signin").send().await {
        Ok(_) => Ok(()),
        Err(e) => {
            let msg = e.to_string();
            let low = msg.to_lowercase();
            if low.contains("certificate") || low.contains("unknownissuer") || low.contains("cert") {
                Err(format!("cert: {msg}"))
            } else if e.is_timeout() {
                Err(format!("timeout: {msg}"))
            } else if e.is_connect() {
                Err(format!("connect: {msg}"))
            } else {
                Err(format!("net: {msg}"))
            }
        }
    }
}

#[derive(Default)]
pub struct ScState {
    write_last_at: RwLock<Option<Instant>>,
    write_blocked_until: RwLock<Option<Instant>>,
    datadome: RwLock<Option<String>>,
    /// Правка идёт через живой webview: запрос уходит из страницы soundcloud,
    /// и два одновременных eval'а перемешались бы — держим очередь.
    page_write: tokio::sync::Mutex<()>,
}

impl ScState {
    fn blocked_for(&self) -> Option<Duration> {
        let guard = self.write_blocked_until.read().ok()?;
        guard.and_then(|until| until.checked_duration_since(Instant::now()))
    }

    fn block_writes(&self) {
        if let Ok(mut g) = self.write_blocked_until.write() {
            *g = Some(Instant::now() + WRITE_BLOCK);
        }
    }

    /// пауза между write-запросами; false — писать нельзя (backoff)
    async fn wait_turn(&self) -> bool {
        if self.blocked_for().is_some() {
            return false;
        }
        let sleep_for = {
            let g = self.write_last_at.read().expect("sc write_last_at");
            g.and_then(|last| WRITE_MIN_GAP.checked_sub(last.elapsed()))
        };
        if let Some(d) = sleep_for {
            tokio::time::sleep(d).await;
        }
        if let Ok(mut g) = self.write_last_at.write() {
            *g = Some(Instant::now());
        }
        true
    }

    fn set_datadome(&self, value: Option<String>) {
        if let Some(v) = value {
            if let Ok(mut g) = self.datadome.write() {
                *g = Some(v);
            }
        }
    }

    fn datadome(&self) -> Option<String> {
        self.datadome.read().ok().and_then(|g| g.clone())
    }
}

/// datadome выдаётся в set-cookie на первом же ответе soundcloud
fn datadome_from(res: &reqwest::Response) -> Option<String> {
    for value in res.headers().get_all(reqwest::header::SET_COOKIE) {
        let Ok(v) = value.to_str() else { continue };
        let Some(rest) = v.strip_prefix("datadome=") else {
            continue;
        };
        let cookie = rest.split(';').next().unwrap_or("");
        if !cookie.is_empty() {
            return Some(cookie.to_string());
        }
    }
    None
}

fn cached_client_id() -> Option<String> {
    settings::load_settings()
        .get("soundcloudAuth")
        .and_then(|a| a.get("clientId"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

/// Скрипт, который вешается в окно логина ДО загрузки soundcloud.com.
/// Перехватывает заголовок `Authorization: OAuth <token>` в XHR и
/// `client_id` в query — ровно то, что electron ловил на уровне сети,
/// только здесь уже внутри страницы. Сайт при этом работает как обычно:
/// мы не подменяем запросы, а только читаем заголовки.
const HOOK_JS: &str = r#"
(function () {
  if (window.__sewerHooked) return;
  window.__sewerHooked = true;
  window.__sewerToken = null;
  window.__sewerClientId = null;

  var note = function (url, headers) {
    try {
      if (!url || String(url).indexOf('api-v2.soundcloud.com') === -1) return;
      if (headers) {
        try {
          if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
            var v = headers.get('Authorization') || headers.get('authorization');
            if (v && String(v).indexOf('OAuth ') === 0 && !window.__sewerToken) {
              window.__sewerToken = String(v).slice(6);
            }
          } else {
            for (var k in headers) {
              if (!Object.prototype.hasOwnProperty.call(headers, k)) continue;
              var val = headers[k];
              if (typeof val === 'string' && val.indexOf('OAuth ') === 0 && !window.__sewerToken) {
                window.__sewerToken = val.slice(6);
              }
            }
          }
        } catch (e) {}
      }
      try {
        var m = /[?&]client_id=([A-Za-z0-9]+)/.exec(String(url));
        if (m && !window.__sewerClientId) window.__sewerClientId = m[1];
      } catch (e) {}
    } catch (e) {}
  };

  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    var open = XHR.prototype.open;
    var setHeader = XHR.prototype.setRequestHeader;
    XHR.prototype.open = function (method, url) {
      try { this.__sewerUrl = url; } catch (e) {}
      return open.apply(this, arguments);
    };
    XHR.prototype.setRequestHeader = function (name, value) {
      try {
        var t = {};
        t[name] = value;
        note(this.__sewerUrl, t);
      } catch (e) {}
      return setHeader.apply(this, arguments);
    };
  }

  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        var url = (typeof input === 'string' || input instanceof URL) ? String(input) : (input && input.url);
        /* заголовки могут лежать и в init, и внутри объекта Request */
        if (init && init.headers) note(url, init.headers);
        if (input && input.headers && typeof input.headers.get === 'function') note(url, input.headers);
        note(url, null);
      } catch (e) {}
      return origFetch.apply(this, arguments);
    };
  }

  /* client_id лежит в гидратации главной страницы, а не в поле client_id:
     {"hydratable":"apiClient","data":{"id":"so5r9Dsxv6…"}}. Раньше он
     добывался отдельным запросом к soundcloud.com, и это оказалось
     хрупким местом. Раз страница всё равно загружена — читаем прямо
     отсюда, тем же хуком и в тот же момент. */
  var grabClientId = function () {
    if (window.__sewerClientId) return;
    try {
      var h = window.__sc_hydration;
      /* Сначала по-честному: это массив объектов, и apiClient лежит в нём
         рядом с другими. Раньше регулярка требовала, чтобы сразу за
         "apiClient" шёл "data":{"id" — а у soundcloud в data есть ещё
         isExpiring, и совпадение держалось на порядке ключей. */
      if (Object.prototype.toString.call(h) === '[object Array]') {
        for (var i = 0; i < h.length; i++) {
          var it = h[i];
          if (it && it.hydratable === 'apiClient' && it.data
              && typeof it.data.id === 'string' && it.data.id.length >= 16) {
            window.__sewerClientId = it.data.id;
            return;
          }
        }
        var s = JSON.stringify(h);
        var m = /"hydratable"\s*:\s*"apiClient"[\s\S]{0,240}?"id"\s*:\s*"([A-Za-z0-9]{16,})"/.exec(s);
        if (m) { window.__sewerClientId = m[1]; return; }
      }
    } catch (e) {}
    /* гидратация бывает и объектом, а не массивом — раньше этот случай
       не проверялся вовсе, и логин ждал client_id до таймаута */
    try {
      var hj = JSON.stringify(window.__sc_hydration || null);
      var mj = /"apiClient"[\s\S]{0,400}?"id"\s*:\s*"([A-Za-z0-9]{16,})"/.exec(hj);
      if (mj) { window.__sewerClientId = mj[1]; return; }
    } catch (e) {}
    /* третий заход: client_id прямо в разметке — либо в query ссылки
       (client_id=…), либо в json-поле ("client_id":"…"). Разметка
       главной содержит его в любом виде, а не только в первом. */
    try {
      var html = document.documentElement.innerHTML || '';
      var m2 = /client_id["']?\s*[:=]\s*["']?([A-Za-z0-9]{16,})/.exec(html);
      if (m2) { window.__sewerClientId = m2[1]; return; }
    } catch (e) {}
  };
  /* Пробник зовёт это перед каждым чтением: гидратация приходит не всегда к
     DOMContentLoaded, а ждать client_id после токена — это те самые пять
     минут молчания, если таймеры уже отработали. */
  window.__sewerGrabCid = grabClientId;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', grabClientId);
  } else {
    grabClientId();
  }
  /* подстраховка: гидратация может прийти позже domready */
  setTimeout(grabClientId, 1500);
  setTimeout(grabClientId, 4000);
})();
"#;

/// Что скрипт-опрос читает из окна логина.
///
/// Основной путь — перехваченный заголовок. Запасной: если заголовок не
/// поймался (сайт переехал на другой вызов api, или запрос ушёл из
/// фрейма, куда не дошёл initialization_script), делаем пробный запрос к
/// `/me` ПРЯМО из страницы. Он уходит с куками сессии окна, и по ответу
/// видно, вошёл пользователь или нет. Это не даёт токен, но даёт
/// уверенность: если /me ответил 200, значит логин состоялся, и токен
/// можно взять из localStorage/кук, куда сайт его положил.
const PROBE_JS: &str = r#"
(function () {
  /* Настоящий access-токен soundcloud всегда выглядит одинаково:
     2-332396-1366999722-sKbZ4vNW6wdsB — четыре группы через дефис,
     первая короткое число. Проверка обязательна: на странице входа, ДО
     авторизации, в localStorage лежит масса строк длиной 20+ символов
     (csrf, session-ключи, идентификаторы), и наивный regexp по ним
     возвращал мусор вместо токена — логин принимал «I7FB0AFFMEE…» и
     выходил с ошибкой, не дождавшись настоящего токена. */
  var TOKEN_RE = /^(?:[0-9]{1,3}-[0-9]{4,}-[0-9]{6,}-[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
  var TOKEN_IN = /(?:[0-9]{1,3}-[0-9]{4,}-[0-9]{6,}-[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/;
  var looksLikeToken = function (s) { return !!s && TOKEN_RE.test(s); };

  /* client_id мог не попасть в хук к моменту опроса — пробуем достать его
     здесь же, на этом круге. Функция из HOOK_JS, если она вообще есть:
     на странице ошибки/заглушке хука нет, и это нормально. */
  try { if (typeof window.__sewerGrabCid === 'function') window.__sewerGrabCid(); } catch (e) {}

  try {
    var token = window.__sewerToken;
    if (looksLikeToken(token)) {
      return JSON.stringify({ ok: true, token: token, clientId: window.__sewerClientId || null });
    }

    /* запасной путь: пробуем достать токен из localStorage и из кук —
       site кладёт access token в оба места после oauth.
       ⚠️ Раньше здесь искалось ТОЛЬКО по именам полей accessToken /
       access_token / oauthToken. А soundcloud хранит его под ключом
       `oauth_token` — с подчёркиванием, а не camelCase, — и ни одно из
       имён не совпадало: токен лежал в localStorage, а логин его не
       видел и висел до таймаута (в логе это выглядело как «окно дошло
       до discover, а токена нет»). Теперь ищем УСТОЙЧИВО: перебираем
       ВСЕ значения хранилища и берём токен-подобную строку, если ключ
       говорит про токен ИЛИ значение — это сам токен целиком. */
    var scanStore = function (store) {
      try {
        for (var i = 0; i < store.length; i++) {
          var k = store.key(i) || '';
          var v = store.getItem(k) || '';
          /* токен всегда содержит дефисы — дешёвый отсев до regexp */
          if (v.indexOf('-') === -1 && v.indexOf('eyJ') === -1) continue;
          var m = TOKEN_IN.exec(v);
          if (!m || !looksLikeToken(m[1])) continue;
          if (/token/i.test(k) || v.trim() === m[1]) return { token: m[1], key: k };
        }
      } catch (e) {}
      return null;
    };
    var found = scanStore(localStorage) || scanStore(sessionStorage);
    var storeTok = found ? found.token : null;
    var storeKey = found ? found.key : null;
    if (!storeTok) {
      try {
        var m2 = /(?:accessToken|access_token|oauthToken|oauth_token)=((?:[0-9]{1,3}-[0-9]{4,}-[0-9]{6,}-[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+))/.exec(document.cookie);
        if (m2 && looksLikeToken(m2[1])) { storeTok = m2[1]; storeKey = 'cookie'; }
      } catch (e) {}
    }
    if (storeTok) {
      return JSON.stringify({ ok: true, token: storeTok, clientId: window.__sewerClientId || null, via: 'store:' + storeKey });
    }

    return JSON.stringify({
      ok: false,
      reason: 'no_token',
      clientId: window.__sewerClientId || null,
      /* работает ли вообще хук: если false — initialization_script не
         выполнился, и перехват заголовка молчит по этой причине */
      hooked: !!window.__sewerHooked,
      /* что хук поймал, но не принял за токен: иногда там почти-токен */
      rawToken: (window.__sewerToken || '').slice(0, 48),
      /* ⚠️ РЕШАЮЩИЙ ЗОНД: запрос к /me ПРЯМО ИЗ СТРАНИЦЫ, с куками сессии
         и без Authorization. Если он даёт 200 — сессия живая и сайт
         авторизует api куками; если 401 — в окне действительно не вошли. */
      me: (function () {
        try {
          var m = window.__sewerMeProbe;
          if (!m) {
            window.__sewerMeProbe = 'pending';
            var h = {};
            if (window.__sewerToken) h['Authorization'] = 'OAuth ' + window.__sewerToken;
            fetch('https://api-v2.soundcloud.com/me?client_id=' + (window.__sewerClientId || ''),
                  { credentials: 'include', headers: h })
              .then(function (r) { window.__sewerMeProbe = 'status:' + r.status; })
              .catch(function (e) { window.__sewerMeProbe = 'err:' + ((e && e.message) || e); });
            return 'started';
          }
          return m;
        } catch (e) { return 'n/a'; }
      })(),
      /* диагностика: что вообще видно на этой странице */
      url: String(location.href).slice(0, 120),
      /* ⚠️ значения token-ключей, а не только имена: именно их отсутствие
         в логе прятало баг с oauth_token. Обрезаем до 80 символов —
         токен здесь же и будет виден, если он есть. */
      tokenKeys: (function () {
        try {
          var a = [];
          for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i) || '';
            if (/token/i.test(k)) a.push(k + '=' + String(localStorage.getItem(k)).slice(0, 80));
          }
          return a.join(' | ') || 'нет token-ключей';
        } catch (e) { return 'n/a'; }
      })(),
      lsKeys: (function () { try { var a = []; for (var i = 0; i < localStorage.length && i < 25; i++) a.push(localStorage.key(i)); return a.join(','); } catch (e) { return 'n/a'; } })(),
      cookieNames: (function () { try { return document.cookie.split(';').map(function (c) { return c.split('=')[0].trim(); }).filter(Boolean).slice(0, 25).join(','); } catch (e) { return 'n/a'; } })()
    });
  } catch (e) {
    return JSON.stringify({ ok: false, reason: 'probe_error' });
  }
})();
"#;

/// Похож ли ответ на настоящий access-токен soundcloud.
///
/// Форма фиксирована: `2-332396-1366999722-sKbZ4vNW6wdsB` — четыре
/// группы через дефис, все символы латинские буквы/цифры. Проверка
/// нужна потому, что пробник ходит по localStorage, а там на странице
/// входа, ДО авторизации, полно 20-символьных строк (csrf, session).
/// Rust проверяет повторно, хотя пробник уже отфильтровал: скрипт в
/// веб-вью — это код с чужой страницы, доверять ему нельзя.
fn looks_like_sc_token(s: &str) -> bool {
    if let Some(rest) = s.strip_prefix("eyJ") {
        let parts: Vec<&str> = rest.split('.').collect();
        return parts.len() == 3
            && parts.iter().all(|p| {
                !p.is_empty()
                    && p.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            });
    }
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 4
        && (1..=3).contains(&parts[0].len())
        && parts[0].bytes().all(|b| b.is_ascii_digit())
        && parts[1].len() >= 4
        && parts[2].len() >= 6
        && parts[3].len() >= 8
        && parts[1..]
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// Разбирает ответ пробника из веб-вью.
///
/// ⚠️ Здесь была причина того, что логин «находил» токен, но никогда не
/// заканчивался. `eval_with_callback` отдаёт результат eval уже
/// сериализованным в JSON, то есть наш объект приходит сериализованным
/// дважды: в логе это видно как `"{\"ok\":true,\"token\":\"...\"}"` — с
/// кавычками вокруг. Один `serde_json::from_str` давал не объект, а
/// `Value::String`, `v.get("ok")` возвращал None, `ok` всегда был false, и
/// цикл крутился до таймаута, всё время держа в руках готовый токен.
/// Поэтому: распарсили — если вышла строка, парсим ещё раз.
fn parse_probe(raw: &str) -> Option<Value> {
    let outer: Value = serde_json::from_str(raw).ok()?;
    match &outer {
        Value::String(inner) => serde_json::from_str(inner).ok().or(Some(outer)),
        _ => Some(outer),
    }
}

/// Токен из кук окна.
///
/// ⚠️ Это оказалось единственным рабочим путём. soundcloud держит access
/// token в **httpOnly-куке** (`oauth_token`), а её `document.cookie` из JS
/// не видит В ПРИНЦИПЕ — поэтому ни пробник, ни хук её не находят: в логе
/// было `hooked: true`, `tokenKeys: нет`, и логин висел до таймаута.
/// webview2 же видит все куки, включая httpOnly, — читаем их здесь, в rust.
/// Приоритет куке, в имени которой есть oauth/token; иначе берём любую,
/// чьё значение похоже на токен (форма фиксирована, см. looks_like_sc_token).
fn percent_decode_str(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Достаёт токен из произвольной строки: значение cookie может прийти в
/// кавычках или url-encoded, поэтому режем по всему, что не буква/цифра/дефис.
fn extract_token(s: &str) -> Option<String> {
    for chunk in s.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-')) {
        if looks_like_sc_token(chunk) {
            return Some(chunk.to_string());
        }
    }
    None
}

fn token_from_cookies(win: &tauri::WebviewWindow) -> Option<String> {
    let url = Url::parse("https://soundcloud.com/").ok()?;
    let cookies = win.cookies_for_url(url).ok()?;
    let c = cookies
        .into_iter()
        .find(|c| c.name().eq_ignore_ascii_case("oauth_token"))?;
    let raw = c.value();
    extract_token(raw).or_else(|| extract_token(&percent_decode_str(raw)))
}

/// Проверяет, что токен действительно рабочий: GET /me.
///
/// Зачем: в профиле webview может лежать СТАРАЯ `oauth_token` от прошлой
/// сессии. Раньше она принималась как успех, окно пряталось, а `/me`
/// отвечал 401 — снаружи это выглядело как «вошёл, но аккаунта нет».
/// Теперь явный 401/403 означает «токен не тот, ждём дальше», а сетевая
/// ошибка — «не смогли проверить», и токен принимается (иначе логин
/// ломался бы на машинах, где reqwest не видит сеть, а webview2 видит).
async fn token_verdict(client_id: &str, token: &str) -> Option<bool> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(SC_WRITE_UA)
        .build()
        .ok()?;
    let url = format!(
        "https://api-v2.soundcloud.com/me?client_id={}",
        percent_encode(client_id)
    );
    match client
        .get(url)
        .header("Authorization", format!("OAuth {token}"))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => Some(true),
        Ok(r) if r.status().as_u16() == 401 || r.status().as_u16() == 403 => Some(false),
        Ok(_) => Some(true),
        Err(_) => None,
    }
}

/// Открывает окно логина soundcloud и достаёт из его сессии рабочий токен.
///
/// Окно намеренно видимое: пользователь должен авторизоваться руками, и
/// electron-версия делала ровно то же (отдельный BrowserWindow). Скрытое
/// окно выглядело бы как «ничего не происходит».
pub async fn sc_login(app: &tauri::AppHandle, proxy_arg: Option<String>) -> Value {
    /* client_id НЕ ищем заранее отдельным запросом. Раньше логин на этом
       спотыкался: запрос к soundcloud.com с нашим User-Agent возвращал
       страницу без гидратации, discover_client_id отдавал None, и
       sc_login выходил с no_client_id, не открыв окно вообще. Теперь
       client_id берётся из уже загруженной страницы окна входа — там он
       гарантированно есть. Запасной вариант (из прошлых настроек)
       оставлен на случай, если хук не успеет вытащить токен. */
    let fallback_client_id = cached_client_id();
    if let Some(c) = fallback_client_id.as_deref() {
        settings::log(&format!("[sc-login] client_id из настроек: {c}"));
    } else {
        settings::log("[sc-login] client_id возьму из окна входа");
    }

    /* Прокси — ДО окна, и напрямую проверяем только когда прокси нет. Смысл:
       подменённый провайдером сертификат иначе виден лишь как окно с ошибкой,
       а в логе — пять минут тишины. Отказ на этом шаге возвращает код, по
       которому интерфейс говорит человеку, что делать. */
    let proxy = match proxy_arg.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        /* значение из интерфейса главнее настроек: на диск они уезжают с
           задержкой, и вписанный только что прокси мог ещё не сохраниться */
        Some(raw) => match parse_proxy(raw) {
            Some(u) => Some(u),
            None => {
                settings::log(&format!("[sc-login] прокси из настроек не разобрался: {raw}"));
                return json!({ "error": "proxy_invalid", "detail": raw });
            }
        },
        None => sc_proxy(),
    };
    if let Some(p) = proxy.as_ref() {
        settings::log(&format!("[sc-login] прокси: {p}"));
    } else {
        /* Проверка — ТОЛЬКО диагностика, а не ворота. Раньше отказ здесь
           закрывал логин ещё до открытия окна, и это ломало вход на чужих
           машинах: reqwest ходит напрямую со своим набором корневых
           сертификатов, а webview2 — через системные настройки прокси и
           системное хранилище корней. На машине с системным прокси (VPN),
           корпоративным или антивирусным MITM-сертификатом reqwest получает
           timeout/cert и отказывает, хотя окно входа открылось бы и работало
           нормально. Теперь ошибка только пишется в лог. */
        match check_site_direct().await {
            Ok(()) => settings::log("[sc-login] soundcloud.com отвечает напрямую"),
            Err(why) => settings::log(&format!(
                "[sc-login] прямая проверка не прошла ({why}) — окно всё равно открываю: \
                 webview2 и reqwest видят сеть по-разному"
            )),
        }
    }

    if let Some(w) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = w.close();
        /* Закрытие асинхронное: без паузы build() ниже падал с
           «webview with label `sc-login` already exists», если человек
           нажал «войти» повторно, не дождавшись закрытия прошлого окна. */
        tokio::time::sleep(Duration::from_millis(400)).await;
    }

    let mut builder = tauri::WebviewWindowBuilder::new(app, LOGIN_WINDOW, WebviewUrl::External(
        Url::parse("https://soundcloud.com/signin").expect("sc url"),
    ))
    .title("seWer — вход в SoundCloud")
    .inner_size(900.0, 700.0)
    /* Хук через initialization_script, а НЕ через eval после build().
       eval выполнялся один раз на старте окна, а первая же навигация
       (с about:blank на soundcloud.com) пересоздавала document и global —
       вместе с нашими обёртками. initialization_script гарантированно
       срабатывает на каждой загрузке ДО html и ДО скриптов сайта, то
       есть ровно тогда, когда нужно подменить fetch/XHR. */
    /* Хук вешаем во ВСЕХ фреймах: после входа soundcloud грузит api
       не с главной страницы, а с другого origin в iframe, и обычный
       initialization_script туда не попадает — перехват молчал. */
    .initialization_script_for_all_frames(HOOK_JS);

    /* Окно с прокси обязано жить в своём каталоге данных: webview2 не даёт
       двум окнам одного профиля разные аргументы браузера, а --proxy-server
       как раз такой аргумент. Без прокси всё остаётся как было — общий
       профиль, из которого окно и берёт уже существующую сессию. */
    if let Some(p) = proxy.clone() {
        builder = builder.data_directory(sc_profile_dir()).proxy_url(p);
    }

    let built = builder.build();

    if let Err(e) = built {
        settings::log(&format!("[sc-login] окно не открылось: {e}"));
        return json!({ "error": "window_failed", "detail": e.to_string() });
    }
    settings::log("[sc-login] окно входа открыто, жду авторизацию");

    /* eval_with_callback — единственный способ получить значение ИЗ
       веб-вью: обычный eval ничего не возвращает. Ответ приходит в
       callback, поэтому опрос делаем одним каналом на весь цикл:
       иначе каждый круг создаёт свой канал, и ответ, пришедший чуть
       позже LOGIN_POLL, никто не читает. */
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let deadline = tokio::time::Instant::now() + LOGIN_WAIT;
    let mut logged_once = false;
    let mut logged_parse_err = false;
    let mut logged_junk = false;
    let mut logged_no_cid = false;
    let mut polls = 0u32;
    /* чем кончился цикл, если токена так и не нашлось: интерфейс по этому
       коду отличает «человек передумал» от «не дождались» и «провайдер
       подсунул заглушку» — раньше на все случаи был null и тишина */
    let mut reason = "login_timeout";
    /* client_id, который успел дать пробник: нужен, если токен придёт из
       куки (см. token_from_cookies) — в самой куке client_id нет. */
    let mut last_client_id: Option<String> = None;
    /* токен, который уже проверен и отвергнут (401): повторно не принимаем,
       иначе каждый круг будет дёргать /me одним и тем же мёртвым токеном */
    let mut verified_reject = String::new();

    loop {
        if tokio::time::Instant::now() >= deadline {
            settings::log(&format!(
                "[sc-login] истекло время ожидания ({LOGIN_WAIT:?}), опросов {polls}"
            ));
            break;
        }
        let Some(win) = app.get_webview_window(LOGIN_WINDOW) else {
            settings::log(&format!(
                "[sc-login] окно закрыто пользователем, опросов было {polls}"
            ));
            reason = "login_closed";
            break;
        };

        /* Не читаем cookie на about:blank и на самой странице входа:
           старый oauth_token уже был в профиле до нового логина и из-за
           этого прежняя версия завершала вход слишком рано. */
        let sc_page = win.url().ok().is_some_and(|u| {
            u.scheme() == "https"
                && u.host_str().is_some_and(|h| h.eq_ignore_ascii_case("soundcloud.com"))
                && !u.path().starts_with("/signin")
                && !u.path().starts_with("/login")
        });
        if sc_page {
            /* Токен лежит в httpOnly-куке, а её JS не видит — читаем из rust. */
            if let Some(tok) = token_from_cookies(&win) {
                let cid = last_client_id
                    .clone()
                    .or(fallback_client_id.clone())
                    .or_else(|| cached_client_id());
                if let Some(cid) = cid {
                    /* Проверяем токен ДО успеха: в профиле может лежать
                       старая oauth_token от прошлой сессии, и без проверки
                       вход «удавался», а /me отвечал 401. */
                    if tok != verified_reject {
                        match token_verdict(&cid, &tok).await {
                            Some(false) => {
                                if verified_reject.is_empty() {
                                    settings::log(
                                        "[sc-login] oauth_token в профиле не рабочий (401) — жду новый",
                                    );
                                    verified_reject = tok.clone();
                                }
                            }
                            _ => {
                                settings::log(&format!(
                                    "[sc-login] ТОКЕН ИЗ oauth_token ({} симв.), client_id={cid}",
                                    tok.len()
                                ));
                                let _ = win.hide();
                                return json!({ "token": tok, "clientId": cid });
                            }
                        }
                    }
                }
            }
        }

        /* Где сейчас окно. Два повода: в логе видно, дошло ли оно до страницы
           входа (без этого диагноз «не логинится» неотличим от «окно пустое»),
           и видно заглушку провайдера — она уводит окно на чужой хост, где
           токена не будет никогда. */
        if polls % 25 == 0 {
            if let Ok(u) = win.url() {
                settings::log(&format!("[sc-login] окно на {u}"));
                let host = u.host_str().unwrap_or_default().to_lowercase();
                if u.scheme() == "chrome-error"
                    || host.contains("megafonpro")
                    || host.contains("rkn")
                {
                    settings::log("[sc-login] окно попало на заглушку провайдера");
                    let _ = win.close();
                    return json!({ "error": "site_blocked", "detail": u.to_string() });
                }
            }
            /* имена ВСЕХ кук окна, включая httpOnly: если oauth_token тут
               есть, а логин не завершился — значит его значение не прошло
               looks_like_sc_token. Печатаем и значения token-кук, иначе
               причину не видно: в логе были только имена. */
            if let Ok(cs) = win.cookies_for_url(Url::parse("https://soundcloud.com/").expect("sc url")) {
                let names: Vec<String> = cs.iter().map(|c| c.name().to_string()).collect();
                settings::log(&format!("[sc-login] куки окна: {}", names.join(",")));
                /* только длина и первые 8 символов: это живой секрет, в лог
                   его целиком писать нельзя, а по префиксу уже видно, JWT
                   там (eyJ…) или старый формат токена */
                for c in &cs {
                    let n = c.name().to_ascii_lowercase();
                    if n.contains("oauth") || n.contains("token") {
                        let v = c.value();
                        settings::log(&format!(
                            "[sc-login] кука {} (len {}, вид {})",
                            c.name(),
                            v.len(),
                            if looks_like_sc_token(v) { "token" } else { "не token" }
                        ));
                    }
                }
            }
        }

        let tx = tx.clone();
        /* Падение eval — это норма: страница сейчас перерисовывается.
           Раньше тут был break, и логин умирал на первой же навигации
           (blank → signin), то есть всегда. Теперь просто ждём дальше. */
        if win
            .eval_with_callback(PROBE_JS, move |raw| {
                let _ = tx.send(raw);
            })
            .is_err()
        {
            polls += 1;
            tokio::time::sleep(LOGIN_POLL).await;
            continue;
        }
        polls += 1;

        match tokio::time::timeout(LOGIN_POLL, rx.recv()).await {
            Ok(Some(raw)) => {
                match parse_probe(&raw) {
                    Some(v) => {
                        /* запоминаем client_id: если токен придёт из куки,
                           взять его будет больше неоткуда */
                        if let Some(c) = v
                            .get("clientId")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                        {
                            last_client_id = Some(c.to_string());
                        }
                        let ok = v.get("ok").and_then(Value::as_bool).unwrap_or(false);
                        /* логируем не каждый, а каждый сотый ответ: внутри
                           видно url страницы, ключи localStorage и куки — по
                           ним понятно, вошёл пользователь или нет и где лежит
                           токен. Писать чаще незачем: ответ идёт в лог только
                           для диагностики, а токен мы всё равно логируем
                           отдельной строкой. */
                        if !ok {
                            /* логируем не каждый, а каждый 25-й: внутри
                               видно url страницы, token-ключи и куки — по ним
                               понятно, вошёл пользователь или нет и где лежит
                               токен. #1 показывал только страницу входа, а
                               discover наступал на 50-м опросе — и в лог не
                               попадал. Писать чаще незачем: ответ идёт в лог
                               только для диагностики, а токен мы всё равно
                               логируем отдельной строкой. */
                            if polls % 25 == 1 {
                                settings::log(&format!("[sc-login] опрос #{polls}: {raw}"));
                            }
                        } else if !logged_once {
                            settings::log("[sc-login] первый успешный опрос");
                            logged_once = true;
                        }
                        if ok {
                            let token =
                                v.get("token").and_then(Value::as_str).unwrap_or("").to_string();
                            if !looks_like_sc_token(&token) {
                                /* Мусор из localStorage. Не fatal: настоящий
                                   токен придёт позже, продолжаем ждать. */
                                if !logged_junk {
                                    settings::log(&format!(
                                        "[sc-login] ответ непохож на токен, ждём дальше: {token}"
                                    ));
                                    logged_junk = true;
                                }
                            } else {
                                let cid = v
                                    .get("clientId")
                                    .and_then(Value::as_str)
                                    .filter(|s| !s.is_empty())
                                    .map(str::to_string)
                                    .or(fallback_client_id.clone())
                                    .or_else(|| cached_client_id());
                                match cid {
                                    Some(cid) => {
                                        settings::log(&format!(
                                            "[sc-login] ТОКЕН ПОЛУЧЕН, client_id={cid}, длина {}",
                                            token.len()
                                        ));
                                        /* Прячем, а НЕ закрываем. Это окно
                                           теперь транспорт для write-запросов:
                                           DataDome режет PUT из reqwest, а
                                           fetch из этой страницы уходит с
                                           настоящими куками. Закроем — и
                                           сессии больше не будет. */
                                        if let Some(w) = app.get_webview_window(LOGIN_WINDOW) {
                                            let _ = w.hide();
                                        }
                                        return json!({ "token": token, "clientId": cid });
                                    }
                                    None => {
                                        /* Токен настоящий, а client_id ещё нет.
                                           Раньше здесь был `break` — логин
                                           сдавался на первом же таком ответе.
                                           Правильно ждать: client_id лежит в
                                           гидратации страницы, хук читает её
                                           на DOMContentLoaded и страхуется
                                           таймерами на 1.5с и 4с, то есть
                                           догоняет токен за доли секунды. */
                                        if !logged_no_cid {
                                            settings::log(&format!(
                                                "[sc-login] токен получен ({} симв.), ждём client_id",
                                                token.len()
                                            ));
                                            logged_no_cid = true;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    None => {
                        if !logged_parse_err {
                            settings::log(&format!("[sc-login] ответ не распарсился: {raw}"));
                            logged_parse_err = true;
                        }
                    }
                }
            }
            Ok(None) => {
                settings::log("[sc-login] канал опроса закрылся");
                reason = "login_interrupted";
                break;
            }
            /* таймаут: веб-вью ещё грузится, ответа не было за LOGIN_POLL —
               пауза уже отработала внутри timeout(), не спим ещё раз */
            Err(_) => { continue; }
        }
        /* Пауза после успешно прочитанного ответа: ограничиваем частоту
           опросов. При таймауте выше — continue, сюда не доходим. */
        tokio::time::sleep(LOGIN_POLL).await;
    }

    if let Some(w) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = w.close();
    }
    settings::log(&format!(
        "[sc-login] завершился без токена ({reason}), опросов {polls}"
    ));
    json!({ "error": reason })
}

/// Настоящий выход из soundcloud.
///
/// Раньше «выйти» стирало только токен из настроек, а окно-сессия продолжало
/// жить со своими куками: следующий вход проходил БЕЗ пароля, и войти под
/// другим аккаунтом было нельзя вообще. Здесь закрываем окно и убираем сессию:
///
/// * окно с прокси живёт в своём каталоге (`sc-webview`) — удаляем каталог;
/// * окно в общем профиле — удаляем только куки домена soundcloud, чтобы не
///   тронуть localStorage интерфейса (в нём история поиска).
pub async fn sc_logout(app: &tauri::AppHandle) -> Value {
    if let Some(w) = app.get_webview_window(LOGIN_WINDOW) {
        /* перед закрытием чистим localStorage soundcloud в окне сессии —
           иначе сайт восстанавливает сессию при следующем открытии */
        let _ = w.eval("try{localStorage.clear();}catch(e){}");
        tokio::time::sleep(Duration::from_millis(200)).await;
        let _ = w.close();
    }
    /* окно закрывается не мгновенно, а webview2 держит файлы профиля, пока жив
       его процесс: без паузы remove_dir_all упирается в занятый файл */
    tokio::time::sleep(Duration::from_millis(800)).await;

    let dir = sc_profile_dir();
    let mut profile_removed = false;
    let mut profile_detail = String::new();
    if dir.exists() {
        for _ in 0..20 {
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => { profile_removed = true; break; }
                Err(e) => {
                    profile_detail = e.to_string();
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            }
        }
        settings::log(&format!(
            "[sc-logout] профиль окна: удалён={profile_removed}{}",
            if profile_removed { String::new() } else { format!(" ({profile_detail})") }
        ));
    }

    /* куки чистим всегда — и когда был отдельный профиль, и когда общий.
       Раньше был early-return после удаления каталога, из-за чего куки
       в общем профиле не удалялись никогда. */
    let cookies_deleted = match app.get_webview_window("main") {
        None => {
            settings::log("[sc-logout] главное окно не найдено, куки не почищены");
            0u32
        }
        Some(main) => {
            let mut deleted = 0u32;
            for u in ["https://soundcloud.com/", "https://api-v2.soundcloud.com/"] {
                let Ok(url) = Url::parse(u) else { continue };
                match main.cookies_for_url(url) {
                    Ok(list) => {
                        for c in list {
                            if main.delete_cookie(c).is_ok() { deleted += 1; }
                        }
                    }
                    Err(e) => settings::log(&format!("[sc-logout] куки не прочитать: {e}")),
                }
            }
            deleted
        }
    };
    settings::log(&format!("[sc-logout] удалено кук soundcloud: {cookies_deleted}"));
    json!({
        "profileRemoved": profile_removed,
        "cookiesDeleted": cookies_deleted,
        "detail": profile_detail
    })
}

// ── запись через живую страницу soundcloud ─────────────────────────────────

/// Окно входа после успешного логина НЕ закрывается, а прячется: через него
/// теперь идут все write-запросы. Причина — DataDome: `PUT` из reqwest
/// получает 403 с капчей, а `fetch` из самой страницы soundcloud уходит с
/// настоящими куками и настоящим TLS-отпечатком. Проверено экспериментом:
/// GET/POST/DELETE из rust проходят, PUT — нет, и куками это не лечится.
const WRITE_JS: &str = r#"
(function () {
  /* fetch асинхронный, а eval результата промиса не дожидается — поэтому
     мы НЕ возвращаем ответ, а кладём его в window.__sewerWrite и читаем
     вторым eval'ом. Один и тот же id защищает от гонки, если запросов
     пришло два. */
  var id = __ID__;
  var url = __URL__;
  var method = __METHOD__;
  /* Тело подставляется СТРОКОЙ, а не объектом. fetch с телом-объектом
     приводит его через String(obj) и отправляет буквально "[object Object]" —
     soundcloud отвечал на это 400 «Unable to parse JSON», и выглядело это
     как «прислали не тот json», хотя тело просто исчезло по дороге. */
  var body = __BODY__;
  var token = __TOKEN__;
  var ct = __CT__;
  window.__sewerWrite = { id: id, status: 0, text: '', sent: 0, done: false };
  (async function () {
    try {
      var h = { 'Accept': 'application/json, text/javascript, */*; q=0.01' };
      if (token) h['Authorization'] = 'OAuth ' + token;
      if (body !== null) h['Content-Type'] = ct || 'application/json';
      var res = await fetch(url, {
        method: method, headers: h, credentials: 'include',
        body: (method === 'GET' || method === 'HEAD' || body === null)
          ? undefined : body
      });
      var text = await res.text();
      /* sent — сколько байт тела ушло на самом деле. Раньше эту ошибку
         приходилось вычислять умозрительно; теперь видно сразу, что тело
         дошло или что ушло вместо него "[object Object]". */
      window.__sewerWrite = {
        id: id, status: res.status, text: text.slice(0, 8000),
        sent: body === null ? 0 : body.length, done: true
      };
    } catch (e) {
      window.__sewerWrite = {
        id: id, status: 0, done: true, sent: -1,
        text: 'fetch failed: ' + ((e && e.message) || e)
      };
    }
  })();
  return 'started';
})();
"#;

/// Второй шаг: забрать ответ, если он появился.
const WRITE_POLL_JS: &str = r#"
(function () {
  var w = window.__sewerWrite;
  if (!w || w.id !== __ID__ || !w.done) return 'wait';
  return JSON.stringify({ status: w.status, text: w.text, sent: w.sent });
})();
"#;

/// Убеждается, что окно входа есть, и оно не на экране. Если его закрыли —
/// пересоздаём скрытым: сессия в куках переживает пересоздание (проверено —
/// повторный запуск находит токен без нового входа).
fn ensure_page_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    /* Видимостью не трогаем: окно прячется в sc_login сразу после получения
       токена, а если пользователь закрыл его руками — мы просто создаём
       новое скрытым. Раньше здесь стояло show()+hide() «на всякий случай»,
       и это моргало окном перед каждым сохранением. */
    if let Some(w) = app.get_webview_window(LOGIN_WINDOW) {
        return Some(w);
    }
    settings::log("[sc-write] окно входа закрыли — пересоздаю скрытым");
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        LOGIN_WINDOW,
        WebviewUrl::External(Url::parse("https://soundcloud.com/").ok()?),
    )
    .title("seWer — сессия soundcloud")
    .inner_size(900.0, 700.0)
    .visible(false)
    .initialization_script_for_all_frames(HOOK_JS);
    /* Ровно та же конфигурация, что у окна входа (см. sc_login): иначе
       профиль другой, сессии в нём нет, и write-запрос уходит без кук.
       С прокси — свой каталог и тот же прокси; без прокси — общий профиль. */
    if let Some(p) = sc_proxy() {
        builder = builder.data_directory(sc_profile_dir()).proxy_url(p);
    }
    let built = builder.build();
    match built {
        Ok(w) => Some(w),
        Err(e) => {
            settings::log(&format!("[sc-write] не пересоздать окно: {e}"));
            None
        }
    }
}

/// Выполняет write-запрос из контекста страницы soundcloud.
async fn sc_write_via_page(
    app: &tauri::AppHandle,
    state: &ScState,
    method: &str,
    url: &str,
    token: &str,
    body: Option<&Value>,
    content_type: Option<&str>,
) -> Option<Value> {
    /* один write за раз: два параллельных eval'а в одном webview перемешали бы
       ответы, а квота у soundcloud всё равно не даёт писать чаще, чем раз в
       1.5с */
    let _turn = state.page_write.lock().await;

    let win = ensure_page_window(app)?;
    let id = format!("{:x}", nano_now());
    let body_json = body
        .map(|b| serde_json::to_string(b).unwrap_or_else(|_| "null".into()))
        .unwrap_or_else(|| "null".into());
    /* Тело вставляется в js КАК СТРОКА (json_str оборачивает в кавычки).
       Раньше подставлялся голый json, то есть в скрипте получался объект,
       а fetch отправлял String(obj) = "[object Object]" — отсюда 400
       «Unable to parse JSON» при вроде бы правильном теле. */
    settings::log(&format!(
        "[sc-write] {method} {} — тело {} байт, ct={}",
        url.replace("https://api-v2.soundcloud.com", ""),
        body_json.len(),
        content_type.unwrap_or("application/json")
    ));
    let js = WRITE_JS
        .replace("__ID__", &json_str(&id))
        .replace("__URL__", &json_str(url))
        .replace("__METHOD__", &json_str(method))
        .replace("__BODY__", &json_str(&body_json))
        .replace("__TOKEN__", &json_str(token))
        .replace("__CT__", &json_str(content_type.unwrap_or("application/json")));

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    if win.eval_with_callback(&js, move |raw| {
        let _ = tx.send(raw);
    }).is_err() {
        settings::log("[sc-write] старт запроса из страницы не удался (окно грузится?)");
        return None;
    }
    /* ответ на старт нам не нужен, но канал должен получить хоть что-то,
       иначе первый опрос ниже провиснет на таймауте */
    let _ = tokio::time::timeout(Duration::from_millis(200), rx.recv()).await;

    let poll = WRITE_POLL_JS.replace("__ID__", &json_str(&id));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
    loop {
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        if win.eval_with_callback(&poll, move |raw| {
            let _ = tx.send(raw);
        }).is_err() {
            return None;
        }
        let raw = match tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
            Ok(Some(r)) => r,
            _ => {
                if tokio::time::Instant::now() >= deadline {
                    settings::log("[sc-write] ответ из страницы не пришёл за 25с");
                    return None;
                }
                continue;
            }
        };
        /* Пробник отдаёт 'wait', пока ответа нет. Это строка, а json-объект,
           и разбирать её через parse_probe нельзя: получился бы
           Value::String без полей status/text, и write сдался бы с нулевым
           статусом на самой первой попытке, ни разу не дождавшись ответа. */
        if raw.contains("wait") && !raw.contains("status") {
            continue;
        }
        let Some(v) = parse_probe(&raw) else { continue };
        if v.get("status").is_none() {
            continue;
        }
        let status = v.get("status").and_then(Value::as_u64).unwrap_or(0) as u16;
        let sent = v.get("sent").and_then(Value::as_i64).unwrap_or(-2);
        let text = v
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        settings::log(&format!(
            "[sc-write] {method} {} из страницы → {status}, отправлено {sent} байт тела",
            url.replace("https://api-v2.soundcloud.com", "")
        ));
        if status == 0 {
            return None;
        }
        return Some(finish(status, &text, None, url.to_string()));
    }
}

/// json-строка для подстановки в js: кавычки и переводы строк внутри url или
/// тела не должны ломать скрипт
fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

fn nano_now() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

struct MultipartField {
    name: String,
    value: String,
}

struct MultipartFile {
    name: String,
    filename: String,
    mime: String,
    b64: String,
}

/// Собираем multipart вручную, boundary задаём сами — так же, как в
/// electron-версии. ВНИМАНИЕ: обложка плейлиста multipart'ом НЕ грузится —
/// soundcloud ждёт json {image_data: base64} на .../artwork. Ветка остаётся
/// на будущее для других файловых загрузок.
fn build_body(
    body: Option<&Value>,
    content_type: Option<&str>,
) -> (Option<Vec<u8>>, Option<String>) {
    let Some(body) = body.filter(|v| !v.is_null()) else {
        return (None, content_type.map(str::to_string));
    };

    let multipart = body.get("__multipart");
    if let Some(mp) = multipart {
        let boundary = format!(
            "----seWer{}{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
            std::process::id()
        );
        let mut out: Vec<u8> = Vec::new();
        let push = |out: &mut Vec<u8>, s: &str| out.extend_from_slice(s.as_bytes());

        if let Some(fields) = mp.get("fields").and_then(Value::as_array) {
            for f in fields {
                let field = MultipartField {
                    name: f.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                    value: f.get("value").and_then(Value::as_str).unwrap_or("").to_string(),
                };
                push(
                    &mut out,
                    &format!(
                        "--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"\r\n\r\n{}\r\n",
                        field.name, field.value
                    ),
                );
            }
        }
        if let Some(file) = mp.get("file") {
            let f = MultipartFile {
                name: file.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                filename: file
                    .get("filename")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .replace(['"', '\\'], ""),
                mime: file.get("mime").and_then(Value::as_str).unwrap_or("").to_string(),
                b64: file.get("b64").and_then(Value::as_str).unwrap_or("").to_string(),
            };
            push(
                &mut out,
                &format!(
                    "--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n",
                    f.name, f.filename, f.mime
                ),
            );
            use base64::Engine;
            if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(f.b64.as_bytes()) {
                out.extend_from_slice(&bytes);
            }
            push(&mut out, &format!("\r\n--{boundary}--\r\n"));
        }
        let ct = format!("multipart/form-data; boundary={boundary}");
        return (Some(out), Some(ct));
    }

    match body {
        Value::String(s) => (Some(s.clone().into_bytes()), content_type.map(str::to_string)),
        other => (
            Some(serde_json::to_vec(other).unwrap_or_default()),
            Some(content_type.unwrap_or("application/json").to_string()),
        ),
    }
}

fn is_write(method: &str) -> bool {
    matches!(method, "PUT" | "DELETE" | "POST")
}

/// sc-fetch. Возвращает `{data}` либо `{error, …}` — формы совпадают с
/// electron-версией, рендерер их разбирает сам.
///
/// Write-запросы сначала уходят через живую страницу soundcloud (см.
/// `sc_write_via_page`): DataDome режет `PUT` из reqwest, а `fetch` из
/// страницы уходит с настоящими куками. Откат на прямой путь нужен для
/// случая, когда окна ещё нет (логин не проходил) — тогда сработает
/// прежнее поведение, чтобы не ломать то, что работало.
pub async fn sc_fetch(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    state: &ScState,
    url: &str,
    token: &str,
    client_id: &str,
    method: &str,
    body: Option<Value>,
    content_type: Option<String>,
) -> Value {
    let write = is_write(method);
    /* app_version/app_locale — как у веб-клиента sc (из HAR рабочего PUT) */
    let full_url = if url.contains("client_id=") {
        url.to_string()
    } else {
        format!(
            "{url}{sep}client_id={cid}{tail}",
            sep = if url.contains('?') { "&" } else { "?" },
            cid = percent_encode(client_id),
            tail = if write { "&app_version=1787325861&app_locale=en" } else { "" }
        )
    };

    if write {
        if let Some(done) = sc_write_via_page(
            app,
            state,
            method,
            &full_url,
            token,
            body.as_ref(),
            content_type.as_deref(),
        )
        .await
        {
            return done;
        }
        settings::log("[sc-write] через страницу не вышло, пробую прямой запрос");
    }

    let (body_bytes, ct) = build_body(body.as_ref(), content_type.as_deref());

    if write {
        if !state.wait_turn().await {
            settings::log(&format!(
                "[sc-write] {method} {full_url}\n   → отложен: write заблокирован после 403/429"
            ));
            return json!({
                "error": 429,
                "body": "write backoff (после 403/429 ждём минуту)",
                "blocked": true
            });
        }

        let mut req = client
            .request(
                reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET),
                &full_url,
            )
            .header("Authorization", format!("OAuth {token}"))
            .header("Accept", "application/json, text/javascript, */*; q=0.01")
            .header("Origin", SC_API_ORIGIN)
            .header("Referer", format!("{SC_API_ORIGIN}/"))
            .header("User-Agent", SC_WRITE_UA);
        /* Content-Type только с телом: follow/unfollow идут без тела,
           а json-тип без тела sc пытается парсить → 400 (по HAR сайта) */
        if let Some(ct) = ct.as_deref() {
            req = req.header("Content-Type", ct);
        }
        if let Some(dd) = state.datadome() {
            req = req.header("x-datadome-clientid", dd);
        }
        if let Some(bytes) = body_bytes {
            req = req.body(bytes);
        }

        let res = match req.send().await {
            Ok(res) => res,
            Err(e) => return json!({ "error": e.to_string() }),
        };
        state.set_datadome(datadome_from(&res));
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();

        if status == 403 || status == 429 {
            state.block_writes();
            settings::log(&format!(
                "[sc-write] {method} {full_url}\n   → {status} (заблокировали write на {WRITE_BLOCK:?})\n   {}",
                truncate(&text.replace('\n', " "), 240)
            ));
            return json!({
                "error": status,
                "body": truncate(&text, 600),
                "blocked": true,
                "sentCT": ct,
                "sentURL": full_url
            });
        }
        if !(200..=299).contains(&status) {
            /* Пишущий запрос, который не прошёл, но и не 403. Раньше он
               уходил в рендерер молча, и «ничего не сохраняется» приходилось
               угадывать: data-dome, неверный content-type, 404 на методе —
               всё выглядело одинаково. */
            settings::log(&format!(
                "[sc-write] {method} {full_url}\n   → {status}, ct={ct:?}\n   {}",
                truncate(&text.replace('\n', " "), 240)
            ));
        }
        return finish(status, &text, ct, full_url);
    }

    let req = client
        .request(
            reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET),
            &full_url,
        )
        .header("Authorization", format!("OAuth {token}"))
        .header("Accept", "application/json")
        .header("User-Agent", "Mozilla/5.0")
        .header(reqwest::header::CONTENT_LENGTH, "0");

    match req.send().await {
        Ok(res) => {
            state.set_datadome(datadome_from(&res));
            let status = res.status().as_u16();
            let text = res.text().await.unwrap_or_default();
            /* тот же аргумент, что и для write: неуспешный GET к api sc
               возвращал рендереру {error} без следа, и список плейлистов
               просто оказывался пустым */
            if !(200..=299).contains(&status) {
                settings::log(&format!(
                    "[sc-get] {method} {full_url}\n   → {status}\n   {}",
                    truncate(&text.replace('\n', " "), 200)
                ));
            }
            finish(status, &text, None, full_url)
        }
        Err(e) => json!({ "error": e.to_string() }),
    }
}

fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn finish(status: u16, text: &str, ct: Option<String>, url: String) -> Value {
    if status != 200 && status != 201 && status != 204 {
        return json!({
            "error": status,
            "body": truncate(text, 600),
            "sentCT": ct,
            "sentURL": url
        });
    }
    if text.trim().is_empty() {
        return json!({ "data": Value::Null });
    }
    match serde_json::from_str::<Value>(text) {
        Ok(data) => json!({ "data": data }),
        Err(_) => json!({ "error": "parse_error" }),
    }
}
