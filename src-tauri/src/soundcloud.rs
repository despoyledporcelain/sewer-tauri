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

const SC_WRITE_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64.64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
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
      if (h) {
        var s = JSON.stringify(h);
        var m = /"hydratable"\s*:\s*"apiClient"\s*,\s*"data"\s*:\s*\{\s*"id"\s*:\s*"([A-Za-z0-9]{16,})"/.exec(s);
        if (m) { window.__sewerClientId = m[1]; return; }
      }
    } catch (e) {}
    try {
      var m2 = /client_id=([A-Za-z0-9]{16,})/.exec(document.documentElement.innerHTML || '');
      if (m2) window.__sewerClientId = m2[1];
    } catch (e) {}
  };

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
  var TOKEN_RE = /^[0-9]{1,3}-[0-9]{4,}-[0-9]{6,}-[A-Za-z0-9]{8,}$/;
  var looksLikeToken = function (s) { return !!s && TOKEN_RE.test(s); };

  try {
    var token = window.__sewerToken;
    if (looksLikeToken(token)) {
      return JSON.stringify({ ok: true, token: token, clientId: window.__sewerClientId || null });
    }

    /* запасной путь: пробуем достать токен из localStorage и из кук —
       site кладёт access token в оба места после oauth */
    var fromStore = null;
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        var v = localStorage.getItem(k) || '';
        var m = /"?(?:accessToken|access_token|oauthToken)"?\s*[:=]\s*"([0-9]{1,3}-[0-9]{4,}-[0-9]{6,}-[A-Za-z0-9]{8,})"/.exec(v);
        if (m && looksLikeToken(m[1])) { fromStore = m[1]; break; }
      }
    } catch (e) {}
    if (!fromStore) {
      try {
        var m2 = /(?:accessToken|access_token|oauthToken)=([0-9]{1,3}-[0-9]{4,}-[0-9]{6,}-[A-Za-z0-9]{8,})/.exec(document.cookie);
        if (m2 && looksLikeToken(m2[1])) fromStore = m2[1];
      } catch (e) {}
    }
    if (fromStore) {
      return JSON.stringify({ ok: true, token: fromStore, clientId: window.__sewerClientId || null, via: 'store' });
    }

    return JSON.stringify({
      ok: false,
      reason: 'no_token',
      clientId: window.__sewerClientId || null,
      /* диагностика: что вообще видно на этой странице */
      url: String(location.href).slice(0, 120),
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
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 4
        && parts.iter().all(|p| {
            !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric())
        })
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

/// Открывает окно логина soundcloud и достаёт из его сессии рабочий токен.
///
/// Окно намеренно видимое: пользователь должен авторизоваться руками, и
/// electron-версия делала ровно то же (отдельный BrowserWindow). Скрытое
/// окно выглядело бы как «ничего не происходит».
pub async fn sc_login(app: &tauri::AppHandle) -> Value {
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

    if let Some(w) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = w.close();
    }

    let built = tauri::WebviewWindowBuilder::new(app, LOGIN_WINDOW, WebviewUrl::External(
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
    .initialization_script_for_all_frames(HOOK_JS)
    .build();

    if let Err(e) = built {
        settings::log(&format!("[sc-login] окно не открылось: {e}"));
        return json!({ "error": "window_failed" });
    }
    settings::log("[sc-login] окно входа открыто, жду авторизацию");

    /* eval_with_callback — единственный способ получить значение ИЗ
       веб-вью: обычный eval ничего не возвращает. Ответ приходит в
       callback, поэтому опрос делаем каналом. */
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let deadline = tokio::time::Instant::now() + LOGIN_WAIT;
    let mut logged_once = false;
    let mut logged_parse_err = false;
    let mut logged_junk = false;
    let mut logged_no_cid = false;
    let mut polls = 0u32;

    loop {
        if tokio::time::Instant::now() >= deadline {
            settings::log(&format!(
                "[sc-login] истекло время ожидания ({LOGIN_WAIT:?}), опросов {polls}"
            ));
            break;
        }
        if !app.get_webview_window(LOGIN_WINDOW).is_some() {
            settings::log(&format!(
                "[sc-login] окно закрыто пользователем, опросов было {polls}"
            ));
            break;
        }

        let Some(win) = app.get_webview_window(LOGIN_WINDOW) else {
            break;
        };
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
                        let ok = v.get("ok").and_then(Value::as_bool).unwrap_or(false);
                        /* логируем не каждый, а каждый сотый ответ: внутри
                           видно url страницы, ключи localStorage и куки — по
                           ним понятно, вошёл пользователь или нет и где лежит
                           токен. Писать чаще незачем: ответ идёт в лог только
                           для диагностики, а токен мы всё равно логируем
                           отдельной строкой. */
                        if !ok {
                            if polls % 100 == 1 {
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
                break;
            }
            Err(_) => { /* окно ещё грузится — ждём следующий круг */ }
        }
        /* Пауза обязательна в конце КАЖДОГО круга, а не только когда
           eval упал. Раньше её здесь не было, и если веб-вью отвечало
           быстро (а оно отвечает за миллисекунды, токен лежит в
           localStorage) цикл крутился без тормозов: 67 тысяч опросов
           за 8 минут и мегабайт лога. */
        tokio::time::sleep(LOGIN_POLL).await;
    }

    if let Some(w) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = w.close();
    }
    settings::log(&format!(
        "[sc-login] завершился без токена, опросов {polls}"
    ));
    Value::Null
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
    let built = tauri::WebviewWindowBuilder::new(
        app,
        LOGIN_WINDOW,
        WebviewUrl::External(Url::parse("https://soundcloud.com/").ok()?),
    )
    .title("seWer — сессия soundcloud")
    .inner_size(900.0, 700.0)
    .visible(false)
    .initialization_script_for_all_frames(HOOK_JS)
    .build();
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
