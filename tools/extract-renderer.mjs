/**
 * Раскладка рендерера Electron-проекта в Vite-проект.
 *
 * Вход:  renderer/index.html из исходного seWer (monolith: 2 <style> + <script type="text/babel">)
 * Выход: src/styles.css, src/app.jsx — те же строки, без единой правки логики,
 *        кроме двух первых строк скрипта (глобалы React/Motion → импорты) и
 *        font-face url ('./fonts/…' → '/fonts/…', потому что css теперь в src/).
 *
 * Скрипт идемпотентен: перезапуск перезаписывает только эти два файла.
 * Исходный проект открывается на чтение и не меняется.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Источник — снапшот монолита на момент начала миграции, а не живой
 * renderer/index.html из electron-репозитория: оригинал продолжает
 * дописываться, и повторный запуск скрипта молча затянул бы в миграцию
 * чужую работу. Чтобы перегенерировать осознанно, передай путь явно:
 *   node tools/extract-renderer.mjs C:/seWer/renderer/index.html
 */
const SNAPSHOT = resolve(dirname(fileURLToPath(import.meta.url)), 'snapshot/index.html')
const SRC = process.argv[2] ?? SNAPSHOT

const lines = readFileSync(SRC, 'utf8').split(/\r?\n/)

/** 1-based inclusive */
const slice = (from, to) => lines.slice(from - 1, to).join('\n')

const FONT_CSS = slice(8, 13)
const APP_CSS = slice(22, 256)

/* 276-277 — глобалы React/Motion, заменяются импортами */
const DROPPED = [
  'const { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } = React;',
  'const { motion, AnimatePresence, LayoutGroup, Reorder } = Motion;',
]
const body = slice(276, 9862).split('\n')
for (const line of DROPPED) {
  const i = body.indexOf(line)
  if (i < 0) throw new Error(`не найдена строка для замены: ${line}`)
  body.splice(i, 1)
}

const IMPORTS = `import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react'
/* createPortal шёл через глобальный ReactDOM из cdn-скрипта; в es-модуле
   глобала нет, поэтому импортируем точечно. Правка в PATCHES — замена
   ReactDOM.createPortal на createPortal. */
import { createPortal } from 'react-dom'
import { motion, AnimatePresence, LayoutGroup, Reorder } from 'framer-motion'
import Hls from 'hls.js'
import gsap from 'gsap'
/* этот модуль ставит window.electronAPI surface; импорт идёт первым, чтобы
   фасад существовал до того, как App смонтируется (bridge ставит его на импорте) */
import './bridge.js'
import { fileSrc } from './bridge.js'
`

/**
 * Правки в разметке/логике ui. Каждая — в этом списке, а не «поправил
 * руками в app.jsx»: снапшот источника заморожен, и без записи здесь
 * правка молча потерялась бы при первом же перегенерировании.
 *
 * Строки записаны массивом и склеиваются \n: в блоках есть и кавычки, и
 * `${…}` из шаблонных строк, и записать их в шаблонный литерал значило бы
 * заэкранировать половину. В двойных кавычках обратные кавычки литеральны.
 */
