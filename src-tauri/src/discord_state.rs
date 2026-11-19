//! Playback snapshots and latest-state delivery, independent of IPC and Tauri.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

const MAX_DURATION: f64 = 86_400.0;
const MAX_SAMPLE_AGE_MS: i64 = 600_000;
pub const SEND_GAP: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, Default)]
pub struct Presence {
    pub title: String,
    pub artist: String,
    pub duration: f64,
    pub position: Option<f64>,
    pub progress: f64,
    pub playback_rate: Option<f64>,
    pub cover_url: String,
    pub cover_key: String,
    pub is_playing: bool,
    pub timestamp: String,
    pub sampled_at_ms: f64,
}

impl Presence {
    fn duration(&self) -> f64 {
        if self.duration.is_finite() { self.duration.clamp(0.0, MAX_DURATION) } else { 0.0 }
    }

    fn position(&self) -> f64 {
        let pos = self.position.filter(|v| v.is_finite() && *v >= 0.0)
            .unwrap_or_else(|| {
                if self.progress.is_finite() { self.progress.clamp(0.0, 1.0) * self.duration() }
                else { 0.0 }
            });
        if self.duration() > 0.0 { pos.min(self.duration()) } else { pos.min(MAX_DURATION) }
    }

    fn rate(&self) -> f64 {
        self.playback_rate.filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(1.0).clamp(0.1, 8.0)
    }

    fn same_track(&self, other: &Self) -> bool {
        if !self.cover_key.is_empty() && !other.cover_key.is_empty() {
            self.cover_key == other.cover_key
        } else {
            self.title == other.title && self.artist == other.artist
        }
    }
}

#[derive(Clone, Debug)]
pub struct Snapshot {
    pub presence: Presence,
    at: Instant,
    position: f64,
}

impl Snapshot {
    pub fn new(presence: Presence, local_now_ms: i64, now: Instant) -> Self {
        let age = if presence.sampled_at_ms.is_finite() && presence.sampled_at_ms > 0.0 {
            local_now_ms.saturating_sub(presence.sampled_at_ms as i64)
        } else { 0 };
        let age = if (0..=MAX_SAMPLE_AGE_MS).contains(&age) { age as u64 } else { 0 };
        let at = now.checked_sub(Duration::from_millis(age)).unwrap_or(now);
        let position = presence.position();
        Self { presence, at, position }
    }

    fn continued(mut self, previous: &Self) -> Self {
        let p = &self.presence;
        let old = &previous.presence;
        if p.is_playing && old.is_playing && p.same_track(old) && p.rate() == old.rate() {
            let expected = previous.position
                + self.at.saturating_duration_since(previous.at).as_secs_f64() * p.rate();
            // Repeated metadata/heartbeat updates must not jitter the start time.
            // A real seek or a stalled decoder establishes a new timeline.
            if (expected - self.position).abs() < 0.75 {
                self.at = previous.at;
                self.position = previous.position;
            }
        }
        self
    }

    pub fn activity(&self, image: Option<&str>, true_now_ms: i64, now: Instant) -> Value {
        let p = &self.presence;
        let title = if p.title.trim().is_empty() { "Unknown track" } else { p.title.trim() };
        let artist = if p.artist.trim().is_empty() { "Unknown artist" } else { p.artist.trim() };
        // Preserve the requested layout: Listening to artist, then the track.
        // Explicit NAME mode prevents member-list text being selected from details.
        let mut activity = json!({
            "type": 2, "name": text(artist), "details": text(title),
            "status_display_type": 0,
        });
        if !p.is_playing {
            let duration = p.duration().round() as i64;
            let position = p.position().round() as i64;
            activity["state"] = json!(if position > 0 && duration > 0 {
                format!("Paused · {} / {}", mmss(position), mmss(duration))
            } else { "Paused".into() });
        }
        if let Some(image) = image.filter(|v| !v.is_empty()) {
            activity["assets"] = json!({ "large_image": image });
        }
        if p.is_playing && p.timestamp != "none" && p.duration() > 0.0 {
            let age_ms = now.saturating_duration_since(self.at).as_millis().min(i64::MAX as u128) as i64;
            let anchor_ms = true_now_ms.saturating_sub(age_ms);
            let start_ms = anchor_ms.saturating_sub((self.position / p.rate() * 1000.0).round() as i64);
            let mut timestamps = json!({ "start": start_ms.div_euclid(1000).max(1) });
            if p.timestamp == "progress" {
                let end_ms = start_ms.saturating_add((p.duration() / p.rate() * 1000.0).round() as i64);
                timestamps["end"] = json!(end_ms.div_euclid(1000).max(timestamps["start"].as_i64().unwrap() + 1));
            }
            activity["timestamps"] = timestamps;
        }
        activity
    }
}

