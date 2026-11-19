//! Isolated RPC regression suite: no WebView or live Discord is launched.
//! Run with `cargo test --test discord_rpc`.

#![allow(dead_code)]

#[path = "../src/discord_clock.rs"]
mod discord_clock;

#[path = "../src/discord_state.rs"]
mod discord_state;
#[path = "../src/discord_rpc.rs"]
mod discord_rpc;
#[path = "../src/ipc_pipe.rs"]
mod ipc_pipe;

mod settings {
    pub fn log(message: &str) { eprintln!("{message}"); }
}