const PATCHES = [
  {
    why: 'локальный трек грузился через file:///, его не видит webview на http-origin',
    from: "      audio.src = 'file:///' + track.path.replace(/\\\\/g, '/');",
    to: '      audio.src = fileSrc(track.path);',
  },
  {
    why: 'порталы шли через глобальный ReactDOM из cdn-скрипта; в es-модуле глобала нет',
    all: 'ReactDOM.createPortal',
    to: 'createPortal',
    count: 4,
  },
  {
    why: 'чип плейлиста в плеере: капс «ПЛЕЙЛИСТ» убран, название наверх, снизу счётчик и суммарная длительность H:MM:SS',
    from: [
      "                <div style={{flex:1, minWidth:0}}>",
      "                  <div style={{display:'flex', alignItems:'center', gap:5, marginBottom:1}}>",
      "                    <span style={{fontSize: 'var(--fs-eyebrow)', letterSpacing:'0.13em', textTransform:'uppercase',",
      "                      color:'rgba(255,255,255,0.34)', fontWeight:600}}>",
      "                      {t('nav_playlists')}",
      "                    </span>",
      "                    <span style={{fontSize: 'var(--fs-eyebrow)', color:'rgba(255,255,255,0.24)', fontVariantNumeric:'tabular-nums'}}>",
      "                      {playlistActive.tracks.length}",
      "                    </span>",
      "                  </div>",
      "                  <div style={{",
      "                    fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.78)', fontWeight:500,",
      "                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',",
      "                  }}>{playlistActive.playlist.title}</div>",
      "                </div>",
    ],
    to: [
      "                <div style={{flex:1, minWidth:0}}>",
      "                  {/* капс «ПЛЕЙЛИСТ» убран: он только повторял то, что уже",
      "                      сказано названием, и занимал целую строку. сверху —",
      "                      название, под ним мета: счётчик треков и суммарная",
      "                      длительность списка H:MM:SS (tabular-nums, иначе цифры",
      "                      разъезжаются при пересчёте) */}",
      "                  <div title={playlistActive.playlist.title} style={{",
      "                    fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.78)', fontWeight:500,",
      "                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',",
      "                  }}>{playlistActive.playlist.title}</div>",
      "                  <div style={{",
      "                    display:'flex', alignItems:'center', gap:5, marginTop:1,",
      "                    fontSize: 'var(--fs-eyebrow)', color:'rgba(255,255,255,0.24)',",
      "                    fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap',",
      "                  }}>",
      "                    <span>{playlistActive.tracks.length}</span>",
      "                    {plTotalDur > 0 && (<>",
      "                      <span style={{opacity:0.5}}>·</span>",
      "                      <span>{fmtHMS(plTotalDur)}</span>",
      "                    </>)}",
      "                  </div>",
      "                </div>",
    ],
  },
  {
    why: 'fmtHMS — суммарная длительность H:MM:SS для чипа плейлиста (у fmt минуты без разряда часов)',
    from: [
      'function fmt(s) {',
      '  const m = Math.floor(s/60), sec = Math.floor(s%60);',
      "  return `${m}:${sec.toString().padStart(2,'0')}`;",
      '}',
    ],
    to: [
      'function fmt(s) {',
      '  const m = Math.floor(s/60), sec = Math.floor(s%60);',
      "  return `${m}:${sec.toString().padStart(2,'0')}`;",
      '}',
      '',
      '/* суммарная длительность в H:MM:SS — для чипа плейлиста. `fmt` тут не',
      '   годится: у него минуты без разряда часов, и «135:07» читается как',
      '   полтора часа только если помнить, что это минуты. часы всегда на',
      '   месте, даже когда их ноль («0:04:12») — колонка не прыгает по ширине */',
      'function fmtHMS(s) {',
      '  const t = Math.max(0, Math.floor(s) || 0);',
      '  const h = Math.floor(t / 3600);',
      '  const m = Math.floor((t % 3600) / 60);',
      '  const sec = t % 60;',
      "  return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;",
      '}',
    ],
  },
  {
    why: 'переключение трека не должно менять isPlaying: иначе кнопка play на ~секунду прыгала на «паузу», хотя музыка не прерывалась',
    from: [
      '    trackSwitchingRef.current = true;',
      '    setScPlayingIdx(idx);',
      '    progressRef.current = 0;',
      '    setIsPlaying(false);',
      '    setLoadingTrackId(scTrack.id);',
      '    destroyHls();',
      '',
      '    const auth = scAuthRef.current;',
      '    if (!auth) { setLoadingTrackId(null); return; }',
    ],
    to: [
      '    trackSwitchingRef.current = true;',
      '    setScPlayingIdx(idx);',
      '    progressRef.current = 0;',
      '    /* Здесь стояло setIsPlaying(false) — и это была причина, по которой',
      '       кнопка play дёргалась на каждом переключении трека. У sc-трека между',
      '       началом переключения и setIsPlaying(true) проходит около секунды',
      '       (резолв streamUrl через api), и всё это время иконка показывала',
      '       «паузу», хотя музыка не прерывалась. Переключение не должно менять',
      '       состояние воспроизведения: если играли — играем дальше, если стояли',
      '       — стоим. Сброс переехал в точки, где переключение реально',
      '       заканчивается ничем (нет авторизации, поток не резолвился, ошибка). */',
      '    setLoadingTrackId(scTrack.id);',
      '    destroyHls();',
      '',
      '    const auth = scAuthRef.current;',
      '    if (!auth) { setLoadingTrackId(null); setIsPlaying(false); return; }',
    ],
  },
  {
    why: 'сброс isPlaying на выходе «нет потока» — компенсирует снятый с начала переключения сброс',
    from: [
      '    if (!scTrack.streamUrl && !scTrack.hlsUrl) {',
      '      trackSwitchingRef.current = false;',
      '      setLoadingTrackId(null);',
      '      markError();',
    ],
    to: [
      '    if (!scTrack.streamUrl && !scTrack.hlsUrl) {',
      '      trackSwitchingRef.current = false;',
      '      setLoadingTrackId(null);',
      '      setIsPlaying(false);',
      '      markError();',
    ],
  },
  {
    why: 'сброс isPlaying на выходе «поток не резолвился» — компенсирует снятый с начала переключения сброс',
    from: [
      '    if (!resolvedUrl) {',
      '      trackSwitchingRef.current = false;',
      '      setLoadingTrackId(null);',
      '      markError();',
    ],
    to: [
      '    if (!resolvedUrl) {',
      '      trackSwitchingRef.current = false;',
      '      setLoadingTrackId(null);',
      '      setIsPlaying(false);',
      '      markError();',
    ],
  },
  {
    why: 'кнопка play дёргалась: обе иконки крутились навстречу друг другу с перелётом. Одно кроссфейд-движение + волна на старте',
    from: [
      'function PlayBtn({ isPlaying, onToggle }) {',
      "  const BTN = 'clamp(58px, 7.2vw, 86px)';",
      "  const ICO = 'clamp(32px, 4.2vw, 50px)';",
      '  const ico = (visible, rot) => ({',
      "    position:'absolute', top:0, left:0, width:ICO, height:ICO,",
      "    filter:'brightness(0) invert(1)',",
      '    opacity: visible ? 1 : 0,',
      "    transform: visible ? 'scale(1) rotate(0deg)' : `scale(0.45) rotate(${rot}deg)`,",
      "    transition:'opacity 0.2s ease, transform 0.26s cubic-bezier(0.34,1.56,0.64,1)',",
      "    pointerEvents:'none',",
      '  });',
      '  return (',
      '    <motion.button onClick={onToggle}',
      '      whileHover={{ scale: 1.06 }}',
      '      whileTap={{ scale: 0.88 }}',
      "      transition={{ type:'spring', stiffness: 600, damping: 22, mass: 0.4 }}",
      '      style={{',
      "        width:BTN, height:BTN, borderRadius:'50%', border:'none',",
      "        background: isPlaying ? 'rgba(178,178,178,0.1)' : 'rgba(255,255,255,0.06)',",
      "        color:'var(--text)',",
      "        display:'flex', alignItems:'center', justifyContent:'center',",
      "        cursor:'pointer', flexShrink:0,",
      "        transition:'background 0.3s ease',",
      '      }}>',
      "      <div style={{position:'relative', width:ICO, height:ICO}}>",
      '        <img src="../assets/play.png"  style={ico(!isPlaying,  90)}/>',
      '        <img src="../assets/pause.png" style={ico( isPlaying, -90)}/>',
      '      </div>',
      '    </motion.button>',
      '  );',
      '}',
    ],
    to: [
      'function PlayBtn({ isPlaying, onToggle, trackKey = null }) {',
      "  const BTN = 'clamp(58px, 7.2vw, 86px)';",
      "  const ICO = 'clamp(32px, 4.2vw, 50px)';",
      '  /* Два разных импульса, потому что это разные события.',
      '     playPulse — нажатие play: широкая волна наружу.',
      '     trackPulse — смена трека: короткий сжатый удар по самой кнопке.',
      '     Раньше смена трека была видна только тем, что иконка на секунду',
      '     прыгала на «паузу» — а это был побочный эффект того, что состояние',
      '     сбрасывали на время переключения. Сброс убрали, и оказалось, что',
      '     переключение не сигналит ничем: обложка меняется в соседней',
      '     панели, а на кнопке ничего. */',
      '  const [playPulse, setPlayPulse] = useState(0);',
      '  const [trackPulse, setTrackPulse] = useState(0);',
      '  const wasPlaying = useRef(false);',
      '  useEffect(() => {',
      '    if (isPlaying && !wasPlaying.current) setPlayPulse(k => k + 1);',
      '    wasPlaying.current = isPlaying;',
      '  }, [isPlaying]);',
      '  const lastTrack = useRef(trackKey);',
      '  useEffect(() => {',
      '    if (lastTrack.current === trackKey) return;',
      '    lastTrack.current = trackKey;',
      '    if (trackKey != null) setTrackPulse(k => k + 1);',
      '  }, [trackKey]);',
      '',
      '  /* Раньше обе иконки анимировались одновременно и навстречу: уходящая',
      '     крутилась на −90° и сжималась до 0.45, приходящая крутилась на +90°',
      '     и расползалась, а кривая с перелётом (0.34,1.56,0.64,1) перескакивала',
      '     через 100%. Три движения разом — и кнопка дёргалась. Теперь вращения',
      '     нет, иконки просто меняются местами через кроссфейд с лёгким масштабом,',
      '     причём уходящая гаснет быстрее, чем появляется новая: наложения двух',
      '     полусоветлых картинок не видно. */',
      '  const ico = visible => ({',
      "    position:'absolute', top:0, left:0, width:ICO, height:ICO,",
      "    filter:'brightness(0) invert(1)',",
      '    opacity: visible ? 1 : 0,',
      "    transform: visible ? 'scale(1)' : 'scale(0.78)',",
      '    transition: visible',
      "      ? 'opacity 0.22s ease-out, transform 0.34s cubic-bezier(0.2,0.9,0.2,1)'",
      "      : 'opacity 0.12s ease-in, transform 0.12s ease-in',",
      "    pointerEvents:'none',",
      '  });',
      '  return (',
      '    <motion.button onClick={onToggle}',
      '      whileHover={{ scale: 1.04 }}',
      '      whileTap={{ scale: 0.93 }}',
      "      animate={trackPulse > 0 ? { scale: [1, 0.9, 1] } : {}}",
      "      transition={{ type:'spring', stiffness: 380, damping: 26, mass: 0.6 }}",
      '      style={{',
      "        width:BTN, height:BTN, borderRadius:'50%', border:'none',",
      "        background: isPlaying ? 'rgba(178,178,178,0.1)' : 'rgba(255,255,255,0.06)',",
      "        color:'var(--text)',",
      "        display:'flex', alignItems:'center', justifyContent:'center',",
      "        cursor:'pointer', flexShrink:0, position:'relative',",
      "        transition:'background 0.3s ease',",
      '      }}>',
      '      {isPlaying && playPulse > 0 && (',
      '        <motion.span key={playPulse}',
      '          initial={{ scale:0.82, opacity:0.5 }}',
      '          animate={{ scale:1.45, opacity:0 }}',
      "          transition={{ duration:0.62, ease:'easeOut' }}",
      '          style={{',
      "            position:'absolute', inset:0, borderRadius:'50%',",
      "            border:'1.5px solid rgba(255,255,255,0.55)', pointerEvents:'none',",
      '          }}/>',
      '      )}',
      "      <div style={{position:'relative', width:ICO, height:ICO}}>",
      '        <img src="../assets/play.png"  style={ico(!isPlaying)}/>',
      '        <img src="../assets/pause.png" style={ico( isPlaying)}/>',
      '      </div>',
      '    </motion.button>',
      '  );',
      '}',
    ],
  },
  {
    why: 'кнопке play передаётся ключ трека, иначе смена трека нечем показать',
    from: [
      '              <PlayBtn isPlaying={isPlaying} onToggle={()=>setIsPlaying(p=>!p)}/>',
    ],
    to: [
      '              <PlayBtn isPlaying={isPlaying} onToggle={()=>setIsPlaying(p=>!p)}',
      "                trackKey={scPlayingTrack ? 'sc:'+scPlayingTrack.id",
      "                        : (track ? 'loc:'+track.id : null)}/>",
    ],
  },
  {
    why: 'слой обложки с уже присутствующим url добавлялся вторым экземпляром: два одинаковых key ломали reconcile react и оставляли сверху обложку чужого трека',
    from: [
      '    setLayers(prev => (url ? [...prev, { url }] : []));',
    ],
    to: [
      '    setLayers(prev => {',
      '      if (!url) return [];',
      '      const found = prev.find(l => l.url === url);',
      '      if (found) return [...prev.filter(l => l.url !== url), found];',
      '      return [...prev, { url }];',
      '    });',
    ],
  },
  {
    why: 'трасса слоёв обложки в лог: без неё «обложки нету» и «осталась чужая» неразличимы',
    from: [
      '  const topReady = layers.length ? !!layers[layers.length - 1].ready : true;',
      '  useEffect(() => { if (topReady) onReady?.(); }, [topReady, onReady]);',
    ],
    to: [
      '  const topReady = layers.length ? !!layers[layers.length - 1].ready : true;',
      '  useEffect(() => { if (topReady) onReady?.(); }, [topReady, onReady]);',
      '  /* трасса слоёв: сколько их, готов ли верхний и какой url пришёл. без неё',
      '     «обложки нету» и «осталась чужая обложка» выглядят одинаково */',
      '  useEffect(() => {',
      '    window.electronAPI?.log?.(',
      "      '[cover] слоёв ' + layers.length + ' topReady=' + topReady",
      "      + ' instant=' + !!instant",
      "      + ' url=' + String(url || 'НЕТ').slice(-46)",
      "      + ' дубликатов=' + (layers.length - new Set(layers.map(l => l.url)).size),",
      '    );',
      '  }, [layers, topReady, url, instant]);',
    ],
  },
  {
    why: 'смена обложки в плеере: честный кроссфейд, только масштаб (канва уже растеризована — иначе перерисовка битмапа)',
    from: ['function CoverLayer({ url, onLoaded, onFailed, instant }) {'],
    to: [
      'function CoverLayer({ url, onLoaded, onFailed, instant, isTop = true, ready = false, topReady = true }) {',
    ],
  },
  {
    why: 'прозрачностью слоя управлял колбэк загрузки: нижний слой становился видимым и не уходил — кроссфейда не было',
    from: [
      '      const ready = () => {',
      '        if (dead) return;',
      '        draw();',
      "        if (canvasRef.current) canvasRef.current.style.opacity = '1';",
      '        retryRef.current = 0;',
      '        onLoaded(url);',
      '      };',
    ],
    to: [
      '      const ready = () => {',
      '        if (dead) return;',
      '        draw();',
      '        /* прозрачностью занимается эффект положения слоя: она зависит ещё и',
      '           от того, верхний этот слой или нет. Раньше здесь стояло',
      "           `style.opacity = '1'` — нижний слой становился видимым и не",
      '           уходил, поэтому кроссфейда не было, а новая обложка просто',
      '           проявлялась поверх неподвижной старой */',
      '        retryRef.current = 0;',
      '        onLoaded(url);',
      '      };',
    ],
  },
  {
    why: 'положение слоя обложки: прилёт и уход старого, но только когда новый уже готов',
    from: [
      '  return (',
      '    <canvas ref={canvasRef}',
      "      style={{position:'absolute',inset:0,width:'100%',height:'100%',display:'block',opacity:0,",
      "        /* ⚠️ instant — на экране hero-клона кроссфейд НЕ нужен и вреден.",
      '           клон поверх уже показывает новую обложку; если дать нижним слоям 0.45s дорисовки,',
      '           в момент снятия клона (510мс) сверху будет полупрозрачная новая,',
      '           а снизу — старая. */',
      "        transition: instant ? 'none' : 'opacity 0.45s ease',pointerEvents:'none'}}/>",
      '  );',
      '}',
    ],
    to: [
      '  /* Положение слоя. Тут и живёт смена обложки в плеере.',
      '     Только масштаб: поворот и подъём читались как дёрганье, а холст уже',
      '     растеризован — двигать его можно композиционно, без перерисовки',
      '     битмапа, и ничего больше.',
      '     Старый слой уходит не сразу, а когда новый УЖЕ готов: иначе между',
      '     появлением нового слоя и его загрузкой мелькнул бы placeholder с',
      '     нотой. Поэтому проверка topReady, а не просто «перестал быть верхним». */',
      '  useEffect(() => {',
      '    const cv = canvasRef.current;',
      '    if (!cv) return;',
      '    if (isTop) {',
      "      cv.style.opacity = ready ? '1' : '0';",
      "      cv.style.transform = ready ? 'none' : 'scale(1.035)';",
      '      return;',
      '    }',
      '    if (!topReady) return;',
      "    cv.style.opacity = '0';",
      "    cv.style.transform = 'scale(0.985)';",
      '  }, [isTop, ready, topReady]);',
      '',
      '  return (',
      '    <canvas ref={canvasRef}',
      "      style={{position:'absolute',inset:0,width:'100%',height:'100%',display:'block',",
      "        opacity: instant ? 1 : 0, transform:'none',",
      "        /* ⚠️ instant — на экране hero-клона кроссфейд НЕ нужен и вреден.",
      '           клон поверх уже показывает новую обложку; если дать нижним слоям дорисовки,',
      '           в момент снятия клона сверху будет полупрозрачная новая,',
      '           а снизу — старая. */',
      "        transition: instant ? 'none' : 'opacity 0.38s ease-out, transform 0.5s cubic-bezier(0.2,0.8,0.2,1)',",
      "        willChange:'transform, opacity',",
      "        pointerEvents:'none'}}/>",
      '  );',
      '}',
    ],
  },
  {
    why: 'AlbumArt передаёт слоям isTop/ready/topReady, иначе положение слоя не считается',
    from: [
      '      {layers.map(l => (',
      '        <CoverLayer key={l.url} url={l.url} onLoaded={markLoaded} onFailed={dropLayer} instant={instant}/>',
      '      ))}    </div>',
    ],
    to: [
      '      {layers.map((l, i) => (',
      '        <CoverLayer key={l.url} url={l.url} onLoaded={markLoaded} onFailed={dropLayer} instant={instant}',
      '          isTop={i === layers.length - 1} ready={!!l.ready} topReady={topReady}/>',
      '      ))}    </div>',
    ],
  },
  {
    why: 'проверка сохранения плейлиста била в /playlists/{id}/tracks, который отвечает 404, и при ошибке возвращала true — «сохранено»',
    from: [
      '    const verify = async () => {',
      '      const check = await window.electronAPI.scFetch(',
      '        `https://api-v2.soundcloud.com/playlists/${playlist.id}/tracks?limit=200`,',
      '        scAuth.token, scAuth.clientId);',
      '      if (check.error) return true; /* проверить не вышли — доверяем 200 */',
      '      const col = Array.isArray(check.data) ? check.data : check.data?.collection;',
      '      if (!col) return true;',
      '      return col.length === snapshot.length && snapshot.every((x, k) => col[k]?.id === x.id);',
      '    };',
    ],
    to: [
      '    const verify = async () => {',
      '      /* Проверять надо GET /playlists/{id}: он отдаёт плейлист сразу со всеми',
      '         треками. Эндпоинт /playlists/{id}/tracks у soundcloud на этот',
      '         playlist отвечает 404 (проверено curl\'ом на живой учётке), и раньше',
      '         проверка на нём всегда падала. Хуже: при ошибке она возвращала',
      '         true, то есть «не смогли проверить» выдавалось за «сохранено» —',
      '         редактор радостно закрывался, ничего не изменив. */',
      '      const check = await window.electronAPI.scFetch(',
      '        `https://api-v2.soundcloud.com/playlists/${playlist.id}`,',
      '        scAuth.token, scAuth.clientId);',
      '      if (check.error) return false;',
      '      const col = check.data?.tracks;',
      '      if (!Array.isArray(col)) return false;',
      '      return col.length === snapshot.length && snapshot.every((x, k) => col[k]?.id === x.id);',
      '    };',
    ],
  },
  {
    why: 'plTotalDur — сумма длительностей для чипа, в useMemo по playlistActive, а не на каждом рендере',
    from: ['  const showWelcome = !settings.musicFolder && !settings.soundcloudAuth;'],
    to: [
      '  /* сумма длительностей плейлиста для чипа в плеере. считается в useMemo',
      '     по playlistActive, а не на каждом рендере App: у треков duration',
      '     обычно есть сразу (mapScTrack делит мс на 1000), но у догруженных',
      '     заглушек он проставляется позже, и список меняет ссылку — так что',
      '     зависимость одна и та же */',
      '  const plTotalDur = useMemo(() => playlistActive',
      '    ? playlistActive.tracks.reduce((a, tr) => a + (Number(tr.duration) || 0), 0)',
      '    : 0, [playlistActive]);',
      '',
      '  const showWelcome = !settings.musicFolder && !settings.soundcloudAuth;',
    ],
  },
]