fn text(value: &str) -> String {
    let value: String = value.chars().take(128).collect();
    if value.chars().count() >= 2 { value } else { format!("{value} ") }
}

fn mmss(value: i64) -> String {
    format!("{}:{:02}", value.max(0) / 60, value.max(0) % 60)
}

#[derive(Default)]
pub struct Delivery {
    pub enabled: bool,
    pub revision: u64,
    pub current: Option<Snapshot>,
    pub dirty: bool,
    pub sent: Option<Value>,
    pub send_at: Option<Instant>,
}

impl Delivery {
    pub fn enable(&mut self, enabled: bool) {
        if self.enabled == enabled { return; }
        self.enabled = enabled;
        self.revision = self.revision.wrapping_add(1);
        if !enabled { self.current = None; }
        self.dirty = true;
    }

    pub fn update(&mut self, p: Presence, local_now_ms: i64, now: Instant) {
        if !self.enabled { return; }
        let mut snapshot = Snapshot::new(p, local_now_ms, now);
        if let Some(previous) = &self.current { snapshot = snapshot.continued(previous); }
        self.current = Some(snapshot);
        self.revision = self.revision.wrapping_add(1);
        self.dirty = true;
    }

    pub fn clear(&mut self) {
        self.current = None;
        self.revision = self.revision.wrapping_add(1);
        self.dirty = true;
    }

    pub fn reconnect(&mut self) {
        self.sent = None;
        self.send_at = None;
        self.dirty = true;
    }

    pub fn invalidate(&mut self) {
        self.revision = self.revision.wrapping_add(1);
        self.dirty = true;
    }

    pub fn activity(&self, image: Option<&str>, true_now_ms: i64, now: Instant) -> Value {
        self.current.as_ref().filter(|_| self.enabled)
            .map(|s| s.activity(image, true_now_ms, now)).unwrap_or(Value::Null)
    }

    pub fn due(&self, now: Instant) -> bool {
        self.dirty && self.send_at.is_none_or(|at| now >= at)
    }

