/**
 * Фасад window.electronAPI поверх Tauri.
 *
 * Смысл: renderer/index.html — монолит на ~9.5k строк, и он ходит в натив
 * только через window.electronAPI (64 вызова). Здесь воспроизводится ровно
 * тот же surface, что был в electron/preload.js, но внутри — invoke/listen.
 * Благодаря этому ui не трогали при переезде на Tauri вообще.
 *
 * Три отличия от electron, все намеренные:
 *   1) electron отдавал пути к обложкам как file:///… — webview их не грузит,
 *      путь отдаётся через asset-протокол (convertFileSrc);
 *   2) локальные треки грузились тем же file:///, теперь через fileSrc();
 *   3) listen() асинхронный, поэтому on* возвращают синхронную функцию
 *      отписки, которая отпишется и после resolve промиса (useEffect-cleanup
 *      не ждёт).
 */
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/**
 * Локальный файл в url, который умеет грузить webview.
 * Electron собирал file:///C:/… руками, но страница в tauri живёт на
 * http-origin (tauri.localhost) и file-ресурсы не видит: нужен asset-протокол.
 */
export function fileSrc(path) {
  return convertFileSrc(path)
}

/** подписка с синхронной отпиской */
const on = (event, cb) => {
  let unlisten = null
  let dead = false
  listen(event, e => cb(e.payload)).then(f => (dead ? f() : (unlisten = f)))
  return () => {
    dead = true
    unlisten?.()
  }
}

const asset = p => (typeof p === 'string' && p ? convertFileSrc(p) : p)

/* Пишем в sewer.log то, что видит рендерер. Раньше лог читался наполовину
   вслепую: rust писал «токен получен», а чем закончилось дело в ui — видно
   было только в консоли, которой у собранного приложения нет. */
const log = msg => invoke('log', { msg }).catch(() => {})

/* последнее известное состояние soundcloudAuth на диске — чтобы логировать
   смену, а не каждый save */
let lastAuthSaved = null

/* Ловим то, что иначе исчезает: необработанные ошибки и отказ промисов.
   Именно так проявляется «вылет» — окно закрывается, а в логе пусто. */
window.addEventListener('error', e => {
  log(`uncaught: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`)
})
window.addEventListener('unhandledrejection', e => {
  const r = e.reason
  log(`unhandled rejection: ${(r && (r.stack || r.message)) || r}`)
})

