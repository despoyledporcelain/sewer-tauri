<div align="center">

<img src="docs/logo.png" width="96" alt="seWer">

# seWer

**музыкальный плеер с разбором SoundCloud**

[![Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB?style=flat-square&logo=tauri&logoColor=24C8DB)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-stable-DEA584?style=flat-square&logo=rust&logoColor=DEA584)](https://www.rust-lang.org)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=61DAFB)](https://react.dev)
[![Windows](https://img.shields.io/badge/Windows-0078D4?style=flat-square&logo=windows&logoColor=0078D4)](https://www.microsoft.com/windows)
[![версия](https://img.shields.io/badge/release-v1.0.0-8A7A5C?style=flat-square)](../../releases/latest)

[скачать установщик](../../releases/latest) · [сборка из исходников](#сборка-из-исходников) · [технические заметки](docs/TECHNOTES.md)

</div>

---

<div align="center">
<img src="docs/screenshot.png" width="820" alt="seWer — плеер">
</div>

<div align="center"><sub>Окно плеера: обложка, таймлайн, лайки, текст трека, локальная библиотека слева.</sub></div>

---

## Что умеет

<div align="center">

| | |
|:--|:--|
| **SoundCloud** | вход, лайки, плейлисты, поиск, страницы исполнителей, подписки |
| **Правка плейлистов** | перестановка и удаление треков, переименование, обложка, всё сохраняется на сервер |
| **Локальная музыка** | папка с MP3/FLAC/OGG, обложки из ID3, длительность из метаданных |
| **Скачивание** | трек целиком с SoundCloud, прогресс, теги ID3 — есть в коде, но живьём не гоняли |
| **Discord** | presence с обложкой, таймером и прогрессом, написание собственных RPC |
| **Система** | трей, сворачивание в трей, медиаклавиши, автозапуск, глобальные горячие клавиши |
| **Оформление** | тёмная тема, акцент из обложки, русский и английский, анимации на gsap и framer-motion |

</div>

---

## Установка

<div align="center">

### ↓ `seWer.Tauri_1.0.0_x64-setup.exe`

**3,4 МБ** · Windows x64 · WebView2 уже есть в системе

</div>

Скачай из [релиза](../../releases/latest) и запусти — установщик NSIS, ставится
в `%LOCALAPPDATA%\seWer Tauri`, ничего не перезаписывает и не требует
перезагрузки.

Нужен **WebView2 Runtime** — на Windows 10/11 он предустановлен. Если
приложение не стартует, поставь runtime
[отсюда](https://developer.microsoft.com/microsoft-edge/webview2/).

---

## Почему Tauri, а не Electron

<table>
<tr><th></th><th>Electron</th><th>Tauri</th></tr>
<tr><td>установщик</td><td>101 МБ</td><td><b>3,4 МБ</b></td></tr>
<tr><td>после установки</td><td>223 МБ</td><td><b>10,8 МБ</b></td></tr>
<tr><td>свой Chromium</td><td>да, ~150 МБ</td><td><b>нет</b>, системный WebView2</td></tr>
</table>

Установщик меньше в **30 раз** — потому что Chromium не тащится в комплект, а
используется системный. При этом логика плеера и весь интерфейс перенесены без
изменений: `src/app.jsx` — это тот же самый код, только разложенный по модулям.

Подробности переноса и все найденные по дороге баги — в
[технических заметках](docs/TECHNOTES.md).

---

## Сборка из исходников

Нужен **Node.js 18+**, **Rust stable** и **MSVC Build Tools** с Windows SDK.

```bash
git clone https://github.com/despoyledporcelain/sewer-tauri.git
cd sewer-tauri
npm install

npm run app:dev      # разработка, hot reload
npm run app:build    # релизный установщик → src-tauri/target/release/bundle/nsis/
```

| команда | что делает |
|---|---|
| `npm run app:dev` | `tauri dev`, поднимает vite сам, изменения подхватываются без перезапуска |
| `npm run app:build` | `tauri build`, LTO — занимает около 5 минут |
| `npm run build` | только фронтенд, проверка что JSX компилируется, ~4 секунды |
| `tools\check-rust.ps1` | проверка Rust без сборки |

---

## Как устроено

```
src/
  app.jsx          весь рендерер: плеер, библиотека, настройки, плейлисты
  bridge.js        window.electronAPI поверх invoke — интерфейс не знает про Tauri
  styles.css
src-tauri/src/
  lib.rs           окна, трей, команды, регистрация плагинов
  soundcloud.rs    логин, чтение api, запись через живую страницу
  discord.rs       presence поверх именованных каналов discord
  library.rs       локальные треки, обложки, кэш
  download.rs      скачивание треков, теги id3
  ipc_pipe.rs      разговор с discord по named pipe
tools/
  extract-renderer.mjs   разбор монолита index.html на модули
  snapshot/index.html    замороженный монолит на момент миграции
```

Данные лежат в `%APPDATA%\sewer-tauri` и не пересекаются с electron-версией —
у сборок разные `settings.json`, разный кэш обложек и разный ключ автозагрузки,
так что обе можно держать установленными рядом.

---

## Известные ограничения

Всё, кроме перечисленного, проверено вживую. Не проверено и может не работать:

- **Скачивание трека** с SoundCloud. Код написан и компилируется, но
  скачиванием не гоняли — это первое, что стоит проверить.
- **Трей, свертывание в трей, перетаскивание окна за тайтлбар, автозапуск.**

Ограничения, которые останутся:

- **Запись в API SoundCloud** идёт через страницу сайта: `PUT` с нашего
  IP-клиента режет анти-бот DataDome. Поэтому окно входа после авторизации
  не закрывается, а прячется — его сессия используется для записи.
- **Discord `client_id` общий** с electron-версией. Обе сборки, запущенные
  одновременно, будут драться за presence.
- **Два языка**, русский и английский. Темы одна, тёмная; настраивается акцент.
- Сборок под macOS и Linux нет, только Windows x64.

---

<div align="center">

**seWer** · сделано с уважением к SoundCloud API

[⬆ в начало](#sewer)

</div>
