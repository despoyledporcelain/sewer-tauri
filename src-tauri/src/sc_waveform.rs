use std::{io::Cursor, sync::LazyLock, time::Duration};

use serde::Deserialize;
use url::Url;

const MAX_BYTES: usize = 1024 * 1024;
const MAX_SAMPLES: usize = 8192;

static CLIENT: LazyLock<Option<reqwest::Client>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()
});

#[derive(Deserialize)]
struct Waveform {
    height: u32,
    samples: Vec<u32>,
}

#[tauri::command]
pub(crate) async fn sc_waveform(url: String) -> Option<Vec<u8>> {
    let url = Url::parse(&url).ok()?;
    let valid_host = matches!(
        url.host_str()?,
        "wis.sndcdn.com" | "wave.sndcdn.com" | "w1.sndcdn.com" | "w2.sndcdn.com"
            | "w3.sndcdn.com" | "w4.sndcdn.com"
    );
    if !valid_host || url.scheme() != "https" || url.port().is_some()
        || !url.username().is_empty() || url.password().is_some()
    {
        return None;
    }
    let json = url.path().ends_with(".json");
    if !json && !url.path().ends_with(".png") {
        return None;
    }

    let mut response = CLIENT.as_ref()?.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    if json {
        let wave: Waveform = serde_json::from_slice(&bytes).ok()?;
        if wave.height == 0 || !(2..=MAX_SAMPLES).contains(&wave.samples.len()) {
            return None;
        }
        return Some(wave.samples.into_iter().map(|sample| {
            (u64::from(sample.min(wave.height)) * 255 / u64::from(wave.height)) as u8
        }).collect());
    }
    png_peaks(&bytes)
}

fn png_peaks(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SAMPLES as u32);
    limits.max_image_height = Some(512);
    limits.max_alloc = Some(24 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().ok()?.into_rgba8();
    let (width, height) = image.dimensions();
    if width < 2 || height < 2 {
        return None;
    }
    let alpha = |x, y| u32::from(image.get_pixel(x, y).0[3]);
    // SoundCloud's older PNGs encode the waveform as a transparent cutout.
    // Also accept alpha masks where the painted area is the waveform itself.
    let edge_alpha: u32 = (0..width).map(|x| alpha(x, 0) + alpha(x, height - 1)).sum();
    let inverted = edge_alpha > width * 255;
    let peaks: Vec<u8> = (0..width).map(|x| {
        let column: u32 = (0..height).map(|y| alpha(x, y)).sum();
        let signal = if inverted { height * 255 - column } else { column };
        (signal / height) as u8
    }).collect();
    peaks.iter().any(|&peak| peak > 0).then_some(peaks)
}