window.electronAPI = {
  /* Лог из рендерера. Нужен не для красоты: баг «кликаю первый трек — обложки
     нету» невозможно объяснить чтением кода — состояние слоёв обложки живёт
     в трёх useState и в таймерах, и без трассы не видно, на каком слое
     перебор остановился. */
  log: msg => log(msg),

  /* ── окно ─────────────────────────────────────────────────────────────── */
  minimize: () => invoke('win-minimize'),
  close: () => invoke('win-close'),
  /* Материал окна. Возвращает bool — получилось ли: DWM на Windows 10 и на 11
     ниже 22H2 принимает вызов и не рисует ничего, и без этой проверки тумблер
     выглядел бы включённым, но нерабочим (см. src-tauri/src/backdrop.rs) */
  setWindowEffect: effect => invoke('set-window-effect', { effect }),

  /* ── локальная библиотека ─────────────────────────────────────────────── */
  selectMusicFolder: () => invoke('dialog-select-folder'),
  scanMusicFolder: (folder, minDuration) =>
    invoke('scan-music-folder', { folderPath: folder ?? null, minDuration: minDuration ?? null }),
  getCoverArt: filePath => invoke('get-cover-art', { filePath }),
  selectImage: () => invoke('dialog-select-image'),

  /* ── настройки ────────────────────────────────────────────────────────── */
  loadSettings: () => invoke('load-settings'),
  /* Логируем не каждый save, а смену наличия токена: именно по нему видно,
     доехала ли авторизация до диска. */
  saveSettings: data => {
    const has = !!(data && data.soundcloudAuth)
    if (has !== lastAuthSaved) {
      lastAuthSaved = has
      log(`save-settings: soundcloudAuth ${has ? 'сохранён' : 'удалён'}`)
    }
    return invoke('save-settings', { data })
  },
  setLoginItem: enable => invoke('set-login-item', { enable: !!enable }),

  /* ── медиаклавиши ─────────────────────────────────────────────────────── */
  onMediaPlayPause: cb => on('media-play-pause', cb),
  onMediaNext: cb => on('media-next', cb),
  onMediaPrev: cb => on('media-prev', cb),

  /* ── soundcloud ───────────────────────────────────────────────────────── */
  /* Логин и первый запрос к api залогированы: это единственное место, где
     логин может тихо сорваться — токен есть, а аккаунт в ui не появился,
     потому что /me не ответил. */
  scLogin: async () => {
    log('sc-login: ждём окно входа')
    const creds = await invoke('sc-login')
    if (!creds || !creds.token) {
      log('sc-login: токен не получен')
      return creds
    }
    log(`sc-login: токен получен, client_id=${creds.clientId}`)
    return creds
  },
  scFetch: async (url, token, clientId, method, body, contentType) => {
    const isMe = /\/me(\?|$)/.test(url)
    const m = (method || 'GET').toUpperCase()
    const res = await invoke('sc-fetch', {
      url,
      token,
      clientId,
      method: m,
      body: body ?? null,
      contentType: contentType ?? null,
    })
    /* Пишущие запросы — это сохранение плейлистов, лайков, подписок. Раньше
       их провал выглядел в ui одинаково с «ничего не нажато», поэтому
       результат каждого пишем явно: метод, что за url, чем кончилось. */
    if (m !== 'GET') {
      const bad = res && res.error
      log(
        `sc-${m} ${url.replace(/^https:\/\/api-v2\.soundcloud\.com/, '').slice(0, 110)}` +
          (bad
            ? ` -> ошибка ${bad}${res.blocked ? ' (write заблокирован)' : ''} ${String(res.body || '').slice(0, 160)}`
            : ' -> ок'),
      )
    }
    if (isMe) {
      /* sc-fetch отдаёт {data} либо {error} — поля status у него нет */
      const has = !!(res && res.data)
      log(`sc-fetch /me: data=${has}${has ? '' : ' ' + JSON.stringify(res).slice(0, 200)}`)
    }
    return res
  },
  netFetch: (url, headers) => invoke('net-fetch', { url, headers: headers || {} }),

  scCheckCovers: async ids => {
    const found = await invoke('sc-check-covers', { ids })
    const out = {}
    for (const [id, path] of Object.entries(found || {})) out[id] = asset(path)
    return out
  },
  scCacheCover: async (id, url) => {
    const path = await invoke('sc-cache-cover', { id, url })
    /* Пустой результат бывает двух видов: скачалось, но вернулось null —
       тогда rust уже написал почему в [cover]; либо не скачалось, потому
       что url не пришёл. Различаем, иначе гадаем. */
    if (!path) log(`sc-cache-cover: id=${id} ничего не вернул, url=${String(url).slice(0, 90)}`)
    return asset(path)
  },
  scClearCoversCache: () => invoke('sc-clear-covers-cache'),
  scClearLikesCache: () => invoke('sc-clear-likes-cache'),
  scLoadLikesCache: () => invoke('sc-load-likes-cache'),
  scSaveLikesCache: data => invoke('sc-save-likes-cache', { data }),
  scDownloadTrack: t => invoke('sc-download-track', { t }),
  onDownloadProgress: cb => on('download-progress', cb),

  /* ── discord rpc ──────────────────────────────────────────────────────── */
  discordUpdate: data => invoke('discord-update', { data }),
  discordClear: () => invoke('discord-clear'),
  discordSetEnabled: enabled => invoke('discord-rpc-enabled', { on: !!enabled }),
  onDiscordStatus: cb => on('discord-status', cb),
}

/* Правый клик. В electron системного меню не было вовсе: electron сам его не
   показывает, пока не построишь явно. А webview2 показывает своё, и на
   странице оно всплывало везде, кроме строк треков — те вызывают
   preventDefault сами (app.jsx, handleContextMenu).
   Тут ловим остальное. Слушатель на document, а не на элементах: react
   вешает свои на корневой контейнер, до document он дойдёт раньше, так что
   кастомное меню треков отмену не сломает. */
document.addEventListener('contextmenu', e => e.preventDefault())

/* кнопки тайтлбара — статический html, обработчики вешаем здесь, чтобы в
   production-csp не пришлось разрешать inline-script */
document.addEventListener('click', e => {
  const btn = e.target.closest?.('[data-win]')
  if (!btn) return
  if (btn.dataset.win === 'minimize') window.electronAPI.minimize()
  if (btn.dataset.win === 'close') window.electronAPI.close()
})