const block = v => (Array.isArray(v) ? v.join('\n') : v)

for (const patch of PATCHES) {
  if (patch.all) {
    const hits = body.filter(l => l.includes(patch.all)).length
    if (hits !== patch.count) {
      throw new Error(
        `патч «${patch.why}» ожидал ${patch.count} вхождений ${patch.all}, а нашёл ${hits}`,
      )
    }
    for (let i = 0; i < body.length; i++) body[i] = body[i].split(patch.all).join(patch.to)
    continue
  }
  const { why } = patch
  const from = block(patch.from)
  const to = block(patch.to)
  /* многострочный блок склеиваем и заменяем по всему телу разом:
     line-based поиск по массиву строк такой патч не находит в принципе */
  if (from.includes('\n')) {
    const text = body.join('\n')
    const hits = text.split(from).length - 1
    if (hits !== 1) {
      throw new Error(`патч «${why}» ожидал 1 вхождение блока, а нашёл ${hits}`)
    }
    body.splice(0, body.length, ...text.split(from).join(to).split('\n'))
    continue
  }
  const i = body.indexOf(from)
  if (i < 0) throw new Error(`патч не нашёл строку: ${why}\n  ${from}`)
  body[i] = to
}

const css = `${FONT_CSS}
${APP_CSS}
`
  .replace("url('./fonts/ProximaSoft-Bold.ttf')", "url('/fonts/ProximaSoft-Bold.ttf')")

const jsx = `${IMPORTS}
${body.join('\n')}

export default App
`

mkdirSync(resolve(root, 'src'), { recursive: true })
writeFileSync(resolve(root, 'src/styles.css'), css, 'utf8')
writeFileSync(resolve(root, 'src/app.jsx'), jsx, 'utf8')

console.log(`styles.css ${css.length} симв., app.jsx ${jsx.length} симв., строк js: ${body.length + 1}`)