    pub fn acknowledge(&mut self, revision: u64, activity: Value, now: Instant) {
        self.sent = Some(activity);
        self.send_at = Some(now + SEND_GAP);
        // An older in-flight reply must not mark a newer state as delivered.
        if self.revision == revision { self.dirty = false; }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WALL: i64 = 1_800_000_000_000;
    fn p(position: f64) -> Presence {
        Presence { title: "Song".into(), artist: "Artist".into(), duration: 200.0,
            position: Some(position), is_playing: true, timestamp: "progress".into(),
            cover_key: "track-1".into(), sampled_at_ms: WALL as f64, ..Default::default() }
    }

    #[test]
    fn layout_is_unchanged_and_title_has_one_field() {
        let now = Instant::now();
        let a = Snapshot::new(p(20.0), WALL, now).activity(None, WALL, now);
        assert_eq!(a["name"], "Artist");
        assert_eq!(a["details"], "Song");
        assert_eq!(a["status_display_type"], 0);
        assert!(a.get("state").is_none());
    }

    #[test]
    fn delayed_cover_and_reconnect_do_not_reset_progress() {
        let now = Instant::now();
        let s = Snapshot::new(p(20.0), WALL, now);
        let a = s.activity(None, WALL, now);
        let later = s.activity(Some("cover"), WALL + 38_000, now + Duration::from_secs(38));
        assert_eq!(a["timestamps"], later["timestamps"]);
        assert_eq!(a["timestamps"]["start"], WALL / 1000 - 20);
        assert_eq!(a["timestamps"]["end"], WALL / 1000 + 180);
    }

    #[test]
    fn transport_delay_and_bad_local_clock_are_independent() {
        let now = Instant::now();
        let mut track = p(20.0);
        track.sampled_at_ms = (WALL - 33_000) as f64;
        let s = Snapshot::new(track, WALL - 32_000, now);
        let a = s.activity(None, WALL + 1_000, now);
        assert_eq!(a["timestamps"]["start"], WALL / 1000 - 20);
    }

    #[test]
    fn paused_position_does_not_advance() {
        let now = Instant::now();
        let mut track = p(20.0);
        track.is_playing = false;
        let s = Snapshot::new(track, WALL, now);
        let a = s.activity(None, WALL + 20_000, now + Duration::from_secs(20));
        assert!(a.get("timestamps").is_none());
        assert_eq!(a["details"], "Song");
        assert_eq!(a["state"], "Paused · 0:20 / 3:20");
    }

    #[test]
    fn clear_then_update_keeps_newest_track() {
        let now = Instant::now();
        let mut d = Delivery::default();
        d.enable(true);
        d.update(p(10.0), WALL, now);
        d.clear();
        let mut track = p(0.0);
        track.cover_key = "track-2".into();
        d.update(track, WALL, now);
        assert_eq!(d.current.as_ref().unwrap().presence.cover_key, "track-2");
        assert!(!d.activity(None, WALL, now).is_null());
    }

    #[test]
    fn update_then_clear_and_disable_do_not_resurrect_activity() {
        let now = Instant::now();
        let mut d = Delivery::default();
        d.enable(true);
        d.update(p(10.0), WALL, now);
        let revision = d.revision;
        d.clear();
        d.acknowledge(revision, json!({"details": "old"}), now);
        assert!(d.dirty);
        assert!(d.activity(None, WALL, now).is_null());
        d.enable(false);
        d.update(p(10.0), WALL, now);
        assert!(d.activity(None, WALL, now).is_null());
    }

    #[test]
    fn seek_resets_timeline_but_metadata_updates_do_not_jitter() {
        let now = Instant::now();
        let mut d = Delivery::default();
        d.enable(true);
        d.update(p(20.0), WALL, now);
        let first = d.activity(None, WALL, now)["timestamps"].clone();
        let mut track = p(21.2);
        track.sampled_at_ms += 1000.0;
        d.update(track, WALL + 1000, now + Duration::from_secs(1));
        assert_eq!(d.activity(None, WALL + 1000, now + Duration::from_secs(1))["timestamps"], first);
        let mut track = p(100.0);
        track.sampled_at_ms += 2000.0;
        d.update(track, WALL + 2000, now + Duration::from_secs(2));
        assert_eq!(d.activity(None, WALL + 2000, now + Duration::from_secs(2))["timestamps"]["start"], WALL / 1000 - 98);
    }

    #[test]
    fn reconnect_retains_latest_snapshot() {
        let now = Instant::now();
        let mut d = Delivery::default();
        d.enable(true);
        d.update(p(20.0), WALL, now);
        let a = d.activity(None, WALL, now);
        d.acknowledge(d.revision, a.clone(), now);
        d.reconnect();
        assert!(d.due(now));
        assert_eq!(d.activity(None, WALL + 10_000, now + Duration::from_secs(10)), a);
    }

    #[test]
    fn a_cover_result_cannot_be_lost_behind_an_old_acknowledgement() {
        let now = Instant::now();
        let mut d = Delivery::default();
        d.enable(true);
        d.update(p(20.0), WALL, now);
        let revision = d.revision;
        let without_cover = d.activity(None, WALL, now);
        d.invalidate();
        d.acknowledge(revision, without_cover, now);
        assert!(d.dirty);
        assert_eq!(d.activity(Some("image"), WALL, now)["assets"]["large_image"], "image");
    }

    #[test]
    fn disable_then_reenable_does_not_restore_an_old_track() {
        let now = Instant::now();
        let mut d = Delivery::default();
        d.enable(true);
        d.update(p(20.0), WALL, now);
        d.enable(false);
        d.enable(true);
        assert!(d.activity(None, WALL, now).is_null());
        d.update(p(10.0), WALL, now);
        assert!(!d.activity(None, WALL, now).is_null());
    }

    #[test]
    fn fractional_position_is_subtracted_before_rounding() {
        let now = Instant::now();
        let s = Snapshot::new(p(12.8), WALL + 800, now);
        // sampledAt was 800 ms before receipt, so the original anchor is WALL.
        assert_eq!(s.activity(None, WALL + 800, now)["timestamps"]["start"], WALL / 1000 - 13);
    }

    #[test]
    fn bad_numbers_and_all_timestamp_modes_are_safe() {
        let now = Instant::now();
        for v in [f64::NAN, f64::INFINITY, -1.0, 0.0, f64::MAX] {
            let mut track = p(v);
            track.duration = v;
            track.sampled_at_ms = v;
            let _ = Snapshot::new(track, WALL, now).activity(None, WALL, now);
        }
        let mut track = p(12.0);
        track.timestamp = "none".into();
        assert!(Snapshot::new(track.clone(), WALL, now).activity(None, WALL, now).get("timestamps").is_none());
        track.timestamp = "elapsed".into();
        assert!(Snapshot::new(track, WALL, now).activity(None, WALL, now)["timestamps"].get("end").is_none());
    }

    #[test]
    fn non_default_speed_scales_time_bar() {
        let now = Instant::now();
        let mut track = p(20.0);
        track.playback_rate = Some(2.0);
        let a = Snapshot::new(track, WALL, now).activity(None, WALL, now);
        assert_eq!(a["timestamps"]["start"], WALL / 1000 - 10);
        assert_eq!(a["timestamps"]["end"], WALL / 1000 + 90);
    }
}
