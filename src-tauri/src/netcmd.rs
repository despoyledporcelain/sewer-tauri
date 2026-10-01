//! net-fetch: прямой https к сторонним сервисам.
//!
//! Отдельный канал от sc-fetch: там soundcloud-сессия с DataDome-кукой и
//! client_id в url. Здесь — обычный GET без куок, с браузерным User-Agent
//! (lrclib.net отвечает 403 на пустой/нечеловеческий UA, genius.com не
//! отдаёт CORS-заголовки, поэтому из рендерера напрямую не уехать).
//! Отдаём сырой текст: genius отвечает HTML, который разбирает рендерер.
//! Хосты зафиксированы — иначе это просто открытый прокси наружу.

use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};
use url::Url;

const NET_FETCH_HOSTS: [&str; 2] = ["lrclib.net", "genius.com"];
const NET_FETCH_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const NET_FETCH_TIMEOUT: Duration = Duration::from_secs(12);

pub async fn net_fetch(
    client: &reqwest::Client,
    url: &str,
    headers: HashMap<String, String>,
) -> Value {
    let Ok(parsed) = Url::parse(url) else {
        return json!({ "error": "bad_url" });
    };
    if parsed.scheme() != "https" || !NET_FETCH_HOSTS.contains(&parsed.host_str().unwrap_or("")) {
        return json!({ "error": "host_not_allowed" });
    }

    let mut req = client
        .get(parsed)
        .header("User-Agent", NET_FETCH_UA)
        .header("Accept-Language", "en-US,en;q=0.9");
    for (k, v) in headers {
        req = req.header(k, v);
    }

    let res = match tokio::time::timeout(NET_FETCH_TIMEOUT, req.send()).await {
        Ok(Ok(res)) => res,
        Ok(Err(e)) => return json!({ "error": e.to_string() }),
        Err(_) => return json!({ "error": "timeout" }),
    };

    let status = res.status().as_u16();
    match res.text().await {
        Ok(body) => json!({ "status": status, "body": body }),
        Err(e) => json!({ "error": e.to_string() }),
    }
}
