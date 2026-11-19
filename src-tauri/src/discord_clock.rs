//! Fresh HTTP time samples. A cached Date must never become the RPC clock.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures_util::stream::{FuturesUnordered, StreamExt};

fn local_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64).unwrap_or(0)
}

pub fn parse_http_date(s: &str) -> Option<i64> {
    let rest = s.trim().split_once(", ")?.1;
    let mut parts = rest.split(' ');
    let day: i64 = parts.next()?.parse().ok()?;
    let month: i64 = match parts.next()? {
        "Jan" => 1, "Feb" => 2, "Mar" => 3, "Apr" => 4, "May" => 5, "Jun" => 6,
        "Jul" => 7, "Aug" => 8, "Sep" => 9, "Oct" => 10, "Nov" => 11, "Dec" => 12,
        _ => return None,
    };
    let year: i64 = parts.next()?.parse().ok()?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month { 2 => if leap { 29 } else { 28 }, 4 | 6 | 9 | 11 => 30, _ => 31 };
    let mut hms = parts.next()?.split(':');
    let h: i64 = hms.next()?.parse().ok()?;
    let m: i64 = hms.next()?.parse().ok()?;
    let sec: i64 = hms.next()?.parse().ok()?;
    if hms.next().is_some() || parts.next()? != "GMT" || parts.next().is_some()
        || !(0..=9999).contains(&year) || !(1..=max_day).contains(&day)
        || !(0..=23).contains(&h) || !(0..=59).contains(&m) || !(0..=60).contains(&sec) {
        return None;
    }
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    Some(days * 86_400 + h * 3_600 + m * 60 + sec)
}

async fn sample(http: reqwest::Client, host: &'static str) -> Option<i64> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let t0 = local_ms();
    let started = Instant::now();
    // no-cache alone does not bypass Discord's CDN (observed: Date six hours old).
    let url = format!("{host}?sewer_clock={t0}-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
    let response = tokio::time::timeout(Duration::from_secs(4), http.head(url)
        .header(reqwest::header::CACHE_CONTROL, "no-cache, no-store")
        .header(reqwest::header::PRAGMA, "no-cache").send()).await.ok()?.ok()?;
    let elapsed = started.elapsed().as_millis() as i64;
    let t1 = local_ms();
    if elapsed > 5_000 || t1.saturating_sub(t0).saturating_sub(elapsed).unsigned_abs() > 250 { return None; }
    let headers = response.headers();
    for name in ["cf-cache-status", "x-cache"] {
        let value = headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
        if value.contains("hit") || value.contains("stale") { return None; }
    }
    if let Some(age) = headers.get(reqwest::header::AGE) {
        if age.to_str().ok()?.parse::<u64>().ok()? != 0 { return None; }
    }
    let server_ms = parse_http_date(headers.get(reqwest::header::DATE)?.to_str().ok()?)?
        .saturating_mul(1000).saturating_add(500);
    Some(t0.saturating_add(elapsed / 2).saturating_sub(server_ms))
}

fn consensus(samples: &[(usize, i64)]) -> Option<i64> {
    // Each origin gets one vote. Never average two unrelated clusters into a
    // fictitious time, as the old four-fastest-samples median did.
    let mut sorted = samples.to_vec();
    sorted.sort_unstable_by_key(|(_, offset)| *offset);
    let mut best: Vec<i64> = Vec::new();
    for (start, &(_, offset)) in sorted.iter().enumerate() {
        let mut votes = std::collections::HashMap::new();
        for &(host, value) in &sorted[start..] {
            if value.saturating_sub(offset) > 2_000 { break; }
            votes.entry(host).or_insert(value);
        }
        if votes.len() > best.len() { best = votes.into_values().collect(); }
    }
    if best.len() < 2 { return None; }
    best.sort_unstable();
    let mid = best.len() / 2;
    Some(if best.len() % 2 == 0 { best[mid - 1].saturating_add(best[mid]) / 2 } else { best[mid] })
}

pub async fn measure_clock_offset(http: &reqwest::Client) -> Option<i64> {
    const HOSTS: [&str; 3] = [
        "https://api-v2.soundcloud.com/", "https://www.cloudflare.com/", "https://discord.com/api/v9/gateway",
    ];
    let mut pending = FuturesUnordered::new();
    for (id, host) in HOSTS.into_iter().enumerate() {
        let http = http.clone();
        pending.push(async move { (id, sample(http, host).await) });
    }
    let mut samples = Vec::new();
    while let Some((host, offset)) = pending.next().await {
        if let Some(offset) = offset { samples.push((host, offset)); }
    }
    consensus(&samples)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_are_validated() {
        assert_eq!(parse_http_date("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0));
        assert_eq!(parse_http_date("Wed, 21 Oct 2015 07:28:00 GMT"), Some(1_445_412_480));
        assert_eq!(parse_http_date("Thu, 19 Nov 2026 14:47:54 GMT"), Some(1_795_099_674));
        for value in ["Thu, 31 Feb 2026 14:47:54 GMT", "Thu, 19 Nov 2026 14:47:54 CET", "garbage"] {
            assert_eq!(parse_http_date(value), None);
        }
    }

    #[test]
    fn cached_discord_date_cannot_shift_time_by_hours() {
        assert_eq!(consensus(&[(0, -33_000), (1, -32_500), (2, -21_394_000)]), Some(-32_750));
        assert_eq!(consensus(&[(0, -33_000), (1, -21_000_000)]), None);
        assert_eq!(consensus(&[(0, -33_000), (0, -32_500)]), None);
    }

    #[tokio::test]
    #[ignore = "live HTTP only; does not touch Discord IPC or launch the app"]
    async fn live_clock_sources_agree() {
        let offset = measure_clock_offset(&reqwest::Client::new()).await.expect("no independent time consensus");
        eprintln!("network correction: {:+.3}s", -(offset as f64) / 1000.0);
        assert!(offset.unsigned_abs() < 120_000, "unexpected correction on this machine: {offset}");
    }
}
