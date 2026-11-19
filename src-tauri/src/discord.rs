//! Tauri adapter; playback state and IPC live in independently tested modules.

use tauri::{AppHandle, Emitter};

pub use crate::discord_rpc::{clock_ready, is_quiet, set_clock_offset_ms, Cmd, Presence};

pub fn spawn(app: AppHandle, http: reqwest::Client) -> tokio::sync::mpsc::UnboundedSender<Cmd> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    tauri::async_runtime::spawn(crate::discord_rpc::run(http, move |status| {
        let _ = app.emit("discord-status", status);
    }, rx));
    tx
}
