/**
 * Обёртка над tauri cli: подкладывает cargo в PATH и запускает сборку.
 *
 * Зачем: rustup кладёт cargo в %USERPROFILE%\.cargo\bin, а tauri cli ищет
 * его через `cargo metadata` — то есть в PATH. У кого-то rustup прописал
 * путь при установке, у кого-то (как здесь, с --no-modify-path) нет, и
 * сборка падает с невнятным «program not found», хотя cargo есть.
 *
 *   node tools/tauri.mjs dev
 *   node tools/tauri.mjs build
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'

const CARGO_DIRS = [
  join(homedir(), '.cargo', 'bin'),
  'C:\\Program Files\\Rust stable MSVC 1.98\\bin',
]

const found = CARGO_DIRS.filter(dir => existsSync(join(dir, 'cargo.exe')) || existsSync(join(dir, 'cargo')))

const path = [found.join(delimiter), process.env.PATH].filter(Boolean).join(delimiter)

if (!found.length) {
  console.error('cargo не найден ни в %USERPROFILE%\\.cargo\\bin, ни в Program Files\\Rust stable MSVC.')
  console.error('Поставь rustup (https://rustup.rs) — cargo обязателен для сборки tauri.')
  process.exit(1)
}

console.error(`[tauri] cargo: ${found[0]}`)

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tauri', ...process.argv.slice(2)],
  { stdio: 'inherit', env: { ...process.env, PATH: path }, shell: process.platform === 'win32' },
)

child.on('exit', code => process.exit(code ?? 1))
