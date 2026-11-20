import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useDeferredValue, useId, useReducer } from 'react'
/* createPortal шёл через глобальный ReactDOM из cdn-скрипта; в es-модуле
   глобала нет, поэтому импортируем точечно. Правка в PATCHES — замена
   ReactDOM.createPortal на createPortal. */
import { createPortal } from 'react-dom'
import { motion, AnimatePresence, LayoutGroup, Reorder, useSpring, useMotionValue, useTransform } from 'framer-motion'
import { EqContour, createEqContourModel } from './eq-contour.jsx'
import { crossfadeBoltEnvelope, crossfadeBoltPath, crossfadeBoltBranches } from './crossfade-preview-motion.js'
import './equalizer.css'
/* ⚠️ hls.js и gsap грузятся ЛЕНИВО, а не в шапке модуля. Оба нужны не на
   старте: hls — только когда включаем SC-трек (и только для hls-стримов),
   gsap — на первом hero-перелёте и на входе в плеер. Статический импорт
   тащил их в стартовый чанк: ~1.2 МБ разбиралось и исполнялось ДО первого
   кадра, на старте, где они не нужны. Теперь каждый — свой чанк, который
   приезжает по динамическому import() ровно в момент первой нужды и дальше
   живёт в памяти (модули кэшируются) — туда-обратно через границу IPC тут
   ничего не ходит, это тот же webview.
   Контракт: loader возвращает модуль целиком, потребитель берёт .default. */
let _hlsPromise = null;
let _gsapPromise = null;
const loadHls  = () => (_hlsPromise ||= import('hls.js').then(m => m.default));
const loadGsap = () => (_gsapPromise ||= import('gsap').then(m => m.default));
/* этот модуль ставит window.electronAPI surface; импорт идёт первым, чтобы
   фасад существовал до того, как App смонтируется (bridge ставит его на импорте) */
import './bridge.js'
import { fileSrc } from './bridge.js'
/* порядок перемешивания: перестановка + курсор в одном месте (src/shuffle.js) */
import { Shuffle } from './shuffle.js'
import { discordSnapshot, updateDiscordPlayback } from './discord-presence.js'
import { CROSSFADE_MAX, CROSSFADE_PRESETS, crossfadeSettings, cleanCrossfadeSettings,
  crossfadeDuration, crossfadeIntroPosition, crossfadeCurvePoints, mixCurvePoints,
  mediaDuration, rotateDecks, CrossfadeEnvelope, waitForDeck } from './crossfade.js'
import { sliderFraction, sliderValue, pointerFraction } from './slider.js'
import { Disclosure, DisclosureLayout } from './disclosure.jsx'
import { MiniPlayer } from './mini-player.jsx'
import { addListeningHistory, cleanListeningHistory, historyTrackKey } from './listening-history.js'
import { useListeningHistory } from './use-listening-history.js'
import { useHistoryCovers } from './use-history-covers.js'
import { HistoryIcon, ListeningHistory } from './listening-history.jsx'
import { ListeningParty, partyLabels } from './listening-party.jsx'
import { PartyPlayerLayout } from './party-player-layout.jsx'
import { initialPartyState, partyReducer, sharedPartyTrack } from './listening-party.js'
import { PartyClient } from './party-client.js'
import { withScArtwork, resolvePartyArtwork } from './party-artwork.js'
import { waitForPartyAudio } from './party-audio.js'
import { createNavigationOwner, createToastOwner, createFeedbackMotion, isFineHover } from './motion-lifecycle.js'
import { useSuccessFeedback } from './use-motion-feedback.js'
import { useReducedMotion } from './use-motion-preference.js'
import { reducedMotionNow, subscribeReducedMotion, animateHeroFlight, heroMayReveal } from './motion-preference.js'


/* десктоп-поведение вместо сайт-поведения:
   Tab не гоняет фокус по вкладкам/кнопкам (рамка-«бегунка» больше не появляется) */
window.addEventListener('keydown', e => { if (e.key === 'Tab') e.preventDefault(); });

/* ── accent presets ──────────────────────────────────────────────────────── */
/* Пять быстрых образцов. Остались как «шорткаты» внутри полного пикера
   цвета: сам акцент давно произвольный, а эти — то, что хочется достать в
   одно нажатие. Хранятся как rgb, потому что приходят в appAccent напрямую. */
const ACCENT_PRESETS = {
  default:  { r: 178, g: 178, b: 178 },
  lavender: { r: 155, g: 125, b: 255 },
  mint:     { r: 130, g: 220, b: 195 },
  rose:     { r: 255, g: 145, b: 175 },
  amber:    { r: 255, g: 178, b: 100 },
};

/* ── тема: разбор цвета ────────────────────────────────────────────────────
   Пикер рисует квадрат насыщенности×светлоты и полосу оттенка, то есть
   думает в HSV, а фон собирается в градиент из тех же чисел и уходит в CSS
   строкой. Поэтому конвертации живут здесь, модулем, а не внутри
   компонента настроек: ими пользуются и пикер, и пресеты, и экспорт. */

const clampNum = (v, a, b) => (v < a ? a : v > b ? b : v);

const rgbToHex = (r, g, b) => '#' + [r, g, b]
  .map(v => clampNum(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');

function hexToRgb(h) {
  const s = String(h || '').trim().replace(/^#/, '');
  const full = s.length === 3 ? s[0] + s[0] + s[1] + s[1] + s[2] + s[2] : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
/* мусорный hex из старого settings.json не должен ронять тему: подставляем
   запасной цвет и едем дальше */
const hexOr = (h, fallback) => (hexToRgb(h) ? h : fallback);

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r)      h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else               h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: mx ? (d / mx) * 100 : 0, v: mx * 100 };
}

function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  s = clampNum(s, 0, 100) / 100;
  v = clampNum(v, 0, 100) / 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const t = h < 60  ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
          : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((t[0] + m) * 255), g: Math.round((t[1] + m) * 255), b: Math.round((t[2] + m) * 255) };
}

const hexToHsv = h => { const c = hexToRgb(h) || { r: 178, g: 178, b: 178 }; return rgbToHsv(c.r, c.g, c.b); };

/* Поверхность всплывающих панелей: меню ПКМ в списке, форма ручного поиска
   текста, диалоги, тосты. Раньше это был жёстко прописанный
   rgba(24,24,24,0.97) — на цветной теме поповер выглядел заплаткой из другого
   приложения, а на «Обложке» и вовсе спорил с живым фоном.

   Оттенок берём у фона темы, а светлоту задаём сами: в поповерах белый текст,
   и на светлой теме он бы просто пропал. Насыщенность приглушена — иначе
   кислотный фон давал бы цветную заливку вместо стекла. */
function popupSurface(hex, alpha = 0.97) {
  const { h, s } = hexToHsv(hex);
  /* 14% светлоты — это уже читаемо белым текстом, но оттенок темы виден;
     ярче делать нельзя: панель начинает выглядеть цветной заливкой. */
  const c = hsvToRgb(h, Math.min(s, 60) * 0.9, 14);
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
}

/* Случайный цвет для «удиви меня». Оттенок берём целиком, а насыщенность и
   светлоту — из узких «вкусных» диапазонов: если крутить все три свободно,
   половина розырков выходит грязно-жёлтой или почти чёрной, и результат
   выглядит как поломка, а не как сюрприз. */
function randomVividHex() {
  const c = hsvToRgb(Math.random() * 360, 58 + Math.random() * 34, 72 + Math.random() * 24);
  return rgbToHex(c.r, c.g, c.b);
}
/* тёмный фон в том же настроении — hue слегка сдвинут, светлота убита */
function randomDeepHex() {
  const c = hsvToRgb(Math.random() * 360, 34 + Math.random() * 40, 7 + Math.random() * 10);
  return rgbToHex(c.r, c.g, c.b);
}

/* ── тема ──────────────────────────────────────────────────────────────────
   Настройка целиком: акцент, фон, свечение, форма, зерно. Раньше «оформление»
   умело только переключить пять заранее заданных цветов и режим «от
   обложки» — то есть покрасить интерфейс можно было ровно пятью способами. */

const THEME_BG_MODES = ['default', 'color', 'gradient', 'cover'];

const THEME_DEFAULT = {
  accent:      '#b2b2b2',
  accent2:     '#9b7dff',
  accentGrad:  false,        /* линия у верхнего края: accent → accent2 */
  bgMode:      'default',
  bgColor:     '#07070a',
  bgColor2:    '#1b1030',
  bgAngle:     145,
  glowStrength: 1,           /* множитель всех свечений, 0…2 */
  radius:      12,           /* скругление окна и карточек, px */
  grain:       0.022,        /* сила зерна, до 0.25 */
  vignette:    0.5,          /* затемнение краёв. дефолт низкий намеренно:
                            на полной силе виньетка читалась тёмной рамкой
                            по всему краю окна и портила скругление */
  preset:      null,
};

/* Темы. В сетке две: стоковая и «Обложка». Ранее здесь был ещё десяток
   раскрасок (Нуар, Лаванда, Океан…), они убраны: то же самое набирается
   ползунками и сохраняется в «Свои темы», а наборов было столько, что
   отличалась от соседней половина одним акцентом.

   ⚠️ Тема со своим фоном обязана ставить `bgMode:'color'`, а не 'default' с
   заполненным `bgColor`. Режим «Стандарт» — это ровно стоковый #07070a, и
   effect фона при нём СНИМАЕТ --bg, а не пишет его. */
const THEME_PRESETS = [
  { id:'default', label:'Стандарт', v:{
    bgMode:'default' } },
  /* Фон под обложку. Зерно здесь выключено намеренно: шум поверх
     плавно ползущего градиента превращается в песочницу — он не
     перерисовывается вместе с ним, и при смене трека фон едет, а зерно
     остаётся на месте, и глаз это видит. */
  { id:'cover', label:'Обложка', v:{
    accent:'#7cf7ff', bgMode:'cover', glowStrength:1.15, radius:20, grain:0 } },
  /* Материал окна. Это единственный набор, который трогает не только тему,
     поэтому у карточки есть `fx`: mica — настройка ОКНА, а не theme, и
     тонировка обложек тоже живёт в своих полях. Вместе они и дают то, что
     видно на превью: полупрозрачное окно и обложки в цвет акцента Windows.
     bgMode:'default' — под материалом свой фон всё равно снимается. */
  { id:'mica', label:'Материал', v:{
    bgMode:'default' }, fx:{
    windowEffect:'mica', coverTintMode:'accent',
    /* сила — как у дефолта: если у человека тонировка была выключена в ноль,
       набор иначе выглядел бы «включил и ничего не произошло». Это пресет,
       он и тему сбрасывает к своим значениям — так же и здесь. */
    coverTint: 0.45 } },
];

const THEME_DEFAULTS_VERSION = 2;
function defaultTheme() {
  const p = THEME_PRESETS.find(x => x.id === 'cover');
  return cleanTheme({ ...THEME_DEFAULT, ...(p ? p.v : null) });
}

/* Число из settings.json: мусор, строки и NaN заменяем дефолтом и зажимаем
   в диапазон. Всё, что приходит с диска, проходит через это — иначе один
   битый grain=Nan уносил в invalid всё, что на нём висит. */
const numOr = (v, d, a, b) => (Number.isFinite(+v) ? clampNum(+v, a, b) : d);

function cleanTheme(raw) {
  const t = { ...THEME_DEFAULT, ...(raw && typeof raw === 'object' ? raw : {}) };
  t.accent      = hexOr(t.accent, THEME_DEFAULT.accent);
  t.accent2     = hexOr(t.accent2, t.accent);
  t.accentGrad  = !!t.accentGrad;
  t.bgMode      = THEME_BG_MODES.includes(t.bgMode) ? t.bgMode : 'default';
  t.bgColor     = hexOr(t.bgColor, THEME_DEFAULT.bgColor);
  t.bgColor2    = hexOr(t.bgColor2, THEME_DEFAULT.bgColor2);
  t.bgAngle     = Math.round(numOr(t.bgAngle, THEME_DEFAULT.bgAngle, 0, 360));
  t.glowStrength = numOr(t.glowStrength, 1, 0, 2);
  t.radius       = Math.round(numOr(t.radius, THEME_DEFAULT.radius, 0, 28));
  t.grain        = numOr(t.grain, THEME_DEFAULT.grain, 0, 0.25);
  t.vignette     = numOr(t.vignette, 1, 0, 1);
  /* пресет держим только если он ещё существует — иначе в сетке не горит
     ни одна карточка, а тема вполне может быть применена */
  t.preset = THEME_PRESETS.some(p => p.id === t.preset) ? t.preset : null;
  return t;
}

/* Свои темы. Живут рядом с theme в settings.userThemes — по тем же воротам,
   что всё остальное: не массив, не строки, а {id, name, v}. Идентификатор
   выдаёт счётчик + время, а не Math.random: при двух сохранениях подряд
   случайные id почти не могут совпасть, но «почти» здесь означает
   перетирание чужой темы, а стоимость проверки нулевая. */
const MAX_USER_THEMES = 24;
function newThemeId() {
  return 'u' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
}
function cleanUserThemes(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object' || out.length >= MAX_USER_THEMES) continue;
    const id = typeof raw.id === 'string' && raw.id && !seen.has(raw.id) ? raw.id : newThemeId();
    seen.add(id);
    const name = String(raw.name ?? '').slice(0, 24);
    out.push({ id, name, v: cleanTheme(raw.v) });
  }
  return out;
}

/* Фон оболочки → строка CSS. Пишется в --bg-image и рисуется поверх
   --bg-цвета, поэтому режим «цвет» и режим по умолчанию дают 'none'.

   `rgb` — подстановка для превью плитки. В самом окне его не передают, и
   тогда в градиент попадает `var(--accent-rgb)`, то есть ЖИВОЕ значение:
   оно обновляется лерпом акцента, и фон едет за обложкой сам, без
   отдельной анимации. Именно поэтому фон «под обложку» плавный: он не
   перерисовывается по своему таймеру, а просто переиспользует тот же
   цвет, что и всё остальное свечение. */
function themeBgImage(t, rgb) {
  if (t.bgMode === 'cover') {
    /* Два пятна от одного цвета, а не одно: с одним пятном тёмный фон
       читался бы как просто затемнение, а не как «обложка светится». */
    return `radial-gradient(130% 100% at 18% 0%, rgba(${rgb || 'var(--accent-rgb)'},0.28) 0%, transparent 62%),`
         + `radial-gradient(100% 85% at 86% 100%, rgba(${rgb || 'var(--accent-rgb)'},0.17) 0%, transparent 60%)`;
  }
  return t.bgMode === 'gradient'
    ? `linear-gradient(${t.bgAngle}deg, ${t.bgColor}, ${t.bgColor2})`
    : 'none';
}
/* «r, g, b» для подстановки в превью: там живого --accent-rgb нет, и под
   него подставлялся бы глобальный акцент, из-за чего все плитки с этим
   режимом показывали бы один и тот же фон */
const rgbTriplet = hex => {
  const c = hexToRgb(hex) || { r: 0, g: 0, b: 0 };
  return `${c.r}, ${c.g}, ${c.b}`;
};

/* Имя своей темы по оттенку акцента. Автоматическое, потому что спрашивать
   имя перед сохранением — лишний шаг, а «Тема 1 / Тема 2» ни о чём не
   говорит. Оттенок — самый узнаваемый признак цвета, по нему список
   читается. */
const HUE_NAMES = {
  ru: ['Красный', 'Оранжевый', 'Янтарный', 'Лаймовый', 'Зелёный', 'Изумрудный',
       'Бирюзовый', 'Голубой', 'Синий', 'Индиго', 'Фиолетовый', 'Пурпурный', 'Розовый'],
  en: ['Red', 'Orange', 'Amber', 'Lime', 'Green', 'Emerald',
       'Teal', 'Sky', 'Blue', 'Indigo', 'Violet', 'Purple', 'Pink'],
};
function themeHueName(accent, lang) {
  const en = lang === 'en';
  const names = en ? HUE_NAMES.en : HUE_NAMES.ru;
  const { h, s, v } = hexToHsv(accent);
  /* Бледный и тёмный акцент называем иначе: серый «Голубой» вводит в
     заблуждение сильнее, чем нейтральное «Пепел». */
  if (v < 22) return en ? 'Charcoal' : 'Уголь';
  if (s < 18) return en ? 'Ash' : 'Пепел';
  return names[Math.round(h / 360 * names.length) % names.length];
}

/* ── lyrics sources ───────────────────────────────────────────────────────── */
/* порядок в settings.lyricsSources — это порядок поиска, сверху вниз.
   synced: true — источник умеет отдавать текст с таймкодами (строка
   подсвечивается по позиции воспроизведения).
   musixmatch сюда не внесён намеренно: поиск у него требует apikey или
   сессионный токен, без них он молча вернул бы 401 на каждый трек */
const LYRICS_SOURCES = [
  { id: 'lrclib', label: 'LRCLib', synced: true  },
  { id: 'genius', label: 'Genius', synced: false },
];
const LYRICS_SOURCE_IDS = LYRICS_SOURCES.map(s => s.id);
/* массив в настройках = включённые источники в порядке приоритета.
   не-массив (поле ещё не было в файле настроек) → все включены по умолчанию;
   массив остаётся как есть, иначе выключенный источник снова «включался» бы */
function cleanLyricsSources(arr) {
  if (!Array.isArray(arr)) return LYRICS_SOURCE_IDS.slice();
  return [...new Set(arr.filter(id => LYRICS_SOURCE_IDS.includes(id)))];
}

/* значения RPC-настроек. мусор из settings.json (или значения из будущей
   версии) раньше уезжали в main как есть: 'Progress' не совпадал ни с одним
   чипом в ui и в main проваливался в ветку 'elapsed' молча, без ошибки */
const DISCORD_TS    = ['progress', 'elapsed', 'none'];
const DISCORD_PAUSE = ['show', 'hide'];
function cleanDiscordSettings(s) {
  s.discordRpc        = s.discordRpc   !== false;
  s.discordCover      = s.discordCover !== false;
  s.discordTimestamp  = DISCORD_TS.includes(s.discordTimestamp)    ? s.discordTimestamp    : 'progress';
  s.discordPause      = DISCORD_PAUSE.includes(s.discordPause)     ? s.discordPause        : 'show';
  return s;
}

/* Локальные переименования sc-треков. мусор из старого/битого settings.json
   (не-объект, пустые значения, не-строки) выкидываем: иначе в SC_TITLES
   попадёт id → undefined и трек останется без названия */
function cleanScTitles(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k in raw) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

/* Один вариант текста: сам текст + источник, которым он найден. Источников
   два, и оба могут дать текст на один трек — тогда в кеше лежат оба, чтобы
   переключаться между ними можно было и после перезапуска, а не только пока
   они оба в памяти. Валидатор общий с чтением настроек: settings.json
   возвращается в программу и правится руками не реже, чем пишется. */
function cleanLyricsVariant(v) {
  if (!v || !Array.isArray(v.lines)) return null;
  const lines = v.lines.filter(l => l && typeof l.text === 'string');
  if (!lines.length) return null;
  return {
    lines,
    synced: !!v.synced,
    source: typeof v.source === 'string' ? v.source : '',
  };
}

/* Кеш найденного текста и ручные пары из карандаша — та же история, что у
   scTitles: битый или очень старый settings.json не должен приносить ни
   падений в рендере, ни записей, по которым нечего искать.
   Запись кеша без единой строки бесполезна — её выбрасываем. */
function cleanLyricsCache(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k in raw) {
    const e = raw[k];
    if (!e || typeof e !== 'object') continue;
    /* старая запись писалась «плоско» (lines/synced/source без alts) —
       заворачиваем её в единственный вариант, чтобы форма в файле была
       одна и читающий код не разбирал два случая */
    const list = Array.isArray(e.alts) ? e.alts : [e];
    const alts = list.map(cleanLyricsVariant).filter(Boolean);
    if (!alts.length) continue;
    out[k] = { alts, at: Number(e.at) || 0 };
  }
  return out;
}
function cleanLyricsQueries(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k in raw) {
    const e = raw[k];
    const title = typeof e?.title === 'string' ? e.title.trim() : '';
    if (!title) continue;                 /* без названия искать нечего */
    out[k] = { artist: typeof e.artist === 'string' ? e.artist.trim() : '', title };
  }
  return out;
}

/* ── lyrics fetching ──────────────────────────────────────────────────────── */
/* Название без мусорного хвоста. Genius ищет по строке целиком и на любом
   лишнем хвосте выдаёт 0 хитов — проверено на реальном треке:
     «Поиск Врачей В Переулках Осенних 🍂 + voidvoice»  → 0 результатов
     «Поиск Врачей В Переулках Осенних»                 → 1 результат
   Поэтому режем:
     «(feat. …)» / «[Live]»  — скобки
     «- Remastered 2011»     — тире + хвост
     «+ voidvoice»           — плюс-хвост (в SC это кредит: продюсер/фит)
     «carnival * prod. @x»   — звёздочка-хвост, ТОТ ЖЕ кредит (проверено:
                               Genius «carnival» / «@sedmoenebo», а с
                               «* prod. …» в запросе — 0 хитов)
     эмодзи                  — в поиске только мешают, Genius их не ищет */
function cleanTrackName(s) {
  return String(s || '')
    .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, ' ')
    .replace(/\s*[-–—]\s.*$/, ' ')
    .replace(/\s+\+\s*.*$/, ' ')
    /* « * » требует пробелов с двух сторон, иначе «2*3» и «AC*DC» разъедутся */
    .replace(/\s+\*\s+.*$/, ' ')
    /* эмодзи и прочая пиктографика: \p{So} символ, \p{Cf} невидимые */
    .replace(/[\p{So}\p{Cf}\p{No}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* [00:12.34] / [01:02.5] → секунды */
function parseLrcStamp(mm) {
  const m = /^(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?$/.exec(mm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number('0.' + m[3]) : 0);
}

/* LRC → строки. на строке бывает несколько тегов ([00:10][01:20] chorus).
   меты вида [ar:…] выкидываем, метки секций ([Verse], [Chorus 2]) — идут
   без времени и рендерятся разделителями.
   порядок строк НЕ сортируем: в LRC он уже правильный, а сортировка
   закинула бы все метки секций в конец */
function parseLrc(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const stamps = [];
    let rest = raw;
    for (;;) {
      const m = /^\s*\[([^\]]*)\]/.exec(rest);
      if (!m) break;
      const t = parseLrcStamp(m[1]);
      /* не таймкод — значит это сама метка секции ([Chorus], [Verse 2]).
         её нельзя срезать: строка останется пустой и потеряется.
         срезаем только то, что действительно распарсилось как время */
      if (t === null) break;
      stamps.push(t);
      rest = rest.slice(m[0].length);
    }
    const line = rest.trim();
    if (!line) continue;
    if (/^\[(ar|ti|al|au|by|length|offset|re|ve|tool|id|encoding):/i.test(line)) continue;
    if (!stamps.length) { out.push({ t: null, text: line, section: true }); continue; }
    for (const t of stamps) out.push({ t, text: line, section: false });
  }
  return out;
}

function parsePlainLyrics(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => ({ t: null, text: l, section: /^\[.+\]$/.test(l) }));
}

/* ── разбор названия SC ─────────────────────────────────────────────────────
   На SC трек называют «Название + кредит», и формат всё время разный:
     «carnival * prod. @lungsinfection»  (звёздочка)
     «Королевский XVII — Charles de Gaulle» (тире, причём тут наоборот:
        на Genius «Название» — это правая часть, а левая became артистом)
     «Song + voidvoice», «Track (feat. X)», «Song - Remastered 2011»
   Добавлять условие на каждый новый случай — путь в никуда, поэтому разбор
   общий: хвост режется по СЛОВАМ-кредитам, а части — по ЗНАКАМ-разделителям.
   Пробелы вокруг знака обязательны, иначе «AC*DC» и «2*3» разъедутся. */

/* Слова-кредиты: после первого такого слова начинается не название.
   Ищем ПЕРВОЕ вхождение, а не жадное «до любого»: «Song feat. Bob (Remix)»
   должен обрезаться до «Song», а не до «Song feat. Bob». */
const CREDIT_WORDS = /\b(prod\.?|prodby|feat\.?|ft\.?|featuring|remix|rmx|mix(?:ed)?|edits?|bootleg|rework|rewrk|vip|mash(?:ed)?[\s-]?up|sped[\s-]*up|slowed(?:ed)?|reverb|nightcore|8d|flip|original\s+mix)\b/gi;

/* знаки, которыми SC отделяет название от кредита.
   ПРОБЕЛЫ с двух сторон обязательны: иначе «AC*DC» и «2*3» разъедутся */
const TITLE_SPLIT = /\s+[-–—*+|·/]\s+|\s+[x×]\s+/i;

function stripCreditTail(title) {
  const s = String(title || '');
  CREDIT_WORDS.lastIndex = 0;
  const m = CREDIT_WORDS.exec(s);
  if (!m) return s;
  /* срез до слова-кредита + снос хвостовых разделителей/открытых скобок */
  return s.slice(0, m.index).replace(/[\s([|+*\-–—/·x×]+$/i, '').trim();
}

/* Отсев мусорных кандидатов. Кандидаты АДДИТИВНЫ: полное название всегда идёт
   первым, поэтому лишний/грязный кандидат лишь добавляет бесполезный запрос и
   ничего не ломает. Ошибка опасна только в одну сторону — пропуск настоящего
   названия, поэтому фильтр мягкий. */
function plausibleTitle(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  /* нечётные скобки: «Track (Slowed» и «Reverb)» — обломки после split */
  const open = (t.match(/[([{]/g) || []).length, close = (t.match(/[)\]}]/g) || []).length;
  if (open !== close) return false;
  /* сама часть состоит только из слова-кредита: «Remix», «feat» */
  CREDIT_WORDS.lastIndex = 0;
  if (CREDIT_WORDS.test(t)) { CREDIT_WORDS.lastIndex = 0; if (t.replace(CREDIT_WORDS, '').trim().length < 3) return false }
  return /\p{L}/u.test(t);
}

/* Кандидаты в «настоящее» название, по убыванию правдоподобия.
   Ограничен CAP: каждый кандидат — это запрос к источнику. */
const TITLE_CAND_CAP = 6;
function titleCandidates(rawTitle) {
  const T = String(rawTitle || '').trim();
  const out = [];
  const add = v => {
    const s = cleanTrackName(v);
    if (s && plausibleTitle(s) && !out.includes(s)) out.push(s);
  };
  add(T);                                  // целиком, почищенное — всегда первым
  add(stripCreditTail(T));                 // без хвоста «prod. …»
  for (const p of T.split(TITLE_SPLIT)) {
    const s = p.trim();
    if (!s) continue;
    add(s);
    add(stripCreditTail(s));
  }
  /* префикс до первого разделителя/слова-кредита: «carnival * prod. @x» →
     «carnival». Раньше брались первые 3 слова подряд, и получалось
     «Королевский XVII —» с висящим тире */
  const head = T.split(TITLE_SPLIT)[0] || '';
  if (head && head !== T) add(head);
  add(stripCreditTail(head));
  return out.slice(0, TITLE_CAND_CAP);
}

/* Трактовки пары «артист / название». На Genius те же слова часто лежат с
   полями НАОБОРОТ (SC «Королевский XVII — Charles de Gaulle» → Genius
   artist «королевский XVII», title «charles de gaulle»), поэтому для каждого
   кандидата пробуем и нормальную, и перевёрнутую расстановку.
   ВАЖНО: аргумент СЫРОЙ — разбор идёт по нему, чистка применяется после. */
function trackQueries(artist, rawTitle) {
  const A = cleanTrackName(artist);
  const seen = new Set();
  const pairs = [];
  for (const c of titleCandidates(rawTitle)) {
    for (const p of [[A, c], [c, A]]) {
      const [a, t] = p;
      /* вырожденная пара «артист + то же имя» бесполезна: запрос вышел бы
         «Королевский XVII Королевский XVII» и вернул 0 хитов */
      if (!a || !t || a === t) continue;
      const k = a + '/' + t;
      if (seen.has(k)) continue;
      seen.add(k);
      pairs.push(p);
    }
  }
  return pairs.length ? pairs : [[A, cleanTrackName(rawTitle)]].filter(([a, t]) => a && t);
}
/* Строки запроса, по приоритету: первым самый вероятный.
   Кроме пар «артист + название» идёт ПОИСК ТОЛЬКО ПО НАЗВАНИЮ — на SC в
   название часто кладут и артиста, и трек, и запрос с артистом мешает
   (проверено: «Королевский XVII — Charles de Gaulle» без артиста → 2 хита).
   Список ОГРАНИЧЕН: каждый вариант — это запрос к источнику, и без потолка
   при длинном названии с кредитами их уходит слишком много. */
const TITLE_QUERY_CAP = 7;
function titleVariants(artist, rawTitle) {
  const out = [];
  const add = s => {
    const v = String(s || '').replace(/\s+/g, ' ').trim();
    if (v && !out.includes(v) && out.length < TITLE_QUERY_CAP) out.push(v);
  };
  for (const [a, t] of trackQueries(artist, rawTitle)) add(a ? `${a} ${t}` : t);
  for (const c of titleCandidates(rawTitle)) add(c);
  add(String(rawTitle || '').trim());   /* СЫРОЕ: с тире и эмодзи — иногда матчится лучше */

  /* 🚨 ЛАТИНСКИЕ ТРАКТОВКИ идут ПОСЛЕ кириллических и со СВОИМ потолком.
     Если сайт записал трек по-кириллице, первые запросы уже ответят и до
     этих дело не дойдёт. А если по-латинице — до кириллических очередь
     не дойдёт никогда, и без этого блока запросов трек не находится
     вовсе. Свой потолок, а не общий TITLE_QUERY_CAP: иначе транскрипции
     вытесняли бы собой исходные варианты, которые могут сработать лучше,
     и мы бы теряли качество ради случая, который иначе не ловился бы
     вообще. */
  const LATIN_QUERY_CAP = 4;
  const base = out.slice();
  let latin = 0;
  const addLatin = s => {
    if (latin >= LATIN_QUERY_CAP) return;
    const v = String(s || '').replace(/\s+/g, ' ').trim();
    if (!v || base.includes(v) || out.includes(v)) return;
    /* защита от бессмыслицы: строка без гласных — не название */
    if (!/[aeiouy]/i.test(v.replace(/\P{L}/gu, ''))) return;
    out.push(v); latin++;
  };
  for (const [a, t] of pairVariants(trackQueries(artist, rawTitle))) {
    if (a) addLatin(`${a} ${t}`); else addLatin(t);
  }
  for (const c of titleCandidates(rawTitle)) for (const l of latinVariants(c)) addLatin(l);
  return out;
}

/* ── Кириллица → латиница для поиска текста ────────────────────────────────
   Проблема: в треке артист «@седьмоенебо», а на сайте он записан как
   «@sedmoenebo». Ни один из трёх подходов по отдельности это не чинит:
     • послать как есть — сайт не находит;
     • транслитерировать только запрос — сайт найдёт, но `trackScore`
       сравнивает результат с КИРИЛЛИЧЕСКИМ названием, `geniusNorm` оставляет
       `\p{L}`, получается 0, и гейт `s > 0` отбрасывает ПРАВИЛЬНЫЙ трек;
     • заменить кириллицу в самом треке — портит название, показываемое
       пользователю, и ломает поиск по сайту, где кириллица есть.
   Поэтому латиница добавляется как ЕЩЁ ОДНА ТРАКТОВКА трека — ровно так же,
   как уже сделано с перевёрнутой расстановкой «артист/название». */
const CYR_LATIN = {
  'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z',
  'и':'i','й':'i','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r',
  'с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh',
  'щ':'shch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
};
/* Вторая схема отличается РОВНО ОДНИМ символом: «х» → h вместо kh.
   В официальной транслитерации — kh, но в вокале/на обложках/в базах
   LRCLib «х» пишут как h. Одной схемы на всё не хватает, а различает их
   ровно одна буква, поэтому вторая схема почти ничего не стоит.
   Проверено: «седьмоенебо» → sedmoenebo (совпадает с написанием на сайте),
   «Королевский XVII» → korolevskii XVII, «Щедрик» → shchedrik,
   «Съезд» → sezd (твёрдый знак схлопывается, как и на сайте). */
const CYR_LATIN_H = { ...CYR_LATIN, 'х':'h' };
/* ДВЕ регулярки, намеренно, а не одна с `g`:
   • `CYR_RE_G` — с `g`, только для `replace` (иначе заменяется ПЕРВЫЙ
     символ, а не все: «седьмоенебо» выходило «sедьмоенебо»);
   • `CYR_RE` — БЕЗ `g`, только для `.test()`.
   ⚠️ ровно поэтому их нельзя объединять: у регулярки с `g` состояние
   `lastIndex` переживает вызов, и `.test()` начинает через раз возвращать
   false на одной и той же строке — транслитерация молча включалась бы и
   выключалась сама. */
const CYR_RE_G = /[Ѐ-ӿ]/g;
const CYR_RE   = /[Ѐ-ӿ]/;

function translitCyr(s, map) {
  return String(s || '').replace(CYR_RE_G, ch => {
    const m = map[ch.toLowerCase()];
    return m === undefined ? ch : m;
  });
}
/* Латинские варианты строки. Пусто, если кириллицы нет — тогда строка уже
   в том виде, в каком она на сайте, и трактовка ничего не добавит. */
function latinVariants(s) {
  const src = String(s || '');
  if (!CYR_RE.test(src)) return [];
  const out = [];
  for (const v of [translitCyr(src, CYR_LATIN), translitCyr(src, CYR_LATIN_H)]) {
    if (v && v !== src && !out.includes(v)) out.push(v);
  }
  return out;
}
/* Пара «артист / название» вместе с латинскими трактовками.
   ⚠️ ПОРЯДОК: СНАЧАЛА ВСЕ исходные пары, и только потом латинские.
   Порядок тут не косметика — `fetchLrclib` берёт первые N пар, и при
   чередовании (базовая, её перевод, её перевод, следующая базовая…) в этот
   срез попали бы три варианта ОДНОЙ пары, а выпала бы перевёрнутая
   расстановка «название/артист» — ровно та, ради которой список и строится.
   Знак @ и прочая пунктуация НЕ трогаются: на сайте артист именно
   «@sedmoenebo», а для /api/get у LRCLib совпадение по имени точное. */
function pairVariants(pairs) {
  const out = [];
  const seen = new Set();
  const add = (a, t) => {
    if (!a || !t) return;
    const k = a + '/' + t;
    if (seen.has(k)) return;
    seen.add(k); out.push([a, t]);
  };
  for (const [a, t] of pairs) add(a, t);
  for (const [a, t] of pairs) {
    for (const ta of latinVariants(a)) for (const tt of latinVariants(t)) add(ta, tt);
    /* случай «артист кириллицей, название латиницей» (и наоборот) — самый
       частый на практике: переводят только одно из двух */
    for (const ta of latinVariants(a)) add(ta, t);
    for (const tt of latinVariants(t)) add(a, tt);
  }
  return out;
}

/* числовые сущности: genius отдаёт `&#x27;` (hex), не только `&#39;` */
const safeChar = n => (Number.isFinite(n) && n > 0 && n < 0x110000) ? String.fromCodePoint(n) : '';
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g,       (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'").replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');   /* &amp; строго последним, иначе раскроет уже раскрытое */
}

/* Содержимое div начиная с позиции ПОСЛЕ его открывающего тега, конец — по
   СЧЁТЧИКУ вложенности, а не ленивым /<\/div>/.
   Именно на этом Genius и ломался: в контейнере текста лежат ВЛОЖЕННЫЕ div'ы
   (шапка «Contributors / Translations» со своей разметкой), и не-greedy
   вариант обрывался на ПЕРВОМ внутреннем </div> — и вместе с шапкой уносил
   куплет, идущий после неё. На проверенном треке это давало 11 строк вместо
   41: оставался только последний припев. */
function divInnerAt(html, openEnd) {
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = openEnd;
  let depth = 1;
  for (let t; (t = tags.exec(html)) !== null; ) {
    if (t[0][1] === '/') { if (--depth === 0) return html.slice(openEnd, t.index); }
    else depth++;
  }
  return html.slice(openEnd);
}

/* все контейнеры текста песни со страницы genius, по порядку */
function geniusLyricChunks(html) {
  const open = /<div[^>]+data-lyrics-container="true"[^>]*>/gi;
  const out = [];
  let m;
  while ((m = open.exec(html)) !== null) {
    const start = m.index + m[0].length;
    const inner = divInnerAt(html, start);
    /* прыгаем за весь матченный блок, иначе open повторно найдёт вложенный
       контейнер (или тот же самый) и зациклится */
    open.lastIndex = start + inner.length;
    out.push(inner);
  }
  return out;
}

/* вырезает блоки, помеченные data-exclude-from-selection — в Genius это
   шапка «Contributors / Translations». она лежит В ТОМ ЖЕ контейнере, что и
   текст песни, поэтому считаем вложенность, а не режем по первому </div> */
function stripExcluded(html) {
  let out = html;
  for (let guard = 0; guard < 50; guard++) {
    const m = /<div[^>]*\sdata-exclude-from-selection="true"[^>]*>/i.exec(out);
    if (!m) return out;
    const start = m.index + m[0].length;
    const inner = divInnerAt(out, start);
    out = out.slice(0, m.index) + out.slice(start + inner.length + 6);
  }
  return out;
}

async function netGet(url, headers) {
  const res = await window.electronAPI.netFetch(url, headers);
  if (!res || res.error) throw new Error(res?.error || 'net_error');
  return res;
}

/* ── LRCLib ───────────────────────────────────────────────────────────────── */
/* открытый, без ключа. /api/get — точное совпадение: artist+track+duration,
   длительность решает (без неё берётся первая строка и можно попасть в
   ремикс). если точного нет — /api/search, из выдачи берём ближайшую по
   длительности версию. внутри источника синхронный текст приоритетнее
   обычного даже если оба пришли */
async function fetchLrclib(artist, title, duration) {
  let hit = null;
  /* Те же варианты, что и для Genius, но ТОЛЬКО ПЕРВЫЕ ДВА. /api/search у
     lrclib и так нечёткий, третий и четвёртый вариант почти ничего не дают,
     а стоят 2 запроса каждый: на висящем lrclib это до 96с ожидания. */
  /* Сначала 3 исходные трактовки (как было), затем до 2 латинских.
     Порядок в pairVariants гарантирует, что в срез попадают именно
     исходные, а не три варианта одной пары. Общий потолок вырос с 3 до 5:
     это 10 запросов в худшем случае вместо 6, но идёт под общим дедлайном
     fetchLyrics (9с), поэтому висящий источник всё равно не съест панель.
     Без латинских пар трек вида «@седьмоенебо» не находится здесь вообще:
     /api/get у LRCLib требует ТОЧНОГО имени, а не нечёткого совпадения. */
  const lrPairs = pairVariants(trackQueries(artist, title));
  const LRC_BASE = 3, LRC_LATIN = 2;
  const lrcList = [
    ...lrPairs.slice(0, LRC_BASE),
    ...lrPairs.slice(LRC_BASE).filter(([a, t]) => CYR_RE.test(a + t)).slice(0, LRC_LATIN),
  ];
  for (const [qa, qt] of lrcList) {
    const params = new URLSearchParams({
      track_name: qt,
      artist_name: qa,
      ...(duration > 0 ? { duration: String(Math.round(duration)) } : {}),
    }).toString();

    if (duration > 0 && !hit) {
      const r = await netGet(`https://lrclib.net/api/get?${params}`);
      if (r.status === 200) { try { hit = JSON.parse(r.body) } catch {} }
    }
    if (!hit) {
      const r = await netGet(`https://lrclib.net/api/search?${params}`);
      if (r.status === 200) {
        try {
          const list = JSON.parse(r.body);
          if (Array.isArray(list) && list.length) {
            hit = duration > 0
              ? list.reduce((a, b) => Math.abs((b.duration || 0) - duration) < Math.abs((a.duration || 0) - duration) ? b : a)
              : list[0];
          }
        } catch {}
      }
    }
    if (hit) {
      /* та же страховка, что в fetchGenius: однословное название не
         различает трек. у LRCLib она почти не срабатывает — /api/get
         требует точного имени, — но /api/search нечёткий и проверка
         бесплатна: `hit.artistName` источник уже отдал */
      if (titleIsAmbiguous(title) && cleanTrackName(artist)) {
        if (!artistMatches(hit.artistName, artist)) { hit = null; continue; }
      }
      break;
    }
  }
  if (!hit) return null;

  if (hit.syncedLyrics && hit.syncedLyrics.trim()) {
    const lines = parseLrc(hit.syncedLyrics);
    if (lines.length) return { lines, synced: true };
  }
  if (hit.plainLyrics && hit.plainLyrics.trim())
    return { lines: parsePlainLyrics(hit.plainLyrics), synced: false };
  return null;
}

/* ── Genius ───────────────────────────────────────────────────────────────── */
/* официальный API требует OAuth-токена, поэтому идём через внутренние
   эндпоинты сайта (те же, что genius.com дёргает из браузера).
   Схема неофициальная и может отвалиться, поэтому у обоих шагов есть
   запасной путь. Проверено на живой странице: /api/songs/{id} отдаёт 200,
   но без поля lyrics (без токена), а текст лежит в HTML — поэтому HTML идёт
   ПЕРВЫМ, json только как фолбэк. Genius синхронизации не даёт, только plain */
function geniusNorm(s) {
  return String(s || '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}
/* Доля слов нашего названия, найденных в кандидате, в процентах.
   Нужна как страховка к includes(): у Genius в заголовке трека часто стоит
   хвост, которого нет в названии на SC («…(SFDITAA)»), или наоборот. Раньше
   из-за одного лишнего слова includes() давал false → score 0 → гейт `s > 0`
   закрывал дверь, хотя трек был найден. */
function geniusWordOverlap(a, b) {
  const A = new Set(a.split(' ').filter(w => w.length > 1));
  if (!A.size) return 0;
  let hit = 0;
  for (const w of A) if (b.includes(w)) hit++;
  return Math.round((hit / A.size) * 100);
}
/* 🚨 Название НЕ различает трек, если это одно короткое слово.
   `carnival`, `skeleton`, `halo`, `fade` — их тысячи, и поиск отдаёт
   первую попавшуюся одноимённую песню. порог 12 символов: «Soul»,
   «Scream» и «Breathe» — короткие, но встречаются с артистом в
   уникальном сочетании; а вот короткая абракадавра (`kkk`, `mvt`)
   у нас и не появится, потому что `plausibleTitle` требует буквы, а
   чистка съедает цифры. длинное название — с пробелом — само по себе
   достаточно различающее, и требование артиста там только мешало бы. */
const GENERIC_TITLE_MAX_LEN = 12;
function titleTooGeneric(t) {
  const s = String(t || '').trim();
  if (!s) return false;
  if (/\s/.test(s)) return false;      /* несколько слов — не generic */
  return s.length <= GENERIC_TITLE_MAX_LEN;
}

/* 🚨 Название НЕОДНОЗНАЧНО, только если ОДНОСЛОВНЫЕ ВСЕ кандидаты.
   Первый вариант считал признак по `cleanTrackName(rawTitle)` — и это была
   ошибка: чистка обрезает название ПО ТИРЕ, так что у
   «skeleton - im not Alex G, and ur not Sarah» остаётся `skeleton`, одно
   слово, и страховка резала честную находку (настоящий перезалив с чужим
   uploader). поймано тестом на живом треке.
   правильно — спрашивать у разбора: если хоть один кандидат длинный,
   название различает трек достаточно, и артист не обязателен. */
function titleIsAmbiguous(rawTitle) {
  const cands = titleCandidates(rawTitle);
  if (!cands.length) return false;
  return cands.every(titleTooGeneric);
}

/* 🚨 Совпадает ли артист источника с нашим — С УЧЁТОМ КИРИЛЛИЦЫ.
   сравнивать «как есть» нельзя: на сайте артист «@sedmoenebo», а у нас
   «@седьмоенебо» — они не равны и не вложены друг в друга, и страховка
   для однословных названий сама собой убивала бы всю транскрипцию,
   то есть ломала бы ровно тот случай, ради которого она и писалась.
   (это поймал тест, а не размышление: без неё однословное название
   переставало находиться ВООБЩЕ) */
function artistMatches(candArtist, artist) {
  const ca = geniusNorm(candArtist || '');
  if (!ca) return false;
  const base = cleanTrackName(artist);
  for (const form of [base, ...latinVariants(base)]) {
    const oa = geniusNorm(form);
    if (!oa) continue;
    if (ca === oa || ca.includes(oa) || oa.includes(ca)) return true;
  }
  return false;
}

/* Лучший score кандидата по ВСЕМ трактовкам трека. При развороте
   «Артист — Название» роли меняются местами, и сравнивать кандидата только с
   исходными полями бессмысленно — он получит 0 вопреки точному совпадению.
   🚨 сюда обязаны входить и ЛАТИНСКИЕ транскрипции (pairVariants): сайт
   записал артиста как «@sedmoenebo», а у нас он «@седьмоенебо». Без них
   geniusScore честно возвращает 0 (строки не равны, слов нет), и гейт
   `s > 0` в fetchGenius отбрасывает именно тот трек, который мы нашли. */
function trackScore(cand, artist, title) {
  if (!cand) return 0;
  let pairs = pairVariants(trackQueries(artist, title));
  /* ⚠️ трек БЕЗ артиста раньше вообще не мог найтись на Genius, и это не
     поломка страховки, а давний баг: `trackQueries` отдаёт пустой список
     (пары отбрасываются по `a && t`, а артиста нет), цикл не делал ни
     одной итерации, score был 0 для ЛЮБОГО кандидата. запрос-то
     отправлялся — `titleVariants` умеет искать по одному названию, — но
     гейт его тут же отбрасывал. */
  if (!pairs.length) pairs = [['', cleanTrackName(title)]];
  let best = 0;
  for (const [a, t] of pairs) {
    const s = geniusScore(cand, geniusNorm(a), geniusNorm(t));
    if (s > best) best = s;
  }
  return best;
}
function geniusScore(cand, artist, title) {
  if (!cand) return 0;
  const ct = geniusNorm(cand.title);
  const ca = geniusNorm(cand.primary_artist_names || cand.primary_artist?.name);
  const t = geniusNorm(title);
  if (!t) return 0;
  let s = ct === t ? 100 : (ct.includes(t) || t.includes(ct)) ? 70 : 0;
  if (!s) {
    const ov = geniusWordOverlap(t, ct);
    /* 60% порог: у Genius к названию почти всегда приписан хвост, иначе
       не проходил бы ни один трек */
    if (ov >= 60) s = 40 + Math.round(ov / 5);
  }
  /* Без совпадения по названию трек не найден. Артиста знать не обязательно
     (перезаливы бывают с чужим uploader), но «совпал только артист» — это
     чужая песня: раньше такое давало 40 и проходило гейт `s > 0`. */
  if (!s) return 0;
  if (artist && ca) s += ca === artist ? 40 : (ca.includes(artist) || artist.includes(ca)) ? 20 : 0;
  return s;
}

async function fetchGenius(artist, rawTitle) {
  /* 1. поиск. Пробуем НЕСКОЛЬКО вариантов запроса: на SC трек называют
        «Артист — Название», а на Genius те же слова лежат с полями
        НАОБОРОТ (проверено: SC «Королевский XVII — Charles de Gaulle» →
        Genius artist «королевский XVII», title «charles de gaulle»).
        Здесь title — СЫРОЕ, разбор внутри trackQueries. */
  let id = null;
  for (const v of titleVariants(artist, rawTitle)) {
    try {
      const r = await netGet(`https://genius.com/api/search/multi?q=${encodeURIComponent(v)}`);
      if (r.status !== 200) continue;
      const sections = JSON.parse(r.body)?.response?.sections || [];
      const hits = sections.find(s => s.type === 'song')?.hits || [];
      const scored = hits
        .map(h => ({ h, s: trackScore(h.result, artist, rawTitle) }))
        .sort((a, b) => b.s - a.s);
      if (scored[0]?.s > 0) {
        const top = scored[0];
        const res = top.h.result || {};
        const candArtist = res.primary_artist_names || res.primary_artist?.name;
        /* 🚨 ОДНОСЛОВНОЕ название + чужой артист = это другая песня.
           гейт `s > 0` засчитывает 100 баллов за одно только совпадение
           названия (артист сверху лишь бонус +40), и для названий вроде
           `carnival` или `skeleton` это находит первую попавшуюся
           одноимённую песню чужого артиста. проверено на живой жалобе:
           «carnival» от @седьмоенебо отдал Playboi Carti.

           артист поэтому обязателен РОВНО для коротких однословных
           названий, и только когда он у нас вообще есть:
           • длинное название само по себе различает достаточно — там
             требование сломало бы честные находки;
           • перезаливы с чужим uploader бывают (об этом написано выше в
             geniusScore), но у однословного названия без артиста нет ни
             одного различающего признака.
           не отвергаем насовсем, а ПРОБУЕМ СЛЕДУЮЩИЙ ВАРИАНТ запроса —
           следующий обычно уже с артистом и отсеется правильно. */
        if (titleIsAmbiguous(rawTitle) && cleanTrackName(artist)) {
          if (!artistMatches(candArtist, artist)) continue;
        }
        id = res.id;
        break;
      }
    } catch {}
  }
  if (!id) return null;

  /* 2. страница трека — рабочий путь. genius режет текст на НЕСКОЛЬКО
     контейнеров (по секциям: [Verse] / [Chorus] / [Bridge]), между ними
     лежат пустые плейсхолдеры для мобильной вёрстки. поэтому склеиваем
     все непустые по порядку: взять первый непустой = оставить только
     первую секцию песни.
     границы контейнеров — по счётчику вложенности (divInnerAt), ленивый
     /<\/div>/ тут обрезал песню до последнего припева */
  try {
    const r = await netGet(`https://genius.com/songs/${id}`, { 'Accept': 'text/html,application/xhtml+xml' });
    if (r.status === 200) {
      let txt = '';
      for (const inner of geniusLyricChunks(r.body)) {
        const chunk = decodeEntities(
          stripExcluded(inner).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
        ).trim();
        if (chunk) txt += chunk + '\n';
      }
      if (txt.trim()) return { lines: parsePlainLyrics(txt), synced: false };
    }
  } catch {}

  /* 3. json — на случай если Genius вернёт lyrics в api без токена */
  try {
    const r = await netGet(`https://genius.com/api/songs/${id}`);
    if (r.status === 200) {
      const txt = JSON.parse(r.body)?.response?.song?.lyrics;
      if (txt?.trim()) return { lines: parsePlainLyrics(txt), synced: false };
    }
  } catch {}
  return null;
}

/* Обходит включённые источники по порядку и берёт первый ответивший.
   Порядок из настроек — это приоритет, а не «кто первый ответил»: гонка
   между источниками не устраивает смысла пользователю.

   Раньше здесь стоял голый `catch {}` на источник, и из-за этого «текст не
   нашёлся» и «сеть / IPC отвалились» выглядели в панели одинаково — а это
   совершенно разные вещи. Теперь tried собирает исход по каждому
   источнику, и панель показывает, кто именно не сработал. */
const LYRICS_MISS = 'miss';   /* источник жив, но трека у него нет */
/* `q` — необязательная пара {artist, title}, которую человек ввёл карандашом
   в панели текста (см. lyricsQueryFor). Тогда метаданные трека не участвуют
   вовсе: ищем ровно то, что попросили. Пустой артист допустим — трек
   отыщется по одному названию.

   `onTried({id, result, why})` — необязательный отчёт по каждому источнику
   в момент его ответа (см. ниже, зачем не в конце).
   `onFound({source, lines, synced})` — текст, как только его принёс любой
   источник, даже если он не первый по приоритету и панель уже показывает
   чужой: из этих находок собирается переключатель под шапкой. */
async function fetchLyrics(track, order, q, onTried, onFound) {
  const artist = q ? String(q.artist || '').trim()
    : cleanTrackName(splitArtists(track.artist || '')[0]?.name || '');
  /* СЫРОЕ название, НЕ чищеное: разбор «Артист — Название» делает
     trackQueries, и если почистить заранее, тире уже исчезнет и ветка
     разбора не сработает. Из-за этого весь разворот был мёртвым кодом:
     «Королевский XVII — Charles de Gaulle» превращался в «Королевский XVII»
     (то же самое, что и артист), и поиск шёл «Королевский XVII
     Королевский XVII» → 0 хитов. */
  const rawTitle = q ? String(q.title || '').trim() : String(track.title || '').trim();
  const dur = track.duration || 0;
  const tried = [];
  if (!cleanTrackName(rawTitle)) return { status: 'empty', tried };

  /* Порядок из настроек — это ПРИОРИТЕТ, а не «кто быстрее ответил».
     Но строго последовательный обход означал, что первый источник блокирует
     остальные на своём таймауте: если LRCLib первым и не отвечает, Genius
     стартовал только через 12с×2 запроса, и панель всё это время молчала.

     Решение — все источники в полёте одновременно + ЖЕСТКИЙ БЮДЖЕТ времени:
     ждём либо разрешения источника №1, либо истечения бюджета. Уложились —
     берём лучшее по приоритету; не уложились — берём то, что уже есть, и
     не ждём оставшиеся. Итог: порядок по-прежнему выбирает победителя среди
     доступных, но мёртвый источник больше не может съесть всё время. */
  const BUDGET_MS = 9000;
  if (!order.length) return { status: 'empty', tried };
  const one = (id) => id === 'lrclib' ? fetchLrclib(artist, rawTitle, dur)
                    : id === 'genius' ? fetchGenius(artist, rawTitle)
                    : Promise.resolve(null);

  const box = order.map(() => null);   /* null = ещё в полёте */
  /* `onTried` зовётся на КАЖДЫЙ ответ сразу, а не когда до источника дошла
     очередь в цикле ниже. Разница видна именно на медленном первом
     источнике: второй уже ответил «нет трека», но спиннер на его плашке
     крутился бы ещё весь бюджет — секунды ожидания впустую. Теперь плашка
     гаснет в тот момент, когда источник действительно ответил. */
  const inflight = order.map((id, i) => {
    const p = Promise.resolve().then(() => one(id));
    p.then(v => {
      box[i] = { ok: true, v };
      const got = !!(v && v.lines && v.lines.length);
      onTried?.({ id, result: got ? 'ok' : LYRICS_MISS });
      if (got) onFound?.({ source: id, lines: v.lines, synced: !!v.synced });
    }, e => {
      box[i] = { ok: false, e };
      onTried?.({ id, result: 'error', why: String(e?.message || e) });
    });
    return p;
  });

  /* Все найденные варианты, по приоритету. Первым идёт победитель, даже если
     по порядку он не первый (такое бывает в ветке «бюджет вышел»): панель и
     кеш считают `alts[0]` тем текстом, который показан по умолчанию.
     Источники, которые ещё в полёте, сюда не попадают — их находки доедут
     отдельным `onFound`. */
  const altsFor = (src, v) => [
    { source: src, lines: v.lines, synced: !!v.synced },
    ...order.map((id, i) => {
      const b = box[i];
      if (id === src || !b || !b.ok || !b.v || !b.v.lines || !b.v.lines.length) return null;
      return { source: id, lines: b.v.lines, synced: !!b.v.synced };
    }).filter(Boolean),
  ];

  /* deadline считаем ДО гонки: если посчитать после, к бюджету прибавится
     весь срок ожидания и он удвоится */
  const deadline = Date.now() + BUDGET_MS;
  const left = () => Math.max(0, deadline - Date.now());
  /* ОЖИДАНИЕ ТОЖЕ ОГРАНИЧЕНО бюджетом. Раньше проверка «вышли ли за бюджет»
     стояла ПЕРЕД await, а сам await был без ограничения — а это и есть
     «скелетон навечно»: genius с 4 вариантами это до 4×12с таймаута, lrclib
     с 4 вариантами × 2 запроса — до 96с, и всё это время панель молчала.
     Теперь КАЖДЫЙ await гоняется с остатком бюджета, и по исчерпании
     берётся всё, что уже успели принести. */
  const settle = (p, ms) => Promise.race([
    p.then(v => ({ ok: true, v }), e => ({ ok: false, e })),
    new Promise(res => setTimeout(() => res(null), ms)),
  ]);

  await settle(inflight[0], left());
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    let s = box[i] || await settle(inflight[i], left());
    if (!s) {
      tried.push({ id, result: 'error', why: 'budget' });
      continue;
    }
    if (s.ok) {
      if (s.v && s.v.lines.length)
        return { status: 'ready', ...s.v, source: id, tried, alts: altsFor(id, s.v) };
      tried.push({ id, result: LYRICS_MISS });
    } else {
      const why = String(s.e?.message || s.e);
      tried.push({ id, result: 'error', why });
      console.warn('[lyrics]', id, why);
    }
  }
  /* бюджет кончился — но может остаться результат источника ПОЗЖЕ по
     приоритету, который уже успел ответить (все промисы в полёте с самого
     начала). берём лучший из пришедших, а не выбрасываем */
  for (let i = 0; i < order.length; i++) {
    const s = box[i];
    if (s && s.ok && s.v && s.v.lines.length && !tried.some(x => x.id === order[i]))
      return { status: 'ready', ...s.v, source: order[i], tried, alts: altsFor(order[i], s.v) };
  }
  /* если все ответили ошибкой, а не «нет трека» — это не miss */
  const allError = tried.length > 0 && tried.every(x => x.result === 'error');
  return { status: allError ? 'error' : 'empty', tried };
}

/* ── кеш текста и ручной поиск ────────────────────────────────────────────── */
/* Текст ищется по сети — от 0.3 до 9 секунд, — а трек в это время уже играет.
   Поэтому найденный текст сразу ложится в settings.lyricsCache, и в
   следующий раз панель открывается с текстом без единого запроса и без
   «ищем текст…». Кеш живёт в settings.json, то есть переживает перезапуск.

   Ключа два, и они разные намеренно:
   · lyricsQueryKey — по САМОМУ ЗАПРОСУ (артист + название). У двух треков с
     одинаковыми метаданными текст один и тот же, делить запись можно.
   · lyricsTrackKey — по ТРЕКУ, для ручной пары из карандаша. У локального
     трека id — это индекс скана, он съезжает при удалении любого файла,
     поэтому в ключ идёт пара artist+title, а не id. */
const normKeyPart = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
function lyricsQueryKey(artist, title) {
  return normKeyPart(artist) + '\u0001' + normKeyPart(title);
}
function lyricsTrackKey(track) {
  return lyricsQueryKey(track?.artist, track?.title);
}
/* Что реально уходит в источники: ручная пара, если она закреплена за
   треком, иначе метаданные (артист — первый из списка, ровно как в
   fetchLyrics). Отсюда же берётся предзаполнение полей в карандаше. */
function lyricsQueryFor(track, pinned) {
  if (pinned && normKeyPart(pinned.title)) {
    return {
      artist: String(pinned.artist || '').trim(),
      title:  String(pinned.title || '').trim(),
    };
  }
  return {
    artist: cleanTrackName(splitArtists(track?.artist || '')[0]?.name || ''),
    title:  String(track?.title || '').trim(),
  };
}
/* Сколько текстов держим. Строка песни в объектах — это 3–5 КБ, то есть
   три сотни записей ≈ 1 МБ в settings.json. Дальше вытесняются самые
   старые: слушают всё-таки последнее, а не то, что было полгода назад. */
const LYRICS_CACHE_MAX = 300;
function putLyricsCache(cache, key, entry) {
  const next = { ...(cache || {}), [key]: entry };
  const keys = Object.keys(next);
  if (keys.length > LYRICS_CACHE_MAX) {
    keys.sort((a, b) => (next[a]?.at || 0) - (next[b]?.at || 0));
    for (const k of keys.slice(0, keys.length - LYRICS_CACHE_MAX)) delete next[k];
  }
  return next;
}

/* ── live accent ─────────────────────────────────────────────────────────── */
/* актуальное анимируемое значение акцента: App лерпит его покадрово,
   canvas-компоненты подписываются и перерисовываются в такт */
const LIVE_ACCENT = { r: 178, g: 178, b: 178 };
/* гейт свечений (настройка «Акцент и свечение» → Выкл): App переключает,
   canvas-компоненты читают при каждой перерисовке */
const LIVE_GLOW = { on: true };
const _accentSubs = new Set();
function onAccentChange(fn) {
  _accentSubs.add(fn);
  return () => _accentSubs.delete(fn);
}

/* ── color extraction ────────────────────────────────────────────────────── */
const _accentCache = new Map();
function extractAccentColor(url) {
  if (!url) return Promise.resolve(null);
  if (_accentCache.has(url)) return Promise.resolve(_accentCache.get(url));
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let done = false;
    const finish = (val) => { if (done) return; done = true; _accentCache.set(url, val); resolve(val); };
    img.onload = () => {
      try {
        const W = 32, H = 32;
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, W, H);
        const { data } = ctx.getImageData(0, 0, W, H);

        // Try a series of relaxing filters; first non-empty wins.
        const passes = [
          { sat: 28, lumMin: 38, lumMax: 222, minCount: 3 },
          { sat: 14, lumMin: 22, lumMax: 235, minCount: 2 },
          { sat: 6,  lumMin: 12, lumMax: 244, minCount: 1 },
        ];

        const tryPass = (p) => {
          const buckets = new Map();
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i+1], b = data[i+2];
            const max = Math.max(r,g,b), min = Math.min(r,g,b);
            const sat = max - min;
            const lum = (r + g + b) / 3;
            if (sat < p.sat || lum < p.lumMin || lum > p.lumMax) continue;
            const key = ((r>>5)<<10) | ((g>>5)<<5) | (b>>5);
            const e = buckets.get(key) || { c:0, r:0, g:0, b:0, s:0 };
            e.c++; e.r += r; e.g += g; e.b += b; e.s += sat;
            buckets.set(key, e);
          }
          let best = null;
          for (const e of buckets.values()) {
            const score = e.c * (e.s / e.c);
            if (!best || score > best.score) best = { ...e, score };
          }
          if (!best || best.c < p.minCount) return null;
          return {
            r: Math.round(best.r / best.c),
            g: Math.round(best.g / best.c),
            b: Math.round(best.b / best.c),
          };
        };

        let color = null;
        for (const p of passes) {
          color = tryPass(p);
          if (color) break;
        }

        // Last resort: weighted mean of all mid-luminance pixels (works on grayscale covers)
        if (!color) {
          let sr=0, sg=0, sb=0, n=0;
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i+1], b = data[i+2];
            const lum = (r + g + b) / 3;
            if (lum < 18 || lum > 245) continue;
            sr += r; sg += g; sb += b; n++;
          }
          if (n > 0) color = { r: Math.round(sr/n), g: Math.round(sg/n), b: Math.round(sb/n) };
        }

        if (!color) { finish(null); return; }

        // Boost low-luminance colors so the glow & accent text stay visible
        let { r, g, b } = color;
        const lum = (r + g + b) / 3;
        if (lum < 90) {
          const k = 90 / Math.max(1, lum);
          r = Math.min(255, Math.round(r * k));
          g = Math.min(255, Math.round(g * k));
          b = Math.min(255, Math.round(b * k));
        }
        finish({ r, g, b });
      } catch { finish(null); }
    };
    img.onerror = () => finish(null);
    img.src = url;
  });
}

/* Плавный скролл с перехватом пользователем. ⚠️ раньше анимацию было
   невозможно прервать: колесо мыши во время автоскролла (переход к треку
   из библиотеки, ведение по тексту песни) — список 420-480мс «убегал»
   из-под руки, потому что rAF продолжал перезаписывать `scrollTop`.
   плюс два вызова подряд (быстрое next/prev) писали в один scrollTop
   ДВУМЯ циклами, и порог был `if (!delta)` — только на точное равенство
   нулю, то есть при delta 0.4px анимация 420мс рисовала нулевое изменение. */
const _smoothScrolls = new WeakMap();
function smoothScroll(el, targetTop, duration) {
  stopSmoothScroll(el);
  if (reducedMotionNow()) { el.scrollTop = targetTop; return; }
  const startTop = el.scrollTop;
  const delta    = targetTop - startTop;
  if (Math.abs(delta) < 1) return;   /* субпиксель — анимировать нечего */
  const t0 = performance.now();
  const unsubscribe = subscribeReducedMotion(event => {
    if (!event.matches) return;
    stopSmoothScroll(el);
    el.scrollTop = targetTop;
  });
  const owner = { frame: 0, unsubscribe, cancelled: false };
  const ease = x => x < 0.5 ? 2*x*x : 1 - Math.pow(-2*x + 2, 2)/2;
  const tick = now => {
    if (owner.cancelled) return;
    const p = Math.min((now - t0) / duration, 1);
    el.scrollTop = startTop + delta * ease(p);
    if (p < 1) owner.frame = requestAnimationFrame(tick);
    else { unsubscribe(); _smoothScrolls.delete(el); }
  };
  owner.frame = requestAnimationFrame(tick);
  _smoothScrolls.set(el, owner);
}
function stopSmoothScroll(el) {
  const h = _smoothScrolls.get(el);
  if (h) { h.cancelled = true; cancelAnimationFrame(h.frame); h.unsubscribe(); _smoothScrolls.delete(el); }
}
/* пользователь перехватывает автоскролл. вешается на сам скроллер */
function bindScrollInterrupt(el) {
  const stop = () => stopSmoothScroll(el);
  el.addEventListener('wheel', stop, { passive: true });
  el.addEventListener('touchstart', stop, { passive: true });
  el.addEventListener('pointerdown', stop);
  return () => {
    el.removeEventListener('wheel', stop);
    el.removeEventListener('touchstart', stop);
    el.removeEventListener('pointerdown', stop);
    stopSmoothScroll(el);
  };
}

function fmt(s) {
  const m = Math.floor(s/60), sec = Math.floor(s%60);
  return `${m}:${sec.toString().padStart(2,'0')}`;
}

/* суммарная длительность в H:MM:SS — для чипа плейлиста. `fmt` тут не
   годится: у него минуты без разряда часов, и «135:07» читается как
   полтора часа только если помнить, что это минуты. часы всегда на
   месте, даже когда их ноль («0:04:12») — колонка не прыгает по ширине */
function fmtHMS(s) {
  const t = Math.max(0, Math.floor(s) || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function fmtCount(n) {
  if (!n) return null;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

/* Год выхода трека для колонки в строке: «2019», а не полная дата.
   Ровно год, потому что колонка узкая, а месяц и день в списке из сотни
   треков — шум: разница между соседними релизами всё равно не читается.
   Полная дата остаётся в подсказке на ячейке.
   Разбираем UTC, не локальное время: `new Date('2019-01-01')` без часового
   пояса — это полночь UTC, и на машине к востоку от Гринвича getFullYear()
   отдавала бы 2018-й год на бóльшую часть суток */
function fmtYear(ms) {
  if (!ms) return null;
  return String(new Date(ms).getUTCFullYear());
}

/* логотип discord в том же приёме, что SoundCloudIcon: инлайн-svg с
   currentColor, потому что картинкой currentColor не красится */
function DiscordIcon({ size = 15, fill = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} style={{display:'block'}}>
      <path d="M20.32 4.57A19.79 19.79 0 0 0 15.43 3c-.24.42-.51.99-.7 1.44a18.3 18.3 0 0 0-5.48 0c-.19-.45-.47-1.02-.71-1.44a19.74 19.74 0 0 0-4.9 1.57C.63 9.2-.3 13.71.13 18.16A19.9 19.9 0 0 0 6.15 21.3c.49-.66.92-1.37 1.29-2.11-.71-.27-1.39-.6-2.03-.99.17-.13.34-.26.5-.4a14.2 14.2 0 0 0 12.18 0c.16.14.33.27.5.4-.64.39-1.32.72-2.03.99.37.74.8 1.45 1.29 2.11a19.87 19.87 0 0 0 6.02-3.14c.5-5.15-.85-9.62-3.55-13.55zM8.02 15.44c-1.18 0-2.15-1.08-2.15-2.4 0-1.32.95-2.4 2.15-2.4 1.21 0 2.18 1.09 2.16 2.4 0 1.32-.95 2.4-2.16 2.4zm7.96 0c-1.18 0-2.15-1.08-2.15-2.4 0-1.32.95-2.4 2.15-2.4 1.21 0 2.18 1.09 2.16 2.4 0 1.32-.95 2.4-2.16 2.4z"/>
    </svg>
  );
}

function SoundCloudIcon({ size = 16, fill = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="-271 345.8 256 111.2" fill={fill}>
      <path d="M-238.4,398.1c-0.8,0-1.4,0.6-1.5,1.5l-2.3,28l2.3,27.1c0.1,0.8,0.7,1.5,1.5,1.5c0.8,0,1.4-0.6,1.5-1.5l2.6-27.1l-2.6-28C-237,398.7-237.7,398.1-238.4,398.1z"/>
      <path d="M-228.2,399.9c-0.9,0-1.7,0.7-1.7,1.7l-2.1,26l2.1,27.3c0.1,1,0.8,1.7,1.7,1.7c0.9,0,1.6-0.7,1.7-1.7l2.4-27.3l-2.4-26C-226.6,400.6-227.3,399.9-228.2,399.9z"/>
      <path d="M-258.6,403.5c-0.5,0-1,0.4-1.1,1l-2.5,23l2.5,22.5c0.1,0.6,0.5,1,1.1,1c0.5,0,1-0.4,1.1-1l2.9-22.5l-2.9-23C-257.7,404-258.1,403.5-258.6,403.5z"/>
      <path d="M-268.1,412.3c-0.5,0-1,0.4-1,1l-1.9,14.3l1.9,14c0.1,0.6,0.5,1,1,1s0.9-0.4,1-1l2.2-14l-2.2-14.2C-267.2,412.8-267.6,412.3-268.1,412.3z"/>
      <path d="M-207.5,373.5c-1.2,0-2.1,0.9-2.2,2.1l-1.9,52l1.9,27.2c0.1,1.2,1,2.1,2.2,2.1s2.1-0.9,2.2-2.1l2.1-27.2l-2.1-52C-205.4,374.4-206.4,373.5-207.5,373.5z"/>
      <path d="M-248.6,399c-0.7,0-1.2,0.5-1.3,1.3l-2.4,27.3l2.4,26.3c0.1,0.7,0.6,1.3,1.3,1.3c0.7,0,1.2-0.5,1.3-1.2l2.7-26.3l-2.7-27.3C-247.4,399.6-247.9,399-248.6,399z"/>
      <path d="M-217.9,383.4c-1,0-1.9,0.8-1.9,1.9l-2,42.3l2,27.3c0.1,1.1,0.9,1.9,1.9,1.9s1.9-0.8,1.9-1.9l2.3-27.3l-2.3-42.3C-216,384.2-216.9,383.4-217.9,383.4z"/>
      <path d="M-154.4,359.3c-1.8,0-3.2,1.4-3.2,3.2l-1.2,65l1.2,26.1c0,1.8,1.5,3.2,3.2,3.2c1.8,0,3.2-1.5,3.2-3.2l1.4-26.1l-1.4-65C-151.1,360.8-152.6,359.3-154.4,359.3z"/>
      <path d="M-197.1,368.9c-1.3,0-2.3,1-2.4,2.4l-1.8,56.3l1.8,26.9c0,1.3,1.1,2.3,2.4,2.3s2.3-1,2.4-2.4l2-26.9l-2-56.3C-194.7,370-195.8,368.9-197.1,368.9z"/>
      <path d="M-46.5,394c-4.3,0-8.4,0.9-12.2,2.4C-61.2,368-85,345.8-114,345.8c-7.1,0-14,1.4-20.1,3.8c-2.4,0.9-3,1.9-3,3.7v99.9c0,1.9,1.5,3.5,3.4,3.7c0.1,0,86.7,0,87.3,0c17.4,0,31.5-14.1,31.5-31.5C-15,408.1-29.1,394-46.5,394z"/>
      <path d="M-143.6,353.2c-1.9,0-3.4,1.6-3.5,3.5l-1.4,70.9l1.4,25.7c0,1.9,1.6,3.4,3.5,3.4c1.9,0,3.4-1.6,3.5-3.5l1.5-25.8l-1.5-70.9C-140.2,354.8-141.7,353.2-143.6,353.2z"/>
      <path d="M-186.5,366.8c-1.4,0-2.5,1.1-2.6,2.6l-1.6,58.2l1.6,26.7c0,1.4,1.2,2.6,2.6,2.6s2.5-1.1,2.6-2.6l1.8-26.7l-1.8-58.2C-184,367.9-185.1,366.8-186.5,366.8z"/>
      <path d="M-175.9,368.1c-1.5,0-2.8,1.2-2.8,2.8l-1.5,56.7l1.5,26.5c0,1.6,1.3,2.8,2.8,2.8s2.8-1.2,2.8-2.8l1.7-26.5l-1.7-56.7C-173.1,369.3-174.3,368.1-175.9,368.1z"/>
      <path d="M-165.2,369.9c-1.7,0-3,1.3-3,3l-1.4,54.7l1.4,26.3c0,1.7,1.4,3,3,3c1.7,0,3-1.3,3-3l1.5-26.3l-1.5-54.7C-162.2,371.3-163.5,369.9-165.2,369.9z"/>
    </svg>
  );
}

function scHashColor(id) {
  let h = 0; const s = String(id);
  for (const c of s) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(h) % 360},48%,38%)`;
}

/* Локальные переименования sc-треков: id → title.
   Живёт на уровне модуля (приём `LIVE_ACCENT`), потому что `mapScTrack` —
   единственная точка, где создаются треки soundcloud: лайки, поиск,
   плейлисты, станции. Она не видит `settings`, а переименование должно
   выживать и после перезагрузки кэша лайков, и после нового поиска.
   В КЭШ НА ДИСК НЕ ПИШЕМ: кэш хранит то, что отдал soundcloud, иначе
   следующая загрузка вернула бы переименованное как «настоящее» и отмена
   правки стала бы невозможной. Это чисто локальная подмена поверх ответа. */
const SC_TITLES = new Map();

/* ⚠️ КЛЮЧ ВСЕГДА СТРОКА. id у sc-трека — ЧИСЛО (`t.id` из ответа soundcloud),
   а в settings.json ключ объекта — строка, и `for...in` тоже даёт строки.
   `Map` сравнивает ключи по типу: `has(2300654447)` против `'2300654447'` —
   всегда false. Симптом был обманчив: переименование жило до перезапуска
   (там ключ ещё число), а после — откатывалось, потому что ключ стал строкой.
   Поэтому `String(...)` на каждом обращении, а не «где-то». */
const scTitleKey = (id) => String(id);
function scTitleOf(id) {
  return SC_TITLES.get(scTitleKey(id));
}

/* Подставить переименования в готовые sc-треки.
   Нужна там, где треки приходят МИМО mapScTrack — а это дисковый кэш
   лайков: initScLikes кладёт его в state как есть, и без этой функции
   переименование после перезапуска просто исчезало. */
function applyScTitles(list) {
  if (!SC_TITLES.size || !Array.isArray(list)) return list;
  return list.map(t => {
    if (!t) return t;
    const title = scTitleOf(t.id);
    return title ? { ...t, title } : t;
  });
}

/* ISO-дата с необязательным временем. Проверка формы нужна ДО Date.parse,
   потому что парсер слишком снисходителен: он разбирает «2 years ago»
   (которое soundcloud реально присылает в display_date у части треков)
   в 1997 год — не NaN, а вполне правдоподобное число, которое молча
   уехало бы в колонку даты как настоящий год выхода */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/;

/* дата выхода трека. soundcloud отдаёт несколько почти одинаковых полей:
     created_at     — когда залили (у перезаливов это может быть позже
                      настоящего выхода),
     display_date   — то же самое, но в своём формате,
     release_date /
     published_at   — встречаются у треков, оформленных как релиз альбома.
   берём по убыванию «свежести» */
function scReleaseDate(t) {
  const raw = t.display_date || t.release_date || t.published_at || t.created_at;
  if (!raw || typeof raw !== 'string') return null;
  if (!ISO_DATE_RE.test(raw.trim())) return null;
  const ms = Date.parse(raw.trim());
  if (Number.isNaN(ms)) return null;
  const y = new Date(ms).getUTCFullYear();
  /* 1990 — раньше soundcloud не существовал; сверху — текущий год +1.
     без верхней границы трек с датой «31.12.2031» показал бы в колонке
     год из будущего: такие значения SC отдаёт у перезаливов с
     неправленной меткой, и проверить их иначе нечем */
  if (y < 1990 || y > new Date().getUTCFullYear() + 1) return null;
  return ms;
}

function mapScTrack(t, noTitle) {
  const progressive = t.media?.transcodings?.find(tc => tc.format?.protocol === 'progressive');
  const hls = t.media?.transcodings?.find(tc => tc.format?.protocol === 'hls');
  return {
    id: t.id,
    title: scTitleOf(t.id) || t.title || noTitle || '—',
    artist: t.publisher_metadata?.artist || t.user?.username || '',
    /* publisher_metadata.artist = настоящий исполнитель, uploader — часто
       канал/лейбл. различаем, иначе разбор «X - Y» лезет в имя трека */
    artistReal: t.publisher_metadata?.artist || null,
    artistId: t.user?.id || null,
    artistAvatarUrl: t.user?.avatar_url || null,
    uploaderUsername: t.user?.username || null,
    duration: Math.floor((t.duration || 0) / 1000),
    color: scHashColor(t.id),
    coverUrl: t.artwork_url ? t.artwork_url.replace('-large', '-t500x500') : null,
    likesCount: t.likes_count || 0,
    playCount: t.playback_count || 0,
    releasedAt: scReleaseDate(t),
    streamUrl: progressive?.url || null,
    hlsUrl: hls?.url || null,
    permalinkUrl: t.permalink_url || null,
  };
}

/* playlist-объект SC (из users/{id}/playlists / лайков).
   ВАЖНО: во встроенном p.tracks SC отдаёт первые ~4 трека полными,
   остальные — заглушки {id} без title/media — фильтруем их, чтобы
   сработала ленивая догрузка /playlists/{id}/tracks */
function mapScPlaylist(p, auth) {
  const noTitle = null;
  return {
    id: p.id,
    title: p.title || '—',
    ownerName: p.user?.username || '',
    ownerAvatarUrl: p.user?.avatar_url || null,
    coverUrl: p.artwork_url ? p.artwork_url.replace('-large', '-t500x500') : null,
    trackCount: p.track_count ?? (p.tracks ? p.tracks.length : 0),
    isOwn: auth ? p.user_id === auth.userId : false,
    permalinkUrl: p.permalink_url || null,
    tracks: (p.tracks || []).filter(t => t && t.title && t.media).map(t => mapScTrack(t, noTitle)),
  };
}

/* SC в /users/{id}/playlists отдаёт вперемешку плейлисты и альбомы.
   признаки albums, найденные в реальном ответе (проба в консоли):
     playlist_kind — ОТСУТСТВУЕТ, type — ОТСУТСТВУЕТ, kind у всех "playlist"
     → различают is_album (bool) и set_type ("playlist"|"album")
   плюс альбомы видно по album-only полям: purchase_title, label_name,
   release_date, published_at, display_date.
   неизвестное значение НЕ режем, чтобы не потерять реальные плейлисты,
   если SC поменяет разметку */
function isScPlaylist(p) {
  if (!p) return true;
  if (p.is_album === true) return false;
  if (typeof p.set_type === 'string') return p.set_type !== 'album';
  return true;
}

/* ─── разбор имени трека для тегов и имени файла ──────────────────────────
   В SC мусорный мета-текст: «Artist - Song (feat. X)», «Song feat. X»,
   «Artist & Other — Song», «[4K] Song», «Song (prod. Y)».
   Разбираем в три части: исполнитель, название, feat-участники
   (feat из имени исполнителя убираем — в тегах он засоряет артиста). */
const TITLE_NOISE = [
  /\[[^\]]*\]/g,                       /* [4K], [Official Video] */
  /* в скобках может быть несколько слов до маркера: «(Official Audio)»,
     «(prod. metro)», «(Audio Version)» — поэтому \\b не сразу после ( */
  /\((?:[^)]*?\b)?(?:prod|produced|official|audio|video|lyrics?|visualizer|hq)\b[^)]*\)/gi,
  /\bofficial\s*(?:music\s*)?video\b/gi,
  /\bhq\b/gi,
];
const FEAT_RE = /\s*[([]?\s*\b(?:feat|ft|featuring|feat\.)[\s.][^)\]]*[)\]]?\s*$/i;
/* «исполнитель — название»: тире в разных кодировках, сократки */
const DASH_RE = /\s+[-–—]\s+/;

function cleanTrackMeta(rawTitle, rawArtist, artistReal, uploader) {
  let title = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  /* artistReal = publisher_metadata.artist (настоящий исполнитель).
     uploader = username аккаунта: часто это канал/лейбл, а не артист */
  let artist = String(artistReal || '').replace(/\s+/g, ' ').trim()
            || String(rawArtist || '').replace(/\s+/g, ' ').trim()
            || String(uploader || '').replace(/\s+/g, ' ').trim();

  for (const re of TITLE_NOISE) title = title.replace(re, ' ');
  title = title.replace(/\s*[([]\s*[)\]]\s*/g, ' ');   /* остатки пустых скобок */
  title = title.replace(/\s+/g, ' ').trim();

  /* feat вытаскиваем ДО разбора на артиста/название, иначе «feat. X» уедет
     в имя трека через разделитель */
  const feats = []
  const featM = title.match(FEAT_RE)
  if (featM) {
    const f = featM[0].replace(/^[\s([]+|[)\]]+$/g, '')
      .replace(/\s*\b(feat|ft|featuring)\b\.?\s*/i, '').trim()
    if (f) feats.push(f)
    title = title.replace(FEAT_RE, '').trim()
  }
  const artistFeatM = artist.match(FEAT_RE)
  if (artistFeatM) {
    const f = artistFeatM[0].replace(/^[\s([]+|[)\]]+$/g, '')
      .replace(/\s*\b(feat|ft|featuring)\b\.?\s*/i, '').trim()
    if (f && !feats.includes(f)) feats.push(f)
    artist = artist.replace(FEAT_RE, '').trim()   /* feat из артиста — выкидываем */
  }

  /* «Исполнитель - Название» в поле title. если исполнитель уже известен —
     не разбираем, а ВЫРЕЗАЕМ префикс из названия: иначе в теги уехало бы
     «GloRilla — Glowing» целиком. если неизвестен — левая часть и есть артист,
     и она важнее uploader'а (канал/лейбл) */
  if (DASH_RE.test(title)) {
    const [a, ...rest] = title.split(DASH_RE)
    const right = rest.join(' ').trim()
    const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    if (right) {
      if (!artistReal && a.length <= 60) { title = right; artist = a.trim() }
      else if (norm(a) === norm(artist)) { title = right }   /* артист уже назван — отрезаем */
    }
  }

  const featStr = feats.filter(Boolean).join(', ')
  return {
    title: title || '—',
    artist: artist || (featStr || '—'),
    /* для тегов: артист без feat + feat отдельной строкой в comment */
    comment: featStr ? `feat. ${featStr}` : '',
  }
}

/* ─── что печатаем в выдаче поиска и чем ищем в soundcloud ─────────────────
   Названия в soundcloud пишут как хотят: «мило #333 #333planet #ripraywan»,
   «song prod. junoes», «трек w/ @user, @other», «lux aeterna (archive)».
   Плеер такие уже разбирает (cleanTrackMeta), а выдача поиска печатала
   сырое поле title — строка читалась как лента хэштегов.

   Второе, и главное: по такой строке НЕ НАХОДИТСЯ трек. Поиск api-v2
   почти буквальный, и «lux aeterna (archive)» промахивается мимо
   «lux aeterna»: в индексе скобочной пометки нет. То же с эмодзи и
   знаками-украшениями — «✞трек✞» человек ищет как «трек». Поэтому одна
   и та же чистка применяется дважды: к строке на экране и к запросу,
   который уходит в soundcloud.

   Чистим ТОЛЬКО строки: id, обложки, ссылки и ручные переименования
   (scTitleOf) не трогаем — по ним ищутся дубли и живёт заголовок, который
   дал человек. */
const SC_MARK_RE = /(^|[\s_+])(?:[#@][\p{L}\p{N}_-]+)+/gu;
/* скобки вместе с содержимым — любой формы: «(archive)», «[Archive]» */
const SC_BRACKETS_RE = /[(（\[【{「『][^)）\]】}」』]*[)）\]】}」』]/g;
/* эмодзи: пиктограммы, флаги, оттенки кожи, склейки ZWJ, селекторы
   начертания (FE0E «текстовый» тоже: он остаётся после вырезанной эмодзи
   и висит в строке невидимым мусором) */
const SC_EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\uFE0F\uFE0E\u200D]/gu;
/* цифра/решётка/звёздочка в рамке-клавише: 1️⃣ #️⃣ *️⃣ — рисуются цифрой,
   поэтому в SC_EMOJI_RE не попадают */
const SC_KEYCAP_RE = /[0-9#*]\uFE0F?\u20E3/gu;
/* кресты, звёзды, ромбы, треугольники — украшение вокруг слова */
const SC_DECOR_RE = /[†‡✝✞☨☦☧♰♱✟✠★☆✦✧✩✪✫✬✭✮✯✰⋆⁂⁎❖◈◆◇■□▲△▼▽●○▪▫▸▹►◄❦❧☙✿❀☬⸸⛧⛥]+/gu;
/* египетские иероглифы: ими в этой сцене только украшают, словами они не
   пишутся. отдельной строкой от SC_DECOR_RE, потому что это диапазоны
   вне BMP, и в класс их удобнее вынести целиком */
const SC_HIEROGLYPH_RE = /[\u{13000}-\u{1345F}]/gu;
/* хвост «студии»: от «prod.», «pr.», «w/» до конца строки — там только
   отметки людей и пометки выпуска, а сам трек назван левее */
const SC_TAIL_RE = /\s+(?:w\/|prod\b\.?|pr\.)\s*\S[\s\S]*$/i;
/* разделители, оставшиеся от вырезанных кусков: « + - », «*, *» */
const SC_SEP_RE = /(?:\s*[+\-–—|,·*]\s*){2,}/g;

/* украшения и скобки — то, чего в индексе soundcloud нет */
function softenScText(raw) {
  return String(raw || '')
    .replace(SC_KEYCAP_RE, ' ')
    .replace(SC_EMOJI_RE, ' ')
    /* «<3» — сердце из двух знаков. иначе от него осталась бы голая «3» */
    .replace(/<+\s*3/g, ' ')
    .replace(SC_HIEROGLYPH_RE, ' ')
    .replace(SC_DECOR_RE, ' ')
    .replace(SC_BRACKETS_RE, ' ');
}

/* хвосты от вырезанных кусков: «авари  , evacry», «camilla , akiko!»,
   «issue +  - ». запятая в пустоте и двойные разделители — это след
   удалённой вставки, а не часть имени */
function tidyScSpacing(s) {
  return String(s || '')
    .replace(/\s*,\s*/g, ', ')
    .replace(/(?:,\s*){2,}/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:.|+·*/\\\-–—]+|[\s,;:.|+·*/\\\-–—]+$/g, '')
    .trim();
}

function squeezeScTitle(raw) {
  let s = softenScText(raw).replace(SC_TAIL_RE, ' ');
  /* склейку перед отметкой убираем вместе с ней: «+@user», «song_#333» —
     иначе на их месте остался бы висячий плюс или подчёркивание */
  s = s.replace(SC_MARK_RE, (m, pre) => (pre === '_' || pre === '+' ? '' : pre));
  /* пометки выпуска, которые глушит плеер: [FREE DL], (Official Audio) */
  for (const re of TITLE_NOISE) s = s.replace(re, ' ');
  s = s.replace(/\s*[([]\s*[)\]]\s*/g, ' ');
  s = s.replace(SC_SEP_RE, ' ');
  /* висячие разделители по краям: «999 - », «999 +», «* 999» */
  s = s.replace(/^[\s+\-–—|,·*]+/, '').replace(/[\s+\-–—|,·*]+$/, '');
  return s.replace(/\s{2,}/g, ' ').trim();
}

/* ─── имя артиста в выдаче ────────────────────────────────────────────────
   Ники в этой сцене — витрина: «Syrit ငါ့အတွက်ပူတယ်»,
   «А Р Т Е М_ ል የ ፐ ይ ጠ», «𓇢𓆸𝘭𝘶𝘹 𝘢𝘦𝘵𝘦𝘳𝘯𝘢». Прочесть в них можно только
   латиницу/кириллицу, остальное — узор из чужих шрифтов (мьянманский,
   эфиопский, иероглифы, каомодзи), и в списке он читается как мусор
   посреди строки.

   Стилизованные ЛАТИНСКИЕ буквы остаются: «𝒮𝒾𝓁𝓋𝑒𝓇», «𝕤𝕖𝕒», «𝙡𝙪𝙭 𝙖𝙚𝙩𝙚𝙧𝙣𝙖»,
   «ＬＵＸ» — это то же имя, просто другим начертанием, и в этой сцене так
   и пишут. Поэтому в белом списке не только «A-Z», но и математические /
   полноширинные формы латиницы.

   Но если от имени не осталось НИЧЕГО (артист и правда пишется только
   японским), возвращаем исходное: пустая строка хуже, чем непривычная. */
/* ⚠️ дефис стоит ПЕРВЫМ и экранирован: в середине класса «&-–» читается
   как диапазон от «&» до «–», то есть весь алфавит подряд — и чистка не
   убирала бы ничего */
const SC_READABLE_RE = /[^\-\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{M}0-9\u{1D400}-\u{1D7FF}\u{2100}-\u{214F}\u{FF21}-\u{FF3A}\u{FF41}-\u{FF5A}\u{FF10}-\u{FF19}\s.,'’"“”«»!?&+_–—*÷()[\]/|·×:;%$]+/gu;

function tidyScArtist(raw) {
  const base = squeezeScTitle(raw) || String(raw || '').trim();
  const readable = tidyScSpacing(
    base
      .replace(SC_READABLE_RE, ' ')
      /* вырезанная вставка оставляла свои диакритики в начале слова:
         «ខ្ញុំ audio terror club» → «្ ុំ audio terror club» */
      .replace(/(^|\s)\p{M}+/gu, '$1')
      /* куски каомодзи, от которых осталась одна пунктуация-украшение:
         «deathkawaii ^_#» → «deathkawaii _». обычную пунктуацию
         (запятую между именами) это не трогает */
      .replace(/(^|\s)[_^~*=+|<>\\/·]+(?=\s|$)/gu, '$1')
  );
  /* одни скобки/знаки без единой буквы — это уже не имя: оставляем как было
     в soundcloud (у «(￣□￣」)» от чистки остаётся голая скобка) */
  return /[\p{L}0-9]/u.test(readable) ? readable : (String(raw || '').trim() || base);
}

/* Запрос для api-v2. Если после чистки не осталось ничего (вставили одни
   смайлики), пробуем ещё раз мягче — без «#» и «@»: по нику «@user» поиск
   надёжнее находит без собаки. Совсем пустой запрос не шлём: он дал бы
   «ничего не найдено» без всякой на то причины. */
function scQueryFor(raw) {
  const deep = squeezeScTitle(raw);
  if (deep) return deep;
  return String(raw || '').replace(/[#@]/g, ' ').replace(/\s{2,}/g, ' ').trim()
      || String(raw || '').trim();
}

function cleanScTrackForSearch(track) {
  if (!track) return track;
  const meta = cleanTrackMeta(track.title, track.artist, track.artistReal, track.uploaderUsername);
  return {
    ...track,
    /* пусто после чистки — значит в названии был только мусор (#333).
       тогда честнее показать авторское, чем прочерк */
    title: squeezeScTitle(meta.title) || track.title,
    artist: tidyScArtist(meta.artist) || track.artist,
  };
}

/* Имя аккаунта для ЗАПРОСА к api-v2. Чистим мягче, чем строку на экране:
   «(archive)» и смайлики вырезаем (с ними человек не находится), а «@» и
   «#» оставляем — в запросе это часть имени, а не пометка */
function softenScName(raw) {
  /* вырезанное «(╥_╥)» оставляло запятую в пустоте: «авари  , evacry» */
  return tidyScSpacing(softenScText(raw)) || String(raw || '').trim();
}

/* имя файла: Windows не любит \/:*?"<>| и хвостовые точки */
const ILLEGAL_FS = /[<>:"/\\|?*\x00-\x1f]/g;
const fileNameFor = (artist, title) =>
  (artist && artist !== '—' ? `${artist} - ${title}` : (title || 'track'))
    .replace(ILLEGAL_FS, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim() || 'track';

/* полный список треков плейлиста. /playlists/{id}/tracks отдаёт голый массив
   ИЛИ {collection, next_href}, и там бывают заглушки {id} без title/media —
   гидратируем их пачками /tracks?ids= (порядок сохраняем как в плейлисте).
   фолбэк если пусто: полный объект /playlists/{id} → .tracks */
async function fetchPlaylistTracks(id, auth, noTitle) {
  let raw = [];
  let url = `https://api-v2.soundcloud.com/playlists/${id}/tracks?limit=200`;
  let pages = 0;
  while (url && pages < 10) {
    const res = await window.electronAPI.scFetch(url, auth.token, auth.clientId);
    if (res.error) break;
    const col = Array.isArray(res.data) ? res.data : res.data?.collection;
    if (!col) break;
    raw.push(...col.filter(x => x?.id));
    url = Array.isArray(res.data) ? null : (res.data?.next_href || null);
    pages++;
  }
  if (raw.length === 0) {
    const res = await window.electronAPI.scFetch(
      `https://api-v2.soundcloud.com/playlists/${id}`, auth.token, auth.clientId);
    raw = (res.data?.tracks || []).filter(x => x?.id);
  }
  const need = raw.filter(x => !(x.title && x.media)).map(x => x.id);
  const hydrated = new Map();
  for (let i = 0; i < need.length; i += 25) {
    const res = await window.electronAPI.scFetch(
      `https://api-v2.soundcloud.com/tracks?ids=${need.slice(i, i + 25).join(',')}`,
      auth.token, auth.clientId
    );
    if (res.error) continue;
    const arr = Array.isArray(res.data) ? res.data : res.data?.collection;
    for (const tr of (arr || [])) if (tr?.id) hydrated.set(tr.id, tr);
  }
  const out = [];
  for (const x of raw) {
    const tr = (x.title && x.media) ? x : hydrated.get(x.id);
    if (tr?.title && tr?.media) out.push(mapScTrack(tr, noTitle));
  }
  return out;
}

/* состав плейлиста для чекбокса в контекст-меню: только id, без гидратации
   и маппинга (fetchPlaylistTracks тут слишком тяжёлый). отдаёт null при ошибке,
   чтобы вызывающий мог отличить «пусто» от «не знаю» */
async function fetchPlaylistTrackIds(id, auth, expected) {
  const ids = new Set();
  let url = `https://api-v2.soundcloud.com/playlists/${id}/tracks?limit=200`;
  let pages = 0;
  while (url && pages < 10) {
    const res = await window.electronAPI.scFetch(url, auth.token, auth.clientId);
    if (res.error) return null;
    const col = Array.isArray(res.data) ? res.data : res.data?.collection;
    if (!col) break;
    for (const x of col) if (x?.id != null) ids.add(x.id);
    pages++;
    if (expected != null && ids.size >= expected) break; /* всё нашли — пагинация не нужна */
    url = Array.isArray(res.data) ? null : (res.data?.next_href || null);
  }
  return ids;
}

/* рекомендации для плейлиста — station-эндпоинт SC (как radio плейлиста).
   URL изолирован тут: если SC поменяет — правится одно место */
const plRecsUrl = id =>
  `https://api-v2.soundcloud.com/stations/soundcloud:playlist-stations:${id}/tracks?limit=50`;

/* картинка → обложка плейлиста: центр-кроп в квадрат, сторона ≤1600,
   jpeg 0.9 (многовато байтов SC не любит, а альфа не нужна). возвращает
   { dataUrl — превью, b64 — голый base64 без data:-префикса, ровно то,
   что SC ждёт в image_data } */
function prepareArtwork({ dataUrl, name }) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try {
        const crop = Math.min(img.width, img.height);
        const side = Math.min(1600, crop);
        const cv = document.createElement('canvas');
        cv.width = cv.height = side;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#101014';
        ctx.fillRect(0, 0, side, side);
        ctx.drawImage(img, (img.width - crop) / 2, (img.height - crop) / 2, crop, crop, 0, 0, side, side);
        const out = cv.toDataURL('image/jpeg', 0.9);
        resolve({ dataUrl: out, b64: out.split(',')[1], mime: 'image/jpeg', filename: 'cover.jpg' });
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/* Разделитель артистов в SoundCloud часто без пробелов: «a,b», «a&b».
   Раньше это уезжало в интерфейс как есть, и подряд стоящие имена
   читались как одно («@emo3ater2000,@nowagz»). Разбирать строку заново
   НЕЛЬЗЯ: `splitArtists` считает точку и амперсанд разделителями
   (на проверенных примерах «R&B» → R + B, «Dr. Dre» → Dr + Dre, «A.B» → A
   + B), то есть он годится для разбора кредитов, а не для показа имени.
   Поэтому здесь только КОСМЕТИКА: ставим пробел вокруг запятой и ничего
   больше не трогаем.

   ⚠️ `&` и `.` намеренно НЕ трогаем. «R&B» — это одно название, и любая
   попытка вставить пробел вокруг амперсанда разорвёт его надвое; в точке
   сразу «Dr. Dre», «A.B.», номера вроде «S1.E2». Только запятая: в
   отличие от них, перед запятой артист всегда заканчивается. */
function formatArtistDisplay(str) {
  return String(str || '')
    /* серия запятых (пустой сегмент между ними) схлопывается в одну:
       иначе «A,,B» превратилось бы в «A, , B» — висячая запятая посреди
       строки выглядит хуже, чем было изначально */
    .replace(/(?:\s*,\s*){2,}/g, ', ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    /* запятая в конце строки — просто мусор, её убираем */
    .replace(/,\s*$/, '');
}

function splitArtists(str) {
  if (!str) return [{ name: '', sep: null }];
  const re = /(\s*[&×,.]\s*|\s+(?:ft\.?|feat\.?|with|vs\.?)\s+)/gi;
  const raw = str.split(re);
  const result = [];
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i]?.trim();
    const sep  = raw[i + 1] || null;
    if (name) result.push({ name, sep });
  }
  return result.length ? result : [{ name: str, sep: null }];
}


/* ── i18n ────────────────────────────────────────────────────────────────── */
const STRINGS = {
  ru: {
    minimize:'Свернуть', close:'Закрыть',
    nav_tracks:'Треки', nav_search:'Поиск', nav_player:'Плеер', nav_playlists:'Плейлисты',
    nav_local:'Локальная библиотека', nav_settings:'Настройки', nav_party:'слушать вместе',
    player_pick:'Выбери трек',
    mini_player:'Миниплеер', playback_previous:'Предыдущий трек', playback_next:'Следующий трек',
    mini_player_open:'Открыть плеер',
    nav_history:'История прослушиваний', history_title:'История', history_subtitle:'Прослушанное в этом приложении',
    history_count:'Прослушиваний: {n}', history_clear:'Очистить', history_confirm_clear:'Удалить историю?',
    history_empty:'Здесь будет твоя музыка', history_empty_hint:'Включи трек. Через несколько секунд он появится здесь.',
    history_play_error:'Не удалось включить трек', history_login:'Войди в soundcloud, чтобы включить этот трек',
    history_local:'локально', history_unavailable:'Файл больше не в библиотеке',
    history_today:'Сегодня', history_yesterday:'Вчера',
    playback_play:'Воспроизвести', playback_pause:'Пауза', track_untitled:'Без названия',
    card_window:'Окно',
    /* ⚠️ Три строки текста в этой плашке были абзацем на весь ряд. Правило
       «что именно несовместимо» осталось, порядок действий («сначала выключи
       материал») убран: он виден прямо на тумблере, который гасит акцент. */
    mica_accent_lock:'Материал окна несовместим с подсветкой акцента и своим фоном: пока включён он, оба выключены.',
    mica:'Материал окна',
    mica_only_win11:'только Windows 11',
    mica_sub:'Фон становится полупрозрачным, и сквозь него видно материал системы. Скругление окна при этом пропадает.',
    mica_unsupported:'Система не поддерживает материал окна — нужен Windows 11',
    unavailable:'недоступен',
    off:'выкл', sec:'с',
    cancel:'отмена',
    cache:'Кэш',
    covers_cache:'Кэш обложек SoundCloud', covers_cache_sub:'Сохранённые обложки треков',
    del:'удалить', clear:'очистить',
    likes_cache:'Кэш треков SoundCloud', likes_cache_sub:'Список лайков, перезагрузится при входе',
    sec_playback:'Воспроизведение', sec_appearance:'Оформление',
    sec_system:'Система', sec_about:'О приложении',
    settings_title:'Настройки',
    /* ❌ УДАЛЕНЫ `card_audio`, `lyrics_sources`, `accent_title`, `card_discord`,
       `accent_off_title`. Все пять были надзаголовками карточек, которые
       называли то же самое, что уже написано в навигации слева или в
       выбранном сегменте: «Аккаунт / Аккаунт», «Акцент и свечение / Акцент»,
       «От обложки / От обложки». Два одинаковых заголовка подряд — это шум,
       а не структура. `default_repeat` тоже был без единого обращения. */
    crossfade:'Кроссфейд', crossfade_sub:'Плавное перекрытие треков',
    crossfade_length:'Длина перехода', crossfade_curve:'Характер перехода',
    crossfade_power:'Ровно', crossfade_smooth:'Мягко', crossfade_linear:'Линейно',
    crossfade_smart:'Умная длина для коротких треков', crossfade_intro:'Пропуск вступления',
    crossfade_current:'Текущий трек', crossfade_next:'Следующий трек', crossfade_preview:'Кривая перехода',
    crossfade_short:'Коротко', crossfade_flow:'Плавно', crossfade_mix:'Длинный микс',
    crossfade_cut:'Склейка', crossfade_radio:'Радио', crossfade_dj:'DJ-микс',
    /* эквалайзер и транспорт */
    fx:'Эффекты',
    eq:'Эквалайзер', eq_on:'Включить', eq_on_sub:'Тембр в реальном времени — и для локальных, и для soundcloud',
    eqp_flat:'Ровно', eqp_bass:'Бас', eqp_vocal:'Вокал', eqp_treble:'Верх', eq_reset:'сбросить',
    eqp_punch:'Панч', eqp_air:'Воздух', eqp_rock:'Рок', eqp_electro:'Электро',
    width:'Ширина стерео', width_sub:'1× — как есть, 2× — шире', mono:'моно',
    stereo_boost:'Стерео буст',
    db:'дБ', hz:'Гц', khz:'кГц',
    speed_pitch:'Скорость и тон',
    speed:'Скорость', hold_pitch:'Не менять тональность',
    hold_pitch_sub:'Высота остаётся прежней — едет только темп',
    pitch:'Тональность', semitones:'пт',
    /* ❌ УДАЛЕНЫ ключи `card_interface`, `hide_dividers`, `hide_dividers_sub` —
       карточка «Интерфейс» была из одного тумблера разделителей, он убран,
       а поведение зафиксировано константой HIDE_DIVIDERS */
    discord_rpc:'Discord Rich Presence', discord_rpc_sub:'Показывать текущий трек в Discord',
    /* ❌ card_discord — см. список удалённых надзаголовков выше */
    discord_timestamp:'Таймстамп',
    discord_ts_progress:'Прогресс', discord_ts_elapsed:'Прошло', discord_ts_none:'Нет',
    discord_on_pause:'При паузе',
    discord_pause_show:'Показывать', discord_pause_hide:'Скрывать',
    discord_cover:'Обложка трека', discord_cover_sub:'Показывать art в присутствии',
    discord_st_off:'Discord не запущен или RPC выключен',
    discord_st_connecting:'Подключение к Discord…',
    discord_st_connected:'Discord подключён',
    discord_st_lost:'Соединение с Discord потеряно, переподключаемся…',
    card_account:'Аккаунт', card_language:'Язык интерфейса', language_label:'Язык',
    /* ❌ language_sub убран вместе с самим рядом: подпись «Язык» и пояснение
       «Язык элементов управления» говорили одно и то же двумя строками */
    card_startup:'Запуск',
    start_windows:'Запускать при старте Windows', minimize_tray:'Сворачивать в трей',
    card_local:'Локальная музыка', music_folder:'Папка с музыкой', no_folder:'Не выбрана',
    remove:'Удалить', choose:'Выбрать',
    min_dur:'Мин. длительность аудиофайлов', min_dur_sub:'Файлы короче этого значения пропускаются при сканировании',
    secs:'сек',
    version:'Версия', repository:'Репозиторий', stack:'Стек',
    profile_error:'не удалось получить данные профиля',
    conn_error:'ошибка подключения',
    unknown:'неизвестно', logout:'выйти',
    sc_not_connected:'soundcloud не подключён',
    sc_hint:'войди чтобы видеть лайки,\nартистов и подписки',
    opening_browser:'жду вход...', login_browser:'войти в soundcloud',
    /* Коды ошибок из sc_login (src-tauri/src/soundcloud.rs). Раньше на любой
       провал возвращался null, кнопка молча возвращалась в исходное, и понять
       «не логинится» было нечем. */
    sc_err_cert:'soundcloud.com не открылся: провайдер подменяет сертификат. включи VPN',
    sc_err_blocked:'провайдер отдаёт заглушку вместо soundcloud.com. нужен VPN',
    sc_err_offline:'soundcloud.com не отвечает: проверь интернет',
    sc_err_closed:'вход отменён',
    sc_err_timeout:'окно входа закрылось по таймауту (5 минут) — попробуй ещё раз',
    sc_err_window:'окно входа не открылось',
    sc_err_expired:'сессия soundcloud истекла — войди заново',
    sc_err_proxy:'прокси не разобрался: нужна форма socks5://хост:порт или хост:порт',
    search_ph:'поиск',
    artists:'Исполнители', followers:'подписчиков', tracks_label:'Треки',
    search_best:'Лучшее', search_recent:'Недавние запросы', search_recent_clear:'очистить',
    search_hint:'начни вводить название трека, исполнителя\nили название плейлиста',
    loading:'загрузка...',
    likes:'Лайки', all_tracks:'Все треки',
    loading_dots:'загружаем...', updating:'обновляем...',
    search_short:'поиск',
    search_hinted:'поиск  (Ctrl+F)',
    sort_added:'по дате', sort_artist:'по артисту', sort_title:'по названию', sort_dur:'по длине',
    welcome_title:'добро пожаловать в seWer',
    welcome_sub:'выбери папку с локальной музыкой\nили войди в soundcloud чтобы начать',
    pick_folder:'выбрать папку', login_sc:'войти в soundcloud',
    loading_likes:'загружаем лайки...', load_failed:'не удалось загрузить',
    not_found:'ничего не найдено', no_likes:'лайков нет', retry:'повторить',
    playlists_empty:'плейлистов пока нет', playlists_empty_sub:'лайкнутые плейлисты soundcloud\nпоявятся в этой вкладке',
    pl_new_title:'Новый плейлист', pl_create_err:'не удалось создать плейлист',
    pl_del:'Удалить плейлист', pl_del_sure:'удалить?', pl_del_err:'не удалось удалить плейлист',
    sc_blocked:'soundcloud ограничил запросы (анти-бот) — подожди пару минут',
    pl_edit:'Редактировать плейлист', pl_login_hint:'войди в soundcloud,\nчтобы видеть плейлисты',
    ed_saving:'сохраняем…', ed_saved:'сохранено', ed_save_err:'ошибка сохранения',
    ed_save_btn:'Сохранить', ed_dirty:'не сохранено', ed_unsaved:'Есть несохранённые изменения',
    ed_save_exit:'Сохранить и выйти', ed_discard:'Не сохранять',
    ed_add:'Добавить', ed_add_search:'Поиск', ed_add_recs:'Рекомендации',
    ed_added:'добавлено', ed_empty:'пусто — добавь треки ниже',
    ed_recs_empty:'рекомендаций нет', ed_rec_loading:'подбираем рекомендации…',
    ed_track_del:'убрать из плейлиста',
    pl_count_1:'трек', pl_count_2:'трека', pl_count_5:'треков',
    unlike_err:'ошибка: не удалось убрать лайк', like_err:'ошибка: не удалось поставить лайк',
    track_unavailable:'трек недоступен', no_title:'Без названия',
    userid_err:'не удалось получить userId', api_err:'ошибка api',
    artist_popular:'Популярные', artist_tracks:'Треки',
    artist_label:'Артист',
    artist_play_all:'Слушать всё',
    back:'назад',
    subscribe:'Подписаться', subscribed:'Вы подписаны',
    follow_err:'не удалось подписаться', unfollow_err:'не удалось отписаться',
    copy_link:'Скопировать ссылку', link_copied:'Ссылка скопирована', copy_link_err:'не удалось скопировать ссылку',
    start_station:'Запустить станцию', station_for:'Станция по треку', station_label:'Станция', station_exit:'выйти', station_err:'не удалось запустить станцию',
    add_to_pl:'Добавить в плейлист', add_pl_new:'новый плейлист', added_to:'добавлено в',
    removed_from:'удалено из', pl_rm_err:'не удалось удалить трек',
    dl_save:'Скачать', dl_folder:'Папка', dl_change:'изменить', dl_name:'Имя файла',
    dl_title:'Название', dl_artist:'Автор',
    dl_no_dir:'папка не выбрана', dl_no_auth:'нужен вход в SoundCloud',
    dl_no_stream:'у трека нет доступного звука',
    dl_resolve:'не удалось получить ссылку на файл',
    dl_not_audio:'сервер вернул не аудио — файл не записан',
    dl_resolving:'получаем ссылку…',
    dl_err:'не удалось скачать', dl_wait:'скачивание…', dl_ok:'скачано',
    dl_no_tags:'скачано, но без тегов и обложки',
    dl_no_cover:'скачано, но без обложки',
    dl_m4a:'скачано в m4a: для mp3 нужен ffmpeg',
    pl_in:'убрать из плейлиста', pl_out:'добавить в плейлист', pl_in_loading:'проверяем…',
    pl_add_err:'не удалось добавить трек', pl_list_err:'не удалось загрузить плейлисты',
    ed_title_ph:'Название плейлиста', ed_art_pick:'Выбрать обложку', ed_art_err:'не удалось загрузить обложку',
    accent_sub:'Свечения и цвет активных элементов интерфейса',
    accent_default:'По умолчанию', accent_lavender:'Лавандовый', accent_mint:'Мятный', accent_rose:'Розовый', accent_amber:'Янтарный', accent_cover:'От обложки',
    accent_cover_sub:'Динамически меняется под обложку трека',
    accent_seg_off:'Выкл', accent_seg_color:'Цвет',
    accent_off_sub:'Фоновые свечения скрыты, акцент — статичный серый',
    art_glow:'Мягкое свечение за обложкой', art_glow_sub:'Цветное пятно вокруг обложки в плеере. Меньше нагрузки на видеокарту, чем настоящее размытие',

    /* ── редактор темы ── */
    card_themes:'Темы',
    theme_random:'Удиви меня', theme_reset:'Сбросить', theme_mine:'своя',
    theme_mine_list:'Свои темы', theme_save:'Сохранить тему', theme_delete:'Удалить тему',
    accent_random:'Случайный цвет',
    pick_color:'Взять цвет с экрана',
    accent_second:'Второй цвет', accent_second_sub:'Линия у верхнего края окна перетекает из акцента во второй цвет',
    accent_quick:'Быстрый выбор',
    card_bg:'Фон',
    bg_seg_default:'Стандарт', bg_seg_color:'Цвет', bg_seg_gradient:'Градиент', bg_seg_cover:'Обложка',
    bg_from:'Откуда', bg_to:'Куда', bg_angle:'Угол',
    bg_sub_default:'Фон приложения: #07070a',
    bg_sub_custom:'Фон залит во всё окно — под содержимым',
    bg_sub_cover:'Фон едет за обложкой трека, плавно. Нужен живой акцент — включи его одной кнопкой',
    bg_cover_turn_on:'Взять акцент тоже от обложки',
    bg_sub_mica:'Материал окна рисует свой фон — свой поверх него класть нельзя',
    card_look:'Свечение и форма',
    glow_strength:'Сила свечений', glow_strength_sub:'Общий множитель для пятна за обложкой, линии у края окна, подсветки лайков и ореолов тумблеров',
    ui_radius:'Скругление', ui_radius_sub:'Углы карточек в настройках. Углы самого окна рисует система',
    ui_grain:'Зерно', ui_grain_sub:'Мелкая шумность поверх фона. Убирает бандинг на градиентах',
    ui_vignette:'Виньетка', ui_vignette_sub:'Затемнение по краям окна',
    card_ui:'Элементы интерфейса', ui_hide_sub:'Спрятать лишнее. Всё возвращается здесь же — ничего не пропадает насовсем',
    ui_hide_source:'Переключатель источника', ui_hide_source_sub:'Иконка папки в шапке: локальные треки ↔ облако. Переключать можно и в «Аккаунте»',
    ui_hide_mini_player:'Миниплеер в шапке', ui_hide_mini_player_sub:'Обложка и управление треком вне плеера',
    ui_hide_volume:'Громкость в плеере', ui_hide_volume_sub:'Тонкий ползунок справа. Громкость остаётся в микшере Windows',
    ui_hide_caption:'Подпись списка', ui_hide_caption_sub:'«Все треки» и счётчик под ним',
    ui_hide_sort:'Сортировка списка', ui_hide_sort_sub:'Чипсы «Добавлено / Артист / Название / Время»',
    ui_show_all:'Вернуть всё',
    source_label:'Источник', source_sub:'Какую библиотеку показывает приложение',
    source_local:'Локальные', source_sc:'Облако',
    card_covers:'Обложки',
    cover_tint:'Сила',
    cover_tint_off:'выкл',
    cover_tint_by_cover:'От обложки', cover_tint_by_accent:'Акцент Windows', cover_tint_by_color:'Свой цвет',
    sec_lyrics:'Текст песен',
    sec_discord:'Discord',
    shuffle_all:'Случайно', shuffle_empty:'Нечего перемешивать',
    lyrics_sources_sub:'Сверху вниз — в этом порядке ищется текст песни',
    lyrics_off:'Выключенные', lyrics_synced:'синхронный',
    lyrics_up:'Выше по списку', lyrics_down:'Ниже по списку',
    lyrics_edit:'найти текст вручную',
    lyrics_edit_artist:'артист', lyrics_edit_title:'название трека',
    lyrics_edit_find:'найти', lyrics_edit_unpin:'сбросить',
    lyrics_src_switch:'показать текст из этого источника',
    lyrics_refresh:'найти текст заново',
    lyrics_loading:'ищем текст…', lyrics_notfound:'текст не нашёлся',
    lyrics_err:'не удалось загрузить текст', lyrics_err_sub:'источники не ответили',
    lyrics_notfound_sub:'попробовали все включённые источники',
    lyrics_tap_line:'нажми на строку, чтобы перейти', lyrics_retry:'попробовать снова',
    lyrics_all_off:'Все источники выключены — искать негде',
  },
  en: {
    minimize:'Minimize', close:'Close',
    nav_tracks:'Tracks', nav_search:'Search', nav_player:'Player', nav_playlists:'Playlists',
    nav_local:'Local library', nav_settings:'Settings', nav_party:'listen together',
    player_pick:'Pick a track',
    mini_player:'Mini player', playback_previous:'Previous track', playback_next:'Next track',
    mini_player_open:'Open player',
    nav_history:'Listening history', history_title:'History', history_subtitle:'Played in this app',
    history_count:'Listens: {n}', history_clear:'Clear', history_confirm_clear:'Delete history?',
    history_empty:'Your music will appear here', history_empty_hint:'Play a track. It will appear here after a few seconds.',
    history_play_error:'Could not play this track', history_login:'Sign in to soundcloud to play this track',
    history_local:'local', history_unavailable:'File is no longer in your library',
    history_today:'Today', history_yesterday:'Yesterday',
    playback_play:'Play', playback_pause:'Pause', track_untitled:'Untitled track',
    card_window:'Window',
    /* см. ru — текст ужат до одной строки */
    mica_accent_lock:'Window material is incompatible with the accent glow and a custom background: while it is on, both are off.',
    mica:'Window material',
    mica_only_win11:'Windows 11 only',
    mica_sub:'The background turns translucent and the system material shows through. The window loses its rounded corners.',
    mica_unsupported:'This system does not support window material — needs Windows 11',
    unavailable:'unavailable',
    off:'off', sec:'s',
    cancel:'cancel',
    cache:'Cache',
    covers_cache:'SoundCloud covers cache', covers_cache_sub:'Saved track artwork',
    del:'delete', clear:'clear',
    likes_cache:'SoundCloud tracks cache', likes_cache_sub:'Likes list, reloads on login',
    sec_playback:'Playback', sec_appearance:'Appearance',
    sec_system:'System', sec_about:'About',
    settings_title:'Settings',
    /* ❌ removed card_audio, autoplay, autoplay_sub, default_repeat,
       card_discord, lyrics_sources, accent_title, accent_off_title — см. ru */
    crossfade:'Crossfade', crossfade_sub:'Smooth overlap between tracks',
    crossfade_length:'Transition length', crossfade_curve:'Transition shape',
    crossfade_power:'Even', crossfade_smooth:'Soft', crossfade_linear:'Linear',
    crossfade_smart:'Adapt to short tracks', crossfade_intro:'Skip intro',
    crossfade_current:'Current track', crossfade_next:'Next track', crossfade_preview:'Transition curve',
    crossfade_short:'Short', crossfade_flow:'Smooth', crossfade_mix:'Long mix',
    crossfade_cut:'Quick cut', crossfade_radio:'Radio', crossfade_dj:'DJ mix',
    fx:'Effects',
    eq:'Equalizer', eq_on:'Enable', eq_on_sub:'Real-time tone shaping — for local files and soundcloud alike',
    eqp_flat:'Flat', eqp_bass:'Bass', eqp_vocal:'Vocal', eqp_treble:'Treble', eq_reset:'reset',
    eqp_punch:'Punch', eqp_air:'Air', eqp_rock:'Rock', eqp_electro:'Electro',
    width:'Stereo width', width_sub:'1× — as is, 2× — wider', mono:'mono',
    stereo_boost:'Stereo boost',
    db:'dB', hz:'Hz', khz:'kHz',
    speed_pitch:'Speed and pitch',
    speed:'Speed', hold_pitch:'Keep pitch',
    hold_pitch_sub:'Pitch stays put — only the tempo moves',
    pitch:'Pitch', semitones:'st',
    /* ❌ removed card_interface, hide_dividers, hide_dividers_sub — см. ru */
    discord_rpc:'Discord Rich Presence', discord_rpc_sub:'Show current track in Discord',
    discord_timestamp:'Timestamp',
    discord_ts_progress:'Progress', discord_ts_elapsed:'Elapsed', discord_ts_none:'None',
    discord_on_pause:'On pause',
    discord_pause_show:'Show', discord_pause_hide:'Hide',
    discord_cover:'Track artwork', discord_cover_sub:'Show art in presence',
    discord_st_off:'Discord is not running or RPC is off',
    discord_st_connecting:'Connecting to Discord…',
    discord_st_connected:'Discord connected',
    discord_st_lost:'Lost connection to Discord, reconnecting…',
    card_account:'Account', card_language:'Interface language', language_label:'Language',
    /* ❌ language_sub — см. ru */
    card_startup:'Startup',
    start_windows:'Launch at Windows startup', minimize_tray:'Minimize to tray',
    card_local:'Local music', music_folder:'Music folder', no_folder:'Not selected',
    remove:'Remove', choose:'Choose',
    min_dur:'Min. audio file duration', min_dur_sub:'Files shorter than this are skipped when scanning',
    secs:'sec',
    version:'Version', repository:'Repository', stack:'Stack',
    profile_error:'could not get profile data',
    conn_error:'connection error',
    unknown:'unknown', logout:'log out',
    sc_not_connected:'soundcloud not connected',
    sc_hint:'log in to see your likes,\nartists and subscriptions',
    opening_browser:'waiting for sign-in...', login_browser:'log in to soundcloud',
    sc_err_cert:'soundcloud.com did not open: your provider is serving a forged certificate. turn on a VPN',
    sc_err_blocked:'your provider serves a block page instead of soundcloud.com. a VPN is required',
    sc_err_offline:'soundcloud.com is not responding: check the connection',
    sc_err_closed:'sign-in cancelled',
    sc_err_timeout:'the sign-in window closed after the 5 minute timeout — try again',
    sc_err_window:'the sign-in window did not open',
    sc_err_expired:'soundcloud session expired — log in again',
    sc_err_proxy:'the proxy could not be parsed: use socks5://host:port or host:port',
    search_ph:'search',
    artists:'Artists', followers:'followers', tracks_label:'Tracks',
    search_best:'Top result', search_recent:'Recent searches', search_recent_clear:'clear',
    search_hint:'start typing a track, an artist\nor a playlist name',
    loading:'loading...',
    likes:'Likes', all_tracks:'All tracks',
    loading_dots:'loading...', updating:'updating...',
    search_short:'search',
    search_hinted:'search  (Ctrl+F)',
    sort_added:'by date', sort_artist:'by artist', sort_title:'by title', sort_dur:'by length',
    welcome_title:'welcome to seWer',
    welcome_sub:'choose a local music folder\nor log in to soundcloud to start',
    pick_folder:'choose folder', login_sc:'log in to soundcloud',
    loading_likes:'loading likes...', load_failed:'failed to load',
    not_found:'nothing found', no_likes:'no likes', retry:'retry',
    playlists_empty:'no playlists yet', playlists_empty_sub:'soundcloud playlists you like\nwill appear in this tab',
    pl_new_title:'New playlist', pl_create_err:'could not create playlist',
    pl_del:'Delete playlist', pl_del_sure:'delete?', pl_del_err:'could not delete playlist',
    sc_blocked:'soundcloud rate-limited requests (anti-bot) — wait a couple of minutes',
    pl_edit:'Edit playlist', pl_login_hint:'log in to soundcloud\nto see your playlists',
    ed_saving:'saving…', ed_saved:'saved', ed_save_err:'save failed',
    ed_save_btn:'Save', ed_dirty:'unsaved', ed_unsaved:'You have unsaved changes',
    ed_save_exit:'Save and exit', ed_discard:'Discard',
    ed_add:'Add tracks', ed_add_search:'Search', ed_add_recs:'Recommended',
    ed_added:'added', ed_empty:'empty — add tracks below',
    ed_recs_empty:'no recommendations', ed_rec_loading:'picking recommendations…',
    ed_track_del:'remove from playlist',
    pl_count_1:'track', pl_count_2:'tracks', pl_count_5:'tracks',
    unlike_err:'error: could not remove like', like_err:'error: could not add like',
    track_unavailable:'track unavailable', no_title:'Untitled',
    userid_err:'could not get userId', api_err:'api error',
    artist_popular:'Popular', artist_tracks:'Tracks',
    artist_label:'Artist',
    artist_play_all:'Play all',
    back:'back',
    subscribe:'Follow', subscribed:'Following',
    follow_err:'could not follow', unfollow_err:'could not unfollow',
    copy_link:'Copy link', link_copied:'Link copied', copy_link_err:'could not copy link',
    start_station:'Start station', station_for:'Station for', station_label:'Station', station_exit:'exit', station_err:'could not start station',
    add_to_pl:'Add to playlist', add_pl_new:'new playlist', added_to:'added to',
    removed_from:'removed from', pl_rm_err:'could not remove the track',
    dl_save:'Download', dl_folder:'Folder', dl_change:'change', dl_name:'File name',
    dl_title:'Title', dl_artist:'Artist',
    dl_no_dir:'no folder selected', dl_no_auth:'SoundCloud login required',
    dl_no_stream:'no playable audio for this track',
    dl_resolve:'could not get a file url',
    dl_not_audio:'server returned non-audio — nothing was written',
    dl_resolving:'getting the file url…',
    dl_err:'download failed', dl_wait:'downloading…', dl_ok:'downloaded',
    dl_no_tags:'downloaded, but without tags and cover',
    dl_no_cover:'downloaded, but without the cover',
    dl_m4a:'downloaded as m4a: mp3 needs ffmpeg',
    pl_in:'remove from playlist', pl_out:'add to playlist', pl_in_loading:'checking…',
    pl_add_err:'could not add the track', pl_list_err:'could not load playlists',
    ed_title_ph:'Playlist name', ed_art_pick:'Choose cover', ed_art_err:'cover upload failed',
    accent_sub:'Glow effects and the color of active interface elements',
    accent_default:'Default', accent_lavender:'Lavender', accent_mint:'Mint', accent_rose:'Rose', accent_amber:'Amber', accent_cover:'From cover',
    accent_cover_sub:'Dynamically follows the current track artwork',
    accent_seg_off:'Off', accent_seg_color:'Color',
    accent_off_sub:'Background glows hidden, accent is flat gray',
    art_glow:'Soft glow behind artwork', art_glow_sub:'Colored halo around the cover in the player. Cheaper for the GPU than a real blur',

    /* ── theme editor ── */
    card_themes:'Themes',
    theme_random:'Surprise me', theme_reset:'Reset', theme_mine:'custom',
    theme_mine_list:'Your themes', theme_save:'Save theme', theme_delete:'Delete theme',
    accent_random:'Random color',
    pick_color:'Pick a color from the screen',
    accent_second:'Second color', accent_second_sub:'The line at the very top of the window fades from the accent into the second color',
    accent_quick:'Quick pick',
    card_bg:'Background',
    bg_seg_default:'Default', bg_seg_color:'Solid', bg_seg_gradient:'Gradient', bg_seg_cover:'Cover',
    bg_from:'From', bg_to:'To', bg_angle:'Angle',
    bg_sub_default:'Application background: #07070a',
    bg_sub_custom:'Painted across the whole window, under the content',
    bg_sub_cover:'The background follows the track artwork, smoothly. Needs a live accent — turn it on with one button',
    bg_cover_turn_on:'Take the accent from the cover too',
    bg_sub_mica:'Window material paints its own background — nothing can be layered on top',
    card_look:'Glow and shape',
    glow_strength:'Glow strength', glow_strength_sub:'One global multiplier for the artwork halo, the window top line, like-button flares and switch glows',
    ui_radius:'Corner radius', ui_radius_sub:'Corners of the settings cards. The window corners are drawn by the system',
    ui_grain:'Grain', ui_grain_sub:'Fine noise over the background. Hides banding in gradients',
    ui_vignette:'Vignette', ui_vignette_sub:'Darkens the edges of the window',
    card_ui:'Interface elements', ui_hide_sub:'Hide the extra chrome. Everything comes back from here — nothing is lost for good',
    ui_hide_source:'Source switch', ui_hide_source_sub:'Folder icon in the titlebar: local tracks ↔ cloud. You can also switch it in Account',
    ui_hide_mini_player:'Titlebar mini player', ui_hide_mini_player_sub:'Artwork and playback controls outside the player',
    ui_hide_volume:'Player volume', ui_hide_volume_sub:'Thin slider on the right. Volume stays available in the Windows mixer',
    ui_hide_caption:'List caption', ui_hide_caption_sub:'“All tracks” and the counter under it',
    ui_hide_sort:'List sorting', ui_hide_sort_sub:'“Added / Artist / Title / Time” chips',
    ui_show_all:'Show everything',
    source_label:'Source', source_sub:'Which library the app shows',
    source_local:'Local', source_sc:'Cloud',
    card_covers:'Artwork',
    cover_tint:'Strength',
    cover_tint_off:'off',
    cover_tint_by_cover:'From artwork', cover_tint_by_accent:'Windows accent', cover_tint_by_color:'Custom colour',
    sec_lyrics:'Lyrics',
    sec_discord:'Discord',
    shuffle_all:'Shuffle', shuffle_empty:'Nothing to shuffle',
    lyrics_sources_sub:'Top to bottom - lyrics are searched in this order',
    lyrics_off:'Turned off', lyrics_synced:'synced',
    lyrics_up:'Move up', lyrics_down:'Move down',
    lyrics_edit:'search for the lyrics by hand',
    lyrics_edit_artist:'artist', lyrics_edit_title:'track title',
    lyrics_edit_find:'search', lyrics_edit_unpin:'reset',
    lyrics_src_switch:'show the lyrics from this source',
    lyrics_refresh:'search for the lyrics again',
    lyrics_loading:'looking for lyrics…', lyrics_notfound:'lyrics not found',
    lyrics_err:'could not load lyrics', lyrics_err_sub:'sources did not respond',
    lyrics_notfound_sub:'tried every enabled source',
    lyrics_tap_line:'tap a line to seek', lyrics_retry:'try again',
    lyrics_all_off:'All sources are turned off — nowhere to look',
  },
};
const LangContext = React.createContext('ru');
function useLang() {
  const lang = React.useContext(LangContext);
  return React.useCallback(key => STRINGS[lang]?.[key] ?? STRINGS.ru[key] ?? key, [lang]);
}
/* Язык как есть, без функции-переводчика. Нужен там, где значение
   ПРОИЗВОДИТСЯ из языка, а не переводится: имя своей темы по оттенку. */
function useLangCode() {
  return React.useContext(LangContext);
}

/* ── MarqueeText ─────────────────────────────────────────────────────────── */
function MarqueeText({ text, style, onClick, maxWidth }) {
  const outerRef = useRef(null);
  const [clipped, setClipped] = useState(false);
  const [showTip, setShowTip] = useState(false);

  useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    setClipped(el.scrollWidth > el.clientWidth + 1);
  }, [text, maxWidth]);

  return (
    <div style={{
      position:'relative',
      ...(maxWidth != null ? { width:'fit-content', maxWidth } : { flex:1, minWidth:0 }),
    }}>
      <div ref={outerRef} onClick={onClick}
        onMouseEnter={() => { if (clipped) setShowTip(true); }}
        onMouseLeave={() => setShowTip(false)}
        style={{
          overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
          textAlign:'center',
          cursor: onClick ? 'pointer' : 'default',
          ...style,
        }}>
        {text}
      </div>
      {showTip && (
        <div style={{
          position:'absolute', bottom:'calc(100% + 8px)', left:'50%',
          translate:'-50% 0',
          background:'rgba(18,18,24,0.97)',
          border:'1px solid rgba(255,255,255,0.08)',
          borderRadius:8, padding:'6px 12px',
          fontSize: 'var(--fs-md)', whiteSpace:'nowrap',
          pointerEvents:'none', zIndex:1000,
          color:'rgba(255,255,255,0.78)',
          boxShadow:'0 4px 20px rgba(0,0,0,0.55)',
          animation:'fadeInUp 0.15s ease',
        }}>
          {text}
        </div>
      )}
    </div>
  );
}

/* ── PlayerLikeBtn ───────────────────────────────────────────────────────── */
/* сердце-лайк: маска по PNG, заливка currentColor → красится в accent без фильтров */
function LikeHeart({ liked, size, className, style }) {
  return (
    <span className={className} style={{
      display:'block', width:size, height:size,
      background: liked ? 'var(--accent)' : 'currentColor',
      WebkitMaskImage:`url('${liked ? '../assets/heart1.png' : '../assets/heart0.png'}')`,
      WebkitMaskSize:'contain', WebkitMaskRepeat:'no-repeat', WebkitMaskPosition:'center',
      ...style,
    }}/>
  );
}

function PlayerLikeBtn({ liked, onLike, style: extraStyle }) {
  const reduced = useReducedMotion();
  const [hov, setHov] = useState(false);
  const [popKey, setPopKey] = useState(0);
  const click = () => { if (!liked) setPopKey(k => k + 1); onLike(); };
  return (
    <div
      onClick={click}
      onPointerEnter={e => { if (isFineHover(e)) setHov(true); }}
      onPointerLeave={() => setHov(false)}
      style={{
        flexShrink:0, cursor:'pointer', padding:4, lineHeight:0,
        opacity: liked ? (hov ? 1 : 0.85) : (hov ? 0.6 : 0.25),
        transition:'opacity 200ms ease',
        ...extraStyle,
      }}
    >
      <div data-motion-spatial="" style={{position:'relative', display:'flex', transform: hov ? 'scale(1.1)' : 'scale(1)', transition:'transform 260ms cubic-bezier(0.23,1,0.32,1)'}}>
        {/* кольцо-вспышка: расходится и гаснет при каждом лайке */}
        {!reduced && popKey > 0 && (
          <motion.div key={'ring' + popKey}
            initial={{ scale: 0.55, opacity: 0.55 }}
            animate={{ scale: 1.8, opacity: 0 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
            style={{position:'absolute', inset:-8, borderRadius:'50%',
              border:'1.5px solid var(--accent)', pointerEvents:'none'}}/>
        )}
        {/* сердце: пружинный поп с лёгким поворотом, replay по key */}
        <motion.div key={'pop' + popKey} data-motion-spatial=""
          initial={{ scale: 1, rotate: 0 }}
          animate={!reduced && popKey > 0
            ? { scale: [1, 1.45, 0.82, 1.12, 1], rotate: [0, -8, 5, 0, 0] }
            : { scale: 1, rotate: 0 }}
          transition={{ duration: 0.55, ease: 'easeOut' }}
          style={{position:'relative'}}>
          <LikeHeart liked={liked} size={19}/>
        </motion.div>
      </div>
    </div>
  );
}

/* ── корни вкладок («стопка») ──────────────────────────────────────────────
   Все вьюхи лежат одной стопкой (position:absolute; inset:0) и прячутся
   прозрачностью, а не размонтированием: так дешевле, и анимация входа не
   рвётся. Но `opacity:0` в WebView2 НЕ исключает поддерево из hit-test:
   элемент невидим, а клики ловит — стоит потомку вернуть себе
   `pointerEvents:'auto'`, а он есть почти у каждой кнопки.
   `pointerEvents:'none'` на корне поэтому не спасал: скрытая вкладка
   продолжала перехватывать клики у видимой. Отсюда были и «ушёл с поиска, а
   он всё ещё нажимается», и «в настройках кнопки не те, что под курсором» —
   просто вкладка лежит в дереве ПОСЛЕ текущей и перекрывает её.

   `visibility:hidden` выключает hit-test на всём поддереве гарантированно и
   на layout не влияет (размеры остаются, framer измеряет как обычно).
   Задержка в transition нужна только на скрытие — чтобы анимация opacity
   успела доехать; при показе visibility переключается сразу, иначе первое
   0.14с элемент был бы невидим. */
const stackRoot = (visible, fadeMs = 0.14) => ({
  position:'absolute', inset:0,
  opacity: visible ? 1 : 0,
  visibility: visible ? 'visible' : 'hidden',
  pointerEvents: visible ? 'auto' : 'none',
  transition:`opacity ${fadeMs}s ease, visibility 0s linear ${visible ? '0s' : `${fadeMs}s`}`,
});

/* ── аудио-движок: эквалайзер, скорость, тон ───────────────────────────────
   Зачем свой граф. Web Audio — единственный способ и править тембр, и менять
   тон независимо от скорости: у `<audio>` есть только `playbackRate`, который
   всегда тянет за собой высоту. Значит медиаэлемент нужно завести в
   AudioContext (`createMediaElementSource`) и дальше гнать сигнал по цепочке
   фильтров.

   ⚠️ Два свойства этой схемы, которые легко забыть:
   1) `crossOrigin='anonymous'` на элементе ОБЯЗАТЕЛЕН и обязан стоять ДО
      первого `src`. Без него кросс-доменный поток (soundcloud отдаёт треки с
      cf-media.sndcdn.com) считается «испорченным», и Chromium глушит узел
      источника — трек просто замолкает при включённом эквалайзере. Проверено:
      CDN отдаёт `access-control-allow-origin: *`, asset-протокол tauri —
      заголовок с origin окна, а hls идёт через MSE (blob:), где CORS вообще
      не участвует.
   2) как только для элемента вызван `createMediaElementSource`, звук идёт
      ТОЛЬКО через граф. Если AudioContext окажется в состоянии `suspended`
      (политика автовоспроизведения), будет тишина. Поэтому `resume()` зовём
      из обработчиков play и из первого клика по окну.

   Громкость и кроссфейд остаются на `element.volume` — он применяется до
   источника, поэтому граф их не ломает и переписывать fade-код не нужно. */

/* полосы. Крайние — полки: peaking у самого низа/верха режет за пределами
   слышимого, а полка двигает весь диапазон, как на настоящем эквалайзере */
const EQ_BANDS = [
  { hz:    60, type: 'lowshelf',  q: 0.7 },
  { hz:   170, type: 'peaking',   q: 1.0 },
  { hz:   350, type: 'peaking',   q: 1.0 },
  { hz:  1000, type: 'peaking',   q: 1.0 },
  { hz:  3500, type: 'peaking',   q: 1.0 },
  { hz:  8000, type: 'peaking',   q: 1.0 },
  { hz: 15000, type: 'highshelf', q: 0.7 },
];
const EQ_FLAT = EQ_BANDS.map(() => 0);
/* ±12 дБ: на 18 дБ любой пресет упирается в клиппинг на мастеринге, а
   пользователь всё равно слышит только «громче», а не «другой тембр» */
const EQ_GAIN_MAX = 12;

/* Пресеты по полосам выше. Значения — в дБ. */
const EQ_PRESETS = {
  flat:  [0, 0, 0, 0, 0, 0, 0],
  bass:  [7, 5, 1, -1, -1, 0, 1],
  vocal: [-3, -1, 2, 5, 3, 1, 0],
  treble:[-2, -1, 0, 0, 2, 4, 5],
  punch: [-1, 4, 3, -1, 0, 1, -1],
  air:   [-1, -2, -1, 0, 0, 1, 6],
  rock:  [3, 2, -1, -2, 2, 3, 2],
  electro:[4, 3, 0, -2, 0, 2, 3],
};

/* 0.75–1.25: шире было 0.5–2, но на краях стретчер уже «пластилит» — форма
   волны слышна на голосе, а вернуть ползунок в 1× приходилось на глаз. четверти
   в обе стороны хватает и подкасту, и медленным вещам */
const SPEED_MIN = 0.75, SPEED_MAX = 1.25;
const PITCH_MAX = 12;          /* полутона в обе стороны */

/* 0 — моно, 1 — как есть, 2 — широко */
const WIDTH_MIN = 0, WIDTH_MAX = 2;

/* ── переживание hot-reload (только dev) ────────────────────────────────────
   правка этого файла в dev окно не перезагружает, но модуль пересоздаёт и все
   эффекты прогоняет заново: cleanup глушил <audio>, стирал `src`, обнулял
   `_afx` — и музыка обрывалась на каждой правке, даже если менялась одна цифра
   в отступе кнопки.

   Пережить подмену модуля может только `import.meta.hot.data`, поэтому туда
   уходит то, что пересоздать нельзя: сами <audio> (для элемента
   `createMediaElementSource` вызывается один раз в жизни) и AudioContext с
   узлами. Всё остальное состояние и так лежит в хуках — react-refresh их
   сохраняет. */
const HOT = import.meta.hot;
const HOT_STORE = HOT ? HOT.data : {};
/* выставляется ровно перед подменой модуля. cleanup этого модуля читает флаг и
   понимает: окно не закрывают, обрывать воспроизведение нельзя */
let hotSwapping = false;
if (HOT) HOT.dispose(() => { hotSwapping = true; });
/* форма цепочки в afxAttach. старый контекст годится, только пока она та же,
   иначе в живом графе остались бы узлы прошлой версии. меняешь цепочку —
   подними число: окно один раз перезагрузится и соберёт граф заново */
/* 12 — защита от хрипа, 13 — стерео-буст 2× на общей шине, 14 — защита убрана */
const AFX_SCHEMA = 14;

/* перевесить обработчики деки так, чтобы после подмены модуля на элементе не
   остались прежние: иначе timeupdate обрабатывался бы дважды, трижды, ... */
function bindDeck(el, onTime, onEnded, onPlayback) {
  if (el.__sewTime)  el.removeEventListener('timeupdate', el.__sewTime);
  if (el.__sewEnded) el.removeEventListener('ended',      el.__sewEnded);
  el.__sewTime  = onTime;
  el.__sewEnded = onEnded;
  el.addEventListener('timeupdate', onTime);
  el.addEventListener('ended',      onEnded);
  const events = ['playing', 'pause', 'waiting', 'seeking', 'seeked', 'ratechange', 'loadedmetadata', 'durationchange', 'ended', 'emptied', 'timeupdate'];
  if (el.__sewRpc) for (const event of events) el.removeEventListener(event, el.__sewRpc);
  el.__sewRpc = event => {
    const changed = updateDiscordPlayback(el, event.type);
    if (event.type === 'playing') afxResume();
    if (changed || event.type === 'playing') onPlayback?.(event);
  };
  for (const event of events) el.addEventListener(event, el.__sewRpc);
}

/* Звук правится ОДНИМ AudioContext на приложение: два контекста дали бы две
   разные временные базы и рассинхрон дек в кроссфейде. */
let _afx = HOT_STORE.afx && HOT_STORE.afx.schema === AFX_SCHEMA ? HOT_STORE.afx : null;
if (HOT_STORE.afx && !_afx) HOT?.invalidate?.();   /* цепочка поменялась — перезагрузка честнее */

/* сигнальная шина — ОДНА на все деки. раньше каждая дека шла прямо в
   `ctx.destination`, и наложить обработку на весь микс было некуда. теперь:
       дека → 7 полос → (тон) → out → вход шины → ширина → колонки

   в шине живёт только ширина стерео: mid/side-матрица, 1× прозрачно.
   никаких лимитеров и компрессоров — они глушили динамику и были не нужны. */
function afxEnsureBus() {
  const fx = _afx;
  if (!fx || fx.bus) return;
  const input = fx.ctx.createGain();
  input.gain.value = 1;

  /* mid/side-матрица. L,R → M=(L+R)/2, S=(L−R)/2, потом
     L'=M+w·S, R'=M−w·S. при w=1 коэффициенты ровно 1/0 — прозрачно.
     четыре gain'а и узлы разведения каналов, без ворклета. */
  const split = fx.ctx.createChannelSplitter(2);
  const merger = fx.ctx.createChannelMerger(2);
  const ll = fx.ctx.createGain(), lr = fx.ctx.createGain();
  const rl = fx.ctx.createGain(), rr = fx.ctx.createGain();
  /* при w=1: L'=L, R'=R — прозрачно; при w=0 оба канала становятся M (моно) */
  ll.gain.value = 1; lr.gain.value = 0;
  rl.gain.value = 0; rr.gain.value = 1;
  input.connect(split);
  split.connect(ll, 0, 0); split.connect(lr, 0, 0);
  split.connect(rl, 1, 0); split.connect(rr, 1, 0);
  ll.connect(merger, 0, 0); rl.connect(merger, 0, 0);
  lr.connect(merger, 0, 1); rr.connect(merger, 0, 1);
  merger.connect(fx.ctx.destination);
  fx.bus = { input, width: { ll, lr, rl, rr } };
}

/* Ширина стерео. w=1 — прозрачно, 0 — моно, 2 — SIDE усилен вдвое.
   Матрица: M=(L+R)/2, S=(L−R)/2, L'=M+w·S, R'=M−w·S.
   Therefore L' = ((1+w)/2)L + ((1−w)/2)R,
             R' = ((1−w)/2)L + ((1+w)/2)R.
   при w=1: 1,0 / 0,1 (идентично); при w=0: 0.5,0.5 (моно). */
function afxApplyWidth(w) {
  const fx = _afx;
  if (!fx) return;
  afxEnsureBus();
  const a = (1 + w) / 2, b = (1 - w) / 2;
  const t = fx.ctx.currentTime;
  const g = fx.bus.width;
  g.ll.gain.setTargetAtTime(a, t, 0.02);
  g.lr.gain.setTargetAtTime(b, t, 0.02);
  g.rl.gain.setTargetAtTime(b, t, 0.02);
  g.rr.gain.setTargetAtTime(a, t, 0.02);
}

/* состояние загрузки процессора тона: null — ещё не начинали,
   промис — грузится, 'fail' — не вышло, { SoundTouchNode } — готов.
   Ворклет нужен ТОЛЬКО тону: эквалайзер живёт на biquad-фильтрах и его
   не грузит, иначе 70 КБ скрипта висели бы в памяти у всех подряд.
   готовый берём из хранилища: ворклет привязан к контексту, и после правки
   файла его пришлось бы регистрировать в том же контексте второй раз. */
let _st = HOT_STORE.st || null;

/* Ленивый граф: пока ни эквалайзер не включён, ни скорость/тон не сдвинуты,
   ни одного узла не создаём — апп не должен платить за фичу, которой не
   пользуются. Как только понадобилось — поднимаем контекст и подключаем в
   него ОБЕ деки (уже созданные и будущие). */
function afx() {
  if (_afx) return _afx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctor({ latencyHint: 'playback' });
  _afx = { ctx, decks: new Map(), eqOn: false, gains: EQ_FLAT.slice(), speed: 1, preserve: true, pitch: 0, schema: AFX_SCHEMA };
  HOT_STORE.afx = _afx;
  /* контекст создан вне пользовательского жеста — он стартует suspended.
     resume() из первого клика/play (см. afxResume) это лечит */
  return _afx;
}

function afxResume() {
  const fx = _afx;
  if (!fx) return;
  if (fx.ctx.state !== 'running') fx.ctx.resume().catch(() => {});
}

/* Цепочка одной деки: источник → 7 полос → (тон) → выход.
   ⚠️ выход отдельным GainNode, а НЕ сразу destination: узлы тона вставляются
   между полосами и выходом, и без такой точки их пришлось бы перекоммутировать
   вручную при каждом включении/выключении, рискуя оставить деку без звука. */
function afxAttach(audio) {
  /* граф поднимаем только по требованию: если ни эквалайзер, ни транспорт
     ещё не включали, подключать элемент некуда и незачем */
  const fx = _afx;
  if (!fx || !audio) return null;

  /* Смена src сбрасывает скорость элемента (см. defaultPlaybackRate в
     afxApplyTransport): переустанавливаем профиль на каждый новый трек.
     Слушатель один и тот же на элемент, поэтому старый снимаем — иначе после
     правки файла тут остались бы функции прошлой версии модуля. */
  if (audio.__sewTransport) audio.removeEventListener('loadstart', audio.__sewTransport);
  audio.__sewTransport = () => { if (_afx) afxApplyTransport(); };
  audio.addEventListener('loadstart', audio.__sewTransport);

  const seen = fx.decks.get(audio);
  if (seen) return seen;
  const src = fx.ctx.createMediaElementSource(audio);
  const filters = EQ_BANDS.map(b => {
    const f = fx.ctx.createBiquadFilter();
    f.type = b.type;
    f.frequency.value = b.hz;
    f.Q.value = b.q;
    f.gain.value = 0;
    return f;
  });
  const out = fx.ctx.createGain();
  filters.forEach((f, i) => (i === 0 ? src.connect(f) : filters[i - 1].connect(f)));
  /* в общую шину, а не прямо в destination: только так ширина видит сумму
     двух дек при кроссфейде. шина создаётся здесь же. */
  afxEnsureBus();
  out.connect(fx.bus.input);
  const deck = { src, filters, out, tail: filters[filters.length - 1], st: null };
  fx.decks.set(audio, deck);
  deck.tail.connect(out);
  /* полосы и транспорт уже могут быть сдвинуты: вторая дека появляется при
     первом кроссфейде, то есть уже после того, как включили эквалайзер */
  deck.filters.forEach((f, i) => {
    f.gain.setTargetAtTime(fx.eqOn ? (fx.gains[i] || 0) : 0, fx.ctx.currentTime, 0.02);
  });
  afxApplyTransport();        /* выставит скорость/тон и подключит ворклет */
  return deck;
}

/* Эквалайзер: включение и профиль. Значения едут плавно (setTargetAtTime),
   иначе на каждом движении ползунка был бы щелчок. */
function afxApplyEq(on, gains) {
  if (!_afx) {
    if (!on) return;                       /* выключен и графа нет — ничего не делаем */
    /* включили — граф нужен, деки подключит эффект App через afxAttach */
    afx();
  }
  const fx = _afx;
  fx.eqOn = !!on;
  fx.gains = (gains || EQ_FLAT).slice();
  const t0 = fx.ctx.currentTime;
  fx.decks.forEach(deck => {
    deck.filters.forEach((f, i) => {
      const g = fx.eqOn ? (fx.gains[i] || 0) : 0;
      f.gain.setTargetAtTime(g, t0, 0.02);
    });
  });
}

/* Модуль процессора тона грузим динамически: 70 КБ воркл-скрипта нужны только
   тем, кто реально двигает тон. Vite кладёт его отдельным файлом-ассетом
   (`?url`), а не в бандл. */
function afxLoadSt() {
  const fx = _afx;
  if (!fx || _st) return _st;
  _st = (async () => {
    try {
      const [{ SoundTouchNode }, proc] = await Promise.all([
        import('@soundtouchjs/audio-worklet'),
        import('@soundtouchjs/audio-worklet/processor?url'),
      ]);
      await SoundTouchNode.register(fx.ctx, proc.default);
      const ready = { SoundTouchNode };
      _st = ready;
      HOT_STORE.st = ready;
      afxApplyTransport();       /* тон могли сдвинуть, пока ворклет грузился */
      return ready;
    } catch (e) {
      console.warn('[audio] процессор тона не загрузился:', e);
      _st = 'fail';
      return null;
    }
  })();
  /* промис тоже кладём в хранилище: иначе подмена модуля на середине загрузки
     начала бы регистрацию ворклета в том же контексте второй раз */
  HOT_STORE.st = _st;
  return _st;
}

/* Скорость и тон.
   Скорость меняется на самом элементе (`playbackRate`): только так
   `currentTime` идёт с той же скоростью, что и звук, — иначе прогресс-бар,
   полоса в дискорде и оставшееся время врут.

   ⚠️ Тон. `<audio>` при `playbackRate ≠ 1` меняет и высоту. Держать её на
   месте элемент умеет сам (`preservesPitch`), а вот сдвинуть на N полутонов —
   нет. Поэтому при `pitch ≠ 0` включается ворклет soundtouch, и правила такие:

   • элемент отдаёт сырое смещение (`preservesPitch = false`): на входе темп `r`
     и высота `r`;
   • ворклету сообщаем ту же `r` — процессор делит на неё
     (`soundtouch-processor.js`: `pitch = 2^(semitones/12) / playbackRate`) и
     возвращает высоту к исходной, добавляя наши полутона;
   • если тональность держать не надо, `playbackRate` ворклета = 1, и высота
     остаётся сдвинутой вместе со скоростью.

   Темп в обоих случаях остаётся `r`: транспондер ворклета скорость не трогает,
   её держит стретчер при tempo = 1. */
function afxApplyTransport() {
  const fx = _afx;
  if (!fx) return;
  const rate = fx.speed, semis = fx.pitch, keep = fx.preserve;
  const stMod = _st && _st.SoundTouchNode ? _st : null;
  if (semis !== 0) afxLoadSt();

  fx.decks.forEach((deck, audio) => {
    /* defaultPlaybackRate, а не только playbackRate: `load()` (его вызывает
       любая смена src) сбрасывает текущую скорость к дефолтной, и новый трек
       стартовал бы на 1× до первой правки ползунка. дефолт держим равным
       скорости — тогда сброс возвращает её же */
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
    const useSt = semis !== 0;
    /* без ворклета высоту держит сам элемент — это бесплатно и качественнее
       любого стретчера, поэтому на чистой скорости идём нативным путём */
    audio.preservesPitch = !useSt && keep;

    if (!useSt) {
      if (deck.st) {
        try { deck.tail.disconnect(deck.st); } catch {}
        try { deck.st.disconnect(deck.out); } catch {}
        deck.tail.connect(deck.out);
        deck.st = null;
      }
      return;
    }

    if (!stMod) return;              /* ворклет ещё грузится — ждём */
    if (!deck.st) {
      deck.st = new stMod.SoundTouchNode({ context: fx.ctx });
      try { deck.tail.disconnect(deck.out); } catch {}
      deck.tail.connect(deck.st);
      deck.st.connect(deck.out);
    }
    deck.st.playbackRate.value = keep ? rate : 1;
    deck.st.pitchSemitones.value = semis;
  });
}

/* Единая точка правки транспорта из настроек: одно поле за раз.
   Граф поднимаем только если правка реально что-то меняет. */
function afxTransport(patch) {
  const needed = patch.pitch ? true : (patch.speed != null && patch.speed !== 1);
  if (!_afx && !needed) return;
  const fx = afx();
  if (patch.speed != null)  fx.speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, Number(patch.speed) || 1));
  if (patch.pitch != null)  fx.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, Number(patch.pitch) || 0));
  if (patch.preserve != null) fx.preserve = !!patch.preserve;
  afxApplyTransport();
}

/* ── Progress Bar ────────────────────────────────────────────────────────── */
function ProgressBar({ progressRef, audioRef, total, onSeek, isPlaying, visible, disabled = false, positionVersion }) {
  const reduced = useReducedMotion();
  const trackRef         = useRef(null);
  const fillRef          = useRef(null);
  const thumbRef         = useRef(null);
  const glowRef          = useRef(null);
  const rafRef           = useRef(null);
  const progRef          = useRef(progressRef.current);
  const dragging         = useRef(false);
  const visibleRef       = useRef(visible);
  const elapsedSpanRef   = useRef(null);
  const remainingSpanRef = useRef(null);
  const totalRef         = useRef(total);
  totalRef.current = total;
  const isPlayingRef     = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const [hover, setHover]   = useState(false);
  const [active, setActive] = useState(false);
  const [tip, setTip] = useState({ x: 0, t: 0, show: false });

  /* стартовое значение прогресса для jsx. дальше transform перезаписывает
     rAF каждый кадр, а константа в style нужна, чтобы react не «восстановил»
     своё значение при ререндере: react пишет в стиль только если значение
     ИЗМЕНИЛОСЬ, поэтому неизменная константа переживает любой ререндер App */
  const initP = useRef(progressRef.current).current;

  /* альфы свечения — ровно те, что раньше были зашиты прямо в три строки
     box-shadow. насыщенность на ховере даёт transition по box-shadow, а
     прогресс едет через opacity: если бы rAF писал ещё и силу свечения,
     переход при наведении перестал бы работать */
  const GLOW_A = { idle: 0.18, soft: 0.2, hover: 0.30, active: 0.42 };

  /* ширина дорожки в css-px. кэшируется, потому что читать offsetWidth
     в rAF — это принудительный layout каждый кадр. меняется только на
     ресайзе, ловится ResizeObserver'ом */
  const trackWRef = useRef(0);

  const drawRef = useRef(null);
  const kick = () => {
    if (visibleRef.current && rafRef.current == null && drawRef.current) {
      rafRef.current = requestAnimationFrame(drawRef.current);
    }
  };

  useEffect(() => {
    visibleRef.current = visible;
    if (visible) kick();
    else { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
  }, [visible]);

  useEffect(() => { kick(); }, [isPlaying]);
  useEffect(() => { kick(); }, [positionVersion]);
  useEffect(() => { if (disabled) { dragging.current = false; setActive(false); } }, [disabled]);

  useEffect(() => {
    let lastRaw = -1;
    const draw = () => {
      /* ЦЕЛЬ БЕРЁТСЯ ИЗ САМОГО audio, а не из progressRef.
         progressRef обновляется событием timeupdate, а оно в html5-аудио
         шлётся примерно 4 раза в секунду, а не каждый кадр. раньше бар
         догонял эту «лестницу» экспоненциальным сглаживанием — отсюда и
         ощущение, что он едет «покадрово»: цель прыгала на 0.25с, а
         сглаживание лишь размазывало прыжок, не убирая его.
         audio.currentTime читается в каждом кадре непрерывно, поэтому
         сглаживать больше нечего и не нужно — плавность получается сама. */
      const audio = audioRef?.current;
      const raw = (audio && audio.duration) ? audio.currentTime / audio.duration : progressRef.current;
      progRef.current = raw;
      const p = Math.max(0, Math.min(1, raw));
      /* ТОЛЬКО transform/opacity. Раньше здесь стояло
         `fill.style.width = p%` и `thumb.style.left = p%` — оба layout-свойства,
         то есть layout+paint на каждом кадре вместо композиции.
         thumb позиционируется через translate в пикселях от кэшированной
         ширины дорожки, потому что translateX в процентах считается от
         ШИРИНЫ САМОГО THUMB'а, а не дорожки. */
      if (fillRef.current)  fillRef.current.style.transform = `scaleX(${p.toFixed(5)})`;
      /* ⚠️ `- 50%` по X обязателен: без него ЛЕВЫЙ край шарика встаёт на
         точку прогресса и он уезжает на половину своей ширины вправо.
         раньше это делало css-свойство `translate: -50% -50%`, отдельное от
         transform, — при переезде позиции в transform оно потерялось */
      if (thumbRef.current) thumbRef.current.style.transform =
        `translate(calc(${(p * trackWRef.current).toFixed(2)}px - 50%), -50%)`;
      /* глоу едет через CSS-переменную, а не через opacity: у слоя есть
         гейт выключенных свечений (--glow-opacity) в calc, и прямое
         присваивание opacity его бы перекрыло.
         раньше ширина глоу бралась из progressRef.current НА РЕНДЕРЕ,
         то есть в rAF не попадала никогда: без ререндера App шкала не
         едет, а у глоу остаётся светящееся пятно у левого края */
      if (glowRef.current)  glowRef.current.style.setProperty('--pb-glow', p.toFixed(5));
      const dur = totalRef.current || 0;
      const de = Math.floor(p * dur);
      if (elapsedSpanRef.current)   elapsedSpanRef.current.textContent   = fmt(de);
      if (remainingSpanRef.current) remainingSpanRef.current.textContent = '-' + fmt(dur - de);
      if (!visibleRef.current) { rafRef.current = null; return; }
      /* остановка на паузе: цель перестала меняться. сравнение с прошлым
         кадром, а не «сблизились два числа» — сглаживания больше нет */
      if (!isPlayingRef.current && !dragging.current && raw === lastRaw) {
        rafRef.current = null; return;
      }
      lastRaw = raw;
      rafRef.current = requestAnimationFrame(draw);
    };
    drawRef.current = draw;
    /* ширина дорожки — для translate thumb'а. меряем здесь и на ресайзе,
       в rAF НЕ меряем: offsetWidth там = принудительный layout каждый кадр */
    const measure = () => { trackWRef.current = trackRef.current?.offsetWidth || 0; };
    measure();
    const ro = new ResizeObserver(measure);
    if (trackRef.current) ro.observe(trackRef.current);
    if (visibleRef.current) rafRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      ro.disconnect();
    };
  }, []);

  const getVal = (e) => {
    const rect = trackRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  };
  useEffect(() => {
    const onMove = (e) => { if (dragging.current && !disabled) onSeek(getVal(e)); };
    const onUp   = () => { if (dragging.current) { dragging.current = false; setActive(false); } };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [onSeek, disabled]);

  const timeStyle = {
    fontSize: 'var(--fs-xs)', fontVariantNumeric: 'tabular-nums',
    color: hover || active ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.28)',
    letterSpacing: '0.02em',
    userSelect: 'none', flexShrink: 0,
    transition: 'color 0.2s ease',
  };
  const thick = !reduced && (hover || active);
  const TRACK_H = thick ? 14 : 10;
  const THUMB_SZ = reduced ? 14 : active ? 16 : (hover ? 14 : 0);
  return (
    <div style={{width:'100%', display:'flex', alignItems:'center', gap:11}}>
      <span ref={elapsedSpanRef} style={timeStyle}>{fmt(Math.floor(progressRef.current * (total||0)))}</span>
      {/* clickable hit-zone with vertical padding */}
      <div
        onPointerEnter={e => { if (isFineHover(e)) setHover(true); }}
        onPointerLeave={() => { setHover(false); setTip(s => ({...s, show:false})); }}
        onPointerMove={e => {
          if (!isFineHover(e)) return;
          const rect = trackRef.current?.getBoundingClientRect();
          if (!rect) return;
          const wrapRect = e.currentTarget.getBoundingClientRect();
          const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          setTip({ x: e.clientX - wrapRect.left, t: Math.floor(p * (total || 0)), show: true });
        }}
        aria-disabled={disabled || undefined}
        onMouseDown={e => { if (disabled) return; dragging.current = true; setActive(true); onSeek(getVal(e)); kick(); }}
        style={{
          flex:1, minWidth:0, position:'relative',
          padding: '10px 0', cursor:disabled ? 'default' : 'pointer',
          display:'flex', alignItems:'center',
        }}
      >
        {/* time tooltip on hover */}
        {tip.show && (
          <div style={{
            position:'absolute',
            left: tip.x, top: -4,
            translate: '-50% -100%',
            background:'var(--pop-bg)',
            backdropFilter:'blur(10px)', WebkitBackdropFilter:'blur(10px)',
            border:'1px solid rgba(255,255,255,0.055)',
            padding:'4px 9px', borderRadius:6,
            fontSize: 'var(--fs-xs)', fontWeight:600, fontVariantNumeric:'tabular-nums',
            color:'rgba(255,255,255,0.92)',
            pointerEvents:'none', whiteSpace:'nowrap',
            boxShadow:'0 8px 20px rgba(0,0,0,0.5)',
            zIndex: 5,
          }}>{fmt(tip.t)}</div>
        )}
        <div style={{ width:'100%', position:'relative' }}>
          {/* track with overflow-hidden so fill scaleX clips cleanly */}
          <div ref={trackRef} data-motion-position=""
            style={{
              width:'100%', position:'relative',
              height: TRACK_H,
              borderRadius: 999, overflow:'hidden',
              background:'rgba(255,255,255,0.085)',
              boxShadow: thick ? 'inset 0 1px 1px rgba(0,0,0,0.18)' : 'none',
              transition: 'height 0.22s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.2s ease',
            }}
          >
            {/* fill: полная ширина + scaleX. почему — в index.md */}
            <div ref={fillRef} style={{
              position:'absolute', left:0, top:0,
              height:'100%', width:'100%',
              transformOrigin:'left center',
              transform: 'scaleX(' + initP.toFixed(5) + ')',
              borderRadius: '0 999px 999px 0',
              background: 'linear-gradient(90deg, rgba(var(--accent-rgb),0.88), color-mix(in srgb, rgb(var(--accent-rgb)) 86%, white))',
              pointerEvents:'none',
            }}/>
          </div>
          {/* glow: полной ширины, едет opacity. почему — в index.md */}
          <div ref={glowRef} data-motion-position="" style={{
            position:'absolute', left:0, right:0, top:'50%', translate:'0 -50%',
            height: TRACK_H,
            borderRadius: 999,
            /* гейт «свечения выключены» живёт в calc: opacity теперь
               перезаписывает rAF, простое значение перекрыло бы его */
            opacity: 'calc(var(--pb-glow, 0) * var(--glow-opacity, 1))',
            boxShadow: (() => {
              if (active) return '0 0 20px rgba(var(--accent-rgb),' + GLOW_A.active + '), 0 0 7px rgba(var(--accent-rgb),' + GLOW_A.hover + ')';
              if (hover)  return '0 0 16px rgba(var(--accent-rgb),' + GLOW_A.hover + '), 0 0 5px rgba(var(--accent-rgb),' + GLOW_A.soft + ')';
              return '0 0 10px rgba(var(--accent-rgb),' + GLOW_A.idle + ')';
            })(),
            pointerEvents:'none',
            transition: 'box-shadow 0.18s linear, height 0.22s cubic-bezier(0.34,1.56,0.64,1)',
          }}/>
          {/* thumb: left 0, позиция приходит translate'ом в px (см. draw) */}
          <div ref={thumbRef} data-motion-position="" style={{
            position:'absolute', top:'50%', left:0,
            transform: 'translate(0, -50%)',
            width: THUMB_SZ, height: THUMB_SZ,
            borderRadius: '50%',
            background: '#fff',
            boxShadow: '0 2px 8px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.08)',
            opacity: (hover || active) ? 1 : 0,
            transition: 'width 0.18s cubic-bezier(0.34,1.56,0.64,1), height 0.18s cubic-bezier(0.34,1.56,0.64,1), opacity 0.18s ease',
            pointerEvents:'none',
          }}/>
        </div>
      </div>
      <span ref={remainingSpanRef} style={timeStyle}>-{fmt((total||0) - Math.floor(progressRef.current * (total||0)))}</span>
    </div>
  );
}

/* ── Thin Volume Slider ───────────────────────────────────────────────────── */
/* шкала громкости. ползунок линеен по ПОЗИЦИИ (0..1), а gain, который идёт
   в audio.volume, проходит перцептивную степень: audio.volume линейна по
   амплитуде, а слух — нет, поэтому на тихой громкости линейный ползунок
   отдавал весь полезный диапазон в самый низ и приходилось тянуть едва ли
   не в ноль. gain = pos^VOL_GAMMA — верх ползунка по-прежнему 100% */
/* варианты меню — В МОДУЛЬНОЙ ОБЛАСТИ, не внутри компонента.
   пересоздание объекта variants на каждом рендере заставляло Motion
   пере-резолвить варианты, и пункты заново проигрывали hidden→show:
   меню дёргалось всеми тремя кнопками при ЛЮБОМ обновлении state
   (setPlMembers сыплет по записи на каждый плейлист, пока едут чекбоксы) */
const MENU_VARIANTS = {
  hidden: { opacity: 0, scale: 0.92, y: -7 },
  show:   { opacity: 1, scale: 1, y: 0,
            transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1],
                          staggerChildren: 0.03, delayChildren: 0.06 } },
};
const itemVars = {
  hidden: { opacity: 0, y: -5 },
  show:   { opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] } },
};
const itemStyle = {
  display:'flex', alignItems:'center', gap:10,
  padding:'7px 11px', borderRadius:7,
  fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.86)',
  cursor:'pointer', transition:'background 0.12s', userSelect:'none',
};
const itemHover = {
  onMouseEnter: e => e.currentTarget.style.background='rgba(255,255,255,0.07)',
  onMouseLeave: e => e.currentTarget.style.background='transparent',
};

/* Item и PlCheck — ТОЖЕ в модульной области. объявленные внутри
   TrackContextMenu они получали новый тип на каждом рендере, и React
   пересоздавал их поддеревья: Motion проигрывал hidden→show заново, и при
   любом обновлении state (setPlMembers едет по плейлистам) первые две
   кнопки меню дёргались. третья кнопка инлайном — не дёргалась, по этому
   и вычислили причину */
function Item({ label, icon, disabled, onClick, onClose }) {
  return (
    <motion.div variants={itemVars} data-motion-spatial="" onClick={disabled ? null : () => { onClick?.(); onClose(); }}
      style={{ ...itemStyle, color: disabled ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.86)', cursor: disabled ? 'default' : 'pointer' }}
      {...(disabled ? {} : itemHover)}>
      <span style={{display:'flex', alignItems:'center', justifyContent:'center', width:14, opacity:0.7}}>{icon}</span>
      <span>{label}</span>
    </motion.div>
  );
}

/* чекбокс строки пикера: state = true | false | 'loading' (спиннер, пока едет
   состав), busy = по этой строке идёт запись */
function PlCheck({ state, busy }) {
  if (busy)
    return <div style={{width:13, height:13, flexShrink:0, border:'1.5px solid rgba(255,255,255,0.2)',
      borderTopColor:'rgba(255,255,255,0.65)', borderRadius:'50%', animation:'spin 0.75s linear infinite'}}/>;
  if (state === 'loading')
    return <div style={{width:14, height:14, flexShrink:0, border:'1.5px solid rgba(255,255,255,0.12)',
      borderTopColor:'rgba(255,255,255,0.34)', borderRadius:'50%', animation:'spin 0.9s linear infinite'}}/>;
  const on = state === true;
  return (
    <motion.span
      animate={{
        backgroundColor: on ? 'rgba(var(--accent-rgb), 0.9)' : 'rgba(255,255,255,0)',
        borderColor:     on ? 'rgba(var(--accent-rgb), 0.9)' : 'rgba(255,255,255,0.22)',
      }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      style={{
        width:14, height:14, flexShrink:0, borderRadius:4, border:'1.5px solid',
        display:'flex', alignItems:'center', justifyContent:'center',
      }}>
      <motion.svg data-motion-spatial="" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#0a0a0c"
        strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"
        initial={false}
        animate={{ scale: on ? 1 : 0.4, opacity: on ? 1 : 0 }}
        transition={{ type:'spring', stiffness: 620, damping: 26, mass: 0.5 }}>
        <polyline points="20 6 9 17 4 12"/>
      </motion.svg>
    </motion.span>
  );
}

const VOL_GAMMA = 2.2;
const volPosToGain = p => Math.pow(Math.max(0, Math.min(1, p)), VOL_GAMMA);
const volGainToPos = g => Math.pow(Math.max(0, Math.min(1, g)), 1 / VOL_GAMMA);

function ThinVolumeSlider({ volume, onChange, onLiveChange }) {
  const wrapRef    = useRef(null);
  const canvasRef  = useRef(null);
  const rafRef     = useRef(null);
  const volActual  = useRef(volGainToPos(volume)); /* позиция 0..1; следует пропу когда idle, курсору при драге */
  const volDisp    = useRef(volGainToPos(volume)); /* плавно догоняет volActual */
  const dragging   = useRef(false);
  const onChangeCb = useRef(onChange);     /* commit to React state (mouseup only) */
  const onLiveCb   = useRef(onLiveChange); /* live apply during drag (no re-render) */
  const TW = 28;

  const drawRef = useRef(null);
  /* метка времени последнего кадра — для нормализации сглаживания на dt */
  const lastT = useRef(0);
  const kick = () => {
    if (rafRef.current == null && drawRef.current) {
      rafRef.current = requestAnimationFrame(drawRef.current);
    }
  };

  useEffect(() => { onChangeCb.current = onChange; }, [onChange]);
  useEffect(() => { onLiveCb.current = onLiveChange; }, [onLiveChange]);
  useEffect(() => {
    if (!dragging.current) volActual.current = volGainToPos(volume);
    kick();
  }, [volume]);
  /* перерисовка в такт анимации акцента */
  useEffect(() => onAccentChange(kick), []);

  const getVal = useCallback((e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, 1 - (e.clientY - rect.top)/rect.height));
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');

    const resize = () => {
      canvas.height = wrap.clientHeight * dpr;
      canvas.width  = TW * dpr;
      canvas.style.height = wrap.clientHeight + 'px';
      canvas.style.width  = TW + 'px';
      kick();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const draw = () => {
      /* ⚠️ сглаживание нормализовано на ВРЕМЯ, а не на кадр.
         было `volDisp += diff * 0.09` — доля от разницы за КАДР. на 144Гц
         она съедала разницу вчетверо быстрее, чем на 60Гц, и «догоняющий»
         бегунок выглядел по-разному на разных мониторах. k = 1-(1-k)^(dt/16.7)
         даёт одну и ту же кривую при любой частоте кадров. */
      const speed = dragging.current ? 0.09 : 0.04;
      const now = performance.now();
      const dt = Math.min(64, lastT.current ? now - lastT.current : 16.7);
      lastT.current = now;
      const frames = dt / 16.7;
      const k = 1 - Math.pow(1 - speed, frames);
      const diff = volActual.current - volDisp.current;
      if (reducedMotionNow() || !dragging.current && Math.abs(diff) < 0.001) {
        volDisp.current = volActual.current;
      } else {
        volDisp.current += diff * k;
      }
      const v = volDisp.current;

      const WW = canvas.width, HH = canvas.height;
      ctx.clearRect(0, 0, WW, HH);

      const cx    = WW / 2;
      const barW  = 5 * dpr;
      const r     = barW / 2;
      const pad   = r + 4 * dpr;
      const trackH = HH - pad * 2;
      const trackTop = pad;
      const trackBot = pad + trackH;

      /* bg track */
      ctx.beginPath();
      ctx.roundRect(cx - r, trackTop, barW, trackH, r);
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fill();

      /* fill */
      if (v > 0.01) {
        const fillH   = Math.max(barW, trackH * v);
        const fillTop = trackBot - fillH;
        ctx.save();
        const accentRgb = `${LIVE_ACCENT.r},${LIVE_ACCENT.g},${LIVE_ACCENT.b}`;
        if (LIVE_GLOW.on) {
          ctx.shadowColor = `rgba(${accentRgb},0.5)`;
          ctx.shadowBlur  = 8 * dpr;
        }
        ctx.beginPath();
        ctx.roundRect(cx - r, fillTop, barW, fillH, r);
        ctx.fillStyle = `rgb(${accentRgb})`;
        ctx.fill();
        ctx.restore();
      }

      if (!dragging.current && Math.abs(volActual.current - volDisp.current) < 0.001) {
        rafRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    drawRef.current = draw;
    rafRef.current = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(rafRef.current); rafRef.current = null; ro.disconnect(); };
  }, []);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current) return;
      volActual.current = getVal(e);
      /* позиция → gain на границе наружу: App и audio знают только gain */
      onLiveCb.current?.(volPosToGain(volActual.current));
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      onChangeCb.current(volPosToGain(volActual.current)); /* commit final gain to React state once */
      kick();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [getVal]);

  return (
    <div ref={wrapRef} style={{flex:1, minHeight:0, cursor:'ns-resize', display:'flex', alignItems:'stretch'}}
      onMouseDown={e => { dragging.current = true; volActual.current = getVal(e); onLiveCb.current?.(volPosToGain(volActual.current)); kick(); }}>
      <canvas ref={canvasRef} style={{display:'block'}}/>
    </div>
  );
}

/* ── Album Art ───────────────────────────────────────────────────────────── */
/* double-buffer crossfade: новая обложка грузится скрытым слоем поверх старой,
   после load+decode плавно проявляется (0.45s), старая остаётся под ней до
   конца кроссфейда — тёмной вспышки и «пустого бокса» при смене трека нет */
function CoverLayer({ url, onLoaded, onFailed, instant, isTop = true, ready = false, topReady = true }) {
  const reduced = useReducedMotion();
  /* кавер рисуется в canvas ПЛОСКИМ прямоугольником, без клипа по скруглению.
     скругление делает контейнер (border-radius + overflow:hidden). вторая
     растеризация той же кривой внутри битмапа давала на стыке светлый шов
     в углах — на почти чёрных обложках это были белые пиксели. см. draw() */
  const canvasRef = useRef(null);
  const imgRef    = useRef(null);
  const retryRef  = useRef(0);

  const draw = useCallback(() => {
    const cv = canvasRef.current, im = imgRef.current;
    if (!cv || !im || !im.naturalWidth) return;
    const dpr  = window.devicePixelRatio || 1;
    const rect = cv.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width  * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    /* БЕЗ roundRect/clip — намеренно. Кант режет контейнер своими
       `border-radius` + `overflow:hidden`, и это ЕДИНСТВЕННАЯ растеризация
       кривой. Скругление в битмапе давало вторую, и на стыке двух
       растеризаций в углу проступал фон контейнера: у контейнера #111116,
       а у почти чёрных обложек (Fallen Angel и подобные) пиксели арта
       3,3,3 — на 4 пикселя в каждом углу было светлее, чем сама обложка.
       измерено: угол 17,17,22 вместо 3,3,3.
       здесь альфа 255 по всему битмапу, проступить просто нечему */
    /* запас 2px остаётся: битмап масштабируется в css-бокс, и без запаса
       на прямых краях возможна волосяная щель от округления размера */
    const bw = w + 2 * dpr, bh = h + 2 * dpr;
    const sc = Math.max(bw / im.naturalWidth, bh / im.naturalHeight);
    const dw = im.naturalWidth * sc, dh = im.naturalHeight * sc;
    ctx.drawImage(im, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }, []);

  /* загрузка → decode → отрисовка → fade-in → ready */
  useEffect(() => {
    let dead = false;
    const im = new Image();
    imgRef.current = im;
    im.decoding = 'async';
    /* ⚠️ Счётчик попыток принадлежал ПРЕДЫДУЩЕМУ url: сбрасывался только в
       `ready`, то есть на успехе. Поэтому исчерпанные попытки переносились на
       СЛЕДУЮЩУЮ обложку в том же экземпляре слоя, и та падала сразу, не
       получив ни одной попытки. Сбрасываем на смену url. */
    retryRef.current = 0;
    /* У локальных треков обложка приходит из тегов как
       `data:image/jpeg;base64,…` (см. cover_art в library.rs), а у sc —
       как сетевой url. Разница критична для обработчика ошибки ниже. */
    const isData = /^data:/i.test(url);
    im.onload = () => {
      if (dead) return;
      const ready = () => {
        if (dead) return;
        draw();
        /* прозрачностью занимается эффект положения слоя: она зависит ещё и
           от того, верхний этот слой или нет. Раньше здесь стояло
           `style.opacity = '1'` — нижний слой становился видимым и не
           уходил, поэтому кроссфейда не было, а новая обложка просто
           проявлялась поверх неподвижной старой */
        onLoaded(url);
      };
      if (im.decode) im.decode().then(ready).catch(ready); else ready();
    };
    im.onerror = () => {
      if (dead) return;
      /* 🚨 Повтор через `?_r=<timestamp>` для data-url не просто бесполезен,
         а ВРЕДИТЕЛЬ: хвост дописывается внутрь base64-полезной нагрузки, и
         следующая попытка гарантированно падает на битом base64. Дальше —
         две попытки, потом onFailed, слой выкидывается, и обложка навсегда
         остаётся заглушкой: переоткрыть трек уже не помогает, потому что
         каждый новый слой повторяет тот же цикл. Именно это и наблюдалось:
         обложка локального трека слетала после переключения трек→библиотека→
         трек. Для data-url повтор не нужен в принципе (сети нет, кэш не
         при чём), поэтому уходим в отказ сразу. */
      if (isData || retryRef.current >= 2) { onFailed(url); return; }
      retryRef.current++;
      setTimeout(() => {
        if (dead) return;
        const sep = url.includes('?') ? '&' : '?';
        im.src = url + sep + '_r=' + Date.now();
      }, 500 * retryRef.current);
    };
    im.src = url;
    return () => { dead = true; };
  }, [url, draw]);

  /* перерисовка при ресайзе окна/контейнера (canvas фиксированного битмапа) */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(cv);
    window.addEventListener('resize', draw);
    return () => { ro.disconnect(); window.removeEventListener('resize', draw); };
  }, [draw]);

  /* Положение слоя. Тут и живёт смена обложки в плеере.
     Только масштаб: поворот и подъём читались как дёрганье, а холст уже
     растеризован — двигать его можно композиционно, без перерисовки
     битмапа, и ничего больше.
     Старый слой уходит не сразу, а когда новый УЖЕ готов: иначе между
     появлением нового слоя и его загрузкой мелькнул бы placeholder с
     нотой. Поэтому проверка topReady, а не просто «перестал быть верхним». */
  /* ⚠️ useLayoutEffect, а не useEffect: это свойство React пишет ИНЛАЙНОМ
     (`opacity: instant ? 1 : 0`), и в момент, когда hero-клон снимается,
     `instant` переключается с true на false — React ставит opacity = 0.
     Пассивный эффект успевает исправить это уже ПОСЛЕ кадра, и обложка на
     один кадр пропадала ровно в момент приземления клона: тот самый рывок
     в конце полёта. layout-эффект отрабатывает до отрисовки, поэтому
     нулевое значение не успевает показаться ни на кадр. */
  useLayoutEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    if (isTop) {
      cv.style.opacity = ready ? '1' : '0';
      cv.style.transform = reduced || ready ? 'none' : 'scale(1.035)';
      return;
    }
    if (!topReady) return;
    cv.style.opacity = '0';
    cv.style.transform = reduced ? 'none' : 'scale(0.985)';
    /* ⚠️ `instant` в deps — обязателен, и это и есть баг «обложка из
       библиотеки приезжает заглушкой».

       React переносит `opacity` из JSX-стиля в инлайн-проп как
       `instant ? 1 : 0`, а этот эффект управляет тем же свойством
       через `cv.style` вручную. Пока instant не меняется, React
       инлайн не трогает и эффект дописывает своё значение поверх.
       Но как только instant меняется (hero стартует при клике по
       карточке библиотеки и снимается по её прилёте), React
       ПЕРЕЗАПИСЫВАЕТ opacity своим значением — и если в этот момент
       ветка выше уже отработала (isTop / topReady не изменились),
       эффект не перезапускается, потому что instant в списке
       зависимостей не было. Верхний слой остаётся с opacity = 0
       от React, то есть невидим, и под ним видна заглушка с нотой.

       Именно поэтому баг воспроизводится ТОЛЬКО из библиотеки:
       переключение треков в списке плеера идёт без hero, там
       instant всегда false и конфликта значений не возникает. */
  }, [isTop, ready, topReady, instant, reduced]);

  return (
    <canvas ref={canvasRef}
      style={{position:'absolute',inset:0,width:'100%',height:'100%',display:'block',
        opacity: instant ? 1 : 0, transform:'none',
        /* ⚠️ instant — на экране hero-клона кроссфейд НЕ нужен и вреден.
           клон поверх уже показывает новую обложку; если дать нижним слоям дорисовки,
           в момент снятия клона сверху будет полупрозрачная новая,
           а снизу — старая. */
        transition: instant ? 'none' : reduced ? 'opacity 0.12s ease-out' : 'opacity 0.38s ease-out, transform 0.5s cubic-bezier(0.2,0.8,0.2,1)',
        willChange:'transform, opacity',
        pointerEvents:'none'}}/>
  );
}

/* ── тонирование обложек ─────────────────────────────────────────────────── */
/* Слой цвета поверх обложки с `mix-blend-mode: color`. Это ровно приём
   tinted-иконок в ios 18: режим color берёт у источника ТОН и НАСЫЩЕННОСТЬ, а
   светлоту — у картинки под ним. Обложка остаётся собой (все переходы, лица,
   фактура), но живёт в одной палитре.

   Цвет ОДИН на всё приложение, и это принципиально: смысл режима — чтобы весь
   экран читался цельно, а не чтобы каждая обложка красовалась своим оттенком.
   Два источника (переключатель в «Оформление → Обложки»):
   • `cover` — оттенок ТЕКУЩЕЙ обложки: переключил трек — перекрасилось всё;
   • `color` — выбранный в колор-пикере.

   Оба приходят сюда одной css-переменной (--cover-tint-rgb), которую пишет
   App: обложки рисуются в полутора десятках мест, и считать/протаскивать цвет
   в каждое было бы и дороже, и бессмысленно — он одинаков для всех.

   Переход между цветами — css-транзишн на самом слое: при смене трека
   переменная меняется один раз, а дальше браузер сам едет от старого тона к
   новому. Никакого lerp-цикла здесь не нужно.

   Ставить слой нужно СРАЗУ ЗА картинкой: всё, что рисуется после (затемнение
   под курсором, спиннер, бейджи, кнопка play), должно лежать поверх
   тонировки — иначе бленд перекрасит и его. */
function CoverTint() {
  return <div aria-hidden="true" style={{
    position:'absolute', inset:0, pointerEvents:'none',
    background:'rgb(var(--cover-tint-rgb))',
    mixBlendMode:'color',
    opacity:'var(--cover-tint, 0)',
    transition:'background 0.5s ease, opacity 0.3s ease',
  }}/>;
}

function AlbumArt({ track, instant, onReady }) {
  const url = track?.coverUrl || null;
  const [layers, setLayers] = useState(() => (url ? [{ url, id: 0 }] : []));
  const nextLayerId = useRef(1);
  const requestedUrl = useRef(url);
  const alive = useRef(true);
  useLayoutEffect(() => { requestedUrl.current = url; }, [url]);
  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const pruneTimer = useRef(null);
  const top = layers[layers.length - 1];
  const topUrl = top?.url || null;
  /* верхний слой отрисован — сообщаем, чтобы hero-клон снимался только когда
     под ним уже лежит НОВАЯ обложка, а не предыдущая */
  const topReady = top ? !!top.ready : true;
  // An empty stack during a new request is not a decoded cover. A failed
  // current layer is retained as a settled placeholder, not mounted for retry.
  const currentReady = url ? topUrl === url && !!(top.ready || top.failed) : layers.length === 0;
  useEffect(() => {
    if (currentReady) onReady?.();
  }, [track?.id, url, currentReady, onReady]);
  /* трасса слоёв: сколько их, готов ли верхний и какой url пришёл. без неё
     «обложки нету» и «осталась чужая обложка» выглядят одинаково */
  useEffect(() => {
    window.electronAPI?.log?.(
      '[cover] слоёв ' + layers.length + ' topReady=' + topReady
      + ' instant=' + !!instant
      + ' url=' + String(url || 'НЕТ').slice(-46)
      + ' дубликатов=' + (layers.length - new Set(layers.map(l => l.url)).size),
    );
  }, [layers, topReady, url, instant]);
  /* при мгновенной подмене старые слои срезаем сразу, не ждя 800мс */
  useEffect(() => {
    if (!instant || layers.length < 2 || !topReady) return;
    setLayers(prev => (prev.length < 2 ? prev : [prev[prev.length - 1]]));
  }, [instant, topReady, layers.length]);


  /* новая обложка → новый слой сверху; без обложки → только placeholder */
  useEffect(() => {
    if (url === topUrl) return;
    if (pruneTimer.current) { clearTimeout(pruneTimer.current); pruneTimer.current = null; }
    const layer = url ? { url, id: nextLayerId.current++ } : null;
    /* 🚨 раньше здесь было `setLayers(url ? [...layers, { url }] : [])`.
       `layers` здесь — ЗАМЫКАНИЕ эффекта, а его deps = [url]. если смена
       обложки приходит в том же батче, что и другая (быстрое переключение
       треков), эффект запускается с УСТАРЕВШИМ layers и затирает `ready`
       у слоя, который уже прогрузился: сверху оказывался неготовый слой,
       и клон/кроссфейд ждал уже несуществующей готовности.
       функциональный апдейтер берёт актуальное prev, поэтому порядок
       применения неважен. */
    setLayers(prev => {
      if (!url) return [];
      const found = prev.find(l => l.url === url && !l.failed);
      if (found) return [...prev.filter(l => l.url !== url), found];
      return [...prev.filter(l => l.url !== url), layer];
    });
  }, [url, topUrl]);

  /* верхний слой проявился → срезаем нижние после кроссфейда */
  useEffect(() => {
    if (layers.length < 2) return;
    const top = layers[layers.length - 1];
    if (!top.ready) return;
    if (pruneTimer.current) clearTimeout(pruneTimer.current);
    pruneTimer.current = setTimeout(() => {
      if (!alive.current) return;
      pruneTimer.current = null;
      setLayers(prev => {
        if (prev.length < 2) return prev;
        const t = prev[prev.length - 1];
        return t.ready ? [t] : prev;
      });
    }, 800);
  }, [layers]);

  useEffect(() => () => { if (pruneTimer.current) clearTimeout(pruneTimer.current); }, []);

  const markLoaded = (u, id) => {
    if (!alive.current) return;
    setLayers(prev => {
      const i = prev.findIndex(l => l.url === u && l.id === id);
      if (i < 0 || prev[i].ready || prev[i].failed) return prev;
      const next = prev.slice();
      next[i] = { ...prev[i], ready: true };
      return next;
    });
  };
  const dropLayer = (u, id) => {
    if (!alive.current) return;
    setLayers(prev => {
      const i = prev.findIndex(l => l.url === u && l.id === id);
      if (i < 0 || prev[i].failed) return prev;
      // Never expose the preceding track or recreate this failed request.
      if (u === requestedUrl.current && i === prev.length - 1) return [{ ...prev[i], ready: false, failed: true }];
      return prev.filter(l => l.id !== id);
    });
  };

  return (
    <div style={{
      position:'relative', width:'100%', aspectRatio:'1', borderRadius:16, overflow:'hidden',
      background:'#111116',
      display:'flex', alignItems:'center', justifyContent:'center',
    }}>
      {/* placeholder underneath — always rendered */}
      <img src="../assets/note.png" style={{width:32,height:32,filter:'brightness(0) invert(1)',opacity:0.13}}/>
      {layers.map((l, i) => !l.failed && (
        <CoverLayer key={l.id} url={l.url} onLoaded={u => markLoaded(u, l.id)} onFailed={u => dropLayer(u, l.id)} instant={instant}
          isTop={i === layers.length - 1} ready={!!l.ready} topReady={topReady}/>
      ))}
      <CoverTint/>
    </div>
  );
}

/* ── AmbientGlow ─────────────────────────────────────────────────────────── */
/* glow за обложкой. Без `filter: blur()` — он стоил двух проходов блюра по
   ~1000×1000 px и перерисовывался на каждом кадре лерпа --accent-rgb.
   Но просто «убрать блюр и оставить тот же градиент» нельзя, и вот почему:
   `filter` применяется ПОСЛЕ обрезки `border-radius`, то есть блюр
   размазывал обрезанный круг НАРУЖУ на ~42px — именно это и давало видимый
   ореол (и заодно замазывало стык обрезки). Без него остаётся только то,
   что в градиенте.
   ⚠️ и вот тут была вторая ошибка: при inset:-30% бокс = 1.6× обложки,
   край обложки попадает на 62% радиуса градиента, где альфа ~0.1 —
   всё яркое сидит ЗА обложкой, наружу торчит только прозрачный хвост,
   и блоба не видно вообще. лечится двумя ручками:
   1) `closest-side` — доводит градиент ровно до нуля на РЕБРЕ бокса, то
      есть ровно там, где его режет border-radius. без размера circle =
      farthest-corner, ноль приходит на УГЛАХ, а режет круг по СЕРЕДИНАМ
      РЁБЕР → чёткая граница круга
   2) `inset:-50%` вместо -30% — блок в 2× обложки, край обложки уходит
      на 50% радиуса вместо 62%, и наружу остаётся читаемая альфа (~0.26) */
function AmbientGlow({ visible, off }) {
  if (off) return null;
  /* Прозрачности ступеней домножаются на --glow-strength, а не на opacity
     самого элемента: opacity выше единицы обрезается движком, и ползунок
     «сила свечений» в «Оформлении» не смог бы разогнать пятно ярче исходного.
     Читать из css нельзя — фон собирается строкой здесь. */
  const ga = k => `rgba(var(--accent-rgb), calc(${k} * var(--glow-strength, 1)))`;
  return (
    <div style={{
      /* Пятно не трогать: это ореол ЗА ОБЛОЖКОЙ, и его размер задан тут же
         ниже в комментарии функции осознанно (ближе к обложке = читаемая
         альфа снаружи). Всё, что светится цветом акцента в верхней части
         окна, приходит ОТСЮДА: пятно круглое и симметричное, поэтому его
         ореол по бокам и его хвост через верх окна — одно и то же пятно,
         и разделить их нельзя, не разрезав круг */
      position:'absolute', inset:'-50%', borderRadius:'50%',
      /* ⚠️ хвост после 60% намеренно сжат. У скруглённой обложки за дугой
         каждого угла остаётся просвет, и в него видно glow. Углы квадрата
         лежат на 0.707 радиуса градиента, а середины рёбер — на 0.5, так
         что дальнюю зону можно гасить независимо от ореола у самой
         обложки: 0.26 на 50% (ореол) оставлено как было, а на 70% вместо
         ~0.135 теперь ~0.068. без этого в просветах углов на секунду
         вспыхивало цветное пятно — glow-то как раз в этот момент гас. */
      background: `radial-gradient(circle closest-side at center, ${ga(0.42)} 0%, ${ga(0.36)} 25%, ${ga(0.26)} 50%, ${ga(0.14)} 62%, ${ga(0.06)} 72%, ${ga(0.024)} 82%, ${ga(0.008)} 91%, ${ga(0.002)} 97%, ${ga(0)} 100%)`,
      opacity: visible ? 1 : 0, transition:'opacity 0.6s ease',
      willChange:'opacity', transform:'translateZ(0)',
      pointerEvents:'none', zIndex:0,
    }}/>
  );
}

/* ── MagBtn ──────────────────────────────────────────────────────────────── */
/* Кнопка транспорта.

   Раньше на ховере была одна `scale(1.1)` на жёсткой пружине: кнопка целиком
   «щёлкала» размером, а иконка и подложка оставались на месте. Отсюда и
   ощущение дешёвки — движение одно, мгновенное, и оно про габарит, а не про
   саму кнопку.

   Теперь масштаба на ховере нет вовсе:
   • под иконкой расцветает ореол в акцентном цвете (radial-gradient, а не
     box-shadow: тень повторяет силуэт кнопки и на тёмном фоне даёт грязное
     пятно вместо свечения);
   • иконка едет за курсором на пару пикселей — отсюда и «магнит». Движение на
     пружине: pointermove приходит на 100 Гц, и без интерполяции иконка прыгала
     бы пиксельными ступеньками;
   • масштаб остался только у нажатия (0.94) — это единственное движение,
     которое обязано читаться как отклик.

   Ореол и уезд иконки — transform/opacity, то есть композитор: ховер не
   трогает layout и не дёргается, даже когда основной поток занят. */
const MAG_PULL = 3.2;          /* предел уезда иконки от центра, px */

function MagBtn({ onClick, active, children, size=52, disabled = false, title }) {
  const reduce = useReducedMotion();
  const [hov, setHov] = useState(false);
  const mx = useSpring(0, { stiffness: 340, damping: 24, mass: 0.35 });
  const my = useSpring(0, { stiffness: 340, damping: 24, mass: 0.35 });
  useLayoutEffect(() => {
    if (reduce || disabled) { mx.jump(0); my.jump(0); }
  }, [reduce, disabled, mx, my]);

  const move = e => {
    if (reduce || disabled || !isFineHover(e)) return;
    const r = e.currentTarget.getBoundingClientRect();
    /* нормализуем по половине габарита: край кнопки = 1, центр = 0, поэтому
       предел уезда одинаков и у 40px, и у 66px */
    mx.set(((e.clientX - (r.left + r.width  / 2)) / (r.width  / 2)) * MAG_PULL);
    my.set(((e.clientY - (r.top  + r.height / 2)) / (r.height / 2)) * MAG_PULL);
  };
  /* возвращаем на место тоже пружиной, а не мгновенно: отпускание курсора —
     часть жеста, и «отскок» читается как инерция */
  const leave = () => { setHov(false); mx.set(0); my.set(0); };

  return (
    <motion.button data-motion-spatial="" onClick={onClick} disabled={disabled} title={title}
      onPointerEnter={e => { if (!disabled && isFineHover(e)) setHov(true); }} onPointerMove={move} onPointerLeave={leave}
      whileTap={disabled || reduce ? undefined : { scale: 0.94 }}
      animate={reduce ? { scale: 1 } : undefined}
      transition={{ type:'spring', stiffness: 520, damping: 28, mass: 0.5 }}
      style={{
        position:'relative',
        width:size, height:size, borderRadius:'50%', border:'none', background:'none',
        color: active ? 'var(--accent)' : 'rgba(255,255,255,0.38)',
        display:'flex', alignItems:'center', justifyContent:'center',
        cursor:disabled ? 'default' : 'pointer', opacity:disabled ? 0.4 : 1, flexShrink:0,
        transition:'color 220ms ease',
      }}>
      {/* ореол лежит ПОД иконкой и не выходит за габарит кнопки: кнопки стоят
          плотно, и пятно крупнее самой кнопки слипалось бы с соседним */}
      <span aria-hidden="true" style={{
        position:'absolute', inset:'6%', borderRadius:'50%',
        background:'radial-gradient(circle at center,'
          + ' rgba(var(--accent-rgb),0.28) 0%,'
          + ' rgba(var(--accent-rgb),0.14) 44%,'
          + ' rgba(var(--accent-rgb),0.04) 67%,'
          + ' rgba(var(--accent-rgb),0) 78%)',
        opacity: hov ? 1 : 0,
        transform: reduce || hov ? 'scale(1)' : 'scale(0.58)',
        /* появление медленнее угасания: курсор влетает быстро, а отпускает
           кнопку глаз ещё несколько кадров */
        transition: reduce ? 'opacity 150ms ease' : hov
          ? 'opacity 190ms ease, transform 340ms cubic-bezier(0.23,1,0.32,1)'
          : 'opacity 150ms ease, transform 150ms cubic-bezier(0.23,1,0.32,1)',
        pointerEvents:'none',
      }}/>
      <motion.span style={{
        position:'relative', display:'flex', alignItems:'center', justifyContent:'center',
        x: mx, y: my,
      }}>{children}</motion.span>
    </motion.button>
  );
}

/* ── PlayBtn ─────────────────────────────────────────────────────────────── */
function PlayBtn({ isPlaying, onToggle, trackKey = null, disabled = false, title }) {
  const reduced = useReducedMotion();
  const pulseRef = useRef(null);
  const pulseMotionRef = useRef(null);
  const BTN = 'clamp(58px, 7.2vw, 86px)';
  const ICO = 'clamp(32px, 4.2vw, 50px)';
  /* Два разных импульса, потому что это разные события.
     playPulse — нажатие play: широкая волна наружу.
     trackPulse — смена трека: короткий сжатый удар по самой кнопке.
     Раньше смена трека была видна только тем, что иконка на секунду
     прыгала на «паузу» — а это был побочный эффект того, что состояние
     сбрасывали на время переключения. Сброс убрали, и оказалось, что
     переключение не сигналит ничем: обложка меняется в соседней
     панели, а на кнопке ничего. */
  const [playPulse, setPlayPulse] = useState(0);
  const [hov, setHov] = useState(false);
  const wasPlaying = useRef(false);
  useEffect(() => {
    if (isPlaying && !wasPlaying.current) setPlayPulse(k => k + 1);
    wasPlaying.current = isPlaying;
  }, [isPlaying]);
  const lastTrack = useRef(trackKey);
  useLayoutEffect(() => {
    pulseMotionRef.current = createFeedbackMotion(pulseRef.current);
    return () => pulseMotionRef.current.cancel();
  }, []);
  useLayoutEffect(() => {
    if (reduced || disabled) pulseMotionRef.current.cancel();
    if (lastTrack.current === trackKey) return;
    lastTrack.current = trackKey;
    if (trackKey != null && !disabled) pulseMotionRef.current.pulse(reduced);
  }, [trackKey, reduced, disabled]);

  /* Раньше обе иконки анимировались одновременно и навстречу: уходящая
     крутилась на −90° и сжималась до 0.45, приходящая крутилась на +90°
     и расползалась, а кривая с перелётом (0.34,1.56,0.64,1) перескакивала
     через 100%. Три движения разом — и кнопка дёргалась. Теперь вращения
     нет, иконки просто меняются местами через кроссфейд с лёгким масштабом,
     причём уходящая гаснет быстрее, чем появляется новая: наложения двух
     полусоветлых картинок не видно. */
  const ico = visible => ({
    position:'absolute', top:0, left:0, width:ICO, height:ICO,
    filter:'brightness(0) invert(1)',
    opacity: visible ? 1 : 0,
    transform: reduced || visible ? 'scale(1)' : 'scale(0.78)',
    transition: reduced ? 'opacity 0.12s ease-out' : visible
      ? 'opacity 0.22s ease-out, transform 0.34s cubic-bezier(0.2,0.9,0.2,1)'
      : 'opacity 0.12s ease-in, transform 0.12s ease-in',
    pointerEvents:'none',
  });
  return (
    <motion.button data-motion-spatial="" onClick={onToggle} disabled={disabled} title={title} aria-label={title}
      onPointerEnter={e => { if (!disabled && isFineHover(e)) setHov(true); }} onPointerLeave={() => setHov(false)}
      whileTap={disabled || reduced ? undefined : { scale: 0.95 }}
      animate={reduced ? { scale: 1 } : undefined}
      transition={{ type:'spring', stiffness: 380, damping: 26, mass: 0.6 }}
      style={{
        width:BTN, height:BTN, borderRadius:'50%', border:'none',
        background:'none',
        color:'var(--text)',
        display:'flex', alignItems:'center', justifyContent:'center',
        cursor:disabled ? 'default' : 'pointer', opacity:disabled ? 0.6 : 1, flexShrink:0, position:'relative',
        transition:'background 0.3s ease',
      }}>
      <span ref={pulseRef} style={{position:'absolute', inset:0, borderRadius:'inherit',
        display:'flex', alignItems:'center', justifyContent:'center', pointerEvents:'none',
        background: isPlaying ? 'rgba(178,178,178,0.1)' : 'rgba(255,255,255,0.06)',
        transition:'background 0.3s ease'}}>
      {/* ховер — не масштаб, а свет: вокруг кнопки проступает акцентное кольцо.
          оно живёт за габаритом кнопки, поэтому ряд не сдвигается и ничего не
          пересчитывается в layout; появление с лёгким расширением, угасание
          быстрее — как у остальных кнопок транспорта */}
      <span aria-hidden="true" style={{
        position:'absolute', inset:-8, borderRadius:'50%',
        border:'1.5px solid rgba(var(--accent-rgb),0.42)',
        opacity: hov ? 1 : 0,
        transform: reduced || hov ? 'scale(1)' : 'scale(0.88)',
        transition: reduced ? 'opacity 140ms ease' : hov
          ? 'opacity 200ms ease, transform 320ms cubic-bezier(0.23,1,0.32,1)'
          : 'opacity 140ms ease, transform 140ms cubic-bezier(0.23,1,0.32,1)',
        pointerEvents:'none',
      }}/>
      {!reduced && isPlaying && playPulse > 0 && (
        <motion.span key={playPulse}
          initial={{ scale:0.82, opacity:0.5 }}
          animate={{ scale:1.45, opacity:0 }}
          transition={{ duration:0.62, ease:'easeOut' }}
          style={{
            position:'absolute', inset:0, borderRadius:'50%',
            border:'1.5px solid rgba(255,255,255,0.55)', pointerEvents:'none',
          }}/>
      )}
      <div style={{position:'relative', width:ICO, height:ICO}}>
        <img src="../assets/play.png"  style={ico(!isPlaying)}/>
        <img src="../assets/pause.png" style={ico( isPlaying)}/>
      </div>
      </span>
    </motion.button>
  );
}

/* ── NavIcon ─────────────────────────────────────────────────────────────── */
function NavIcon({ icon, label, active, onClick, size=38, noActiveBg=false }) {
  return (
    <button onClick={onClick} title={label}
      style={{
        width:size, height:size, borderRadius:11, border:'none',
        background: (active && !noActiveBg) ? 'rgba(178,178,178,0.11)' : 'none',
        display:'flex', alignItems:'center', justifyContent:'center',
        cursor:'pointer', flexShrink:0,
        opacity: active ? 1 : 0.5,
        transition:'opacity 0.18s ease, background 0.18s ease',
      }}>
      {icon}
    </button>
  );
}

/* Кнопка/плашка «случайно». две формы одного:
     icon — квадратная, в ряд чипов (плейлист) и рядом с поиском в плеере
     pill — широкая, с подписью: главный экран и шапка плеера
   иконка assets/shuffle.png — та же, что в кнопках плеера, только ей
   нельзя красить currentColor, поэтому фильтр brightness(0) invert(1) +
   opacity, как у heart0/note.png. активное состояние — живой акцент. */
function ShuffleBtn({ on, onClick, variant='icon', label, disabled, h=26, field=false, style }) {
  const t = useLang();
  const body = (
    <img src="../assets/shuffle.png" style={{
      width: variant === 'pill' ? 13 : (field ? 13 : 12), height: variant === 'pill' ? 13 : (field ? 13 : 12),
      filter:'brightness(0) invert(1)', display:'block',
      opacity: disabled ? 0.25 : on ? 0.8 : (field ? 0.4 : 0.5),
      transition:'opacity 0.18s ease',
    }}/>
  );
  /* вкл/выкл — ТОЛЬКО заливкой и яркостью иконки. рамка выглядела
     чужеродно: в приложении ни одно поле не обведено, состояние везде
     обозначают фоном. актив заливкой accent читается и без обводки.
     заливка намеренно слабая (.10): на .20 живой акцент от обложки светил,
     и кнопка выглядела включённой лампой и била по глазам */
  const onBg = disabled ? 'transparent' : 'rgba(var(--accent-rgb), 0.10)';
  if (variant === 'icon') {
    /* field=true — рядом с поиском в плеере: та же высота, радиус и фон поля,
       иначе кнопка выглядит мелкой заплатой на одной линии с инпутом */
    const r = Math.round(h * 0.32);
    const idleBg = field ? 'rgba(255,255,255,0.04)' : 'transparent';
    const hovBg  = field ? 'rgba(255,255,255,0.065)' : 'rgba(255,255,255,0.07)';
    return (
      <div title={label || t('shuffle_all')} onClick={disabled ? undefined : onClick}
        style={{
          width:h, height:h, borderRadius:r, flexShrink:0,
          display:'flex', alignItems:'center', justifyContent:'center',
          cursor: disabled ? 'default' : 'pointer',
          background: on ? onBg : idleBg,
          transition:'background 0.18s',
          ...style,
        }}
        onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = on ? onBg : hovBg; }}
        onMouseLeave={e => { e.currentTarget.style.background = on ? onBg : idleBg; }}>
        {body}
      </div>
    );
  }
  return (
    <div title={label || t('shuffle_all')} onClick={disabled ? undefined : onClick}
      style={{
        display:'flex', alignItems:'center', gap:8, flexShrink:0,
        height:h, padding:'0 16px', borderRadius:Math.round(h * 0.32),
        cursor: disabled ? 'default' : 'pointer', userSelect:'none',
        background: on ? onBg : 'rgba(255,255,255,0.05)',
        transition:'background 0.2s ease',
        ...style,
      }}
      onMouseEnter={e => {
        if (disabled) return;
        e.currentTarget.style.background = on ? onBg : 'rgba(255,255,255,0.085)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = on ? onBg : 'rgba(255,255,255,0.05)';
      }}>
      {body}
      <span style={{
        fontSize:'var(--fs-xs)', fontWeight:500, letterSpacing:'0.03em', whiteSpace:'nowrap',
        color: disabled ? 'rgba(255,255,255,0.18)' : on ? 'var(--accent)' : 'rgba(255,255,255,0.42)',
        transition:'color 0.2s ease',
      }}>{t('shuffle_all')}</span>
    </div>
  );
}

/* ── TrackRow ────────────────────────────────────────────────────────────── */
const TrackRow = React.memo(function TrackRow({ track, isActive, isLoading, isError, onClick, onContextMenu }) {
  const t = useLang();
  /* спиннер показываем только если загрузка длится >300мс — иначе мелькает */
  const [showSpinner, setShowSpinner] = useState(false);
  useEffect(() => {
    if (!isLoading) { setShowSpinner(false); return; }
    const id = setTimeout(() => setShowSpinner(true), 300);
    return () => clearTimeout(id);
  }, [isLoading]);
  const handleClick = useCallback(() => onClick(track), [onClick, track]);
  const handleContextMenu = useCallback((e) => {
    if (!onContextMenu) return;
    e.preventDefault();
    onContextMenu(track, e.clientX, e.clientY);
  }, [onContextMenu, track]);
  return (
    <div className={isActive ? 'track-row active' : 'track-row'} onClick={handleClick} onContextMenu={handleContextMenu}
      style={{
        display:'flex', alignItems:'center', gap:10, padding:'8px 10px', borderRadius:9,
        cursor:'pointer', position:'relative', zIndex:1,
        height: 50, overflow:'hidden',
      }}>
      <div style={{
        width:34, height:34, borderRadius:7, flexShrink:0,
        background:'#111116',
        display:'flex', alignItems:'center', justifyContent:'center',
        overflow:'hidden', position:'relative',
      }}>
        {track.coverUrl
          ? <img src={track.coverUrl} loading="lazy" decoding="async" style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover',clipPath:'inset(0 round 7px)',display:'block'}}
              onError={e=>{e.currentTarget.style.display='none'}}/>
          : <img src="../assets/note.png" style={{width:11,height:11,filter:'brightness(0) invert(1)',opacity:isActive?0.9:0.2}}/>
        }
        <CoverTint/>
      </div>
      <div style={{flex:1, overflow:'hidden'}}>
        <div style={{fontSize: 'var(--fs-sm)', fontWeight: isActive ? 700 : 500,
          color: isActive ? 'var(--accent)' : 'rgba(255,255,255,0.78)',
          whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{track.title}</div>
        <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.26)', marginTop:1}}>{formatArtistDisplay(track.artist)}</div>
      </div>
      <div style={{display:'flex', alignItems:'center', gap:7, flexShrink:0}}>
        <div style={{
          width:14, height:14, flexShrink:0,
          opacity: showSpinner ? 1 : 0,
          transition:'opacity 0.22s ease',
          borderRadius:'50%',
          border:'2px solid rgba(255,255,255,0.08)',
          borderTopColor:'rgba(255,255,255,0.45)',
          animation: showSpinner ? 'spin 0.75s linear infinite' : 'none',
        }}/>
        {isError
          ? <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,80,80,0.7)', transition:'opacity 0.3s ease'}}>{t('unavailable')}</div>
          : <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.16)'}}>{fmt(track.duration)}</div>
        }
      </div>
    </div>
  );
});

/* ── TrackList ───────────────────────────────────────────────────────────── */
/* ── TrackContextMenu ────────────────────────────────────────────────────── */
/* меню ПКМ по треку: копировать ссылку / станция / добавить в плейлист.
   вход — spring + каскад пунктов (лёгкий mac-стиль), «добавить» раскрывает
   сабменю-пикер со своими плейлистами, где чекбокс = трек внутри плейлиста
   (клик снимает/кладёт, повторно добавить нельзя) */
function TrackContextMenu({ menu, onClose, onCopyLink, onStartStation, canAddPl, onDownload,
  playlists, playlistsLoading, onEnsurePlaylists, plMembers, onEnsureMembers,
  onToggleInPlaylist, onCreateWithTrack }) {
  const SUB_W = 262; /* ширины хватает чекбоксу + обложке + названию + счётчику */

  const ref = useRef(null);
  const subRef = useRef(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  const [plOpen, setPlOpen]   = useState(false);
  const [subPos, setSubPos]   = useState(null); /* {x, y, dir} — dir: 1 справа / -1 слева */
  const [busyId, setBusyId]   = useState(null); /* id плейлиста | 'new' */
  const [doneNew, setDoneNew] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const PAD = 8;
    let x = menu.x;
    let y = menu.y;
    if (x + w > window.innerWidth - PAD)  x = window.innerWidth  - w - PAD;
    if (y + h > window.innerHeight - PAD) y = window.innerHeight - h - PAD;
    if (x < PAD) x = PAD;
    if (y < PAD) y = PAD;
    setPos({ x, y });
    setPlOpen(false); setSubPos(null); setBusyId(null); setDoneNew(false);
  }, [menu.x, menu.y]);

  /* позиция сабменю: у правого края меню, при нехватке места — слева.
     сабменю — сосед меню в портале (не потомок): backdrop-filter меню иначе
     сделал бы его containing block для position:fixed */
  const placeSub = useCallback(() => {
    const mEl = ref.current, sEl = subRef.current;
    if (!mEl || !sEl) return;
    const m = mEl.getBoundingClientRect();
    const sH = sEl.offsetHeight; /* без transform — сабменю входит со scale */
    const PAD = 8;
    let dir = 1, x = m.right + 8;
    if (x + SUB_W > window.innerWidth - PAD) { dir = -1; x = m.left - SUB_W - 8; }
    if (x < PAD) { dir = 1; x = Math.min(m.right + 8, window.innerWidth - SUB_W - PAD); }
    let y = Math.min(m.top, window.innerHeight - sH - PAD);
    if (y < PAD) y = PAD;
    setSubPos(prev => (prev && prev.x === x && prev.y === y && prev.dir === dir) ? prev : { x, y, dir });
  }, []);

  useLayoutEffect(() => { if (plOpen) placeSub(); }, [plOpen, playlists, playlistsLoading, placeSub]);

  /* ресайз окна — пересчитать, пока сабменю открыто */
  useEffect(() => {
    if (!plOpen) return;
    window.addEventListener('resize', placeSub);
    return () => window.removeEventListener('resize', placeSub);
  }, [plOpen, placeSub]);

  /* пикер открыт → тянем список плейлистов и состав каждого (для чекбоксов).
     оба запроса ленивые и кешируются в App, повторно не летят */
  useEffect(() => {
    if (!plOpen) return;
    onEnsurePlaylists?.();
    onEnsureMembers?.(playlists);
  }, [plOpen, playlists]);

  useEffect(() => {
    /* сабменю — сосед меню в портале, клик/скролл внутри него тоже «свои» */
    const inside = e => {
      if (ref.current && ref.current.contains(e.target)) return true;
      if (subRef.current && subRef.current.contains(e.target)) return true;
      return false;
    };
    const onDown = (e) => {
      if (inside(e)) return;
      onClose();
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (plOpen) { setPlOpen(false); setSubPos(null); } else onClose();
    };
    const onScroll = (e) => {
      /* скролл внутри самого пикера плейлистов не закрывает меню */
      if (inside(e)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onScroll, { passive: true });
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', onScroll);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose, plOpen]);

  const t = useLang();
  const canCopy = !!menu.track.permalinkUrl;
  /* качать можно любой SC-трек со звуком: progressive даёт mp3, hls
     собирается из сегментов в m4a. локальный файл уже на диске — его не качаем.
     раньше здесь стояло только streamUrl, а у большинства треков SC отдаёт
     один hls — и пункт «Скачать» не показывался вообще */
  const canDownload = !!(menu.track.streamUrl || menu.track.hlsUrl);
  const own = (playlists || []).filter(p => p.isOwn);

  /* tri-state чекбокса: 'loading' — состав РЕАЛЬНО в полёте; true/false —
     известно. всё остальное (нет записи, запрос упал) = false: раньше такие
     случаи тоже отдавали 'loading' и строка залипала со спиннером навсегда,
     а клик по loading был заблокирован — добавление становилось невозможно */
  const inState = pl => {
    const e = plMembers?.[pl.id];
    if (!e) return false;
    if (e.pending) return 'loading';
    if (e.ids instanceof Set) return e.ids.has(menu.track.id);
    return false;
  };

  const toggleTrack = async pl => {
    if (busyId) return;
    /* 'loading' НЕ блокирует клик: handleAddToPlaylist и так делает свежий GET
       и вернёт 'exists' без PUT, так что дубль невозможен даже по незнанию */
    const isIn = inState(pl) === true;
    setBusyId(pl.id);
    await onToggleInPlaylist?.(menu.track, pl, isIn);
    setBusyId(null);
    /* меню НЕ закрываем: чекбокс снимается/ставится, можно править сразу
       несколько плейлистов подряд — это и есть смысл чекбоксов */
  };
  const createWith = async () => {
    if (busyId || doneNew) return;
    setBusyId('new');
    const r = await onCreateWithTrack?.(menu.track);
    setBusyId(null);
    if (r === 'created' || r === true) {
      setDoneNew(true);
      setTimeout(onClose, 640);
    }
  };

  return createPortal(
    <>
    <motion.div ref={ref} data-motion-spatial=""
      /* вход и каскад пунктов — на ОДНОМ элементе, на корне, и варианты
         вынесены в MENU_VARIANTS (модуль): инлайновый объект пересоздавался
         каждый рендер и пункты переанимировались на любое обновление state.
         раньше вход был размазан ещё и по двум элементам: у корня
         opacity: pos.ready?1:0 в style (обычный CSS, не Motion — переключался
         мгновенно), а scale/y жили на вложенном контейнере, который ещё и
         масштабировался от центра, а не от курсора */
      variants={MENU_VARIANTS}
      initial="hidden" animate="show"
      /* exit только на корне: у вложенного он заставлял AnimatePresence ждать
         его пружину и держать панель на экране после закрытия ~0.4с */
      exit={{ opacity: 0, scale: 0.96, y: -2, transition: { duration: 0.14, ease: [0.22, 1, 0.36, 1] } }}
      style={{
        position:'fixed', left: pos.x, top: pos.y,
        transformOrigin: 'top left',
        minWidth: 208,
        background:'var(--pop-bg)',
        /* backdrop-filter убран: при альфе 0.97 блюр визуально ничего не даёт
           (просвечивает 3%), но создаёт backdrop-root — из-за него Chromium
           пересчитывает блюр у всех элементов в нём, когда рядом появляется
           анимированный контент. Он же раньше ломал position:fixed потомков.
           Возврат блюра = шаг назад: 465мс висения панели и наезд сабменю. */
        border:'1px solid rgba(255,255,255,0.055)',
        borderRadius:11, padding:4,
        boxShadow:'0 16px 44px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.32)',
        zIndex: 9998,
      }}>
      <div style={{ display:'flex', flexDirection:'column' }}>
      {/* «Скачать» ВМЕСТО «Скопировать ссылку» — по решению пользователя.
          canDownload=false, когда качать нечем: локальный файл или трек,
          у которого SC отдал только hls. тогда остаётся ссылка, а не
          заведомо мёртвый пункт. */}
      {canDownload ? (
        <Item label={t('dl_save')} onClose={onClose}
          onClick={() => onDownload?.(menu.track)}
          icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          }/>
      ) : (
        <Item label={t('copy_link')} disabled={!canCopy} onClose={onClose}
          onClick={() => onCopyLink(menu.track)}
          icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
          }/>
      )}
      <Item label={t('start_station')} disabled={!menu.track.id || !onStartStation} onClose={onClose}
        onClick={() => onStartStation(menu.track)}
        icon={
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="2"/>
            <path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M20.49 4a10 10 0 0 1 0 16M3.51 20a10 10 0 0 1 0-16"/>
          </svg>
        }/>
      {canAddPl && (
        <motion.div variants={itemVars} data-motion-spatial=""
          onClick={() => setPlOpen(v => !v)}
          style={itemStyle} {...itemHover}>
          <span style={{display:'flex', alignItems:'center', justifyContent:'center', width:14, opacity:0.7}}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18V5l12-2v13"/>
              <circle cx="6" cy="18.5" r="3"/><circle cx="18" cy="16.5" r="3"/>
            </svg>
          </span>
          <span>{t('add_to_pl')}</span>
          <motion.span data-motion-rotation={plOpen ? 'open' : 'closed'} animate={{ rotate: plOpen ? 90 : 0 }} transition={{ duration: reducedMotionNow() ? 0 : 0.18, ease:'easeOut' }}
            style={{marginLeft:'auto', display:'flex', color:'rgba(255,255,255,0.3)'}}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </motion.span>
        </motion.div>
      )}
      </div>
    </motion.div>

      {/* сабменю: пикер своих плейлистов. сосед меню в том же портале — не
          потомок (backdrop-filter меню иначе сделал бы containing block для
          position:fixed) и не наследует его variants (иначе каскад пунктов
          перезапускается и соседние строки мигают).
          backdrop-filter здесь убран намеренно: при 0.97 альфы блюр не виден,
          но он заставляет Chromium пересчитывать блюр у МЕНЮ, а под ним
          анимированный ambient glow плеера — отсюда рябь на панели.
          Вход — короткий сдвиг без scale: scale с origin у края наезжал на
          меню на 2px и тоже дёргал его край. */}
      <AnimatePresence>
        {plOpen && (
          <motion.div key="plPicker" ref={subRef}
            initial={{ opacity: 0, x: subPos ? (subPos.dir > 0 ? -6 : 6) : -6 }}
            animate={{ opacity: subPos ? 1 : 0, x: 0 }}
            data-motion-spatial=""
            exit={{ opacity: 0, x: subPos ? (subPos.dir > 0 ? -4 : 4) : -4, transition: { duration: 0.12, ease: [0.22, 1, 0.36, 1] } }}
            transition={{ type:'spring', stiffness: 560, damping: 36, mass: 0.5 }}
            style={{
              position:'fixed', left: subPos?.x ?? -9999, top: subPos?.y ?? -9999,
              width: SUB_W,
              background:'var(--pop-bg)',
              border:'1px solid rgba(255,255,255,0.055)',
              borderRadius:11, padding:4,
              boxShadow:'0 16px 44px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.32)',
              zIndex: 9998,
            }}>
            <div style={{padding:'5px 9px 6px', fontSize: 'var(--fs-eyebrow)', letterSpacing:'0.13em',
              textTransform:'uppercase', color:'rgba(255,255,255,0.34)', fontWeight:600,
              overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
              {t('add_to_pl')}
            </div>
            {/* создать новый с этим треком */}
            <div onClick={doneNew ? undefined : createWith}
              style={{...itemStyle, padding:'7px 9px', color:'rgba(255,255,255,0.72)',
                cursor: (busyId || doneNew) ? 'default' : 'pointer'}} {...((busyId || doneNew) ? {} : itemHover)}>
              <span style={{display:'flex', alignItems:'center', justifyContent:'center', width:14}}>
                {busyId === 'new'
                  ? <div style={{width:11, height:11, border:'1.5px solid rgba(255,255,255,0.2)', borderTopColor:'rgba(255,255,255,0.65)', borderRadius:'50%', animation:'spin 0.75s linear infinite'}}/>
                  : doneNew
                    ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>}
              </span>
              <span>{t('add_pl_new')}</span>
            </div>
            <div style={{height:1, background:'rgba(255,255,255,0.055)', margin:'3px 6px 4px'}}/>
            {/* список / скелетоны / ошибка */}
            {playlistsLoading && !playlists ? (
              <div style={{padding:'2px 5px 6px'}}>
                {[0,1,2].map(i => (
                  <div key={i} className="skel" style={{height:30, borderRadius:8, marginBottom:5, ['--skel-delay']: `${i * 0.12}s`}}/>
                ))}
              </div>
            ) : playlists === null ? (
              <div style={{padding:'8px 9px 10px', fontSize: 'var(--fs-xs)', color:'rgba(255,80,60,0.75)', display:'flex', alignItems:'center', justifyContent:'space-between', gap:8}}>
                {t('pl_list_err')}
                <div onClick={() => onEnsurePlaylists?.(true)} style={{
                  fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.55)', cursor:'pointer', padding:'2px 9px',
                  borderRadius:999, border:'1px solid rgba(255,255,255,0.08)', userSelect:'none'}}>
                  ⟳ {t('retry')}
                </div>
              </div>
            ) : own.length === 0 ? null : (
              <div className="scroll-thin" style={{maxHeight:246, overflowY:'auto', padding:'1px 1px 3px'}}>
                {own.map(pl => {
                  const on = inState(pl) === true;
                  const busy = busyId === pl.id;
                  const dis = !!busyId;   /* loading не блокирует — см. toggleTrack */
                  return (
                    <div key={pl.id} onClick={dis ? undefined : () => toggleTrack(pl)}
                      title={on ? t('pl_in') : t('pl_out')}
                      style={{...itemStyle, padding:'6px 8px', gap:8,
                        background: on ? 'rgba(var(--accent-rgb),0.08)' : 'transparent',
                        cursor: dis ? 'default' : 'pointer'}}
                      {...(dis ? {} : itemHover)}>
                      <PlCheck state={inState(pl)} busy={busy}/>
                      <div style={{width:26, height:26, borderRadius:6, flexShrink:0, background:'#111116', overflow:'hidden', position:'relative'}}>
                        {pl.coverUrl
                          ? <img src={pl.coverUrl} loading="lazy" style={{position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', clipPath:'inset(0 round 6px)'}}/>
                          : <img src="../assets/note.png" style={{width:9, height:9, filter:'brightness(0) invert(1)', opacity:0.2, position:'absolute', inset:0, margin:'auto'}}/>}
                        <CoverTint/>
                      </div>
                      <div style={{flex:1, minWidth:0, fontSize: 'var(--fs-sm)', fontWeight:500,
                        color: on ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.82)',
                        overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                        {pl.title}
                      </div>
                      <span style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.28)', fontVariantNumeric:'tabular-nums', flexShrink:0}}>
                        {pl.trackCount ?? '—'}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>,
    document.body
  );
}

/* коды из main → человекочитаемый текст. раньше всё, кроме no_progressive,
   сворачивалось в общий dl_err — и «пришёл json вместо звука» выглядело так же,
   как «сеть отвалилась». различать обязательно: это разные диагнозы */
const DL_ERR = {
  no_dir:        'dl_no_dir',
  no_progressive:'dl_no_stream',
  not_audio_json:'dl_not_audio',
  not_audio_m3u8:'dl_not_audio',
  not_audio_html:'dl_not_audio',
  not_audio:     'dl_not_audio',
  too_small:     'dl_not_audio',
};
/* всё, чего здесь нет (HTTP 403, 'too many redirects', 'rename: …'), уходит в
   общий dl_err — отдельные коды для них заводить незачем */

/* ─── DownloadDialog ───────────────────────────────────────────────────────
   Кастомный диалог сохранения вместо нативного: в приложении вся отрисовка
   своя, и системный окошко выбивается. нативный появляется ровно один раз —
   для выбора папки (обойти ФС из рендерера нельзя).
   Показывает разобранные метаданные ДО сохранения, имя файла редактируется. */
function DownloadDialog({ track, scAuth, dir, onPickDir, onClose, onSaved }) {
  const t = useLang();
  const [name, setName] = useState('');
  /* автор и название правятся прямо здесь и уходят и в теги, и в имя файла.
     Это не превью отдельно от полей: то, что видно рядом с обложкой, и есть
     поля — иначе в диалоге было бы по два одинаковых значения. */
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  /* имя файла правили руками — перестаём тянуть его за автором/названием */
  const [nameTouched, setNameTouched] = useState(false);
  /* hls-трек приходит как aac: в mp3 его перекодирует ffmpeg. есть он или нет,
     знает только main — спрашиваем один раз, чтобы имя файла не обещало mp3,
     которого не будет */
  const [mp3, setMp3] = useState(true);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState(null);   /* { got, total } */
  const [err, setErr] = useState(null);
  /* причина от main: без неё «не удалось скачать» одинаково для HTTP 403,
     таймаута и битого файла, и разбираться приходится по логам */
  const [errDetail, setErrDetail] = useState(null);
  const idRef = useRef(null);

  const meta = useMemo(
    () => cleanTrackMeta(track?.title, track?.artist, track?.artistReal, track?.uploaderUsername),
    [track?.id, track?.title, track?.artist, track?.artistReal]
  );

  /* расширение решает формат источника: progressive — уже mp3. hls — это aac,
     его в mp3 перекодирует ffmpeg, а без ffmpeg честно остаётся m4a. Пока
     ответа нет, считаем, что ffmpeg есть: так поле сразу показывает mp3 */
  const ext = (track?.streamUrl || mp3) ? '.mp3' : '.m4a';

  useEffect(() => {
    let alive = true;
    window.electronAPI.scHasFfmpeg?.()
      .then(v => { if (alive) setMp3(v !== false) })
      .catch(() => {});
    return () => { alive = false };
  }, []);

  /* useLayoutEffect, а не useEffect: поля рисуются сразу с значениями трека,
     без кадра с пустыми плашками */
  useLayoutEffect(() => {
    if (!track) return;
    setTitle(meta.title);
    setArtist(meta.artist);
    setName(fileNameFor(meta.artist, meta.title) + ext);
    setNameTouched(false);
    setProg(null); setErr(null); setErrDetail(null); setBusy(false);
  }, [track?.id]);

  /* ffmpeg мог не найтись уже после открытия диалога: имя, которое ещё не
     правили руками, обязано догнать настоящее расширение. ref, а не флаг —
     чтобы не переписывать имя лишний раз на монтировании */
  const extRef = useRef(ext);
  useEffect(() => {
    if (extRef.current === ext) return;
    extRef.current = ext;
    if (!nameTouched) setName(fileNameFor(artist, title) + ext);
  }, [ext]);

  const changeTitle = v => {
    setTitle(v);
    /* пустое название не должно оставлять в имени висящий дефис */
    if (!nameTouched) setName((v.trim() ? fileNameFor(artist, v) : fileNameFor('', artist)) + ext);
  };
  const changeArtist = v => {
    setArtist(v);
    if (!nameTouched) setName((v.trim() ? fileNameFor(v, title) : fileNameFor('', title)) + ext);
  };

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onDownloadProgress || !track) return;
    /* got != null — фильтр служебных сообщений (warn/done): без него
       setProg({got: undefined}) затирал бы нормальный прогресс на 35% */
    const cb = p => { if (p.id === idRef.current && p.got != null) setProg({ got: p.got, total: p.total }) };
    const off = api.onDownloadProgress(cb);
    return () => off?.();
  }, [track?.id]);

  /* РЕЗОЛВ URL. streamUrl из mapScTrack — это api-v2 .../stream/progressive,
     который отдаёт JSON-МАНИФЕСТ, а не звук. если отдать его в main как есть,
     на диск ляжет ~1кб json с расширением .mp3 (так и было). настоящий файл
     лежит в .data.url — ровно так же, как это уже делает путь воспроизведения
     в handleScTrackClick. резолвим ЗДЕСЬ, по двум причинам: scFetch — единственный
     путь, обкатанный против DataDome, и CDN-ссылка короткоживущая (policy с TTL),
     чем свежее — тем лучше.

     hls даёт не файл, а m3u8-плейлист: main собирает из него fmp4. поэтому
     возвращаем ещё и признак — от него зависит и расширение, и путь загрузки */
  const resolveStream = async (auth) => {
    const candidates = [];
    if (track.streamUrl) candidates.push({ url: track.streamUrl, hls: false });
    if (track.hlsUrl) candidates.push({ url: track.hlsUrl, hls: true });
    for (const c of candidates) {
      const res = await window.electronAPI.scFetch(c.url, auth.token, auth.clientId);
      const url = res?.data?.url;
      if (typeof url === 'string' && url.startsWith('http')) return { url, hls: c.hls };
    }
    return null;
  };

  const start = async () => {
    /* dir — проп из прошлого рендера: после await он не обновится, поэтому
       выбор папки кладём в локальную переменную, иначе нативный диалог
       выскочил бы дважды подряд */
    let target = dir;
    if (!target) { target = await onPickDir?.(); if (!target) return }
    if (!scAuth?.token) { setErr(t('dl_no_auth')); return }
    if (!track?.streamUrl && !track?.hlsUrl) { setErr(t('dl_no_stream')); return }
    setBusy(true); setErr(null); setErrDetail(null); setProg(null);
    idRef.current = track.id;
    try {
      const resolved = await resolveStream(scAuth);
      if (!resolved) { setBusy(false); setErr(t('dl_resolve')); return }
      setProg({ got: 0, total: 0 });
      const res = await window.electronAPI.scDownloadTrack({
        id: track.id,
        /* в теги идёт то, что человек поправил в диалоге, а не исходник:
           именно ради этого поля и сделаны */
        title: title.trim(),
        artist: artist.trim(),
        comment: meta.comment,
        coverUrl: track.coverUrl,
        streamUrl: resolved.url,
        hls: resolved.hls,
        baseName: name.replace(/\.(mp3|m4a)$/i, ''),
        dir: target,
        token: scAuth.token,
      });
      setBusy(false);
      if (res?.error) { setErr(t(DL_ERR[res.error] || 'dl_err')); setErrDetail(res.error); return }
      setProg(null);
      onSaved?.(res);
    } catch (e) {
      setBusy(false);
      setErr(t('dl_err'));
      setErrDetail(String(e?.message || e));
    }
  };

  const pct = prog && prog.total ? Math.min(99, Math.round(prog.got / prog.total * 100)) : null;
  const mb = n => (n / 1048576).toFixed(1);

  return (
    <AnimatePresence>
      {track && (
        <motion.div key="dl" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          /* zIndex выше меню (9998): клик по «Скачать» закрывает меню, и его
             exit-анимация не должна прорисоваться поверх диалога */
          style={{ position: 'absolute', inset: 0, zIndex: 10000, background: 'rgba(4,4,8,0.55)',
            backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <motion.div data-motion-spatial=""
            initial={{ scale: 0.97, y: 10, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.98, y: 6, opacity: 0, transition: { duration: 0.13, ease: [0.22, 1, 0.36, 1] } }}
            transition={{ type: 'spring', stiffness: 420, damping: 32, mass: 0.7 }}
            style={{ width: 384, background: 'var(--pop-bg)',
              backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
              border: '1px solid rgba(255,255,255,0.055)', borderRadius: 14, padding: 16,
              boxShadow: '0 24px 60px rgba(0,0,0,0.5)' }}>

            {/* трек: обложка + разобранные метаданные */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
              <div style={{ width: 56, height: 56, borderRadius: 9, flexShrink: 0, overflow: 'hidden',
                background: '#111116', position: 'relative',
                boxShadow: '0 0 0 1px rgba(255,255,255,0.055)' }}>
                {track.coverUrl
                  ? <img src={track.coverUrl} style={{ position: 'absolute', inset: 0, width: '100%',
                      height: '100%', objectFit: 'cover' }}/>
                  : <img src="../assets/note.png" style={{ position: 'absolute', inset: 0, margin: 'auto',
                      width: 14, height: 14, filter: 'brightness(0) invert(1)', opacity: 0.2 }}/>}
                <CoverTint/>
              </div>
              {/* название и автор — редактируемые плашки. в теги уйдёт ровно
                  то, что здесь написано, поэтому отдельного превью нет:
                  иначе в диалоге было бы по два одинаковых значения */}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
                <input value={title} onChange={e => changeTitle(e.target.value)} disabled={busy}
                  spellCheck={false} placeholder={t('dl_title')} title={t('dl_title')}
                  onFocus={e => { e.currentTarget.style.background = 'rgba(var(--accent-rgb),0.1)' }}
                  onBlur={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.045)' }}
                  style={{
                    width: '100%', boxSizing: 'border-box', minWidth: 0,
                    background: 'rgba(255,255,255,0.045)', border: 'none', borderRadius: 8,
                    padding: '5px 9px', outline: 'none', fontFamily: 'inherit',
                    fontSize: 'var(--fs-md)', fontWeight: 600, color: 'rgba(255,255,255,0.88)',
                    transition: 'background 0.15s ease',
                  }}/>
                <input value={artist} onChange={e => changeArtist(e.target.value)} disabled={busy}
                  spellCheck={false} placeholder={t('dl_artist')} title={t('dl_artist')}
                  onFocus={e => { e.currentTarget.style.background = 'rgba(var(--accent-rgb),0.1)' }}
                  onBlur={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.045)' }}
                  style={{
                    width: '100%', boxSizing: 'border-box', minWidth: 0,
                    background: 'rgba(255,255,255,0.045)', border: 'none', borderRadius: 8,
                    padding: '4px 9px', outline: 'none', fontFamily: 'inherit',
                    fontSize: 'var(--fs-xs)', color: 'rgba(255,255,255,0.55)',
                    transition: 'background 0.15s ease',
                  }}/>
                {meta.comment && (
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'rgba(255,255,255,0.26)', marginTop: 1,
                    paddingLeft: 9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta.comment}</div>
                )}
              </div>
            </div>

            {/* папка */}
            <div style={{ fontSize: 'var(--fs-eyebrow)', letterSpacing: '0.13em', textTransform: 'uppercase',
              fontWeight: 600, color: 'rgba(255,255,255,0.26)', marginBottom: 7 }}>{t('dl_folder')}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <div style={{ flex: 1, minWidth: 0, padding: '7px 10px', borderRadius: 9,
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)',
                fontSize: 'var(--fs-xs)', color: dir ? 'rgba(255,255,255,0.62)' : 'rgba(255,80,60,0.75)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {/* хвост пути informative важнее начала, поэтому режем слева
                   тем же приёмом, что и в настройках, а не через rtl */}
                {!dir ? t('dl_no_dir') : (dir.length > 40 ? '…' + dir.slice(-40) : dir)}
              </div>
              <div onClick={() => !busy && onPickDir?.()} style={{
                padding: '0 11px', height: 30, borderRadius: 9, flexShrink: 0, cursor: busy ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', fontSize: 'var(--fs-xs)', color: 'rgba(255,255,255,0.6)',
                background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.07)',
                transition: 'background 0.15s' }}>{t('dl_change')}</div>
            </div>

            {/* имя файла */}
            <div style={{ fontSize: 'var(--fs-eyebrow)', letterSpacing: '0.13em', textTransform: 'uppercase',
              fontWeight: 600, color: 'rgba(255,255,255,0.26)', marginBottom: 7 }}>{t('dl_name')}</div>
            <div style={{ display: 'flex', alignItems: 'center', borderRadius: 9,
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)',
              paddingLeft: 10 }}>
              <input value={name} onChange={e => { setName(e.target.value); setNameTouched(true); }} disabled={busy}
                spellCheck="false"
                style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none',
                  padding: '8px 0', color: 'rgba(255,255,255,0.82)',
                  fontSize: 'var(--fs-xs)', fontFamily: 'inherit' }}/>
            </div>

            {/* прогресс. prog === null при busy = идёт фаза резолва URL,
                байты ещё не пошли — поэтому indeterminate-бар и отдельный текст */}
            {busy && (
              <div style={{ marginTop: 12 }}>
                <div style={{ height: 3, borderRadius: 999, background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: 999,
                    width: pct != null ? pct + '%' : '35%',
                    background: 'var(--accent)',
                    opacity: pct == null ? 0.5 : 1, transition: 'width 0.18s linear' }}/>
                </div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'rgba(255,255,255,0.32)', marginTop: 6,
                  fontVariantNumeric: 'tabular-nums' }}>
                  {!prog ? t('dl_resolving')
                    : pct != null ? `${pct}% · ${mb(prog.got)} / ${mb(prog.total)} МБ`
                    : `${mb(prog.got)} МБ · ${t('dl_wait')}`}
                </div>
              </div>
            )}

            {err && (
              <div style={{ marginTop: 12, fontSize: 'var(--fs-xs)', color: 'rgba(255,110,95,0.9)' }}>
                {err}
                {/* причина от main — мелким и тусклым: она для разбора, а не
                    для чтения, но без неё любой сбой выглядит одинаково */}
                {errDetail && (
                  <span style={{ color: 'rgba(255,255,255,0.26)' }}> · {errDetail}</span>
                )}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <div onClick={() => !busy && onClose()} style={{
                padding: '0 14px', height: 32, borderRadius: 9, display: 'flex', alignItems: 'center',
                cursor: busy ? 'default' : 'pointer', fontSize: 'var(--fs-sm)', color: 'rgba(255,255,255,0.4)',
                border: '1px solid rgba(255,255,255,0.075)', transition: 'color 0.15s' }}
                onMouseEnter={e => { if (!busy) e.currentTarget.style.color = 'rgba(255,255,255,0.8)' }}
                onMouseLeave={e => { if (!busy) e.currentTarget.style.color = 'rgba(255,255,255,0.4)' }}>
                {t('cancel')}
              </div>
              <div onClick={() => !busy && start()} style={{
                padding: '0 16px', height: 32, borderRadius: 9, display: 'flex', alignItems: 'center',
                cursor: busy ? 'default' : 'pointer', fontSize: 'var(--fs-sm)', fontWeight: 600,
                color: '#0a0a0c', background: 'rgba(var(--accent-rgb),0.9)', opacity: busy ? 0.6 : 1,
                transition: 'background 0.15s' }}
                onMouseEnter={e => { if (!busy) e.currentTarget.style.background = 'var(--accent)' }}
                onMouseLeave={e => { if (!busy) e.currentTarget.style.background = 'rgba(var(--accent-rgb),0.9)' }}>
                {/* подпись не меняем: прогресс-баром выше идёт обратная связь,
                   смена текста дёргала бы ширину кнопки */}
                {t('dl_save')}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function VirtualTrackList({ items, pinned, revealKey, activeId, loadingId, errorId, onClickItem, onContextMenuItem, scrollToActive, scrollTargetId }) {
  const ROW_H = 50;
  const BUFFER = 5;
  const ref = useRef(null);
  const scrollRafRef = useRef(null);
  const [range, setRange] = useState({ start: 0, end: 30 });

  const updateRange = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const scrollTop = el.scrollTop;
    const viewportH = el.clientHeight;
    const visibleStart = Math.floor(scrollTop / ROW_H);
    const visibleEnd = Math.ceil((scrollTop + viewportH) / ROW_H);
    const start = Math.max(0, visibleStart - BUFFER);
    const end = Math.min(items.length, visibleEnd + BUFFER);
    setRange(prev => (prev.start === start && prev.end === end) ? prev : { start, end });
  }, [items.length]);

  const updateRangeRef = useRef(updateRange);
  updateRangeRef.current = updateRange;

  useLayoutEffect(() => { updateRange(); }, [updateRange]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      if (scrollRafRef.current) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        updateRangeRef.current?.();
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const unbind = bindScrollInterrupt(el);   /* колесо прерывает автоскролл */
    const ro = new ResizeObserver(() => updateRangeRef.current?.());
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      unbind();
      ro.disconnect();
      cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  /* Градиенты по краям — ОТДЕЛЬНЫМИ слоями ПОВЕРХ скроллера, а не mask'ом
     на нём. Маска на скроллируемом элементе заставляет chromium каждый кадр
     скролла перерастрировать содержимое в замаскированный слой, а
     transition по mask-image сверху запускал вторую интерполяцию градиента
     ровно в тот момент, когда список уже поехал. Здесь скроллер чистый,
     а края — обычная композиция с дешёвым transition по opacity. */
  /* Затенение по краям УБРАНО. Раньше здесь лежали два слоя
     `linear-gradient(..., var(--bg), transparent)`, заливавшие верх и низ
     списка цветом фона: список «растворялся под волоском». На своей панели
     это выглядело правильно, но на ТЕМЕ — как грязное пятно: заливка шла
     цветом --bg, то есть тем ПЛОСКИМ цветом, который стоит ПОД градиентом,
     и поверх живого фона «под обложку» она читалась серой полосой поперёк
     окна.

     Плавность не пострадала: её обеспечивало отсутствие mask на скроллере
     (комментарий выше), а не сами слои. Состояние `edges`, ради которого
     пересчитывалось на каждом кадре скролла, ушло вместе с ними. */

  useEffect(() => {
    if (!scrollToActive || !ref.current) return;
    const targetId = scrollTargetId ?? activeId;
    const idx = items.findIndex(t => t.id === targetId);
    if (idx < 0) return;
    const el = ref.current;
    smoothScroll(el, Math.max(0, idx * ROW_H - el.clientHeight / 2 + ROW_H / 2), 420);
  }, [scrollToActive]);

  const onClickStable = useCallback(t => onClickItem(t), [onClickItem]);

  const activeIdx = items.findIndex(t => t.id === activeId);
  const visibleItems = items.slice(range.start, range.end);
  const totalHeight = items.length * ROW_H;
  const offsetTop = range.start * ROW_H;

  return (
    /* обёртка ради двух слоёв градиента, скроллер внутри без маски */
    <div style={{position:'relative', flex:1, minHeight:0, display:'flex', flexDirection:'column'}}>
    {/* «сейчас играет» над списком. Трек мог прийти не из этого списка —
        из поиска, из волны, с экрана артиста, — и в лайках его нет: строка
        пропадала вместе с меню ПКМ. Теперь он висит первым и живёт ВНЕ
        скроллера: не уезжает при прокрутке, а черта под ним отделяет его
        от самого списка. Это не дубль: App присылает `pinned` только когда
        трека в полном списке действительно нет. */}
    {pinned && (
      <>
        <div style={{flexShrink:0, padding:'2px 6px 0'}}>
          {/* подсветка активной строки в списке — отдельный слой, потому что
              сам TrackRow прозрачный; здесь тот же цвет и радиус */}
          <div style={{borderRadius:9, background:'rgba(var(--accent-rgb),0.14)'}}>
            <TrackRow track={pinned} isActive
              isLoading={pinned.id === loadingId}
              isError={pinned.id === errorId}
              onClick={onClickStable}
              onContextMenu={onContextMenuItem}/>
          </div>
        </div>
        <div style={{
          flexShrink:0, height:1, margin:'6px 16px 4px',
          background:'rgba(255,255,255,0.07)',
        }}/>
      </>
    )}
    <div ref={ref} className="scroll-thin" style={{
      flex:1, minHeight:0, overflowY:'auto', padding:'2px 6px 10px', position:'relative',
      /* место под скроллбар зарезервировано всегда: иначе при поиске список
         становится короче, полоса пропадает — и все строки прыгают вправо на
         8px. `stable` держит жёлоб даже без полосы, лэйаут не едет.
         `both-edges` добавляет такой же жёлоб слева: без него контент
         прижимается к левому краю на 8px меньше, и колонка выглядит
         сдвинутой влево. с двумя жёлобами центр содержимого остаётся ровно
         по центру, независимо от того, есть полоса или нет. */
      scrollbarGutter:'stable both-edges',
    }}>
      {activeIdx >= 0 && (
        <div data-motion-position="" style={{
          position:'absolute', pointerEvents:'none',
          top:2, left:6, right:6, height: ROW_H - 2,
          transform:`translateY(${activeIdx * ROW_H}px)`,
          borderRadius:9,
          background: 'rgba(var(--accent-rgb),0.14)',
          transition:'transform 0.42s cubic-bezier(0.45,0,0.55,1)',
          willChange:'transform',
          zIndex:0,
        }}/>
      )}
      <div key={revealKey} style={{
        position:'relative', zIndex:1, height: totalHeight,
        /* смена результатов поиска — один общий фейд на весь список, а не
           анимация на каждой строке: строки виртуализированы и монтируются
           при скролле, и анимация на них мигала бы на каждом колесе */
        animation:'setIn 0.18s ease',
      }}>
        <div style={{transform:`translateY(${offsetTop}px)`}}>
          {visibleItems.map(t => (
            <TrackRow key={t.id} track={t} isActive={t.id === activeId}
              isLoading={t.id === loadingId}
              isError={t.id === errorId}
              onClick={onClickStable}
              onContextMenu={onContextMenuItem}/>
          ))}
        </div>
      </div>
    </div>
    </div>
  );
}

/* ── SourceMark ────────────────────────────────────────────────────────────── */
/* Индикатор источника текста песни: кружок «ищем» и красная точка «упал».
   Оба меняют ширину плашки — и меняли её мгновенно: в момент, когда
   источник отвечал, чип терял 12px и подпрыгивал, а соседние чипы уезжали
   вместе с ним. Теперь ширина слота переезжает на transition, и размер
   меняется плавно.

   Ширина, а не scale: под transform текст растягивался бы — на 24px плашке
   это видно. Здесь текст остаётся резким на каждом кадре.

   Слот в разметке всегда: иначе на `busy→false` элемент просто вынимался бы
   из дерева и анимировать было бы нечего. Поэтому он абсолютный внутри
   слота, а не потоковый ребёнок flex — иначе ширина снова зависела бы от
   содержимого. */
function SourceMark({ busy, dead }) {
  /* 7px под кружок, 4px под точку, 0 когда индикатора нет */
  const w = busy ? 7 : dead ? 4 : 0;
  return (
    <span data-motion-position="" style={{
      position:'relative', flexShrink:0,
      width:w, height:7, marginRight: w ? 5 : 0,
      transition:'width 0.26s cubic-bezier(0.22,1,0.36,1), margin-right 0.26s cubic-bezier(0.22,1,0.36,1)',
    }}>
      <span data-motion-spatial="" style={{
        position:'absolute', left:0, top:'50%', width:4, height:4, marginTop:-2,
        borderRadius:'50%', background:'rgba(255,80,60,0.7)',
        opacity: dead ? 1 : 0,
        transform: dead ? 'scale(1)' : 'scale(0.3)',
        transition:'opacity 0.16s ease, transform 0.2s cubic-bezier(0.34,1.56,0.64,1)',
      }}/>
      {/* кружок: scale живёт на обёртке, потому что transform самого кружка
          занимает анимация spin — инлайновый scale просто не применился бы
          (тот же класс бага, что с :hover у .home-card в styles.css) */}
      <span data-motion-spatial="" style={{
        position:'absolute', left:0, top:'50%', width:7, height:7, marginTop:-3.5,
        opacity: busy ? 1 : 0,
        transform: busy ? 'scale(1)' : 'scale(0.3)',
        transition:'opacity 0.16s ease, transform 0.2s cubic-bezier(0.34,1.56,0.64,1)',
      }}>
        <span style={{
          display:'block', width:'100%', height:'100%', borderRadius:'50%',
          boxSizing:'border-box',
          border:'1px solid rgba(255,255,255,0.28)',
          borderTopColor:'rgba(255,255,255,0.7)',
          animation: busy ? 'spin 0.7s linear infinite' : 'none',
        }}/>
      </span>
    </span>
  );
}

/* ── LyricsPanel ──────────────────────────────────────────────────────────── */
/* панель текста песни: перекрывает библиотеку в колонке 260px и уезжает
   вместе с ней. всегда смонтирована — видимостью управляет `open`
   (крестфейд + сдвиг), иначе на первом открытии был бы мгновенный
   переход вместо анимации.
   `state` = { status:'loading'|'ready'|'empty', lines, synced, source }.
   `activeLine` считает App (см. rAF-эффект) — здесь только отрисовка.

   ⚠️ `onRefresh` и `onRetry` — это ОДНО И ТО ЖЕ действие (перезапуск
   поиска). Смысла в двух кнопках нет: у `onRetry` меняется только подпись
   («попробовать снова») и он виден лишь в аварийных состояниях, а
   «перечитать» нужно и на обычном тексте — например, когда песня найдена,
   но это перезалив из другого региона. Поэтому шапка получила
   ненавязчивую кнопку, работающую всегда.

   ❌ рядом была кнопка «жалоба» (писала разбор в файл) — удалена по решению
   пользователя, вместе со сборщиком отчёта и ipc записи. подробности в
   `renderer/index.md`.

   ✏️ кнопка «вернуться к трекам» на этом месте заменена карандашом: из панели
   чаще нужно не выйти, а переискать текст руками — когда в файле битые теги
   («3.mp3 (2022)») или трек известен под другим названием. карандаш открывает
   маленькую форму «артист / название», введённая пара закрепляется за треком
   (settings.lyricsQueries) и подставляется в поиск в следующий раз. сама панель
   по-прежнему закрывается Escape и кнопкой текста в управлении плеером. */
function LyricsPanel({ open, inPlayer, state, activeLine, onSeek, onRetry, onRefresh, sources,
                       query, pinned, onFindLyrics, onUnpin, onPickSource }) {
  const t = useLang();
  const bodyRef  = useRef(null);
  const lineRefs = useRef([]);
  const userScrollRef = useRef(0);
  const autoUntilRef  = useRef(0);
  const wasOpenRef    = useRef(false);
  /* форма ручного поиска (карандаш). поля живут отдельно от `query`: пока
     идёт поиск по прошлой паре, набранное в них не должно меняться под рукой */
  const [editOpen, setEditOpen] = useState(false);
  const [qArtist,  setQArtist]  = useState('');
  const [qTitle,   setQTitle]   = useState('');
  lineRefs.current = [];

  /* порядок — из массива настроек, не из реестра (см. LyricsSettings) */
  const _on = cleanLyricsSources(sources);
  const enabled = _on.map(id => LYRICS_SOURCES.find(s => s.id === id)).filter(Boolean);
  const lines   = state?.status === 'ready' ? state.lines : null;
  /* `state.synced` панели всё-таки нужен: подпись «без таймкодов» убрана, но
     по нему решается, каким серым рисовать текст. У синхронного рядом с
     активной строкой есть светлые соседи, поэтому сам «фон» можно утопить;
     у обычного подсветки нет вовсе, и ровный серый должен читаться сам —
     он чуть светлее. */
  const synced  = state?.status === 'ready' && !!state.synced;
  /* Тексты, между которыми можно переключаться: источники, которые реально
     дали строки. Обычно один, но иногда оба — тогда плашки в шапке становятся
     переключателем. Set, потому что проверка идёт у каждого чипа на каждом
     рендере панели. */
  const altIds = new Set((state?.status === 'ready' ? state.alts || [] : [])
    .map(a => a.source).filter(Boolean));

  /* Ключ списка строк — он же триггер волны появления. Список пересоздаётся
     (и значит заново играет css-анимацию lyricLineIn), когда меняется сам текст
     или панель открывают заново.

     Почему не флаг «показано» + transition, как было: у волны задержка по
     строкам до полусекунды, и гашение применилось бы только на следующем
     кадре — дальние строки не успевали даже начать гаснуть, и «вторая волна»
     выглядела бы как полное отсутствие анимации. Пересоздание узлов решает это
     без гонки: свежий узел всегда играет свою анимацию с нуля.

     Считается во время рендера, а не в эффекте: эффект отрабатывает уже после
     кадра, и новый текст успевал бы мелькнуть без анимации. Сравниваем ССЫЛКУ
     на массив строк — App отдаёт новый массив только когда текст правда другой
     (поздний ответ второго источника alts меняет, а lines — нет). */
  const waveRef  = useRef(0);
  const waveSeen = useRef({ lines: null, open: false });
  if (open && (!waveSeen.current.open || lines !== waveSeen.current.lines)) waveRef.current++;
  waveSeen.current = { lines, open };
  const waveKey = waveRef.current;

  /* панель закрыли — форма ручного поиска уезжает вместе с ней, чтобы при
     следующем открытии не всплывала поверх нового трека */
  useEffect(() => { if (!open) setEditOpen(false); }, [open]);

  /* Затенение по краям убрано. Раньше здесь были два слоя
     `linear-gradient(..., var(--bg), transparent)` поверх скроллера — список
     «растворялся под волоском». На своей панели это выглядело правильно, но
     на ТЕМЕ — как грязное пятно: заливка шла цветом --bg, то есть тем
     плоским цветом, который стоит ПОД градиентом, и поверх живого фона
     «под обложку» она читалась серой полосой поперёк панели.

     Плавность скролла не пострадала: её обеспечивало отсутствие mask на
     скроллере, а не сами слои. Индикацию «есть что прокрутить» теперь
     даёт полоса прокрутки. Всё, что считало края (ref, счётчик,
     ResizeObserver, две проверки в обработчике скролла), убрано вместе с
     ними — иначе оно пересчитывалось на каждом кадре скролла впустую. */

  const scrollToActive = useCallback((smooth) => {
    const el   = bodyRef.current;
    const line = lineRefs.current[activeLine];
    if (!el || !line) return;
    const top = Math.max(0, line.offsetTop - el.clientHeight / 2 + line.offsetHeight / 2);
    autoUntilRef.current = Date.now() + (smooth ? 700 : 120);
    if (smooth) smoothScroll(el, top, 480);
    else el.scrollTop = top;
  }, [activeLine]);

  /* новый текст — с начала: другой трек, повторный поиск или другой источник
     из переключателя. Иначе панель открывалась бы с середины прошлого текста,
     а у другого источника там вообще другие строки. Заодно сразу встаём на
     активную строку, если она уже известна: эффект подсветки ниже поедет
     только когда строка СМЕНИТСЯ, а это может быть через полминуты.
     `lines` — единственная зависимость намеренно: массив новый ровно тогда,
     когда текст другой (кеш делится одним и тем же объектом между открытиями,
     поэтому переоткрытие панели скролл не сбивает). */
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = 0;
    if (activeLine > 0) scrollToActive(false);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [lines]);

  /* Колесо прерывает автопрокрутку. Раньше этот эффект заодно пересчитывал
     края для затенения; после её удаления от него осталась ровно эта одна
     задача, и подписка живёт на scroll-interrupt, а не на каждый кадр. */
  useEffect(() => {
    if (!open) return;
    const el = bodyRef.current;
    if (!el) return;
    return bindScrollInterrupt(el);
  }, [open]);

  /* при открытии — сразу к активной строке. плавно прокручивать через весь
     текст от начала смысла нет, это зрелищно и долго */
  useEffect(() => {
    if (!open) { wasOpenRef.current = false; return; }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    if (activeLine >= 0) scrollToActive(false);
  }, [open, activeLine, scrollToActive]);

  /* дальше подсветка ведёт сама. 4 секунды после ручного скролла панель
     не дёргается — иначе она вырывает текст из-под читателя */
  useEffect(() => {
    if (!open || !wasOpenRef.current || activeLine < 0) return;
    if (Date.now() - userScrollRef.current < 4000) return;
    scrollToActive(true);
  }, [activeLine, open, scrollToActive]);

  const onBodyScroll = useCallback(() => {
    if (Date.now() < autoUntilRef.current) return;  /* это наша автопрокрутка */
    userScrollRef.current = Date.now();
  }, []);

  /* Один стиль на чип источника и на кнопки в шапке — по просьбе выключалка
     должна быть того же размера, что и чипы. Раньше шапка была большой
     плашкой «ТЕКСТ ПЕСНИ» с иконкой 26px, а источники жили отдельной полосой
     внизу; теперь плашки нет, а чипы стоят на её месте. */
  const CHIP = {
    display:'flex', alignItems:'center', gap:5,
    fontSize:'var(--fs-xs)', lineHeight:1,
    padding:'5px 8px', borderRadius:7, height:24,
    background:'rgba(255,255,255,0.035)',
    border:'1px solid rgba(255,255,255,0.03)',
    color:'rgba(255,255,255,0.22)',
    boxSizing:'border-box',
    /* Ответ источника меняет не только размер, но и цвет плашки (нашли
       текст — она заливается акцентом), и цвет переключался мгновенно:
       плашка не просто прыгала, а ещё и вспыхивала. Кнопки обновления и
       карандаша переопределяют transition ниже по стилю, так что здесь
       анимируется только чип источника. */
    transition:'color 0.25s ease, background-color 0.25s ease, border-color 0.25s ease',
  };

  /* поля формы карандаша. без рамок-разделителей, как и всё остальное:
     границу даёт сама подложка карточки */
  const FIELD = {
    width:'100%', boxSizing:'border-box',
    background:'rgba(255,255,255,0.05)',
    border:'1px solid rgba(255,255,255,0.06)',
    borderRadius:8, padding:'7px 9px', outline:'none',
    fontSize:'var(--fs-sm)', fontFamily:'inherit',
    color:'rgba(255,255,255,0.86)',
  };

  const openEditor = () => {
    if (!editOpen) {
      /* предзаполняем тем, чем ищем ПРЯМО СЕЙЧАС: закреплённая пара, иначе
         метаданные трека. обычно правят одно поле, а не пишут оба с нуля */
      setQArtist(query?.artist || '');
      setQTitle(query?.title || '');
    }
    setEditOpen(v => !v);
  };

  const submitEditor = () => {
    if (!qTitle.trim()) return;          /* без названия искать нечего */
    onFindLyrics?.(qArtist, qTitle);
    setEditOpen(false);
  };

  /* Escape закрывает ТОЛЬКО форму: панель под ней уезжать не должна.
     stopPropagation обязателен — App слушает Escape на window и иначе
     закроет панель целиком вместе с формой */
  const onEditorKey = e => {
    if (e.key === 'Escape') { e.stopPropagation(); setEditOpen(false); }
    if (e.key === 'Enter')  { e.stopPropagation(); submitEditor(); }
  };

  return (
    <div data-motion-spatial="" style={{
      position:'absolute', inset:0, display:'flex', flexDirection:'column',
      opacity: open ? 1 : 0,
      /* inPlayer — тот же трюк, что у слоя списка: `pointer-events:none` на
         скрытом слое плеера не гасит потомка, который сам ставит auto. Панель
         закрыта, но на главной всё равно оставалась целью для кликов в
         левом краю. */
      pointerEvents: inPlayer && open ? 'auto' : 'none',
      /* и всё равно visibility: закрытая панель невидима, но её кнопки внутри
         ставят pointerEvents:auto и продолжали ловить клики по списку рядом */
      visibility: inPlayer && open ? 'visible' : 'hidden',
      transform: open ? 'translateX(0)' : 'translateX(14px)',
      transition: open
        ? 'opacity 0.3s ease 0.08s, transform 0.44s cubic-bezier(0.22,1,0.36,1) 0.08s'
        : 'opacity 0.16s ease, transform 0.16s ease',
    }}>
      {/* верхняя полоса: чипы источников + выключалка того же размера.
          большой плашки «ТЕКСТ ПЕСНИ» с иконкой больше нет — по просьбе
          на её место переехали сами источники */}
      <div style={{
        display:'flex', alignItems:'center', gap:4,
        margin:'10px 12px 0', flexShrink:0, minHeight:24,
      }}>
        {enabled.map(s => {
          const used  = state?.status === 'ready' && state.source === s.id;
          const entry = state?.tried?.find(x => x.id === s.id);
          const dead  = entry?.result === 'error';
          const busy  = state?.status === 'loading' && !entry;
          /* Источник ответил «у меня этого трека нет» — плашка уходит
             совсем: в шапке остаётся только то, что действительно дало
             текст. Ошибка («не ответил / упал») — другое дело: там красная
             точка и причина в title, такую плашку прятать нельзя, иначе
             пропадёт объяснение, почему текста нет. */
          const gone  = entry?.result === LYRICS_MISS;
          /* Оба источника могут найти текст: тогда плашка, которая сейчас НЕ
             показана, работает переключателем между ними. У показанной клика
             нет — она и так на экране, а вернуться можно щелчком по соседней. */
          const pick  = altIds.has(s.id) && !used;
          return (
            <span key={s.id}
              title={dead ? entry.why : pick ? t('lyrics_src_switch') : undefined}
              onClick={pick ? () => onPickSource?.(s.id) : undefined}
              onMouseEnter={pick ? e => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.075)';
                e.currentTarget.style.color = 'rgba(255,255,255,0.66)';
              } : undefined}
              onMouseLeave={pick ? e => {
                e.currentTarget.style.background = CHIP.background;
                e.currentTarget.style.color = CHIP.color;
              } : undefined}
              style={{
              ...CHIP,
              cursor: pick ? 'pointer' : 'default',
              /* gap обнулён именно у чипа: отступ до подписи теперь задаёт
                 сам слот индикатора (marginRight 5 только когда он виден).
                 При gap:5 пустой слот всё равно раздвинул бы плашку на 5px,
                 и в покое она была бы шире нужной. Кнопки рядом gap не
                 используют — у них один ребёнок. */
              gap:0,
              /* Схлопывание в ноль. Через max-width, потому что width:auto не
                 анимируется, а через display:none плашка исчезла бы рывком и
                 сдвинула соседей. marginRight гасит gap контейнера, иначе на
                 месте ушедшей плашки остаётся пустой зазор в 4px. */
              maxWidth: gone ? 0 : 160,
              marginRight: gone ? -4 : 0,
              paddingLeft: gone ? 0 : 8,
              paddingRight: gone ? 0 : 8,
              opacity: gone ? 0 : 1,
              overflow: 'hidden', whiteSpace: 'nowrap',
              pointerEvents: gone ? 'none' : 'auto',
              color: used ? 'rgba(255,255,255,0.6)' : CHIP.color,
              background: used ? 'rgba(var(--accent-rgb),0.1)' : CHIP.background,
              border: used ? '1px solid rgba(var(--accent-rgb),0.28)' : CHIP.border,
              /* рамка в ноль не сжимается: у border-box при max-width:0 ширина
                 содержимого становится нулевой, а кайма остаётся 2px и висит
                 вертикальной чёрточкой. поэтому гасим её цвет, а не ширину —
                 цвет как раз анимируется и уходит вместе с плашкой. */
              borderColor: gone ? 'transparent' : undefined,
              borderWidth: gone ? 0 : 1,
              transition:
                'opacity 0.26s ease, max-width 0.34s cubic-bezier(0.22,1,0.36,1), '
                + 'padding 0.34s cubic-bezier(0.22,1,0.36,1), margin-right 0.34s cubic-bezier(0.22,1,0.36,1), '
                + 'color 0.25s ease, background-color 0.25s ease, border-color 0.25s ease',
            }}>
              <SourceMark busy={busy} dead={dead}/>
              {s.label}
            </span>
          );
        })}
        <div style={{flex:1, minWidth:4}}/>
        {/* Обновление: иконка-стрелка по кругу, тот же приём, что у retry.
            Кнопка работает в любом состоянии, а не только при ошибке —
            на обычном «нашлось не то» перечитать нужно не меньше. */}
        <div onClick={onRefresh} title={t('lyrics_refresh')} style={{
          ...CHIP, flexShrink:0, cursor:'pointer',
          justifyContent:'center', color:'rgba(255,255,255,0.3)',
          transition:'background 0.15s, color 0.15s',
        }}
          onMouseEnter={e => { e.currentTarget.style.background='rgba(255,255,255,0.08)'; e.currentTarget.style.color='rgba(255,255,255,0.75)'; }}
          onMouseLeave={e => { e.currentTarget.style.background=CHIP.background; e.currentTarget.style.color='rgba(255,255,255,0.3)'; }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/>
            <path d="M20.8 4.2v4.6h-4.6"/>
          </svg>
        </div>
        {/* Карандаш: ручной поиск. Стоит там, где раньше была кнопка
            «вернуться к трекам» — из панели чаще нужно переискать текст,
            чем выйти из неё (выход остался на Escape и на кнопке textt). */}
        <div onClick={openEditor} title={t('lyrics_edit')} style={{
          ...CHIP, flexShrink:0, cursor:'pointer',
          justifyContent:'center',
          color: editOpen ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.3)',
          background: editOpen ? 'rgba(255,255,255,0.08)' : CHIP.background,
          transition:'background 0.15s, color 0.15s',
        }}
          onMouseEnter={e => { e.currentTarget.style.background='rgba(255,255,255,0.08)'; e.currentTarget.style.color='rgba(255,255,255,0.75)'; }}
          onMouseLeave={e => {
            if (editOpen) return;   /* открытую форму не гасим под курсором */
            e.currentTarget.style.background=CHIP.background; e.currentTarget.style.color='rgba(255,255,255,0.3)';
          }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 20h4L19.5 8.5a2.12 2.12 0 0 0-3-3L5 17v3z"/>
            <path d="M13.4 6.6l4 4"/>
          </svg>
        </div>
      </div>

      {/* форма ручного поиска. всплывает под шапкой, а не занимает место в
          колонке: текст под ней остаётся виден, и после «найти» список
          просто перезагружается на месте */}
      {editOpen && (
        <>
          {/* клик мимо формы закрывает её — иначе карточка висела бы поверх
              текста, пока её не закроют карандашом ещё раз */}
          <div onClick={() => setEditOpen(false)} style={{position:'absolute', inset:0, zIndex:5}}/>
          <div style={{
            position:'absolute', top:38, right:10, left:10, zIndex:6,
            display:'flex', flexDirection:'column', gap:6,
            background:'var(--pop-bg)',
            borderRadius:11, padding:'9px 9px 8px',
            boxShadow:'0 14px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05)',
            animation:'setIn 0.2s cubic-bezier(0.22,1,0.36,1)',
          }}>
            <input autoFocus value={qArtist} onChange={e => setQArtist(e.target.value)}
              onKeyDown={onEditorKey} spellCheck={false}
              placeholder={t('lyrics_edit_artist')} style={FIELD}/>
            <input value={qTitle} onChange={e => setQTitle(e.target.value)}
              onKeyDown={onEditorKey} spellCheck={false}
              placeholder={t('lyrics_edit_title')} style={FIELD}/>
            <div style={{display:'flex', alignItems:'center', gap:6, marginTop:2}}>
              <div onClick={submitEditor} style={{
                flex:1, textAlign:'center', cursor: qTitle.trim() ? 'pointer' : 'default',
                fontSize:'var(--fs-xs)', fontWeight:600, padding:'6px 0', borderRadius:7,
                color: qTitle.trim() ? 'rgba(var(--accent-rgb),0.95)' : 'rgba(255,255,255,0.22)',
                background: qTitle.trim() ? 'rgba(var(--accent-rgb),0.14)' : 'rgba(255,255,255,0.04)',
                transition:'background 0.15s, color 0.15s',
              }}>{t('lyrics_edit_find')}</div>
              {/* сброс виден только когда за треком закреплена ручная пара —
                  иначе сбрасывать нечего */}
              {pinned && (
                <div onClick={() => { onUnpin?.(); setEditOpen(false); }} title={t('lyrics_edit_unpin')}
                  style={{
                    flexShrink:0, cursor:'pointer', padding:'6px 9px', borderRadius:7,
                    fontSize:'var(--fs-xs)', color:'rgba(255,255,255,0.32)',
                    background:'rgba(255,255,255,0.04)', transition:'background 0.15s, color 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background='rgba(255,255,255,0.08)'; e.currentTarget.style.color='rgba(255,255,255,0.7)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background='rgba(255,255,255,0.04)'; e.currentTarget.style.color='rgba(255,255,255,0.32)'; }}
                >{t('lyrics_edit_unpin')}</div>
              )}
            </div>
          </div>
        </>
      )}

      {/* обёртка ради слоёв градиента по краям, скроллер внутри без маски */}
      <div style={{position:'relative', flex:1, minHeight:0, display:'flex', flexDirection:'column'}}>
      <div className="scroll-none" ref={bodyRef} onScroll={onBodyScroll}
        style={{
          flex:1, minHeight:0, overflowY:'auto',
          display:'flex', flexDirection:'column',
          padding:'0 14px 10px', marginTop:12,
        }}>
        {/* Раньше здесь была строка «без таймкодов — подсветки не будет».
            Убрана: она съедала 12px сверху текста на каждом треке без
            синхронизации, а в колонке 260px это ощутимый кусок первого
            экрана. Отсутствие подсветки теперь видно и без подписи — просто
            ни одна строка не подсвечивается. */}
        {/* Загрузка. Скелетон строк тут был плохой идеей: он изображал
            строки текста, которых ещё нет, и в узкой колонке 260px читался
            как кривые полосы. Вместо него — эквалайзер: трек-то играет, и
            motion честный («идёт работа»), и не выдаёт несуществующий текст.
            Та же анимация .st-eq, что в чипе станции. */}
        {state?.status === 'loading' && (
          <div style={{
            flex:1, display:'flex', flexDirection:'column',
            alignItems:'center', justifyContent:'center', gap:16, padding:'0 20px 60px',
          }}>
            <div className="st-eq" style={{display:'flex', alignItems:'flex-end', gap:4, height:26}}>
              {[0, 1, 2, 3, 4].map(i => (
                <i key={i} style={{
                  width:3, background:'var(--accent)', opacity:0.55,
                  /* инлайн перекрывает nth-child задержки из CSS — у нас 5
                     полос вместо трёх, иначе последние две шевелились в такт */
                  animationDelay: (i * 0.11) + 's',
                }}/>
              ))}
            </div>
            <div style={{
              fontSize:'var(--fs-xs)', color:'rgba(255,255,255,0.26)',
              textAlign:'center', lineHeight:1.5,
            }}>{t('lyrics_loading')}</div>
          </div>
        )}

        {/* подписи вида [Куплет] / [Chorus] / [Bridge] НЕ рисуем — по просьбе
            текст должен идти сплошным. сами строки в данных остаются (индексы
            `lines` не сдвигаются, автоскролл и подсветка считают по ним),
            пропускаем их только на отрисовке */}
        {lines && lines.map((l, i) => {
          if (l.section) return null;
          /* Подсветка. Плашки под строкой нет — она читалась как кнопка в
             списке и спорила с текстом. Вместо неё три вещи разом:

             · активная строка ВЫЕЗЖАЕТ вперёд: сдвиг вправо и масштаб 1.8%
               от левого края. это и есть «ближе» — строка будто отделяется
               от плоской стены текста;
             · акцентное свечение вокруг букв. вспышка при смене строки
               (keyframes lyricLit в styles.css) + ровное свечение после неё;
             · фокус: две ближайшие строки чуть размыты, дальние нет. глаз
               читает активную резче остальных, и список перестаёт быть
               ровной серой простынёй.

             остальное — прозрачность и цвет по расстоянию: соседние светлее
             дальних, поэтому видно не только «где я», но и «куда поедет». */
          const on = i === activeLine;
          const d  = activeLine >= 0 ? Math.abs(i - activeLine) : 99;
          return (
            <div key={waveKey + ':' + i} className="lyric-highlight" ref={el => { if (el) lineRefs.current[i] = el; }}
              onClick={() => l.t != null && onSeek(l.t)}
              title={l.t != null ? t('lyrics_tap_line') : undefined}
              style={{
                fontSize:'var(--fs-md)', lineHeight:1.5,
                /* правый отступ — запас под сдвиг и масштаб: без него
                   выехавшая строка вылезает за колонку и появляется
                   горизонтальный скролл */
                padding:'3px 12px 3px 0', boxSizing:'border-box',
                transform: on ? 'translateX(7px) scale(1.018)' : 'none',
                transformOrigin:'left center',
                color: on ? 'rgba(255,255,255,0.98)'
                     : d === 1 ? 'rgba(255,255,255,0.44)'
                     : synced ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.34)',
                fontWeight: on ? 600 : 500,
                /* конечное значение обязано совпадать с кадром `to` у
                   lyricLit, иначе в конце вспышки будет рывок */
                textShadow: on ? '0 0 26px rgba(var(--accent-rgb),0.42), 0 0 4px rgba(var(--accent-rgb),0.35)' : 'none',
                filter: on || !synced ? 'none'
                      : d === 1 ? 'blur(0.35px)'
                      : d === 2 ? 'blur(0.7px)'
                      : 'none',
                animation: on ? 'lyricLit 0.6s ease-out' : 'none',
                cursor: l.t != null ? 'pointer' : 'default',
                transition:'color 0.3s ease, filter 0.3s ease, transform 0.42s cubic-bezier(0.22,1,0.36,1), text-shadow 0.3s ease',
              }}>
              {/* Волна появления — на внутреннем span, а не на самой строке:
                  у строки свой transform (выезд и масштаб активной) и своя
                  transition, и анимация на ней же спорила бы с ними за
                  transform. Отдельный слой разводит их по разным узлам.
                  Анимация, а не transition — потому что строки пересоздаются
                  по key списка (см. waveKey): свежий узел играет её всегда, а
                  transition на уже проявленном узле не играл бы вовсе.
                  `backwards` держит строку прозрачной всю её задержку — иначе
                  нижние успевали бы мелькнуть до старта. */}
              <span className="lyric-wave" style={{
                display:'block',
                animation:'lyricLineIn 0.42s cubic-bezier(0.22,1,0.36,1) backwards',
                /* задержка растёт с номером строки, но не бесконечно: на
                   первом экране помещается строк 19, а в песне их бывает
                   под сотню. Дальше идут ровно — их всё равно не видно, и
                   волна в полминуты ради нижних строк никому не нужна */
                animationDelay: Math.min(i, 16) * 24 + 'ms',
              }}>{l.text}</span>
            </div>
          );
        })}

        {/* «не нашлось» и «источник упал» — разные вещи, и раньше они
            выглядели одинаково. error показываем явно + причину в title */}
        {(state?.status === 'empty' || state?.status === 'error') && (
          <div style={{
            display:'flex', flexDirection:'column', alignItems:'center',
            gap:11, padding:'54px 8px 0', textAlign:'center',
          }}>
            <img src="../assets/textt.png" style={{width:22, height:22, filter:'brightness(0) invert(1)', opacity:0.15, display:'block'}}/>
            <div style={{fontSize:'var(--fs-md)', fontWeight:500, color:'rgba(255,255,255,0.38)', lineHeight:1.45}}>
              {state.status === 'error' ? t('lyrics_err') : t('lyrics_notfound')}
            </div>
            <div style={{fontSize:'var(--fs-xs)', color:'rgba(255,255,255,0.2)', lineHeight:1.5}}>
              {!enabled.length ? t('lyrics_all_off')
                : state.status === 'error' ? t('lyrics_err_sub')
                : t('lyrics_notfound_sub')}
            </div>
            {state.status === 'error' && state.tried?.some(x => x.why) && (
              <div style={{
                fontSize:'var(--fs-xs)', color:'rgba(255,80,60,0.55)', lineHeight:1.45,
                maxWidth:'100%', wordBreak:'break-word',
              }}>{state.tried.filter(x => x.why).map(x => `${x.id}: ${x.why}`).join(' · ')}</div>
            )}
            <div onClick={onRetry} style={{
              marginTop:4, fontSize:'var(--fs-xs)', fontWeight:500, cursor:'pointer',
              color:'rgba(255,255,255,0.4)', background:'rgba(255,255,255,0.055)',
              borderRadius:7, padding:'5px 13px', transition:'background 0.15s, color 0.15s',
            }}
              onMouseEnter={e => { e.currentTarget.style.background='rgba(255,255,255,0.09)'; e.currentTarget.style.color='rgba(255,255,255,0.7)'; }}
              onMouseLeave={e => { e.currentTarget.style.background='rgba(255,255,255,0.055)'; e.currentTarget.style.color='rgba(255,255,255,0.4)'; }}
            >{t('lyrics_retry')}</div>
          </div>
        )}

        {/* Раньше здесь была вторая полоса чипов источников снизу. Теперь они
            в верхней строке (вместо бывшей плашки «ТЕКСТ ПЕСНИ»), здесь
            ничего — иначе один и тот же список рисовался дважды. */}
      </div>
      </div>
    </div>
  );
}

/* ── FxPanel ──────────────────────────────────────────────────────────────── */
/* панель эффектов. живёт в той же колонке 260px и тем же приёмом, что
   LyricsPanel: список уезжает влево, панель приезжает справа. сделана
   панелью на всю колонку, а не всплывашкой у кнопки, потому что настроек
   много (семь полос плюс транспорт) — попап такого размера закрывал бы сам
   плеер, а ради одного ползунка скорости уходить в «Настройки» далеко.

   полосы свои, а не нативные input[type=range]: нативному треку заливку
   принято рисовать от левого края, а эквалайзеру нужна заливка ОТ НУЛЕВОЙ
   ЛИНИИ (иначе «−6 дБ» выглядит как «ничего не поднято»), и на ширине 30px
   системный бегунок не попадается мышью. клавиатура и role=slider при этом
   сохранены руками: стрелки — шаг, Shift — крупный шаг, двойной клик — ноль. */

const fmtDb = v => (v === 0 ? '0' : `${v > 0 ? '+' : ''}${Math.round(v * 10) / 10}`);
/* подпись полосы в панели: 350 / 1k / 3.5k — длина строки важнее точных
   герц, полное «3 500 Гц» в тридцати пикселях не влезает */
const hzShort = hz => (hz >= 1000
  ? `${hz % 1000 ? (hz / 1000).toFixed(1) : hz / 1000}k`
  : String(hz));

/* Позиция непрерывна даже при дискретном шаге значения. Один критически
   затухающий spring для настроек, эквалайзера и скорости. Двигается DOM,
   а не React, поэтому анимация не пересобирает плеер каждым кадром. */
function useSmoothPosition(value, min, max, dragging) {
  const reduced = useReducedMotion();
  const target = useMotionValue(sliderFraction(value, min, max));
  const spring = useSpring(target, { stiffness: 700, damping: 38, mass: 0.45 });
  useLayoutEffect(() => {
    if (!dragging.current) target.set(sliderFraction(value, min, max));
  }, [value, min, max, target, dragging]);
  useLayoutEffect(() => { if (reduced) spring.jump(target.get()); }, [reduced, spring, target]);
  return { target, position: reduced ? target : spring };
}

/* Звук получает округлённое значение раз в кадр; ручка следует всем
   событиям указателя, не прыгая по ступенькам 0.5 дБ. */
function useRail({ value, min, max, step, vertical, onChange }) {
  const ref = useRef(null);
  const dragging = useRef(false);
  const { target, position } = useSmoothPosition(value, min, max, dragging);
  const live = useRef(onChange);
  live.current = onChange;
  const pending = useRef(null);
  const frame = useRef(0);
  const committed = useRef(value);
  if (!dragging.current && pending.current === null) committed.current = value;
  const flush = useCallback(() => {
    frame.current = 0;
    if (pending.current !== null) {
      const v = pending.current;
      pending.current = null;
      committed.current = v;
      live.current(v);
    }
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  /* от чего считать шаг стрелками: от ещё не применённого значения, иначе
     быстрые нажатия считались бы от одного и того же props.value */
  const base = () => (pending.current !== null ? pending.current : committed.current);
  /* округление через *100: шаг 0.05 — это 0.05000000000000001 в двоичной
     дроби, и без него ползунок выдаёт значения вида 1.3000000000000003,
     которые потом не сравниваются ни с пресетом, ни с дефолтом */
  const apply = v => {
    pending.current = sliderValue(sliderFraction(v, min, max), min, max, step);
    if (!frame.current) frame.current = requestAnimationFrame(flush);
  };
  const pick = e => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || !r.height || !r.width) return;
    const fraction = pointerFraction(e, r, vertical);
    target.set(fraction);
    apply(min + fraction * (max - min));
  };
  const finish = () => {
    cancelAnimationFrame(frame.current);
    const final = pending.current ?? committed.current;
    flush();
    dragging.current = false;
    target.set(sliderFraction(final, min, max));
  };
  return {
    ref, position,
    onPointerDown: e => {
      if (e.button) return;                     /* правый клик — не наше дело */
      e.currentTarget.setPointerCapture(e.pointerId);
      dragging.current = true;
      pick(e);
    },
    onPointerMove: e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) pick(e); },
    onPointerUp: e => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      finish();
    },
    onPointerCancel: finish,
    onLostPointerCapture: () => { if (dragging.current) finish(); },
    /* мгновенный сброс (двойной клик по полосе). отменяем ещё не применённое
       значение от клика: иначе кадр после сброса вернул бы его обратно */
    reset: v => {
      pending.current = null;
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      committed.current = v;
      target.set(sliderFraction(v, min, max));
      live.current(v);
    },
    onKeyDown: e => {
      const dir = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1
                : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();                       /* иначе стрелка крутит панель */
      apply(base() + dir * step * (e.shiftKey ? 5 : 1));
      target.set(sliderFraction(pending.current, min, max));
    },
  };
}

/* Семь вертикальных зон ввода остаются фейдерами, но визуально это ручки
   единой кривой. Передаём ей spring-position, чтобы линия не обгоняла ручки.
   Сама ручка двигается только transform; звук и шаг 0.5 дБ прежние. */
function EqFader({ value, onChange, label, band, onPosition }) {
  const { ref, position, reset, ...events } = useRail({
    value, min: -EQ_GAIN_MAX, max: EQ_GAIN_MAX, step: 0.5, vertical: true, onChange,
  });
  useLayoutEffect(() => {
    onPosition(band, position.get());
    return position.on('change', value => onPosition(band, value));
  }, [band, position, onPosition]);
  const thumbPosition = useTransform(position, pct => `translateY(${(1 - pct) * 100}%)`);
  return (
    <div ref={ref} className="eq-fader" role="slider" tabIndex={0}
      aria-orientation="vertical" aria-label={label}
      aria-valuemin={-EQ_GAIN_MAX} aria-valuemax={EQ_GAIN_MAX} aria-valuenow={value}
      aria-valuetext={`${fmtDb(value)} dB`}
      onDoubleClick={() => reset(0)} {...events}>
      <div className="eq-slot"/>
      <motion.div style={{
        position:'absolute', left:0, right:0, top:0, height:'100%',
        transform: thumbPosition,
        pointerEvents:'none',
      }}>
        <div className="eq-thumb"/>
      </motion.div>
    </div>
  );
}

/* горизонтальная полоса транспорта. заливка растёт от `origin` — у скорости
   это 1×, и ровно там же стоит метка: без неё непонятно, куда возвращаться,
   когда ползунок уехал в край.

   Двигается только transform. Раньше заливка анимировала `left`/`width`, а
   точка — `left`: это layout на каждое движение мыши, и полоса ехала
   ступеньками — та же история, что была у фейдеров с `top`/`height`.
   translateX в процентах считается от СОБСТВЕННОЙ ширины элемента, а у
   заливки она равна дорожке, поэтому всё считается в процентах без пикселей. */
function FxSlider({ value, min, max, step, origin, onChange, resetTo, label }) {
  const { ref, position, reset, ...events } = useRail({ value, min, max, step, vertical: false, onChange });
  const o = origin == null ? 0 : sliderFraction(origin, min, max);
  const fillPosition = useTransform(position, pct => `translateX(${Math.min(pct, o) * 100}%) scaleX(${Math.abs(pct - o)})`);
  const fillOpacity = useTransform(position, pct => Math.abs(pct - o) > 0.002 ? 0.9 : 0);
  const thumbPosition = useTransform(position, pct => `translateX(${pct * 100}%)`);
  return (
    <div ref={ref} className="eq-rail" role="slider" tabIndex={0} aria-label={label}
      aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
      onDoubleClick={() => reset(resetTo)} {...events}>
      <div className="eq-groove">
        {origin != null && (
          <div style={{
            position:'absolute', left:`${o * 100}%`, top:-3, width:1, height:10, marginLeft:-0.5,
            borderRadius:1, background:'rgba(255,255,255,0.13)',
          }}/>
        )}
        <motion.div style={{
          position:'absolute', inset:0, borderRadius:2, background:'var(--accent)',
          transformOrigin:'left center',
          transform: fillPosition,
          opacity: fillOpacity,
        }}/>
        <motion.div style={{
          position:'absolute', inset:0, pointerEvents:'none',
          transform: thumbPosition,
        }}>
          <div className="eq-dot"
            style={{transition:'transform 0.16s ease, box-shadow 0.18s ease'}}/>
        </motion.div>
      </div>
    </div>
  );
}

function FxPanel({ open, inPlayer, settings, onSettings, onClose, onOpenCrossfade, partyActive = false }) {
  const t = useLang();
  const reduced = useReducedMotion();
  /* значения нормализуются на КАЖДОМ чтении, как и в настройках: файл мог
     остаться от версии без этих полей, а ползунок с NaN — это пустая
     дорожка и `-Infinity` в dB */
  const eqOn  = !!settings.eqOn;
  const gains = Array.isArray(settings.eqGains) && settings.eqGains.length === EQ_BANDS.length
    ? settings.eqGains.map(v => clampNum(Number(v) || 0, -EQ_GAIN_MAX, EQ_GAIN_MAX))
    : EQ_FLAT;
  const speed = clampNum(Number(settings.speed) || 1, SPEED_MIN, SPEED_MAX);

  /* совпавшие с пресетом полосы подсвечивают свой чип — иначе не видно, из
     чего исходишь, и «сбросить» приходится на глаз */
  const matched = Object.keys(EQ_PRESETS).find(k =>
    EQ_PRESETS[k].every((v, i) => Math.abs(v - gains[i]) < 0.01));

  const [contourModel] = useState(() => createEqContourModel(EQ_BANDS.length));
  const contourRef = useRef(null);
  const reportPosition = useCallback((index, position) => contourModel.set(index, position), [contourModel]);

  /* любая правка полосы включает эквалайзер. панель открывают, чтобы СЛЫШАТЬ
     результат: «двигаю ползунок, а звук тот же» читается как поломка.
     выключить обратно можно кнопкой питания: сами полосы сохраняются */
  const patchGains = (fn, wake) => onSettings(s => {
    const g = Array.isArray(s.eqGains) && s.eqGains.length === EQ_BANDS.length
      ? s.eqGains.slice() : EQ_FLAT.slice();
    fn(g);
    return { ...s, eqGains: g, ...(wake && !s.eqOn ? { eqOn: true } : null) };
  });
  const setGain   = (i, v) => patchGains(g => { g[i] = v; }, true);
  const setPreset = k => {
    /* Повторный клик не перезапускает движение. Выключенный EQ включается. */
    if (matched === k && eqOn) return;
    onSettings(s => ({ ...s, eqGains: EQ_PRESETS[k].slice(), eqOn: true }));
    contourRef.current?.pulse();
  };
  const setSpeed  = v => onSettings(s => ({ ...s, speed: Math.round(v * 100) / 100 }));
  const toggleEq  = () => onSettings(s => ({ ...s, eqOn: !s.eqOn }));
  const width = clampNum(Number(settings.width) || 1, WIDTH_MIN, WIDTH_MAX);
  const stereoOn = width > 1.01;
  const toggleStereo = () => onSettings(s => ({
    ...s,
    width: (Number(s.width) || 1) > 1.01 ? 1 : 2,
  }));

  return (
    <div className="fx-panel" data-motion-spatial="" style={{
      position:'absolute', inset:0, display:'flex', flexDirection:'column',
      opacity: open ? 1 : 0,
      /* обе защиты те же, что у панели текста: `pointer-events:none` на слое
         плеера не гасит потомка с auto, а закрытая панель с inset:0 ловила бы
         клики по списку рядом */
      pointerEvents: inPlayer && open ? 'auto' : 'none',
      visibility: inPlayer && open ? 'visible' : 'hidden',
      transform: open ? 'translateX(0)' : 'translateX(14px)',
      transition: open
        ? 'opacity 0.3s ease 0.08s, transform 0.44s cubic-bezier(0.22,1,0.36,1) 0.08s'
        : 'opacity 0.16s ease, transform 0.16s ease',
    }}>
      <div className="fx-panel-header">
        <span className="fx-panel-label">{t('fx')}</span>
        <button type="button" className="fx-close" onClick={onClose} title={t('close')} aria-label={t('close')}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/>
          </svg>
        </button>
      </div>

      <div className="fx-panel-body">
        <section className="eq-instrument" data-enabled={eqOn ? 'true' : 'false'} aria-label={t('eq')}>
          <div className="eq-heading">
            <h2>{t('eq')}</h2>
            <button type="button" className="eq-power" onClick={toggleEq} title={t('eq_on')}
              aria-label={t('eq')} aria-pressed={eqOn}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M12 3v8M7 5.5a8 8 0 1 0 10 0"/>
              </svg>
            </button>
          </div>

          <div className="eq-presets" role="group" aria-label={t('eq')}>
            {Object.keys(EQ_PRESETS).map(k => <button type="button" key={k} className="eq-preset"
              onClick={() => setPreset(k)} aria-pressed={matched === k}>{t('eqp_' + k)}</button>)}
          </div>

          <div className="eq-band-grid">
            <EqContour ref={contourRef} model={contourModel} active={open && inPlayer} reduced={reduced}/>
            {EQ_BANDS.map((b, i) => (
              <div key={b.hz} className="eq-band" data-adjusted={gains[i] ? 'true' : 'false'}>
                <span className="eq-gain">{fmtDb(gains[i])}</span>
                <EqFader value={gains[i]} onChange={v => setGain(i, v)} band={i} onPosition={reportPosition}
                  label={b.hz >= 1000 ? `${b.hz / 1000} ${t('khz')}` : `${b.hz} ${t('hz')}`}/>
                <span className="eq-frequency">{hzShort(b.hz)}</span>
              </div>
            ))}
          </div>
          <div className="eq-footer">
            <span className="eq-range">±{EQ_GAIN_MAX} dB</span>
            <button type="button" className="eq-reset" disabled={matched === 'flat'}
              onClick={() => setPreset('flat')}>{t('eq_reset')}</button>
          </div>
        </section>

        <div className="fx-secondary">
          <button type="button" className="fx-stereo" onClick={toggleStereo} aria-pressed={stereoOn}>
            <span className="fx-stereo-indicator" aria-hidden="true"/>
            <span>{t('stereo_boost')}</span>
          </button>
          {!partyActive && <div className="fx-speed">
            <div className="fx-speed-heading">
              <span>{t('speed')}</span>
              <span className="fx-speed-value">{speed.toFixed(2)}×</span>
            </div>
            <FxSlider value={speed} min={SPEED_MIN} max={SPEED_MAX} step={0.01} origin={1}
              onChange={setSpeed} resetTo={1} label={t('speed')}/>
          </div>}
          <button type="button" className="fx-crossfade-link" onClick={onOpenCrossfade}
            title={`${t('crossfade')}, ${t('settings_title')}`}>
            <span>{t('crossfade')}</span>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
              strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 8h10M9 4l4 4-4 4"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── HomeCard ────────────────────────────────────────────────────────────── */
const HomeCard = React.memo(function HomeCard({ track, onSelect, artRef, artHidden, isLiked, onLike }) {
  const handleClick = useCallback(() => onSelect(track), [onSelect, track]);
  const [popKey, setPopKey] = useState(0);
  return (
    /* Появление — css-анимацией, а не framer: в библиотеке сотни карточек, и
       при поиске список пересобирается на каждую букву. `initial/animate/exit`
       на каждой карточке означали сотни одновременных пружин (а exit ещё и
       держал удалённые карточки в DOM) — именно это и лагало.
       css-анимация считается один раз и не тянет js на кадр; появляются только
       реально новые карточки, оставшиеся не перезапускаются. Задержка каскада
       живёт в css по nth-child — так проп index не нужен, и memo не ломается
       на каждом изменении фильтра. */
    <div className="home-card home-card-anim" onClick={handleClick}
      style={{ borderRadius:16, cursor:'pointer' }}>
      <div style={{
        padding:'8px 8px 7px', textAlign:'center',
        background:'rgba(255,255,255,0.05)',
        borderRadius:'16px 16px 0 0',
      }}>
        <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.3)', marginBottom:2,
          whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{formatArtistDisplay(track.artist)}</div>
        <div style={{fontSize: 'var(--fs-sm)', fontWeight:500, color:'rgba(255,255,255,0.88)',
          whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{track.title}</div>
      </div>
      <div ref={artRef} data-sewer-art={track.id} style={{
        opacity: artHidden ? 0 : 1,
        width:'100%', aspectRatio:'1', position:'relative',
        background:'#111116',
        borderRadius:'0 0 16px 16px', overflow:'hidden',
        display:'flex', alignItems:'center', justifyContent:'center',
      }}>
        {track.coverUrl ? (
          <img src={track.coverUrl} loading="lazy" decoding="async" style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover',clipPath:'inset(0 round 0 0 16px 16px)',display:'block'}}
            onError={e=>{e.currentTarget.style.display='none'}}/>
        ) : (
          <img src="../assets/note.png" style={{width:24,height:24,filter:'brightness(0) invert(1)',opacity:0.13}}/>
        )}
        <CoverTint/>
        <div className="home-card-overlay" style={{
          position:'absolute', inset:0, background:'rgba(0,0,0,0.32)',
          display:'flex', alignItems:'center', justifyContent:'center',
        }}>
          <div className="home-card-play" style={{
            width:46, height:46, borderRadius:'50%',
            display:'flex', alignItems:'center', justifyContent:'center',
          }}>
            <svg width="26" height="26" fill="#fff" viewBox="0 0 24 24" style={{marginLeft:3}}><polygon points="6,4 20,12 6,20"/></svg>
          </div>
        </div>
        {onLike && (
          <div className="home-card-like" onClick={e=>{ e.stopPropagation(); if (!isLiked) setPopKey(k=>k+1); onLike(track); }} style={{
            position:'absolute', right:7, bottom:7, zIndex:2,
            background:'rgba(0,0,0,0.45)', borderRadius:'50%',
            width:26, height:26, display:'flex', alignItems:'center', justifyContent:'center',
            color: isLiked ? 'var(--accent)' : 'rgba(255,255,255,0.75)',
            backdropFilter:'blur(4px)',
          }}>
            <LikeHeart key={popKey} liked={isLiked} size={13}
              className={popKey ? 'like-pop like-glow' : undefined}/>
          </div>
        )}
      </div>
    </div>
  );
});

/* Сетка главного экрана — ОТДЕЛЬНЫЙ мемоизированный компонент.
   🚨 инлайн она была причиной ~150ms блокировки на КАЖДЫЙ клик (INP 264ms).
   список лайков — это сотни карточек, и каждое состояние App (клик по треку,
   смена тома, открытие меню) пересоздавало их элементы заново: React
   проходил по всем, плюс `AnimatePresence` со `PresenceChild` на каждой
   карточке (хук на карточку) — всё это заново на каждый рендер App.
   теперь список/лайки/коллбеки стабильны (useMemo/useCallback), а
   artHidden приходит ПРИМИТИВАМИ (heroId/reverseId), а не выражением с
   замыканием — иначе React.memo сравнивал бы по ссылке на новый объект
   и пропускал бы всегда. Мемоизация работает только когда ВСЕ пропы
   стабильны: список, Set лайков, три коллбека и два примитива. */
const HomeGrid = React.memo(function HomeGrid({ list, likedIds, onLike, onSelect, getArtRef, heroId, reverseId }) {
  return (
    <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(128px, 1fr))', gap:18}}>
      {list.map(t => (
        <HomeCard key={t.id} track={t}
          artRef={getArtRef(t.id)}
          onSelect={onSelect}
          artHidden={(reverseId != null && t.id === reverseId) || (heroId != null && t.id === heroId)}
          isLiked={likedIds ? likedIds.has(t.id) : false}
          onLike={onLike}/>
      ))}
    </div>
  );
});

/* ── Hero clone ──────────────────────────────────────────────────────────── */
const HERO_DUR_MS  = 430;
/* ⚠️ Фейд начинается ПОСЛЕ посадки, а не за 80мс до неё. Раньше `heroExiting`
   ставился на 350мс, то есть последние 80мс полёта обложка уже растворялась:
   визуально она «не долетала» — гасла в паре процентов от цели, а под ней
   проступала неподвижная обложка плеера. читалось как рывок перед концом.
   теперь клон доезжает до цели в полной непрозрачности, и только потом
   коротко гаснет — уже ровно поверх такой же обложки, поэтому сам фейд
   не виден, он лишь страхует от пиксельного шва при подмене. */
const HERO_FADE_MS = 140;
/* ⚠️ было `expo.inOut` — и это была ровно та резкость, на которую жаловались.
   expo.inOut держит пол пути в середине: между 25% и 75% времени проходит
   ~97% дистанции. обложка будто стоит на месте, потом резко пролетает
   экран, потом снова стоит — «хлёсткий» перелёт.
   easeInOutCubic в той же середине проходит ~87%, и он симметричен, поэтому
   разгон и торможение читаются плавно. `ease-in-out` мягче ещё, но на
   длинной дистанции обложка начинает «плыть» — если покажется вяло,
   двигать сюда, а не трогать остальное.

   Это css-кривая, а не gsap-строка: полёт теперь идёт через Web Animations
   (см. HeroClone), а не через js-тикер. */
const HERO_EASE    = 'cubic-bezier(0.65, 0, 0.35, 1)';
/* 4 радиуса углов элемента [tl,tr,br,bl] из computed style */
function cssCorners(el) {
  try {
    const nums = getComputedStyle(el).borderRadius.split('/')[0].trim().split(/\s+/).map(parseFloat);
    if (!nums.length || nums.some(isNaN)) return [16,16,16,16];
    if (nums.length === 1) return [nums[0],nums[0],nums[0],nums[0]];
    if (nums.length === 2) return [nums[0],nums[1],nums[0],nums[1]];
    if (nums.length === 3) return [nums[0],nums[1],nums[2],nums[1]];
    return nums.slice(0,4);
  } catch { return [16,16,16,16]; }
}
function HeroClone({ hero, exiting, reverse = false }) {
  const cloneRef = useRef(null);
  /* внутренний элемент: скругление и обрезка. transform живёт на внешнем —
     см. комментарий у эффекта ниже */
  const clipRef  = useRef(null);
  const { left: tLeft, top: tTop, size } = hero.targetRect;
  const { left: sLeft, top: sTop, width: sW, height: sH } = hero.startRect;

  const dx = (sLeft + sW/2) - (tLeft + size/2);
  const dy = (sTop + sH/2) - (tTop + size/2);
  const sc = sW / size;
  /* углы карточки-цели [tl,tr,br,bl]; на конце полёта клон уменьшен через scale,
     поэтому радиусы анимируем до corners/sc — визуально приезжаем ровно в углы
     карточки, приземление без щелчка */
  const corners = hero.corners || [16,16,16,16];
  const BR4     = '16px 16px 16px 16px';
  const BR_END  = corners.map(c => (c / sc) + 'px').join(' ');
  const DUR = HERO_DUR_MS / 1000;

  /* ⚠️ Полёт — через Web Animations, а НЕ через gsap, и это главное про
     плавность. gsap тикает из rAF на главном потоке: каждый кадр полёта —
     это js-работа. А летит обложка ровно в тот момент, когда монтируется
     плеер (раскладка, canvas под обложку, блюры) и библиотека программно
     скроллится к играющему треку (420мс rAF-цикла + пересборка
     виртуализированных строк). Любой длинный таск в эти 430мс = пропущенный
     кадр полёта, то есть ровно та дёрганность, на которую жаловались.
     `element.animate` с transform уходит на композитор: он тикает в
     compositor-потоке и продолжает идти, даже если главный поток занят.

     Раньше здесь ещё ждали `loadGsap().then(...)`: пока ленивый чанк грузился
     (первый полёт за сессию), клон тупо висел на стартовой точке, а потом
     стартовал — это читалось как рывок. Теперь анимация стартует синхронно,
     в том же кадре, что и коммит.

     transform и border-radius — на РАЗНЫХ элементах, и это тоже про
     плавность: border-radius некомпозитный, его перерисовка не должна
     мешать композитору вести transform. Внешний div везёт transform,
     внутренний — скругление и обрезку картинки.

     Радиус морфим только первые 55% полёта: к посадке он уже равен
     целевому, а остаток — чистый композиционный transform без перерисовки.
     (Раньше здесь было ручное округление до целых пикселей — с WAAPI оно
     не нужно: интерполяцию ведёт движок анимаций, а не наш onUpdate.) */
  useLayoutEffect(() => {
    const el = cloneRef.current, clip = clipRef.current;
    if (!el || !clip) return;
    const from = reverse
      ? { x: 0, y: 0, scale: 1, br: BR4 }
      : { x: dx, y: dy, scale: sc, br: BR_END };
    const to = reverse
      ? { x: dx, y: dy, scale: sc, br: BR_END }
      : { x: 0, y: 0, scale: 1, br: BR4 };
    return animateHeroFlight(el, clip, from, to,
      { duration: DUR * 1000, easing: HERO_EASE, fill: 'forwards' });
  }, [hero, reverse]);

  /* ❌ Раньше гашение клона было gsap-твином в useEffect: `exiting` ставился
     таймером, эффект ждал ленивый gsap и только потом начинал фейд — клон
     успевал лишний кадр простоять полностью непрозрачным. Теперь это css-
     transition по opacity: свойство композитное, живёт на композиторе, и
     стартует ровно в тот кадр, когда пришёл `exiting`. */

  // pre-paint inline transform — clone is born already in its starting position
  const initialTransform = reverse
    ? 'translate3d(0,0,0) scale(1)'
    : `translate3d(${dx}px, ${dy}px, 0) scale(${sc})`;

  return createPortal(
    <div ref={cloneRef} style={{
      position:'fixed',
      left: tLeft, top: tTop,
      width: size, height: size,
      zIndex:960, pointerEvents:'none',
      transformOrigin:'center center',
      transform: initialTransform,
      /* фон и обрезка — на внутреннем элементе: у внешнего не должно быть
         ни фона, ни скругления, иначе за скруглёнными углами внутреннего
         проступал бы тёмный прямоугольник */
      willChange:'transform, opacity',
      backfaceVisibility:'hidden',
      contain:'layout style paint',
      opacity: exiting ? 0 : 1,
      transition: `opacity ${HERO_FADE_MS / 1000}s ease-out`,
    }}>
      <div ref={clipRef} style={{
        position:'absolute', inset:0,
        borderRadius: reverse ? BR4 : BR_END,
        overflow:'hidden',
        background:'#111116',
      }}>
      {hero.track.coverUrl ? (
        /* без clip-path: обрезает родитель (overflow:hidden + borderRadius).
           ⚠️ `-1px / +2px` — НЕ косметика, а подгонка кадра под реальную
           обложку. `CoverLayer.draw` рисует картинку в битмапе с запасом
           `w + 2*dpr` (защита от волосяной щели на прямых краях), т.е.
           картинка на 2 css-px шире бокса, по 1px за каждую сторону.
           клон раньше был `inset:0, width:100%` — то есть кадр на 2px
           мельче, и в момент подмены кадр прыгал: обложка «обрезалась»
           сразу после прилёта. здесь ровно тот же кадр, что у AlbumArt;
           лишний px срезает overflow:hidden родителя. */
        <img src={hero.track.coverUrl}
          loading="eager" decoding="sync"
          style={{
            position:'absolute', left:-1, top:-1,
            width:'calc(100% + 2px)', height:'calc(100% + 2px)',
            objectFit:'cover', display:'block',
          }}
          onError={e=>{e.currentTarget.style.display='none'}}/>
      ) : (
        <div style={{
          position:'absolute', inset:0,
          display:'flex', alignItems:'center', justifyContent:'center',
        }}>
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
            <path d="M9 18V5l12-2v13" stroke="rgba(255,255,255,0.13)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="6" cy="18" r="3" stroke="rgba(255,255,255,0.13)" strokeWidth="1.5"/>
            <circle cx="18" cy="16" r="3" stroke="rgba(255,255,255,0.13)" strokeWidth="1.5"/>
          </svg>
        </div>
      )}
      {/* тонировка и на клоне: он летит в плеер и подменяется обложкой
          AlbumArt, и без слоя цвет на полёте «прыгал» бы */}
      <CoverTint/>
      </div>
    </div>,
    document.body
  );
}

/* ── TopBar ──────────────────────────────────────────────────────────────── */
/* навигация в тайтлбаре: слева настройки→source-тумблер→миниплеер, по центру
   (абсолютно на окно) сегмент Плейлисты|Треки|Плеер|Поиск с горизонтальным
   пиллом, справа комнаты и collapse библиотеки (только в плеере). рендерится порталами в
   #topbar-slot и #titlebar (тайтлбар — статический html вне react-root) */
function TopBar({ navActive, onNav, libCollapsed, onToggleLib, inPlayer, scAuth, sourceMode, onToggleSource, hideSource, hideMiniPlayer,
  track, hasTrack, isPlaying, onPrev, onTogglePlayback, onNext, partyOpen, partyActive, onToggleParty, partyTriggerRef, partyLocked }) {
  const t = useLang();
  const navImg = (src, s=17) => <img src={src} style={{width:s, height:s, filter:'brightness(0) invert(1)', display:'block'}}/>;
  const NAV = [
    { id:"playlists", label:t('nav_playlists'), icon: navImg('../assets/playlists.png') },
    { id:"home",    label:t('nav_tracks'),  icon: navImg('../assets/tracks.png')  },
    { id:"library", label:t('nav_player'),  icon: navImg('../assets/player.png', 19), size:38 },
    { id:"search",  label:t('nav_search'),  icon: navImg('../assets/search.png')  },
    { id:"history", label:t('nav_history'), icon:<span style={{color:'var(--text)', display:'flex'}}><HistoryIcon/></span> },
  ];
  const folderIcon = navImg('../assets/local.png');

  const navRefs = useRef({});
  const navWrapRef = useRef(null);
  const [pillRect, setPillRect] = useState({ left: 0, width: 34, visible: false });
   /* вкладка «Плеер» стоит ровно по центру окна: сегмент смещается так,
      чтобы центр library-кнопки попал на 50% ширины (по две вкладки с краёв) */
  const [navShift, setNavShift] = useState(0);

  useLayoutEffect(() => {
    const el = navRefs.current[navActive];
    if (!el || (navActive !== 'playlists' && navActive !== 'home' && navActive !== 'search' && navActive !== 'library' && navActive !== 'history')) {
      setPillRect(p => ({ ...p, visible: false }));
      return;
    }
    setPillRect({ left: el.offsetLeft, width: el.offsetWidth, visible: true });
  }, [navActive]);

  useLayoutEffect(() => {
    const bar = document.getElementById('titlebar');
    const measure = () => {
      const wrap = navWrapRef.current, el = navRefs.current['library'];
      if (!wrap || !el || !bar) return;
      const playerCenter = el.offsetLeft + el.offsetWidth / 2;
      setNavShift(wrap.offsetWidth / 2 - playerCenter);
      /* Reserve the actual space BEFORE navigation. Covers and text collapse
         inside this lane, so playback controls cannot push the middle tabs. */
      bar.style.setProperty('--topbar-left-width', `${Math.max(0, bar.clientWidth / 2 - playerCenter - 10)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (bar) observer.observe(bar);
    if (navWrapRef.current) observer.observe(navWrapRef.current);
    return () => { observer.disconnect(); bar?.style.removeProperty('--topbar-left-width'); };
  }, []);

  const slot = document.getElementById('topbar-slot');
  const bar  = document.getElementById('titlebar');
  if (!slot || !bar) return null;

  /* центрированный сегмент — абсолют внутри #titlebar; «Плеер» ровно по центру окна */
  const nav = (
    <div ref={navWrapRef} style={{position:'absolute', left:'50%', top:'50%', translate:'-50% -50%',
      transform:`translateX(${navShift}px)`,
      display:'flex', alignItems:'center', gap:4, WebkitAppRegion:'no-drag'}}>
      <div data-motion-position="" style={{
        position:'absolute', top:2, bottom:2, left:0,
        width: pillRect.width || 34, borderRadius:10,
        background:'rgba(178,178,178,0.11)',
        transform:`translateX(${pillRect.left}px)`,
        opacity: pillRect.visible ? 1 : 0,
        transition:'transform 0.34s cubic-bezier(0.45,0,0.55,1), opacity 0.18s ease',
        pointerEvents:'none', zIndex:0,
      }}/>
      {NAV.map(n => (
        <div key={n.id} ref={el => navRefs.current[n.id] = el} style={{position:'relative', zIndex:1}}>
          <NavIcon icon={n.icon} label={n.label} active={navActive===n.id} onClick={()=>onNav(n.id)} size={n.size || 34} noActiveBg={true}/>
        </div>
      ))}
    </div>
  );

  return (
    <>
      {createPortal(
        <div style={{display:'flex', alignItems:'center', width:'100%', height:'100%'}}>
          {/* миниплеер остаётся на месте и при паузе; навигация не смещается */}
          <div className="topbar-left">
            <div style={{WebkitAppRegion:'no-drag', flexShrink:0}}>
              <NavIcon label={t('nav_settings')} active={navActive==='settings'} onClick={()=>onNav('settings')} size={32}
                icon={<img src="../assets/settings.png" style={{width:17,height:17,filter:'brightness(0) invert(1)',display:'block'}}/>}/>
            </div>
            {scAuth && !hideSource && (
              <div style={{WebkitAppRegion:'no-drag', flexShrink:0}}>
                <NavIcon label={t('nav_local')} active={sourceMode==='local'} onClick={onToggleSource} size={32} icon={folderIcon}/>
              </div>
            )}
            <MiniPlayer visible={hasTrack && !inPlayer && !hideMiniPlayer} track={track} isPlaying={isPlaying} transportLocked={partyLocked}
              onPrev={onPrev} onToggle={onTogglePlayback} onNext={onNext} onOpen={()=>onNav('library')}
              labels={{ player:t('mini_player'), previous:t('playback_previous'), next:t('playback_next'),
                play:t('playback_play'), pause:t('playback_pause'), untitled:t('track_untitled'),
                openPlayer:t('mini_player_open') }}/>
          </div>

          {/* комнаты перед collapse списка и системными кнопками, во всех разделах */}
          <div style={{flex:1, display:'flex', alignItems:'center', justifyContent:'flex-end', gap:3, paddingRight:6}}>
            <button type="button" className="party-trigger" ref={partyTriggerRef} onClick={onToggleParty}
              title={t('nav_party')} aria-label={t('nav_party')} aria-expanded={!!partyOpen}
              aria-controls="listening-party-stage" data-room={partyActive ? 'true' : 'false'}>
              <span className="party-icon" aria-hidden="true"/>
            </button>
            <div style={{display:'flex', alignItems:'center',
              opacity: inPlayer ? 1 : 0, pointerEvents: inPlayer ? 'auto' : 'none', visibility: inPlayer ? 'visible' : 'hidden', transition:'opacity 0.2s ease'}}>
              <div style={{WebkitAppRegion:'no-drag', width:30, height:30, borderRadius:9, cursor:'pointer',
                display:'flex', alignItems:'center', justifyContent:'center',
                color:'rgba(255,255,255,0.35)', transition:'color 0.18s ease'}}
                onClick={onToggleLib}
                onMouseEnter={e=>e.currentTarget.style.color='rgba(255,255,255,0.7)'}
                onMouseLeave={e=>e.currentTarget.style.color='rgba(255,255,255,0.35)'}>
                <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
                  data-motion-position="" style={{transition:'transform 0.26s cubic-bezier(0.4,0,0.2,1)', transform: libCollapsed ? 'rotate(180deg)' : 'rotate(0deg)'}}>
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
              </div>
            </div>
          </div>
        </div>, slot)}
      {createPortal(nav, bar)}
    </>
  );
}

/* ── примитивы настроек ───────────────────────────────────────────────────── */
/* Модульный уровень, не тело SettingsView. Раньше Card, Row и Toggle были
   объявлены внутри SettingsView, а значит пересоздавались на каждом рендере
   (те же грабли, что описаны у TrackContextMenu) и ещё передавались в
   LyricsSettings и ClearCacheCard пропсами. Здесь они общие, и у всех рядов
   одна геометрия вместо пяти копий.

   Язык экрана сжат до двух контролов: тумблер (булево) и сегменты
   (выбор из нескольких). Раньше их было пять видов — тумблер, чипсы таймстампа,
   сегменты акцента, крупные кнопки языка, квадратный степпер, — и каждый со
   своим радиусом, отступом и цветом. */

/* Значения цветов настроек. Собраны здесь, потому что раньше один и тот же
   серый писался по двадцати раз инлайном в восьми местах, и любая правка
   тона означала вычитку всего SettingsView. Прозрачности, а не hex: поверх
   материала окна подложки складываются с тем, что видно сквозь окно. */
const SN = {
  panel: 'rgba(255,255,255,0.032)',  /* подложка группы настроек */
  line:  'rgba(255,255,255,0.05)',   /* разделитель, когда HIDE_DIVIDERS выключен */
  hi:    'rgba(255,255,255,0.78)',   /* подпись строки */
  mid:   'rgba(255,255,255,0.46)',   /* вторичный текст, значение */
  dim:   'rgba(255,255,255,0.3)',    /* пояснение под строкой */
  faint: 'rgba(255,255,255,0.2)',    /* надзаголовок группы */
  fill:  'rgba(255,255,255,0.05)',   /* заливка кнопки/сегмента в покое */
};

/* Иконки разделов инлайном, а не картинками из public/assets. Те — разно­
   весная дутона с цветом, и их приходилось выбеливать фильтром
   `brightness(0) invert(1)`, из-за чего выбранный пункт нельзя было покрасить
   в акцент: белым оставалась и иконка, и подпись. Один штрих 1.7px у всех
   шести — и цвет достаётся из currentColor. */
function SettingsIcon({ size = 15, children }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0 }}>{children}</svg>
  );
}

/* Группа настроек. `title` необязателен: у первой карточки раздела он
   дублировал бы пункт боковой навигации, поэтому там его не передают.
   Скругление берётся из --radius, то есть живёт тем же ползунком, что и
   углы окна: раньше радиус был зашит в 14px и не поддавался ничему. */
function Card({ title, children, style }) {
  return (
    <div style={{ marginBottom: 20, ...style }}>
      {title && (
        <div style={{
          fontSize: 'var(--fs-eyebrow)', letterSpacing: '0.1em', textTransform: 'uppercase',
          color: SN.faint, marginBottom: 9, paddingLeft: 3,
        }}>{title}</div>
      )}
      <div data-disclosure-surface="" style={{ position: 'relative', isolation: 'isolate', borderRadius: 'var(--radius, 14px)' }}>
        <div data-disclosure-background="" aria-hidden="true" style={{ background: SN.panel }}/>
        {children}
      </div>
    </div>
  );
}

/* Строка настройки: подпись и пояснение слева, контрол справа.
   `dim` гасит всю строку целиком — так помечаются пункты, которые сейчас
   не применимы (материал окна гасит подсветку акцента). */
function Row({ label, sub, badge, children, last, dim, wrap }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
      flexWrap: wrap ? 'wrap' : undefined,
      padding: '13px 16px',
      borderBottom: (last || HIDE_DIVIDERS) ? 'none' : `1px solid ${SN.line}`,
      opacity: dim ? 0.4 : 1, transition: 'opacity 0.22s ease',
    }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          fontSize: 'var(--fs-md)', color: SN.hi, lineHeight: 1.3,
        }}>
          {label}
          {badge}
        </div>
        {sub && (
          /* Ограничение ширины держит строку в читаемых 65 знаках: колонка
             узкая, и без него длинный абзац уходил в две-три строки. В px,
             а не в ch — на 11px Proxima Soft один ch около 5.5px, и 44ch
             давали 240px, то есть вдвое уже того, что нужно. */
          <div style={{
            fontSize: 'var(--fs-xs)', color: SN.dim, marginTop: 3,
            lineHeight: 1.45, maxWidth: 360,
          }}>{sub}</div>
        )}
      </div>
      {children && (
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 7 }}>
          {children}
        </div>
      )}
    </div>
  );
}

/* Мелкая плашка рядом с подписью: ограничения и метки. */
function Badge({ children }) {
  return (
    <span style={{
      fontSize: 'var(--fs-eyebrow)', letterSpacing: '0.08em', textTransform: 'uppercase',
      color: SN.mid, background: SN.fill,
      padding: '2px 6px', borderRadius: 5, whiteSpace: 'nowrap', flexShrink: 0,
    }}>{children}</span>
  );
}

/* ── примитивы редактора темы ─────────────────────────────────────────────
   Четыре контрола на весь раздел. Раньше здесь не было ничего, кроме пяти
   кружков: произвольный цвет, число и фон произвольной формы нечем было
   задать, поэтому всё это пришлось бы писать руками в каждом режиме. */

/* Общий нативный ползунок настроек: клавиши работают, колесо не меняет
   значение случайно при прокрутке раздела. Заливку задаёт --fill. */
function MiniSlider({ label, value, min, max, step = 1, onChange, display, disabled }) {
  const rail = useRef(null);
  const dragging = useRef(false);
  const { target, position } = useSmoothPosition(value, min, max, dragging);
  const length = useMotionValue(0);
  const thumbX = useTransform([position, length], ([fraction, width]) => fraction * width);
  useLayoutEffect(() => {
    const el = rail.current;
    const measure = () => length.set(Math.max(0, el.getBoundingClientRect().width - 14));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [length]);
  const follow = e => {
    if (!disabled) target.set(pointerFraction(e, rail.current.getBoundingClientRect(), false, 7));
  };
  const finish = e => {
    dragging.current = false;
    target.set(sliderFraction(+e.currentTarget.value, min, max));
  };
  return (
    <div style={{
      padding: '12px 16px 14px', opacity: disabled ? 0.4 : 1,
      transition: 'opacity 0.22s ease',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        gap: 12, marginBottom: 9,
      }}>
        <span style={{ fontSize: 'var(--fs-md)', color: SN.hi }}>{label}</span>
        <span style={{
          fontSize: 'var(--fs-xs)', color: SN.mid, fontVariantNumeric: 'tabular-nums',
        }}>{display ?? value}</span>
      </div>
      <div className="smooth-slider" ref={rail} data-disabled={disabled || undefined}>
        <div className="smooth-slider-track" aria-hidden="true">
          <motion.div className="smooth-slider-fill" style={{ scaleX: position }}/>
        </div>
        <motion.div className="smooth-slider-thumb" aria-hidden="true" style={{ x: thumbX }}/>
        <input type="range" className="th-range smooth-slider-input" min={min} max={max} step={step}
          value={value} disabled={disabled} aria-label={label} aria-valuetext={display == null ? undefined : String(display)}
          onPointerDown={e => {
            if (e.button || disabled) return;
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            follow(e);
          }}
          onPointerMove={e => { if (dragging.current) follow(e); }}
          onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
          onChange={e => {
            const next = +e.target.value;
            if (!dragging.current) target.set(sliderFraction(next, min, max));
            onChange(next);
          }}/>
      </div>
    </div>
  );
}

/* Квадрат насыщенности×светлоты и полоса оттенка. Тянуть можно мышью прямо
   по элементу, без захвата: события висят на window, пока зажата кнопка, и
   снимаются на pointerup. Оттенок живёт в ref, а не в пропсе, — иначе
   движение по полосе оттенка подменяло бы насыщенность и светлоту, только
   что выведенные квадратом, и кадр дёргался на каждом пикселе.

   ⚠️ События мыши НЕ пишут в состояние напрямую — они копятся в позицию и
   применяются раз в кадр. Это главная причина, по которой пикер когда-то
   «перекрашивал всё приложение и лагал»: цвет лежит в настройках, те лежат
   в App, и одно движение мыши пересобирало весь интерфейс. Мышь даёт больше
   событий, чем кадров (до 240 в секунду на 100hz-мониторе, а браузер рисует
   60), поэтому промежуточные позиции всё равно не показывались — только
   тратили на перерисовку. */
function ColorPad({ hex, onChange }) {
  const padRef  = useRef(null);
  const barRef  = useRef(null);
  const [drag, setDrag] = useState(null);        /* 'pad' | 'hue' | null */
  const hsv = hexToHsv(hex);
  /* Обработчики движения живут в ref, а пересоздаются каждый рендер.
     Раньше эффект подписки зависел от `hex`, и на каждое движение мыши он
     переподписывался — за время между commit'ом и кадром указатель
     успевал отдать пару pointermove в никуда, и протяжка дёргалась рывками.
     Ссылка на ref даёт подписку один раз на всё время нажатия. */
  const live = useRef(null);
  live.current = { hex, onChange };
  /* последнее событие мыши и номер кадра, на котором оно будет применено.
     Позиция нужна целиком: пока ждём кадра, указатель может уйти дальше, и
     применять надо ту, что свежее всего.
     ⚠️ Режим (квадрат или полоса) берём из ref, а НЕ из e.target: во время
     протяжки указатель ходит над всей страницей, и target у pointermove —
     элемент под курсором, а не пикер. */
  const pending = useRef(null);
  const mode    = useRef('pad');
  const frame   = useRef(0);

  const flush = () => {
    frame.current = 0;
    const e = pending.current;
    if (!e) return;
    pending.current = null;
    if (mode.current === 'pad') {
      const el = padRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const x = clampNum((e.clientX - r.left) / r.width, 0, 1);
      const y = clampNum((e.clientY - r.top) / r.height, 0, 1);
      /* оттенок берём из ТЕКУЩЕГО значения, а не из замыкания: пока тянут по
         квадрату, раз в кадр меняется насыщенность, и вчерашний оттенок в
         замыкании дал бы палитру, уезжающую в другую часть круга */
      const c = hsvToRgb(hexToHsv(live.current.hex).h, x * 100, (1 - y) * 100);
      live.current.onChange(rgbToHex(c.r, c.g, c.b));
    } else {
      const el = barRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const x = clampNum((e.clientX - r.left) / r.width, 0, 1);
      const cur = hexToHsv(live.current.hex);
      const c = hsvToRgb(x * 360, cur.s, cur.v);
      live.current.onChange(rgbToHex(c.r, c.g, c.b));
    }
  };

  /* Позиция от указателя — кладём в очередь и просим кадр. Пока кадр не
     пришёл, новые движения только перезаписывают позицию: применяется
     ровно одна, последняя. */
  const queue = (e, m) => {
    if (m) mode.current = m;
    pending.current = e;
    if (!frame.current) frame.current = requestAnimationFrame(flush);
  };

  useEffect(() => {
    if (!drag) return;
    const move = e => queue(e);
    const up   = () => {
      /* Последнее движение не ждём следующего кадра: иначе цвет встал бы на
         позицию указателя с задержкой в кадр после отпускания */
      if (pending.current) {
        cancelAnimationFrame(frame.current);
        flush();
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      pending.current = null;
    };
  }, [drag]);

  /* Стиль кружка, а не компонент: возвращать <div> здесь нельзя —
     JSX-вызов развернулся бы в объект, и react попытался бы отрисовать
     его как содержимое. */
  const knobStyle = (x, y) => ({
    position: 'absolute', left: x, top: y, width: 12, height: 12, marginLeft: -6, marginTop: -6,
    borderRadius: '50%', background: hex, pointerEvents: 'none',
    /* два кольца: внутреннее цвета фона отделяет кружок от пестрых участков
       квадрата, внешнее — белое, иначе на светлом тоне его не видно */
    boxShadow: '0 0 0 2px rgba(10,10,14,0.9), 0 0 0 3.5px rgba(255,255,255,0.85)',
  });

  return (
    <div style={{ width: 148, flexShrink: 0 }}>
      <div ref={padRef} onPointerDown={e => { e.preventDefault(); setDrag('pad'); queue(e, 'pad'); }}
        style={{
          position: 'relative', height: 108, borderRadius: 10, cursor: 'crosshair',
          /* долгое свойство, а не шорткат background: ниже в том же объекте
             стоит backgroundImage, и react при обновлении ругается на
             смешение шортката с длинным (background сбрасывал бы картинку) */
          backgroundColor: `hsl(${hsv.h}, 100%, 50%)`,
          /* сверху — чёрный, снизу прозрачный: так светлота уезжает вниз */
          backgroundImage: 'linear-gradient(to top, #000, transparent)',
        }}>
        <div style={{
          position: 'absolute', inset: 0, borderRadius: 10, pointerEvents: 'none',
          backgroundImage: 'linear-gradient(to right, #fff, transparent)',
        }}/>
        <div style={knobStyle(`${hsv.s}%`, `${100 - hsv.v}%`)}/>
      </div>
      <div ref={barRef} onPointerDown={e => { e.preventDefault(); setDrag('hue'); queue(e, 'hue'); }}
        style={{
          position: 'relative', height: 14, marginTop: 12, borderRadius: 7, cursor: 'ew-resize',
          /* радугу держим в backgroundImage: ниже того же элемента нет, но
             соседние слои в этом файле уже на longhand — одинаково везде */
          backgroundImage: 'linear-gradient(to right, #f00, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00)',
        }}>
        <div style={knobStyle(`${(hsv.h / 360) * 100}%`, '50%')}/>
      </div>
    </div>
  );
}

/* Пипетка. Системный EyeDropper из Chromium (в WebView2 он есть): нажал —
   экран темнеет, водишь мышью, клик забирает цвет пикселя. Отдаёт sRGBHex,
   то есть ровно то, что понимает ColorField.

   Вызов обязан идти из обработчика клика: без пользовательского жеста
   браузер отказывает. Отмену (Escape) глотаем — это не ошибка. Если API
   нет (старый WebView2), кнопка просто не рисуется: мёртвая кнопка хуже
   отсутствующей. */
function EyedropperButton({ onChange }) {
  const t = useLang();
  if (typeof window === 'undefined' || typeof window.EyeDropper !== 'function') return null;
  const pick = async () => {
    try {
      const res = await new window.EyeDropper().open();
      if (res?.sRGBHex) onChange(res.sRGBHex.toLowerCase());
    } catch { /* отменили — ничего не делаем */ }
  };
  return (
    <div role="button" tabIndex={0} title={t('pick_color')} aria-label={t('pick_color')}
      onClick={pick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = 'rgba(255,255,255,0.9)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = 'rgba(255,255,255,0.62)'; }}
      style={{
        width: 30, height: 28, flexShrink: 0, borderRadius: 8, cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'rgba(255,255,255,0.62)', background: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.09)',
        transition: 'background 0.15s ease, color 0.15s ease',
      }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="m2 22 1-1h3l9-9"/>
        <path d="M3 21v-3l9-9"/>
        <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>
      </svg>
    </div>
  );
}

/* Hex-поле с локальным черновиком. Напрямую значение в state не годится:
   пользователь набирает «ff0000» и на второй же букве «ff» получает
   откат — поле не даёт допечатать. Поэтому текст живёт здесь, наружу
   уходит разобранный цвет, а по потере фокуса черновик приводится к
   тому, что реально применено.

   Трёхзначную запись принимаем как есть: пользователь ставит курсор в
   середину строки и вбивает «ff0» — это уже цвет, и требовать дописывания
   до шести знаков было бы придиркой к способу печатать. */
function ColorField({ value, onChange }) {
  const [text, setText] = useState(value);
  const [dirty, setDirty] = useState(false);
  /* синхронизация извне: пикер, второй цвет, «удиви меня» и пресет меняют
     значение, не проходя через это поле — без эффекта оно показывало бы
     прошлый цвет */
  useEffect(() => {
    if (!dirty) setText(value);
  }, [value, dirty]);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <input type="color" className="th-color" value={value} onChange={e => onChange(e.target.value)}/>
      <input className="th-hex" value={text} spellCheck={false}
        onChange={e => {
          const s = e.target.value;
          setText(s);
          setDirty(true);
          /* применяем как только цвет дописан — тогда результат виден
             сразу, без отдельного «применить» и без потери фокуса */
          const c = hexToRgb(s) || (s.length === 3
            ? hexToRgb('#' + s[0] + s[0] + s[1] + s[1] + s[2] + s[2])   /* «ff0» → #ff00aa */
            : null);
          if (c) onChange(rgbToHex(c.r, c.g, c.b));
        }}
        onBlur={() => { setDirty(false); setText(value); }}/>
      <EyedropperButton onChange={onChange}/>
    </div>
  );
}

/* Ряд «подпись — значение» для параметров, которые меняют одну цифру.
   Отдельного компонента не делал: это две строки, а рост компонентов
   в файле уже заметно мешает читать соседние секции. */
function ThRow({ label, children, dim }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
      padding: '11px 16px', opacity: dim ? 0.4 : 1, transition: 'opacity 0.22s ease',
    }}>
      <span style={{ fontSize: 'var(--fs-md)', color: SN.hi }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>{children}</div>
    </div>
  );
}

/* Плитка темы в сетке. Общая для наборов и для сохранённых — отличаются
   только подпись и наличие крестика, а превью и подсветка должны быть
   ровно одни и те же, иначе «своя» тема выглядела бы как другая карточка
   из другого списка.

   `onDelete` рисуется поверх превью, а не под подписью: подпись у плитки
   своя, и добавление туда кнопки ломало бы высоту всех плиток в ряду —
   соседние поехали бы вниз на высоту крестика. */
function ThemeTile({ label, theme, active, onClick, onDelete, deleteTitle, mica, accent }) {
  /* mica-плитка рисует не тему, а материал: своего фона у неё нет, поэтому
     берём тёмную подложку и два мягких пятна в цвете акцента Windows — так
     карточка обещает ровно то, что даёт набор (полупрозрачное окно + обложки
     в системный цвет), а не ещё один градиент. */
  const ac = accent || theme.accent;
  const a2 = theme.accentGrad ? theme.accent2 : ac;
  return (
    <div title={label} role="button" data-motion-spatial=""
      onClick={onClick}
      style={{
        position: 'relative', padding: 0, cursor: 'pointer', borderRadius: 11, overflow: 'hidden',
        /* двухслойное кольцо: внутреннее цвета подложки отделяет карточку от
           соседей, внешнее — сам выбор */
        boxShadow: active
          ? '0 0 0 2px rgba(10,10,14,0.9), 0 0 0 3.5px var(--accent)'
          : 'inset 0 0 0 1px rgba(255,255,255,0.07)',
        transform: active ? 'translateY(-1px)' : 'none',
        transition: 'box-shadow 0.2s ease, transform 0.2s ease',
      }}
      onMouseEnter={e => {
        if (active) return;
        e.currentTarget.style.boxShadow = 'inset 0 0 0 1px rgba(255,255,255,0.16)';
      }}
      onMouseLeave={e => {
        if (active) return;
        e.currentTarget.style.boxShadow = 'inset 0 0 0 1px rgba(255,255,255,0.07)';
      }}>
      <div style={{
        position: 'relative', height: 46,
        backgroundColor: mica ? '#0b0b10'
          : (theme.bgMode === 'default' ? THEME_DEFAULT.bgColor : theme.bgColor),
        /* подставляем СВОЙ акцент плитки: в самом окне здесь встаёт
           var(--accent-rgb), а в превью он был бы общим для всех плиток,
           и режим «под обложку» показывал бы у всех один и тот же фон */
        backgroundImage: mica
          ? `radial-gradient(120% 95% at 12% 0%, ${ac}55 0%, transparent 62%),`
            + `radial-gradient(95% 85% at 92% 100%, ${ac}2e 0%, transparent 60%),`
            + 'linear-gradient(140deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.015) 46%, transparent 70%)'
          : themeBgImage(theme, rgbTriplet(theme.accent)),
      }}>
        {/* полоска акцента внизу — та же линия, что у верхнего края окна,
            только без второго цвета: в превью места нет, а разница в один
            градиент ничего не решает */}
        <div style={{
          position: 'absolute', left: 7, bottom: 7, height: 5, width: '46%',
          borderRadius: 3, background: `linear-gradient(to right, ${ac}, ${a2})`,
          boxShadow: `0 0 8px ${ac}66`,
        }}/>
        <div style={{
          position: 'absolute', right: 7, top: 7, width: 10, height: 10, borderRadius: '50%',
          background: ac, boxShadow: `0 0 9px ${ac}`,
        }}/>
      </div>
      <div style={{
        padding: '6px 8px 7px', fontSize: 'var(--fs-xs)',
        fontWeight: active ? 600 : 500,
        color: active ? 'rgba(255,255,255,0.94)' : SN.mid,
        background: active ? 'rgba(255,255,255,0.055)' : 'rgba(255,255,255,0.022)',
        transition: 'color 0.18s ease, background 0.18s ease',
      }}>{label}</div>
      {onDelete && (
        <div role="button" title={deleteTitle} aria-label={deleteTitle}
          onClick={e => { e.stopPropagation(); onDelete(); }}
          style={{
            position: 'absolute', right: 5, top: 5, width: 20, height: 20, borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', color: 'rgba(255,255,255,0.5)',
            /* затемнение кружка под крестиком, иначе на светлом превью он
               не читался бы — подпись темы может быть любой */
            background: 'rgba(10,10,14,0.55)',
            transition: 'color 0.15s ease, background 0.15s ease',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.background = 'rgba(255,90,80,0.8)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.5)'; e.currentTarget.style.background = 'rgba(10,10,14,0.55)'; }}>
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor"
            strokeWidth="1.6" strokeLinecap="round">
            <path d="M2 2l6 6M8 2l-6 6"/>
          </svg>
        </div>
      )}
    </div>
  );
}

/* Тумблер. Включённое состояние — заливка акцентом: раньше трек был
   `rgba(255,255,255,0.5)`, то есть тем же серым, что и галочка рядом, и
   «включено» читалось только по форме. Заливка акцентом работает и при
   режиме «от обложки»: appAccent поднят по светлоте до 110 (см. App), так
   что тёмная обложка не даёт чёрный тумблер.
   `disabled` гасит только курсор и клик: гасить ещё и заливку нельзя —
   строка вокруг уже приглушена через Row dim, и две прозрачности подряд
   уронили бы тумблер в невидимость. */
function Switch({ on, onChange, disabled, label }) {
  return (
    <div role="switch" aria-checked={!!on} aria-disabled={disabled || undefined}
      aria-label={label} tabIndex={label && !disabled ? 0 : undefined}
      onKeyDown={e => {
        if (label && !disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onChange(!on); }
      }}
      onClick={() => { if (!disabled) onChange(!on); }}
      style={{
        width: 36, height: 21, borderRadius: 11, flexShrink: 0, position: 'relative',
        cursor: disabled ? 'default' : 'pointer',
        background: on ? 'var(--accent)' : 'rgba(255,255,255,0.11)',
        /* ореол домножается на --glow-strength, иначе ползунок «сила свечений»
           в «Оформлении» двигал бы всё, кроме тумблеров */
        boxShadow: on ? '0 0 10px rgba(var(--accent-rgb),calc(0.28 * var(--glow-strength,1)))' : 'none',
        transition: 'background 0.24s ease, box-shadow 0.24s ease',
      }}>
      <div style={{
        position: 'absolute', top: 3.5, width: 14, height: 14, borderRadius: '50%',
        background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
        left: on ? 19 : 3.5,
        transition: 'left 0.24s cubic-bezier(0.32,0.72,0,1)',
      }}/>
    </div>
  );
}

/* Сегменты: выбор из двух-трёх вариантов. Пилл ездит по `layoutId`, поэтому
   переключение не мигает. Активный сегмент — подложка акцентом плюс
   светлая подпись: сам акцент в текст не пускаем, он приглушён и на мелком
   кегле теряется, зато подложка работает на любой светлоте.

   ⚠️ У пилла НЕТ обводки (`inset 0 0 0 1px`). Раньше она была, и на
   прозрачном акценте читалась как рамка вокруг выбранного пункта — на
   светлой теме или при слабом свечении это выглядело клетчатой таблицей,
   а не выбором. Убрана по просьбе. Взамен подложка поднята с 0.15 до 0.2:
   раньше часть контраста пилла давала рамка, и без неё он был бы заметно
   бледнее соседей. */
/* Каждая подложка живёт у своего пункта. Никаких общих layoutId:
   активный чип только проявляется на месте, в том числе при входе в раздел. */
function SelectionFill({ active, className = '', style }) {
  return <div aria-hidden="true" className={`selection-fill ${className}`}
    data-active={String(!!active)} style={style}/>;
}

function Segmented({ value, options, onChange, disabled, stretch, label: groupLabel }) {
  return (
    <div role={groupLabel ? 'group' : undefined} aria-label={groupLabel} style={{
      display: stretch ? 'flex' : 'inline-flex',
      gap: 2, padding: 3, borderRadius: 11, background: 'rgba(255,255,255,0.04)',
      opacity: disabled ? 0.4 : 1, pointerEvents: disabled ? 'none' : 'auto',
      transition: 'opacity 0.2s ease',
    }}>
      {options.map(({ v, label, icon }) => {
        const active = value === v;
        return (
          <div key={v} onClick={() => { if (active) return; onChange(v); }}
            role={groupLabel ? 'button' : undefined} aria-pressed={groupLabel ? active : undefined}
            tabIndex={groupLabel && !disabled ? 0 : undefined}
            onKeyDown={e => {
              if (groupLabel && !disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onChange(v); }
            }}
            style={{
              position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 6, padding: '6px 13px', borderRadius: 9, cursor: 'pointer',
              flex: stretch ? 1 : undefined,
              color: active ? 'rgba(255,255,255,0.92)' : SN.mid,
              transition: 'color 0.18s ease',
            }}>
            <SelectionFill active={active} style={{
              position: 'absolute', inset: 0, borderRadius: 9,
              background: 'rgba(var(--accent-rgb),0.2)',
            }}/>
            <span style={{
              position: 'relative', display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 'var(--fs-sm)', fontWeight: active ? 600 : 500, whiteSpace: 'nowrap',
            }}>{icon}{label}</span>
          </div>
        );
      })}
    </div>
  );
}

/* Кнопка. Три тона: спокойная, главная и опасная. Раньше на экране было пять
   разных кнопок — свой радиус, отступ и цвет у входа, выхода, очистки кэша,
   выбора папки и удаления. */
function Btn({ children, tone = 'quiet', onClick, disabled, title }) {
  const T = {
    quiet:  { bg: SN.fill,                            hov: 'rgba(255,255,255,0.09)', fg: SN.mid },
    accent: { bg: 'rgba(var(--accent-rgb),0.12)',      hov: 'rgba(var(--accent-rgb),0.2)',  fg: 'var(--accent)' },
    danger: { bg: 'rgba(255,84,84,0.09)',              hov: 'rgba(255,84,84,0.17)',      fg: 'rgba(255,110,100,0.92)' },
    /* вход в soundcloud оранжевым: это не «главное действие раздела», это
       бренд площадки, и путать его с акцентом интерфейса не надо */
    brand:  { bg: 'rgba(255,85,0,0.11)',               hov: 'rgba(255,85,0,0.19)',       fg: 'rgba(255,140,60,0.92)' },
  }[tone];
  return (
    <div role="button" title={title} onClick={disabled ? undefined : onClick}
      style={{
        background: T.bg, color: T.fg, fontSize: 'var(--fs-sm)', fontWeight: 500,
        padding: '6px 14px', borderRadius: 9, flexShrink: 0,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
        transition: 'background 0.15s, color 0.15s, opacity 0.15s',
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = T.hov; }}
      onMouseLeave={e => { if (!disabled) e.currentTarget.style.background = T.bg; }}
    >{children}</div>
  );
}

/* Степпер числовой настройки. Раньше был свёрстан прямо в строке и не умел
   показывать, что уже на минимуме: − жал бесконечно. */
function Stepper({ value, onChange, step = 5, min = 0, label }) {
  const btn = (dir, glyph) => {
    const edge = dir < 0 ? value <= min : false;
    return (
      <div onClick={() => { if (!edge) onChange(value + dir * step); }}
        style={{
          width: 26, height: 26, borderRadius: 8, display: 'flex', alignItems: 'center',
          justifyContent: 'center', cursor: edge ? 'default' : 'pointer',
          background: SN.fill,
          color: edge ? 'rgba(255,255,255,0.14)' : SN.mid,
          fontSize: 15, lineHeight: 1, paddingBottom: 2,
          transition: 'background 0.15s, color 0.15s',
        }}
        onMouseEnter={e => { if (!edge) e.currentTarget.style.background = 'rgba(255,255,255,0.09)'; }}
        onMouseLeave={e => { if (!edge) e.currentTarget.style.background = SN.fill; }}
      >{glyph}</div>
    );
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {btn(-1, '−')}
      {/* tabular-nums: без него цифры прыгают по ширине и счётчик дёргается
         на каждом шаге, потому что окно неприлично узкое и не меняет размер */}
      <span style={{
        minWidth: 48, textAlign: 'center', fontSize: 'var(--fs-md)', color: SN.hi,
        fontVariantNumeric: 'tabular-nums',
      }}>{label}</span>
      {btn(1, '+')}
    </div>
  );
}

/* Геометрия морфится от уже показанного кадра: быстрые повторные клики не
   сбрасывают линии. Разряд следует обеим кривым независимо от эффекта EQ. */
function CrossfadeCurvePreview({ curve }) {
  const t = useLang();
  const reduced = useReducedMotion();
  const filterId = `crossfade-glow-${useId().replace(/:/g, '')}`;
  const lines = useRef({});
  const bolts = useRef({});
  const shown = useRef(crossfadeCurvePoints(curve));
  const previous = useRef(curve);
  const path = points => points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  const paint = points => {
    shown.current = points;
    lines.current.out?.setAttribute('d', path(points.out));
    lines.current.in?.setAttribute('d', path(points.in));
  };
  const clear = () => {
    for (const el of Object.values(bolts.current)) {
      el?.setAttribute('d', '');
      if (el) el.style.opacity = 0;
    }
  };
  useLayoutEffect(() => { paint(shown.current); }, []);
  useEffect(() => {
    const changed = previous.current !== curve;
    previous.current = curve;
    const from = shown.current;
    const to = crossfadeCurvePoints(curve);
    clear();
    if (!changed || reduced) { paint(to); return; }
    let frame;
    const start = performance.now();
    const tick = now => {
      const elapsed = Math.max(0, now - start);
      const progress = Math.min(1, elapsed / 420);
      const points = mixCurvePoints(from, to, 1 - (1 - progress) ** 4);
      paint(points);
      const alpha = crossfadeBoltEnvelope(elapsed) * 0.72;
      if (!alpha) { clear(); return; }
      const anchors = channel => points[channel].filter((_, i) => i % 6 === 0);
      const outgoing = anchors('out'), incoming = anchors('in');
      const d = `${crossfadeBoltPath(outgoing)} ${crossfadeBoltPath(incoming)}`;
      bolts.current.main.setAttribute('d', d);
      bolts.current.glow.setAttribute('d', d);
      bolts.current.bits.setAttribute('d', `${crossfadeBoltBranches(outgoing)} ${crossfadeBoltBranches(incoming)}`);
      bolts.current.main.style.opacity = alpha;
      bolts.current.glow.style.opacity = alpha * 0.36;
      bolts.current.bits.style.opacity = alpha * 0.5;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); clear(); };
  }, [curve, reduced]);
  return <div className="crossfade-preview">
    <svg viewBox="0 0 320 132" role="img" aria-label={t('crossfade_preview')}>
      <defs>
        <filter id={filterId} x="-30%" y="-80%" width="160%" height="260%">
          <feGaussianBlur stdDeviation="3"/>
        </filter>
      </defs>
      <path ref={el => { lines.current.out = el; }} fill="none" stroke="var(--text)" strokeOpacity="0.46" strokeWidth="2.6" strokeLinecap="round"/>
      <path ref={el => { lines.current.in = el; }} fill="none" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round"/>
      <g aria-hidden="true" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path ref={el => { bolts.current.glow = el; }} stroke="var(--accent)" strokeWidth="7" filter={`url(#${filterId})`} opacity="0"/>
        <path ref={el => { bolts.current.bits = el; }} stroke="var(--accent)" strokeWidth="1" opacity="0"/>
        <path ref={el => { bolts.current.main = el; }} stroke="var(--text)" strokeWidth="1.25" opacity="0"/>
      </g>
    </svg>
    <div className="crossfade-preview-labels">
      <span>{t('crossfade_current')}</span><span>{t('crossfade_next')}</span>
    </div>
  </div>;
}

function CrossfadeCurvePicker({ value, onChange }) {
  const t = useLang();
  const reduced = useReducedMotion();
  return <div className="crossfade-curves" role="group" aria-label={t('crossfade_curve')}>
    {['power', 'smooth', 'linear'].map(curve => {
      const active = curve === value;
      const sample = crossfadeCurvePoints(curve).in;
      const path = sample.map((p, i) => `${i ? 'L' : 'M'}${(p.x - 12) / 296 * 38 + 3},${(p.y - 14) / 104 * 18 + 3}`).join(' ');
      return <motion.button key={curve} data-motion-spatial="" type="button" className="crossfade-curve" aria-pressed={active}
        whileTap={reduced ? undefined : { scale: 0.96 }} onClick={() => { if (!active) onChange(curve); }}>
        <SelectionFill active={active} className="crossfade-curve-active"/>
        <svg viewBox="0 0 44 24" aria-hidden="true"><path d={path} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
        <span>{t('crossfade_' + curve)}</span>
      </motion.button>;
    })}
  </div>;
}

/* Кривая на схеме и в звуке считается одной функцией. Дополнительные
   настройки остаются в дереве до завершения плавного закрытия. */
function CrossfadeControls({ settings, onSettings }) {
  const t = useLang();
  const config = crossfadeSettings(settings);
  const matched = CROSSFADE_PRESETS.find(preset =>
    Math.abs(config.seconds - preset.seconds) < 0.01 && config.curve === preset.curve
    && config.smart === preset.smart && Math.abs(config.intro - preset.intro) < 0.01)?.id;
  const setPreset = preset => {
    if (matched === preset.id) return;
    onSettings(s => ({ ...s, crossfade: preset.seconds, crossfadeLast: preset.seconds,
      crossfadeCurve: preset.curve, crossfadeSmart: preset.smart, crossfadeIntro: preset.intro }));
  };
  const set = (key, value) => onSettings({ ...settings, [key]: value });
  return <Card>
    <div className="settings-crossfade-highlight" aria-hidden="true"/>
    <Row label={t('crossfade')} last>
      <Switch label={t('crossfade')} on={config.seconds > 0} onChange={on => onSettings({ ...settings,
        crossfade: on ? (crossfadeSettings({ crossfade: settings.crossfadeLast ?? 5 }).seconds || 5) : 0,
        crossfadeLast: config.seconds || settings.crossfadeLast || 5,
      })}/>
    </Row>
    <div className="crossfade-presets" role="group" aria-label={t('crossfade')}>
      {CROSSFADE_PRESETS.map(preset => <button type="button" key={preset.id} className="crossfade-preset"
        aria-pressed={matched === preset.id} onClick={() => setPreset(preset)}
        title={`${t('crossfade_curve')}: ${t('crossfade_' + preset.curve)} · ${t('crossfade_intro')}: ${preset.intro ? `${preset.intro} ${t('sec')}` : t('off')}`}>
        <span>{t('crossfade_' + preset.id)}</span>
        <span className="crossfade-preset-duration">{preset.seconds} {t('sec')}</span>
      </button>)}
    </div>
    <Disclosure open={config.seconds > 0}>
      <MiniSlider label={t('crossfade_length')} min={0.5} max={CROSSFADE_MAX} step={0.5}
        value={config.seconds} display={`${config.seconds} ${t('sec')}`}
        onChange={value => set('crossfade', value)}/>
      <Row label={t('crossfade_curve')} last wrap>
        <CrossfadeCurvePicker value={config.curve} onChange={value => set('crossfadeCurve', value)}/>
      </Row>
      <CrossfadeCurvePreview curve={config.curve}/>
      <Row label={t('crossfade_smart')} last>
        <Switch label={t('crossfade_smart')} on={config.smart} onChange={value => set('crossfadeSmart', value)}/>
      </Row>
      <MiniSlider label={t('crossfade_intro')} min={0} max={10} step={0.5} value={config.intro}
        display={config.intro ? `${config.intro} ${t('sec')}` : t('off')}
        onChange={value => set('crossfadeIntro', value)}/>
    </Disclosure>
  </Card>;
}

/* ── ClearCacheCard ───────────────────────────────────────────────────────── */
function ClearCacheCard({ onClearCoversCache, onClearLikesCache }) {
  const t = useLang();
  const reduced = useReducedMotion();
  const [confirm, setConfirm] = useState(null);
  /* один confirm на оба кэша вместо двух: подтверждение относится к строке,
     а не к карточке, и два независимых флага держали в состоянии то, что
     всегда нужно не больше одного */
  const row = (label, sub, key, action, last) => (
    <Row label={label} sub={sub} last={last}>
      <Disclosure inline open={confirm === key} style={{ marginLeft: confirm === key ? 0 : -7 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Btn onClick={() => setConfirm(null)}>{t('cancel')}</Btn>
          <Btn tone="danger" onClick={() => { action(); setConfirm(null); }}>{t('del')}</Btn>
        </div>
      </Disclosure>
      <Disclosure inline open={confirm !== key} style={{ marginLeft: confirm === key ? -7 : 0 }}>
        <Btn onClick={() => setConfirm(key)}>{t('clear')}</Btn>
      </Disclosure>
    </Row>
  );
  return (
    <DisclosureLayout motionKey={confirm} reduced={reduced}>
      <Card title={t('cache')}>
        {row(t('covers_cache'), t('covers_cache_sub'), 'covers', onClearCoversCache)}
        {row(t('likes_cache'), t('likes_cache_sub'), 'likes', onClearLikesCache, true)}
      </Card>
    </DisclosureLayout>
  );
}

/* ── LyricsSettings ───────────────────────────────────────────────────────── */
/* пара «стрелки приоритета» у строки источника. на краях списка стрелка
   гаснет и не кликается. на модульном уровне — вложенный компонент
   пересоздавался бы на каждом рендере (см. TrackContextMenu) */
function SourceArrows({ i, count, onMove, upTitle, downTitle }) {
  return (
    <div className="lyr-arrows" style={{ display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }}>
      {[-1, 1].map(dir => {
        const edge = i + dir < 0 || i + dir >= count;
        return (
          <div key={dir} onClick={() => { if (!edge) onMove(i, dir); }}
            title={dir < 0 ? upTitle : downTitle}
            style={{
              width: 18, height: 12, borderRadius: 4,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: edge ? 'default' : 'pointer',
              color: edge ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.45)',
              transition: 'color 0.15s, background 0.15s',
            }}
            onMouseEnter={e => { if (!edge) e.currentTarget.style.color = 'rgba(255,255,255,0.85)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = edge ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.45)'; }}>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"
              style={{ transform: dir < 0 ? 'none' : 'rotate(180deg)' }}>
              <path d="m6 15 6-6 6 6"/>
            </svg>
          </div>
        );
      })}
    </div>
  );
}

function LyricsSettings({ settings, onSettings }) {
  const t = useLang();
  const on = cleanLyricsSources(settings.lyricsSources);
  /* порядок берётся из МАССИВА НАСТРОЕК, а не из реестра LYRICS_SOURCES.
     `LYRICS_SOURCES.filter(s => on.includes(s.id))` всегда возвращает порядок
     реестра, и стрелки «ничего не меняют»: массив перезаписывался правильно,
     но рендер снова сортировал его по исходному. сортируем по позиции в `on` */
  const byOrder = ids => ids
    .map(id => LYRICS_SOURCES.find(s => s.id === id))
    .filter(Boolean);
  const enabled  = byOrder(on);
  const disabled = byOrder(LYRICS_SOURCE_IDS.filter(id => !on.includes(id)));
  const line = HIDE_DIVIDERS ? 'none' : `1px solid ${SN.line}`;

  const write  = next => onSettings(s => ({ ...s, lyricsSources: next }));
  const toggle = id => write(on.includes(id) ? on.filter(x => x !== id) : [...on, id]);
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= on.length) return;   /* на границе списка — no-op */
    const next = on.slice();
    [next[i], next[j]] = [next[j], next[i]];
    write(next);
  };

  return (
    <Card>
      <div style={{
        padding: '14px 16px 13px', fontSize: 'var(--fs-xs)', color: SN.dim, lineHeight: 1.45,
      }}>{t('lyrics_sources_sub')}</div>

      {enabled.map((s, i) => (
        <div key={s.id} className="lyr-row" style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px 10px 12px',
          borderBottom: (disabled.length || i === enabled.length - 1) ? line : 'none',
        }}>
          <SourceArrows i={i} count={enabled.length} onMove={move}
            upTitle={t('lyrics_up')} downTitle={t('lyrics_down')}/>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 'var(--fs-md)', color: SN.hi }}>{s.label}</span>
            {s.synced && <Badge>{t('lyrics_synced')}</Badge>}
          </div>
          <Switch on onChange={() => toggle(s.id)}/>
        </div>
      ))}

      <Disclosure open={enabled.length === 0}>
        <div style={{
          padding: '2px 16px 15px', fontSize: 'var(--fs-xs)', color: SN.faint, lineHeight: 1.45,
        }}>{t('lyrics_all_off')}</div>
      </Disclosure>

      <Disclosure open={disabled.length > 0}>
          <div style={{
            padding: '12px 16px 5px',
            fontSize: 'var(--fs-eyebrow)', letterSpacing: '0.1em', textTransform: 'uppercase',
            color: SN.faint,
          }}>{t('lyrics_off')}</div>
          {disabled.map((s, i) => (
            <div key={s.id} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '9px 16px',
              borderBottom: i === disabled.length - 1 ? 'none' : line,
            }}>
              {/* место под стрелки, чтобы названия выключенных не съезжали влево */}
              <div style={{ width: 18, flexShrink: 0 }}/>
              <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-md)', color: SN.mid }}>
                {s.label}
              </span>
              <Switch on={false} onChange={() => toggle(s.id)}/>
            </div>
          ))}
      </Disclosure>
    </Card>
  );
}

/* ── SettingsView ─────────────────────────────────────────────────────────── */
/* ── что можно спрятать в интерфейсе ──────────────────────────────────────────
   Оформление → «Элементы интерфейса». Один объект вместо отдельных полей
   настроек: все ключи читаются одним смыслом («этот кусок скрыт»), и
   «вернуть всё» получается одной записью.

   Ключи: source — переключатель источника в шапке, volume — вертикальная
   громкость в плеере, miniPlayer — миниплеер в шапке, caption — подпись и счётчик списка, sort — чипсы
   сортировки. Функциональных тупиков нет: источник переключается в «Аккаунте»,
   громкость остаётся в микшере Windows, управление треками — в плеере,
   а подпись и чипсы — только оформление. */
const UI_HIDDEN_NONE = { source:false, miniPlayer:false, volume:false, caption:false, sort:false };
/* файл настроек может быть старее ключа: недостающее добираем дефолтом, иначе
   `settings.uiHidden.source` — это TypeError на первом же запуске */
const uiHiddenOf = s => ({ ...UI_HIDDEN_NONE, ...(s && s.uiHidden) });

function SettingsView({ settings, onSettings, visible, onScanTracks, onClearFolder, onClearCoversCache, onClearLikesCache, appAccent, scAuth, onScLogin, onScLogout, sec, setSec, discordStatus, winAccent, crossfadeFocus = 0 }) {
  const t = useLang();
  const lang = useLangCode();
  const reduced = useReducedMotion();
  const settingsScrollRef = useRef(null);
  const crossfadeTargetRef = useRef(null);
  const handledCrossfadeFocus = useRef(0);
  useEffect(() => {
    if (!visible || sec !== 'playback' || !crossfadeFocus || handledCrossfadeFocus.current === crossfadeFocus) return;
    let highlight, stopScroll;
    const frame = requestAnimationFrame(() => {
      const target = crossfadeTargetRef.current, scroller = settingsScrollRef.current;
      if (!target || !scroller) return;
      handledCrossfadeFocus.current = crossfadeFocus;
      target.focus({ preventScroll: true });
      const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 18;
      const targetTop = Math.max(0, top);
      scroller.scrollTo({ top: targetTop, behavior: reduced ? 'instant' : 'smooth' });
      stopScroll = () => scroller.scrollTo({ top: reducedMotionNow() ? targetTop : scroller.scrollTop, behavior: 'instant' });
      highlight = target.querySelector('.settings-crossfade-highlight')?.animate?.([
        { opacity: 0 }, { opacity: 0.2, offset: 0.12 },
        { opacity: 0.12, offset: 0.65 }, { opacity: 0 },
      ], { duration: 1600, delay: reduced ? 0 : 180, easing: 'ease-out' });
    });
    return () => { cancelAnimationFrame(frame); stopScroll?.(); highlight?.cancel(); };
  }, [visible, sec, crossfadeFocus, reduced]);
  /* Материал окна выключает подсветку акцента — см. карточку акцента */
  const micaOn = settings.windowEffect === 'mica';
  const [scLoading, setScLoading] = useState(false);
  const [scError, setScError] = useState(null);
  /* Коды из sc_login → человеческий текст (см. soundcloud.rs, sc_login). */
  const scLoginError = code => {
    switch (code) {
      case 'site_cert':      return t('sc_err_cert');
      case 'site_blocked':   return t('sc_err_blocked');
      case 'site_unreachable':
      case 'site_timeout':   return t('sc_err_offline');
      case 'login_interrupted':
      case 'login_closed':   return t('sc_err_closed');
      case 'login_timeout':  return t('sc_err_timeout');
      case 'window_failed':  return t('sc_err_window');
      case 'proxy_invalid':  return t('sc_err_proxy');
      default:               return t('conn_error');
    }
  };
  const scLogin = async () => {
    setScLoading(true); setScError(null);
    try {
      /* Прокси из интерфейса больше не вводится: провайдерские блокировки
         лечатся VPN на уровне системы. Аргумент остаётся null — rust сам
         посмотрит, не осталось ли значение в старых настройках. */
      const creds = await window.electronAPI.scLogin(null);
      /* Ошибка теперь приходит объектом с кодом и подробностью, а не null:
         молчаливое «кнопка вернулась на место» и было главной жалобой
         «не получается войти». */
      if (!creds || creds.error || !creds.token) {
        setScError(scLoginError(creds && creds.error));
        setScLoading(false);
        return;
      }
      const res = await window.electronAPI.scFetch('https://api-v2.soundcloud.com/me', creds.token, creds.clientId);
      if (res.data) onScLogin({ ...creds, userId: res.data.id, username: res.data.username, avatarUrl: res.data.avatar_url || null });
      else {
        /* Токен есть, а профиль не отдался: сессия мёртвая. Чистим её,
           иначе следующая попытка снова подхватит ту же cookie. */
        setScError(t('profile_error'));
        try { await window.electronAPI.scLogout(); } catch {}
      }
    } catch { setScError(t('conn_error')); }
    setScLoading(false);
  };
  const set = (k, v) => onSettings({ ...settings, [k]: v });
  /* Транспорт: битые настройки не должны давать ползунок с NaN. */
  const speed = clampNum(Number(settings.speed) || 1, SPEED_MIN, SPEED_MAX);
  const pitch = Math.round(clampNum(Number(settings.pitch) || 0, -PITCH_MAX, PITCH_MAX));
  const holdPitch = settings.shiftPitch === false;

  /* «Элементы интерфейса»: что из хрома спрятано. Пишем функциональной формой
     onSettings, а не {...settings}: тумблеры пишут один объект, и
     замыкание из прошлого рендера теряло бы соседнюю правку */
  const uiHidden  = uiHiddenOf(settings);
  /* цвет тонирования обложек; пустое/битое значение из старого файла → чёрный */
  const tintColor = settings.coverTintColor || '#000000';
  const tintMode  = ['color', 'accent'].includes(settings.coverTintMode)
    ? settings.coverTintMode : 'cover';
  const anyHidden = Object.values(uiHidden).some(Boolean);
  const setHidden = (k, v) => onSettings(s => ({
    ...s,
    uiHidden: k === null ? { ...UI_HIDDEN_NONE } : { ...uiHiddenOf(s), [k]: v },
  }));
  /* Тема. Значение нормализуется на КАЖДОМ чтении, а не только на записи:
     мусор из старого settings.json (или из чужой вставки) обязан молча
     чиниться, иначе любой потребитель ниже получил бы NaN в градиенте.
     Сама запись — через setTh, и он же гасит метку пресета, если правка
     пришла мимо карточки: иначе подсветка осталась бы на наборе, которого
     в теме уже нет. */
  const th = cleanTheme(settings.theme);
  const setTh = patch => onSettings(s => {
    const next = { ...(s.theme || THEME_DEFAULT), ...patch };
    if (!Object.prototype.hasOwnProperty.call(patch, 'preset')) next.preset = null;
    return { ...s, theme: cleanTheme(next) };
  });
  /* Свои темы. Читаются через cleanUserThemes на каждом рендере — как и
     theme: список лежит на диске и может прийти мусорным. */
  const userThemes = cleanUserThemes(settings.userThemes);
  const setUserThemes = fn => onSettings(s => ({
    ...s, userThemes: cleanUserThemes(fn(cleanUserThemes(s.userThemes))),
  }));
  /* Применение набора. Отдельная функция, а не setTh, потому что тема
     «Обложка» живая только вместе с акцентом от обложки: её фон считается
     от --accent-rgb, и при зафиксированном акценте он был бы просто
     одноцветной подложкой — то есть набор вёл бы себя не так, как
     обещает. */
  const applyTheme = (v, presetId, fx) => onSettings(s => {
    const next = {
      ...s,
      ...(fx || {}),
      theme: cleanTheme({ ...THEME_DEFAULT, ...v, preset: presetId }),
    };
    if (v.bgMode === 'cover' && s.accentMode !== 'cover') next.accentMode = 'cover';
    /* материал несовместим с подсветкой акцента — то же правило, что у
       тумблера материала, и здесь оно должно сработать сразу, а не следующим
       эффектом: иначе сегменты акцента на кадр останутся включёнными */
    if (next.windowEffect === 'mica') next.accentMode = 'off';
    return next;
  });
  const secRefs  = useRef({});
  const [pill, setPill] = useState({ top:0, height:0 });

  useLayoutEffect(() => {
    const el = secRefs.current[sec];
    if (!el) return;
    const parent = el.parentElement;
    const pr = parent.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    setPill({ top: er.top - pr.top, height: er.height });
  }, [sec]);

  /* Иконки разделов. Набор из assets разношёрстный и цветной, поэтому раньше
     их приходилось выбеливать фильтром — и выбранный пункт нельзя было
     покрасить в акцент. Теперь это штриховые иконки на currentColor, и
     активный пункт красится целиком: и иконка, и подпись. */
  const SECS = [
    { id:'account',  label:t('card_account'),
      icon:<SoundCloudIcon size={14} fill="currentColor"/> },
    { id:'playback', label:t('sec_playback'),
      icon:<SettingsIcon><path d="M4 9.5h3L11.5 6v12L7 14.5H4z"/><path d="M15 9.2a4 4 0 0 1 0 5.6"/><path d="M17.6 6.6a7.6 7.6 0 0 1 0 10.8"/></SettingsIcon> },
    { id:'lyrics',   label:t('sec_lyrics'),
      icon:<SettingsIcon><path d="M4.5 6.5h15"/><path d="M4.5 12h15"/><path d="M4.5 17.5h9"/></SettingsIcon> },
    { id:'discord',  label:t('sec_discord'),
      icon:<DiscordIcon size={15} fill="currentColor"/> },
    { id:'appearance', label:t('sec_appearance'),
      icon:<SettingsIcon><circle cx="12" cy="12" r="8.2"/><path d="M12 3.8a8.2 8.2 0 0 1 0 16.4z" fill="currentColor" stroke="none"/></SettingsIcon> },
    { id:'system',   label:t('sec_system'),
      icon:<SettingsIcon><path d="M4 8.5h9"/><path d="M18.5 8.5H20"/><path d="M4 15.5h4"/><path d="M13.5 15.5H20"/><circle cx="15.2" cy="8.5" r="2.3"/><circle cx="10.2" cy="15.5" r="2.3"/></SettingsIcon> },
    { id:'about',    label:t('sec_about'),
      icon:<SettingsIcon><circle cx="12" cy="12" r="8.4"/><path d="M12 11.2v5.4"/><path d="M12 7.8v.6"/></SettingsIcon> },
  ];

  const content = {
    /* Без надзаголовка у первой карточки: раздел уже назван в навигации, и
       два одинаковых слова подряд читались как сбой. */
    account: (
      <Card>
        {scAuth ? (
          <div style={{ display:'flex', alignItems:'center', gap:13, padding:'14px 16px' }}>
            <div style={{
              width: 40, height: 40, borderRadius: 13, flexShrink: 0, overflow: 'hidden',
              background: 'rgba(255,255,255,0.05)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: SN.dim,
            }}>
              {scAuth.avatarUrl
                ? <img src={scAuth.avatarUrl} style={{ width:'100%', height:'100%', objectFit:'cover' }}/>
                : <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
              }
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 'var(--fs-md)', fontWeight: 600, color: 'rgba(255,255,255,0.88)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{scAuth.username || t('unknown')}</div>
              <div style={{
                fontSize: 'var(--fs-eyebrow)', color: SN.dim, letterSpacing: '0.09em',
                textTransform: 'uppercase', marginTop: 3,
              }}>soundcloud</div>
            </div>
            <Btn onClick={onScLogout}>{t('logout')}</Btn>
          </div>
        ) : (
          <div style={{ padding: '14px 16px 16px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:13, marginBottom: 13 }}>
              <div style={{
                width: 40, height: 40, borderRadius: 13, flexShrink: 0,
                background: 'rgba(255,85,0,0.08)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <SoundCloudIcon size={21} fill="rgba(255,100,20,0.6)"/>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 'var(--fs-md)', fontWeight: 600,
                  color: 'rgba(255,255,255,0.62)', marginBottom: 3,
                }}>{t('sc_not_connected')}</div>
                <div style={{
                  fontSize: 'var(--fs-xs)', color: SN.dim, lineHeight: 1.5,
                }}>{t('sc_hint').split('\n').map((l, i) => <span key={i}>{l}{i === 0 && <br/>}</span>)}</div>
              </div>
            </div>
            {scError && (
              <div style={{ fontSize: 'var(--fs-xs)', color: 'rgba(255,90,70,0.75)', marginBottom: 11 }}>
                {scError}
              </div>
            )}
            <Btn tone="brand" onClick={scLogin} disabled={scLoading}>
              {scLoading ? t('opening_browser') : t('login_browser')}
            </Btn>
          </div>
        )}
        {/* Источник библиотеки. Раньше переключался только иконкой папки в
            шапке — а её можно спрятать (Оформление → Элементы интерфейса), и
            тогда переключение осталось бы без единой ручки в интерфейсе.
            Здесь же оно и по смыслу: облако — это про аккаунт. */}
        <Disclosure open={!!scAuth}>
          <Row label={t('source_label')} sub={t('source_sub')}>
            <Segmented id="segSource" value={settings.sourceMode === 'sc' ? 'sc' : 'local'}
              onChange={v => set('sourceMode', v)}
              options={[{ v:'local', label:t('source_local') }, { v:'sc', label:t('source_sc') }]}/>
          </Row>
        </Disclosure>
      </Card>
    ),
    playback: (<>
      <div ref={crossfadeTargetRef} className="settings-crossfade-target" tabIndex={-1}
        role="group" aria-label={t('crossfade')}>
        <CrossfadeControls settings={settings} onSettings={onSettings}/>
      </div>

      <Card title={t('speed_pitch')}>
        <MiniSlider label={t('speed')} value={speed} min={SPEED_MIN} max={SPEED_MAX} step={0.01}
          display={`${speed.toFixed(2)}×`}
          onChange={v => set('speed', Math.round(v * 100) / 100)}/>
        {/* «горит» = высота не едет, то есть по умолчанию он выключен:
            скорость меняет и темп, и тон, как у магнитофона. кому это мешает
            (подкаст, вокал) — включает и получает чистый тайм-стретч */}
        <Row label={t('hold_pitch')} sub={t('hold_pitch_sub')}>
          <Switch label={t('hold_pitch')} on={holdPitch} onChange={v => set('shiftPitch', !v)}/>
        </Row>
        <MiniSlider label={t('pitch')} value={pitch} min={-PITCH_MAX} max={PITCH_MAX} step={1}
          display={`${pitch > 0 ? '+' : ''}${pitch} ${t('semitones')}`}
          onChange={v => set('pitch', v)}/>
      </Card>
    </>),
    lyrics: (
      <LyricsSettings settings={settings} onSettings={onSettings}/>
    ),
appearance: (<>
{/* ⚠️ Материал окна и тема несовместимы: DWM рисует мику ПОД окном,
          а акцент и свой фон — это свет OUR OWN слоя над ней, и они бьют по
          одному и тому же. Поэтому при включённом материале и акцент, и
          редактор фона заблокированы, а не просто гаснут: иначе можно было
          бы включить материал, потом тыкнуть «Цвет» и снова получить
          несовместимую комбинацию. Гасит их сам тумблер материала внизу. */}
      <Card title={t('card_themes')}>
        {/* Сетка наборов. Превью рисует ровно то, что получится у оболочки:
            тот же фон (цвет + тот же градиент), полоска акцента внизу и
            кружок с ореолом. Настоящий фон окна за карточкой не видно — он
            закрыт содержимым, поэтому превью и есть единственный честный
            способ показать тему до применения. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, padding: '14px 16px 14px' }}>
          {THEME_PRESETS.map(p => {
            /* «Материал» — единственный набор с побочными настройками, и
               активен он только пока материал действительно включён: если DWM
               его не принял (Windows 10), тумблер откатился, и подсвеченная
               карточка врала бы про состояние окна. */
            const isMica = p.fx?.windowEffect === 'mica';
            return (
              <ThemeTile key={p.id} label={p.label} theme={cleanTheme({ ...THEME_DEFAULT, ...p.v })}
                mica={isMica} accent={isMica ? (winAccent || THEME_DEFAULT.accent) : undefined}
                active={th.preset === p.id && (!isMica || settings.windowEffect === 'mica')}
                onClick={() => applyTheme(p.v, p.id, p.fx)}/>
            );
          })}
        </div>
        {/* Свои темы. Отдельная строка, а не вперемешку с наборами: свои
            можно удалить, и перемешивать их с вечными наборами значило бы
            показывать крестик то на одной, то на другой карточке. */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
          padding: '12px 16px', borderTop: `1px solid ${SN.line}`,
        }}>
          <span style={{ fontSize: 'var(--fs-xs)', color: SN.faint }}>{t('theme_mine_list')}</span>
          <Btn tone="quiet" onClick={() => setUserThemes(list => [
            ...list,
            { id: newThemeId(), name: themeHueName(th.accent, lang), v: { ...th, preset: null } },
          ])}>{t('theme_save')}</Btn>
        </div>
        <Disclosure open={userThemes.length > 0}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, padding: '0 16px 14px' }}>
            {userThemes.map(u => (
              <ThemeTile key={u.id} label={u.name} theme={cleanTheme(u.v)}
                active={th.preset === u.id} deleteTitle={t('theme_delete')}
                onClick={() => applyTheme(cleanTheme(u.v), u.id)}
                onDelete={() => setUserThemes(list => list.filter(x => x.id !== u.id))}/>
            ))}
          </div>
        </Disclosure>
        {/* Нижний ряд навыков. «Удиви меня» собирает тему из новых цветов и
            заодно снимает метку пресета: получившееся ни с чем не совпадёт,
            и подсветка осталась бы на чужой карточке. */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
          padding: '11px 16px', borderTop: `1px solid ${SN.line}`,
        }}>
          <span style={{ fontSize: 'var(--fs-xs)', color: SN.faint }}>
            {th.preset
              ? THEME_PRESETS.find(p => p.id === th.preset)?.label ?? t('theme_mine')
              : t('theme_mine')}
          </span>
          <div style={{ display: 'flex', gap: 7 }}>
            <Btn tone="accent" onClick={() => {
              /* фон тёмный и в тон акценту: тот же оттенок, светлота убита.
                 Иначе случайный светлый фон выбивал бы белый текст интерфейса,
                 который написан фиксированными белыми прозрачностями */
              setTh({
                accent: randomVividHex(), accent2: randomVividHex(),
                bgColor: randomDeepHex(), bgColor2: randomDeepHex(),
                bgAngle: Math.round(Math.random() * 360),
                glowStrength: 0.8 + Math.random() * 0.7,
                radius: [0, 8, 12, 16, 20, 26][Math.floor(Math.random() * 6)],
                grain: [0, 0.022, 0.04, 0.07][Math.floor(Math.random() * 4)],
              });
            }}>{t('theme_random')}</Btn>
            <Btn onClick={() => setTh({ ...THEME_DEFAULT })}>{t('theme_reset')}</Btn>
          </div>
        </div>
      </Card>

      <Card>
        <div style={{ padding: '14px 16px 0', fontSize: 'var(--fs-xs)', color: SN.dim, lineHeight: 1.45 }}>
          {t('accent_sub')}
        </div>
        <Disclosure open={micaOn}>
          <div style={{
            display:'flex', gap:8, margin:'12px 16px 0', padding:'8px 11px',
            border:`1px solid ${SN.line}`,
            borderRadius:9, background:'rgba(255,255,255,0.028)',
            fontSize:'var(--fs-xs)', color:'rgba(255,255,255,0.34)', lineHeight:1.45,
          }}>
            <div style={{
              width:6, height:6, borderRadius:'50%', marginTop:5, flexShrink:0,
              background:'var(--accent)', opacity:0.7,
            }}/>
            <div>{t('mica_accent_lock')}</div>
          </div>
        </Disclosure>
        {(() => {
          const mode = settings.accentMode || 'color';
          const segIcon = paths => (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{paths}</svg>
          );
          const SEGS = [
            ['off',   t('accent_seg_off'),   segIcon(<><path d="M12 3v9"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/></>)],
            ['color', t('accent_seg_color'), segIcon(<path d="M12 2.7s6.3 6.8 6.3 11.1a6.3 6.3 0 1 1-12.6 0C5.7 9.5 12 2.7 12 2.7z"/>)],
            ['cover', t('accent_cover'),     segIcon(<><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m21 16-5-5-4.5 4.5"/></>)],
          ];
          return (
            <>
              {/* сегмент Выкл | Цвет | От обложки. Тот же Segment, что у
                  таймстампа discord и у языка: раньше сегменты, чипсы и
                  кнопки языка были тремя разными контролами с разными
                  радиусами и отступами. Пилл ездит по layoutId и переезжает
                  между опциями, `stretch` растягивает их на ширину колонки. */}
              <div style={{ padding:'14px 16px 0' }}>
                <Segmented stretch id="accentSegPill" value={mode} disabled={micaOn}
                  onChange={id => onSettings(s => ({ ...s, accentMode: id }))}
                  options={SEGS.map(([v, label, icon]) => ({ v, label, icon }))}/>
              </div>
              {/* Режимы остаются смонтированными: открытие и закрытие
                  продолжаются от текущего кадра даже при быстрых кликах. */}
              <div style={{ padding: '16px 16px 0' }}>
                <Disclosure open={mode === 'color'}>
                  <div style={{ display: 'flex', gap: 14 }}>
                    <ColorPad hex={th.accent} onChange={hex => setTh({ accent: hex })}/>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <ColorField value={th.accent} onChange={hex => setTh({ accent: hexOr(hex, th.accent) })}/>
                      <div style={{ marginTop: 9 }}>
                        <Btn tone="quiet" onClick={() => setTh({ accent: randomVividHex() })}>
                          {t('accent_random')}
                        </Btn>
                      </div>
                      {/* Второй цвет. Дергает не весь интерфейс, а одну
                          полосу у верхнего края окна — и именно поэтому
                          включается одиноким кубиком, а не сегментом режима */}
                      <div style={{
                        marginTop: 13, display: 'flex', alignItems: 'center',
                        justifyContent: 'space-between', gap: 10,
                      }}>
                        <span style={{ fontSize: 'var(--fs-xs)', color: SN.mid }}>{t('accent_second')}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                          <div role="switch" aria-checked={th.accentGrad} title={t('accent_second_sub')}
                            onClick={() => setTh({ accentGrad: !th.accentGrad })}
                            style={{
                              width: 32, height: 19, borderRadius: 10, cursor: 'pointer', position: 'relative',
                              flexShrink: 0,
                              background: th.accentGrad ? 'var(--accent)' : 'rgba(255,255,255,0.11)',
                              boxShadow: th.accentGrad
                                ? '0 0 10px rgba(var(--accent-rgb),calc(0.28 * var(--glow-strength,1)))' : 'none',
                              transition: 'background 0.24s ease, box-shadow 0.24s ease',
                            }}>
                            <div style={{
                              position: 'absolute', top: 3, width: 13, height: 13, borderRadius: '50%',
                              background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                              left: th.accentGrad ? 16 : 3,
                              transition: 'left 0.24s cubic-bezier(0.32,0.72,0,1)',
                            }}/>
                          </div>
                          {/* Пикер показываем только когда второй цвет реально
                              на что-то влияет: выключенный кубик с полем рядом
                              читался как «уже задано», но не влияло ни на что */}
                           <Disclosure inline open={th.accentGrad} style={{ marginLeft: th.accentGrad ? 0 : -7 }}>
                             <ColorField value={th.accent2} onChange={hex => setTh({ accent2: hexOr(hex, th.accent2) })}/>
                           </Disclosure>
                        </div>
                      </div>
                    </div>
                  </div>
                </Disclosure>
                {/* Пять образцов остались как шорткаты: свой цвет теперь
                    можно задать чем угодно, а эти — то, что хочется достать в
                    одно нажатие. Набор цветов теперь в THEME_PRESETS и
                    ACCENT_PRESETS, а список подписей — тут единственный. */}
                <Disclosure open={mode === 'color'}>
                  <div style={{ marginTop: 14 }}>
                    <div style={{
                      fontSize: 'var(--fs-eyebrow)', letterSpacing: '0.1em',
                      textTransform: 'uppercase', color: SN.faint, marginBottom: 8,
                    }}>{t('accent_quick')}</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {[
                        ['default',  t('accent_default')],
                        ['lavender', t('accent_lavender')],
                        ['mint',     t('accent_mint')],
                        ['rose',     t('accent_rose')],
                        ['amber',    t('accent_amber')],
                      ].map(([key, label]) => {
                        const c = ACCENT_PRESETS[key];
                        const hex = rgbToHex(c.r, c.g, c.b);
                        /* активен тот, с которым в themes.accent совпадает
                           ЦВЕТ, а не запись пресета: иначе подсветка слетела
                           бы с кнопки при любой ручной правке цвета */
                        const active = th.accent.toLowerCase() === hex;
                        return (
                          <div key={key} role="button" title={label} data-motion-spatial=""
                            onClick={() => setTh({ accent: hex })}
                            style={{
                              width: 26, height: 26, borderRadius: '50%', cursor: 'pointer', flexShrink: 0,
                              background: hex,
                              boxShadow: active
                                ? `0 0 0 2px rgba(10,10,14,0.9), 0 0 0 3.5px ${hex}`
                                : `0 2px 6px ${hex}38`,
                              transition: 'box-shadow 0.22s ease, transform 0.18s ease',
                            }}
                            onPointerEnter={e => { if (!active && !reduced && isFineHover(e)) e.currentTarget.style.transform = 'scale(1.12)'; }}
                            onPointerLeave={e => { e.currentTarget.style.transform = 'none'; }}
                          />
                        );
                      })}
                    </div>
                  </div>
                </Disclosure>
                {/* «От обложки» и «Выкл» раньше показывали карточку с
                    заголовком, который просто повторял уже выбранный
                    сегмент. Осталось по одной строке: живой образец цвета
                    либо объяснение, что именно выключено. */}
                <Disclosure open={mode === 'cover'}>
                  <div style={{ display:'flex', alignItems:'center', gap:11 }}>
                    <div style={{
                      width:26, height:26, borderRadius:8, flexShrink:0,
                      background:'conic-gradient(from 0deg, #ff8fb1, #ffb164, #ffeb6b, #82dcc3, #9b7dff, #ff8fb1)',
                      boxShadow:`0 0 16px rgba(${appAccent.r},${appAccent.g},${appAccent.b},0.45)`,
                      transition:'box-shadow 0.4s',
                    }}/>
                    <div style={{ fontSize:'var(--fs-xs)', color: SN.dim, lineHeight:1.45 }}>
                      {t('accent_cover_sub')}
                    </div>
                  </div>
                </Disclosure>
                <Disclosure open={mode === 'off'}>
                  <div style={{ fontSize:'var(--fs-xs)', color: SN.dim, lineHeight:1.45 }}>
                    {t('accent_off_sub')}
                  </div>
                </Disclosure>
              </div>
            </>
          );
        })()}

        {/* Тумблер пятна за обложкой — в этой же карточке, а не в «Интерфейсе».
            Полноширинная строка: он отделяет блок выбора режима от края
            карточки, а не висит на общей подложке с палитрой. */}
        <Row label={t('art_glow')} sub={t('art_glow_sub')} last
          dim={settings.accentMode === 'off'}>
          <Switch on={!!settings.ambientGlow} disabled={settings.accentMode === 'off'}
            onChange={v => set('ambientGlow', v)}/>
        </Row>
      </Card>

      <Card title={t('card_bg')}>
        <div style={{ padding: '13px 16px 12px', fontSize: 'var(--fs-xs)', color: SN.dim, lineHeight: 1.45 }}>
          {micaOn ? t('bg_sub_mica')
            : th.bgMode === 'cover' ? t('bg_sub_cover')
            : th.bgMode === 'default' ? t('bg_sub_default') : t('bg_sub_custom')}
        </div>
        <div style={{ padding: '0 16px 14px' }}>
          <Segmented stretch id="bgSegPill" value={micaOn ? 'default' : th.bgMode} disabled={micaOn}
            onChange={v => setTh({ bgMode: v })}
            options={[
              { v: 'default',  label: t('bg_seg_default') },
              { v: 'color',    label: t('bg_seg_color') },
              { v: 'gradient', label: t('bg_seg_gradient') },
              { v: 'cover',    label: t('bg_seg_cover') },
            ]}/>
        </div>
        {/* Режим «под обложку» без живого акцента бессмысленен: фон
            считается от --accent-rgb, а при фиксированном цвете он был бы
            просто одноцветной подложкой. Поэтому включая его, мы включаем
            и акцент от обложки — обратно выбор акцента пользователь
            делает сам, а фон просто перестанет за ним следовать. */}
        <Disclosure open={th.bgMode === 'cover' && settings.accentMode !== 'cover'}>
          <div style={{ padding: '0 16px 14px' }}>
            <Btn onClick={() => onSettings(s => ({ ...s, accentMode: 'cover' }))}>
              {t('bg_cover_turn_on')}
            </Btn>
          </div>
        </Disclosure>
        {/* Поля каждого режима. Базовый цвет у «цвета» и «градиента» общий:
            у градиента он же один из его концов. */}
        <Disclosure open={!micaOn && ['color', 'gradient'].includes(th.bgMode)}>
          <ThRow label={t('bg_from')}>
            <ColorField value={th.bgColor} onChange={hex => setTh({ bgColor: hexOr(hex, th.bgColor) })}/>
          </ThRow>
        </Disclosure>
        <Disclosure open={!micaOn && th.bgMode === 'gradient'}>
          <ThRow label={t('bg_to')}>
            <ColorField value={th.bgColor2} onChange={hex => setTh({ bgColor2: hexOr(hex, th.bgColor2) })}/>
          </ThRow>
          <div style={{ padding: '4px 16px 14px' }}>
            <MiniSlider label={t('bg_angle')} value={th.bgAngle} min={0} max={360} step={1}
              display={`${th.bgAngle}°`} onChange={v => setTh({ bgAngle: v })}/>
          </div>
        </Disclosure>
      </Card>

      {/* Свечение и форма. Четыре ползунка, каждый пишет ровно одну
          css-переменную: --glow-strength, --radius, --grain, --vignette.
          Всё, что не читает эти переменные, под ползунки специально НЕ
          переделывалось — иначе правка одного стиля разъехалась бы по
          десятку мест, и «тема» перестала бы быть набором переменных. */}
      <Card title={t('card_look')}>
        <MiniSlider label={t('glow_strength')} value={th.glowStrength} min={0} max={2} step={0.05}
          display={`${Math.round(th.glowStrength * 100)}%`} disabled={settings.accentMode === 'off'}
          onChange={v => setTh({ glowStrength: v })}/>
        <div style={{ padding: '0 16px 11px', fontSize: 'var(--fs-xs)', color: SN.dim, lineHeight: 1.45 }}>
          {t('glow_strength_sub')}
        </div>
        <MiniSlider label={t('ui_radius')} value={th.radius} min={0} max={28} step={1}
          display={`${th.radius}px`} onChange={v => setTh({ radius: v })}/>
        <div style={{ padding: '0 16px 11px', fontSize: 'var(--fs-xs)', color: SN.dim, lineHeight: 1.45 }}>
          {t('ui_radius_sub')}
        </div>
        <MiniSlider label={t('ui_grain')} value={th.grain} min={0} max={0.15} step={0.002}
          display={`${Math.round(th.grain * 1000) / 10}%`} onChange={v => setTh({ grain: v })}/>
        <div style={{ padding: '0 16px 11px', fontSize: 'var(--fs-xs)', color: SN.dim, lineHeight: 1.45 }}>
          {t('ui_grain_sub')}
        </div>
        <MiniSlider label={t('ui_vignette')} value={th.vignette} min={0} max={1} step={0.02}
          display={`${Math.round(th.vignette * 100)}%`} onChange={v => setTh({ vignette: v })}/>
        <div style={{
          padding: '0 16px 15px', fontSize: 'var(--fs-xs)', color: SN.dim, lineHeight: 1.45,
        }}>{t('ui_vignette_sub')}</div>
      </Card>

      {/* Обложки. Цвет ОДИН на всё приложение, поэтому оно и читается цельно:
          «От обложки» — тон текущего трека (переключил — перекрасилось всё),
          «Акцент Windows» — системный цвет, тот же, которым красится мика,
          «Свой цвет» — выбранный здесь. */}
      <Card title={t('card_covers')}>
        <div style={{ padding: '14px 16px 0' }}>
          <Segmented stretch id="coverTintPill" value={tintMode}
            onChange={v => set('coverTintMode', v)}
            options={[
              { v: 'cover', label: t('cover_tint_by_cover') },
              { v: 'accent', label: t('cover_tint_by_accent') },
              { v: 'color', label: t('cover_tint_by_color') },
            ]}/>
        </div>
        <Disclosure open={tintMode === 'color'}>
          <div style={{ padding: '14px 16px 0', display: 'flex', gap: 14, alignItems: 'flex-start' }}>
            <ColorPad hex={tintColor} onChange={hex => set('coverTintColor', hex)}/>
            <div style={{ flex: 1, minWidth: 0 }}>
              <ColorField value={tintColor} onChange={hex => set('coverTintColor', hexOr(hex, tintColor))}/>
            </div>
          </div>
        </Disclosure>
        <MiniSlider label={t('cover_tint')} value={settings.coverTint ?? 0} min={0} max={1} step={0.02}
          display={settings.coverTint > 0 ? `${Math.round(settings.coverTint * 100)}%` : t('cover_tint_off')}
          onChange={v => set('coverTint', v)}/>
      </Card>

      {/* Элементы интерфейса. Не «спрятать всё», а конкретный хром, без
          которого приложение остаётся рабочим: источник переключается в
          «Аккаунте», громкость живёт в микшере Windows, подпись и чипсы —
          чистое оформление. Обратная связь мгновенная: шапка видна и отсюда,
          так что спрятанный переключатель исчезает прямо на глазах. */}
      <Card title={t('card_ui')}>
        <div style={{ padding: '13px 16px 6px', fontSize: 'var(--fs-xs)', color: SN.dim, lineHeight: 1.45 }}>
          {t('ui_hide_sub')}
        </div>
        <Row label={t('ui_hide_source')} sub={t('ui_hide_source_sub')}>
          <Switch on={!!uiHidden.source} onChange={v => setHidden('source', v)}/>
        </Row>
        <Row label={t('ui_hide_mini_player')} sub={t('ui_hide_mini_player_sub')}>
          <Switch on={!!uiHidden.miniPlayer} onChange={v => setHidden('miniPlayer', v)}/>
        </Row>
        <Row label={t('ui_hide_volume')} sub={t('ui_hide_volume_sub')}>
          <Switch on={!!uiHidden.volume} onChange={v => setHidden('volume', v)}/>
        </Row>
        <Row label={t('ui_hide_caption')} sub={t('ui_hide_caption_sub')}>
          <Switch on={!!uiHidden.caption} onChange={v => setHidden('caption', v)}/>
        </Row>
        <Row label={t('ui_hide_sort')} sub={t('ui_hide_sort_sub')} last={!anyHidden}>
          <Switch on={!!uiHidden.sort} onChange={v => setHidden('sort', v)}/>
        </Row>
        <Disclosure open={anyHidden}>
          <div style={{ padding: '2px 16px 14px' }}>
            <Btn onClick={() => setHidden(null)}>{t('ui_show_all')}</Btn>
          </div>
        </Disclosure>
      </Card>

      {/* ❌ УДАЛЕНА карточка «Код темы» (показ/копирование/вставка темы
           текстом). Тема и так сохраняется в settings.json и в своих наборах,
           а два способа держать одно и то же только расходились: вставка через
           текст молча перетирала тему, которую правили ползунками. Вместе с
           карточкой ушли themeToJson, состояние редактора и ключи theme_code_*
           в обоих словарях. */}

      {/* ❌ УДАЛЕНА карточка «Интерфейс» с тумблером «Отключить разделители».
           Тумблер убран по просьбе, а поведение оставлено включённым: разделители
           между пунктами и треками не рисуются. Карточка была из одного этого
           тумблера, так что с ним ушла и она.
           Поведение теперь задано константой HIDE_DIVIDERS, а не настройкой —
           иначе ключ остался бы в settings.json и мог вернуть разделители
           обратно из старого файла настроек. */}
      <Card title={t('card_window')}>
        <Row
          /* Плашка «только Windows 11» прямо у названия. Материал окна —
             единственная функция в настройках, которая на другой системе
             не просто не работает, а молча ничего не делает: DWM на Windows 10
             и на 11 ниже 22H2 принимает атрибут и не рисует его. Поэтому
             ограничение видно до переключения, а не после. */
          label={<>{t('mica')}<Badge>{t('mica_only_win11')}</Badge></>}
          sub={t('mica_sub')} last>
          <Switch on={micaOn}
            onChange={v => onSettings(s => {
              const next = { ...s, windowEffect: v ? 'mica' : 'off' };
              /* материал окна несовместим с подсветкой акцента и своим фоном
                 (см. карточку акцента) — гасим здесь, в одном месте, чтобы
                 правило не разъехалось по коду. обратно не трогаем: выключение
                 материала не должно само включать акцент обратно, пользователь
                 выберет режим сам. фон при этом не восстанавливаем — у
                 включённого материа свой */
              if (v) {
                if (next.accentMode !== 'off') next.accentMode = 'off';
                next.theme = cleanTheme({ ...(next.theme || THEME_DEFAULT), bgMode: 'default' });
              }
              return next;
            })}/>
        </Row>
      </Card>
    </>),
    /* секция discord вынесена из оформления: это интеграция, а не вид */
    discord: (
      <Card>
        <Row label={t('discord_rpc')} sub={t('discord_rpc_sub')} last={!settings.discordRpc}>
          <Switch label={t('discord_rpc')} on={!!settings.discordRpc} onChange={v => set('discordRpc', v)}/>
        </Row>
        {/* Раскрывающийся блок. Раньше он лежал вложенной карточкой с отступом
            и скруглением — читался как отдельный экран внутри экрана. Теперь
            это подряд идущие строки на одной подложке, и единственный намёк на
            уровень — чуть более светлая заливка: пунктов внутри нет, они все
            принадлежат тумблеру выше. */}
        <Disclosure open={settings.discordRpc}>
        <div style={{ background: 'rgba(255,255,255,0.022)', borderRadius: '0 0 var(--radius, 14px) var(--radius, 14px)' }}>
          {/* статус подключения. без него «RPC включён, но ничего не видно»
             и «Discord не запущен» выглядят одинаково — а это разные вещи,
             и чинить их надо по-разному (перезапустить клиент vs ждать) */}
          {(() => {
            const map = {
              connected:   { c:'#4ade80', t:t('discord_st_connected')   },
              connecting:  { c:'#fbbf24', t:t('discord_st_connecting')  },
              disconnected:{ c:'#fbbf24', t:t('discord_st_lost')        },
              off:         { c:'rgba(255,255,255,0.25)', t:t('discord_st_off') },
            }[discordStatus] || { c:'rgba(255,255,255,0.25)', t:t('discord_st_off') };
            const live = discordStatus === 'connected';
            return (
              <div style={{
                display:'flex', alignItems:'center', gap:9, padding:'11px 16px',
              }}>
                <div style={{
                  width:6, height:6, borderRadius:'50%', background:map.c, flexShrink:0,
                  boxShadow: live ? '0 0 0 3px rgba(74,222,128,0.14)' : 'none',
                  transition:'background-color 160ms ease, box-shadow 160ms ease',
                }}/>
                <div style={{ fontSize:'var(--fs-xs)', color: live ? SN.mid : SN.dim }}>{map.t}</div>
              </div>
            );
          })()}
          <Row label={t('discord_timestamp')}>
            <Segmented id="segDiscordTs" value={settings.discordTimestamp||'progress'}
              onChange={v => set('discordTimestamp', v)}
              options={[
                { v:'progress', label:t('discord_ts_progress') },
                { v:'elapsed',  label:t('discord_ts_elapsed') },
                { v:'none',     label:t('discord_ts_none') },
              ]}/>
          </Row>
          <Row label={t('discord_on_pause')}>
            <Segmented id="segDiscordPause" value={settings.discordPause||'show'}
              onChange={v => set('discordPause', v)}
              options={[
                { v:'show', label:t('discord_pause_show') },
                { v:'hide', label:t('discord_pause_hide') },
              ]}/>
          </Row>
          <Row label={t('discord_cover')} sub={t('discord_cover_sub')} last>
            <Switch on={!!settings.discordCover} onChange={v => set('discordCover', v)}/>
          </Row>
        </div>
        </Disclosure>
      </Card>
    ),
    system: (<>
      <Card title={t('card_language')}>
        {/* без пояснения: подпись «Язык» и пояснение «Язык элементов управления»
           говорили одно и то же двумя строками */}
        <Row label={t('language_label')} last>
          <Segmented id="segLang" value={settings.language||'RU'}
            onChange={v => set('language', v)}
            options={[{ v:'RU', label:'RU' }, { v:'EN', label:'EN' }]}/>
        </Row>
      </Card>
      <ClearCacheCard onClearCoversCache={onClearCoversCache} onClearLikesCache={onClearLikesCache}/>
      <Card title={t('card_startup')}>
        <Row label={t('start_windows')}>
          <Switch on={!!settings.startWithWindows} onChange={v => set('startWithWindows', v)}/>
        </Row>
        <Row label={t('minimize_tray')} last>
          <Switch on={!!settings.minimizeToTray} onChange={v => set('minimizeToTray', v)}/>
        </Row>
      </Card>
      <Card title={t('card_local')}>
        <Row label={t('music_folder')}
          sub={settings.musicFolder
            ? settings.musicFolder.length > 42
              ? '...' + settings.musicFolder.slice(-42)
              : settings.musicFolder
            : t('no_folder')}>
          <Disclosure inline open={!!settings.musicFolder} style={{ marginLeft: settings.musicFolder ? 0 : -7 }}>
            <Btn tone="danger" onClick={() => onClearFolder()}>{t('remove')}</Btn>
          </Disclosure>
          <Btn onClick={async () => {
            const folder = await window.electronAPI.selectMusicFolder();
            if (folder) { set('musicFolder', folder); onScanTracks(folder); }
          }}>{t('choose')}</Btn>
        </Row>
        <Row label={t('min_dur')} sub={t('min_dur_sub')} last>
          <Stepper value={settings.minDuration ?? 30} min={0}
            onChange={v => set('minDuration', v)}
            label={`${settings.minDuration ?? 30} ${t('secs')}`}/>
        </Row>
      </Card>
    </>),
    about: (
      <Card>
        <Row label={t('version')}>
          <span style={{ fontSize: 'var(--fs-sm)', color: SN.mid, fontVariantNumeric: 'tabular-nums' }}>1.0.0</span>
        </Row>
        <Row label={t('repository')}>
          {/* ссылка: раньше это был блок текста, у которого прочерк курсора
             выдавал, что он кликабельный, — теперь это кнопка, и видно сразу */}
          <Btn title="https://github.com/despoyledporcelain/sewer-tauri"
            onClick={() => window.open('https://github.com/despoyledporcelain/sewer-tauri','_blank','noopener')}>
            GitHub
          </Btn>
        </Row>
        <Row label={t('stack')} last>
          <span style={{ fontSize: 'var(--fs-sm)', color: SN.mid }}>Tauri v2 · Rust · React</span>
        </Row>
      </Card>
    ),
  };

  return (
    <div style={{
      ...stackRoot(visible, 0.28),
      display:'flex',
      /* Только прозрачность, БЕЗ translateY. Панель — предок `layoutId`-пилла
         сегментов, а framer меряет его бокс через getBoundingClientRect, то
         есть вместе с transform предка. Пока предок едет на translateY, пилл
         перепроецируется и на первом входе в настройки дёргается. Подъём на
         8px того не стоил: эффект давали одни layout-анимации внутри.
         visibility/pointerEvents — из stackRoot: скрытая панель не должна
         ловить клики у видимой вкладки. */
    }}>
      {/* левая навигация */}
      <div style={{
        width:200, flexShrink:0, height:'100%',
        padding:'34px 12px 20px',
        display:'flex', flexDirection:'column',
      }}>
        <div style={{
          fontSize: 'var(--fs-xl)', fontWeight:600, letterSpacing:'-0.025em',
          color:'rgba(255,255,255,0.85)', marginBottom:24, paddingLeft:11,
        }}>{t('settings_title')}</div>
        <div style={{ display:'flex', flexDirection:'column', gap:1, position:'relative' }}>
          {/* Пилл выбранного раздела. Заливка акцентом вместо общего серого:
              выбранный пункт теперь виден и по цвету, а не только по насыщенности
              подписи, и совпадает с подсветкой сегментов справа. */}
          <div data-motion-position="" style={{
            position:'absolute', left:0, right:0, borderRadius:9, pointerEvents:'none',
            background:'rgba(var(--accent-rgb),0.12)',
            boxShadow:'inset 0 0 0 1px rgba(var(--accent-rgb),0.16)',
            top: pill.top, height: pill.height,
            transition:'top 0.26s cubic-bezier(0.4,0,0.2,1), height 0.26s cubic-bezier(0.4,0,0.2,1)',
          }}/>
          {SECS.map(s => {
            const active = sec === s.id;
            return (
              <div key={s.id} ref={el => secRefs.current[s.id] = el}
                style={{
                  display:'flex', alignItems:'center', gap:10,
                  padding:'9px 11px', borderRadius:9, cursor:'pointer',
                  color: active ? 'var(--accent)' : 'rgba(255,255,255,0.38)',
                  transition:'color 0.18s ease',
                  position:'relative', zIndex:1,
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.color = 'rgba(255,255,255,0.66)'; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.color = 'rgba(255,255,255,0.38)'; }}
                onClick={() => setSec(s.id)}>
                {/* иконка гаснет отдельно от подписи: иначе невыбранные пункты
                    выглядят так же тяжело, как выбранный */}
                <span style={{ opacity: active ? 1 : 0.75, transition:'opacity 0.18s ease' }}>{s.icon}</span>
                <span style={{ fontSize: 'var(--fs-md)', fontWeight: active ? 500 : 400 }}>{s.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* правый контент */}
      <div ref={settingsScrollRef} className="scroll-thin" style={{ flex:1, minWidth:0, overflowY:'auto', padding:'34px 36px 40px' }}>
        {/* Заголовок раздела над контентом удалён: он дублировал название
           слева в навигации, и оба менялись синхронно — при переключении
           раздела читались два одинаковых слова подряд.
            Ширина 520 оставляет место для длинных подписей и пути к музыке. */}
        <DisclosureLayout key={sec} reduced={reduced}
          motionKey={[micaOn, settings.accentMode, th.accentGrad, th.bgMode, tintMode,
            anyHidden, settings.discordRpc, crossfadeSettings(settings).seconds > 0,
            !!scAuth, !!settings.musicFolder, userThemes.length,
            cleanLyricsSources(settings.lyricsSources).join(',')].join('|')}
          style={{ maxWidth:520, animation:reduced ? 'none' : 'setIn 0.24s ease' }}>
          {content[sec]}
        </DisclosureLayout>
      </div>
    </div>
  );
}

/* ── SearchTrackRow ──────────────────────────────────────────────────────── */
/* ── skeletons (shimmer) ──────────────────────────────────────────────────── */
/* детерминированный «случайный» размер, чтобы блоки не выглядели копипастой */
const skelW = (i, base, spread) => `${base + (i * 13) % spread}%`;
const skelDelay = i => `${((i * 0.13) % 1.1).toFixed(2)}s`;

function TrackRowSkeleton({ i }) {
  return (
    /* геометрия 1:1 с SearchTrackRow: обложка 44, прослушивания 48, год 32,
       длительность 34, лайк 58. скелетон должен занимать ровно то же место,
       что и содержимое, иначе при подстановке списка вся правая часть
       дёргается */
    <div style={{display:'flex', alignItems:'center', gap:12, padding:'7px 0',
      borderBottom:'1px solid rgba(255,255,255,0.032)'}}>
      <div className="skel" style={{width:44, height:44, borderRadius:8, flexShrink:0, '--skel-delay':skelDelay(i)}}/>
      <div style={{flex:1, minWidth:0, display:'flex', flexDirection:'column', gap:6}}>
        <div className="skel" style={{height:11, borderRadius:4, width:skelW(i, 46, 30), '--skel-delay':skelDelay(i + 3)}}/>
        <div className="skel" style={{height:9,  borderRadius:4, width:skelW(i, 24, 22), '--skel-delay':skelDelay(i + 7)}}/>
      </div>
      <div style={{display:'flex', alignItems:'center', gap:15, flexShrink:0}}>
        <div className="skel" style={{width:48, height:9, borderRadius:4, '--skel-delay':skelDelay(i + 4)}}/>
        <div className="skel" style={{width:32, height:9, borderRadius:4, '--skel-delay':skelDelay(i + 8)}}/>
        <div className="skel" style={{width:34, height:9, borderRadius:4, '--skel-delay':skelDelay(i + 6)}}/>
      </div>
      <div className="skel" style={{width:58, height:13, borderRadius:4, flexShrink:0, '--skel-delay':skelDelay(i + 5)}}/>
    </div>
  );
}

/* скелет строки редактора плейлиста. геометрия 1:1 с реальной строкой
   (обложка 36, gap 12, padding 6+6 → 48px высоты) — иначе при переходе
   skeleton → список высота прыгала бы и всё ниже съезжало.
   на модульном уровне: компонент, объявленный внутри PlaylistEditor,
   пересоздавался бы каждый рендер (см. TrackContextMenu) */
function PlEditorRowSkeleton({ i }) {
  return (
    <div style={{display:'flex', alignItems:'center', gap:12, padding:'6px 8px', height:48}}>
      <div className="skel" style={{width:6, height:14, borderRadius:3, flexShrink:0, '--skel-delay':skelDelay(i + 1)}}/>
      <div className="skel" style={{width:36, height:36, borderRadius:8, flexShrink:0, '--skel-delay':skelDelay(i)}}/>
      <div style={{flex:1, minWidth:0, display:'flex', flexDirection:'column', gap:6}}>
        <div className="skel" style={{height:11, borderRadius:4, width:skelW(i, 44, 32), '--skel-delay':skelDelay(i + 3)}}/>
        <div className="skel" style={{height:9,  borderRadius:4, width:skelW(i, 22, 24), '--skel-delay':skelDelay(i + 7)}}/>
      </div>
      <div className="skel" style={{width:28, height:9, borderRadius:4, flexShrink:0, '--skel-delay':skelDelay(i + 5)}}/>
    </div>
  );
}

/* скелет блока «Лучшее»: та же геометрия, что у SearchTopCard (обложка 76 +
   две строки текста + строка чисел), иначе при подстановке результата всё
   правее обложки дёргалось бы */
function SearchTopSkeleton() {
  return (
    <div style={{
      display:'flex', alignItems:'center', gap:16,
      padding:'10px 14px 10px 10px', borderRadius:16, background:'rgba(255,255,255,0.03)',
    }}>
      <div className="skel" style={{width:76, height:76, borderRadius:12, flexShrink:0, '--skel-delay':skelDelay(2)}}/>
      <div style={{flex:1, minWidth:0, display:'flex', flexDirection:'column', gap:7, justifyContent:'center'}}>
        <div className="skel" style={{height:12, borderRadius:4, width:skelW(2, 42, 26), '--skel-delay':skelDelay(3)}}/>
        <div className="skel" style={{height:9,  borderRadius:4, width:skelW(3, 24, 20), '--skel-delay':skelDelay(6)}}/>
        <div style={{display:'flex', gap:14, marginTop:5}}>
          <div className="skel" style={{height:8, borderRadius:4, width:36}}/>
          <div className="skel" style={{height:8, borderRadius:4, width:24, '--skel-delay':skelDelay(8)}}/>
          <div className="skel" style={{height:8, borderRadius:4, width:28, '--skel-delay':skelDelay(11)}}/>
        </div>
      </div>
      <div className="skel" style={{width:26, height:26, borderRadius:'50%', flexShrink:0, '--skel-delay':skelDelay(13)}}/>
    </div>
  );
}

function SearchArtistSkeleton({ i }) {
  return (
    <div style={{display:'flex', alignItems:'center', gap:12, padding:'9px 12px', minWidth:0}}>
      <div className="skel" style={{width:44, height:44, borderRadius:'50%', flexShrink:0, '--skel-delay':skelDelay(i + 6)}}/>
      <div style={{flex:1, minWidth:0, display:'flex', flexDirection:'column', gap:6}}>
        <div className="skel" style={{height:10, borderRadius:4, width:skelW(i, 48, 26)}}/>
        <div className="skel" style={{height:8, borderRadius:4, width:'36%', '--skel-delay':skelDelay(i + 9)}}/>
      </div>
    </div>
  );
}

function SearchSkeleton() {
  return (
    <div>
      {/* «Лучшее» */}
      <div style={{marginBottom:28}}>
        <div className="skel" style={{height:8, width:46, borderRadius:4, marginBottom:13}}/>
        <SearchTopSkeleton/>
      </div>
      {/* исполнители */}
      <div style={{marginBottom:28}}>
        <div className="skel" style={{height:8, width:58, borderRadius:4, marginBottom:13}}/>
        <div style={{display:'grid', gridTemplateColumns:'repeat(4, minmax(0, 1fr))', gap:6}}>
          {[0,1,2,3].map(i => <SearchArtistSkeleton key={i} i={i}/>)}
        </div>
      </div>
      {/* треки */}
      <div>
        <div className="skel" style={{height:8, width:52, borderRadius:4, marginBottom:13}}/>
        {[0,1,2,3,4].map(i => <TrackRowSkeleton key={i} i={i}/>)}
      </div>
    </div>
  );
}

function HomeGridSkeleton() {
  return (
    <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(128px, 1fr))', gap:18}}>
      {Array.from({length: 15}, (_, i) => (
        <div key={i} style={{borderRadius:16, overflow:'hidden'}}>
          <div style={{padding:'8px 8px 7px'}}>
            <div className="skel" style={{height:8, borderRadius:4, width:'45%', margin:'0 auto 6px', '--skel-delay':skelDelay(i)}}/>
            <div className="skel" style={{height:9, borderRadius:4, width:'70%', margin:'0 auto', '--skel-delay':skelDelay(i + 4)}}/>
          </div>
          <div className="skel" style={{width:'100%', aspectRatio:'1', borderRadius:'0 0 16px 16px', '--skel-delay':skelDelay(i + 2)}}/>
        </div>
      ))}
    </div>
  );
}

function SearchTrackRow({ track, isLiked, onLike, onClick, onCoverClick, isLoading, isError, hideDividers, artHidden }) {
  const t = useLang();
  const lang = React.useContext(LangContext);
  const [hov, setHov] = useState(false);
  const [popKey, setPopKey] = useState(0);
  const lc = fmtCount(track.likesCount);
  const pc = fmtCount(track.playCount);
  const yr = fmtYear(track.releasedAt);
  /* полная дата в подсказке — год в колонке слишком мал, чтобы сказать,
     вышел трек в январе или в декабре. время выставляем UTC: разбираем
     дату, полученную от soundcloud, — сдвиг на часы тут не нужен, а
     локальная зона машины могла бы переставить её на соседние сутки */
  const fullDate = track.releasedAt
    ? new Date(track.releasedAt).toLocaleDateString(lang, {
        year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
    : null;
  return (
    <div onPointerEnter={e => { if (isFineHover(e)) setHov(true); }} onPointerLeave={()=>setHov(false)}
      /* Строка ничего не анимирует при появлении: список меняется целиком,
         и плавность делает один общий фейд контейнера (см. ArtistView /
         SearchView). Здесь только дешёвое приглушение недоступного трека —
         opacity, без пересчёта раскладки. */
      style={{
        display:'flex', alignItems:'center', gap:12, padding:'7px 0',
        borderBottom: hideDividers ? 'none' : '1px solid rgba(255,255,255,0.032)',
        overflow:'hidden',
        opacity: isError ? 0.55 : 1,
        transition: 'opacity 0.18s ease',
      }}>
      {/* cover. data-sewer-art — по нему App находит обложку, когда трек
          открывают в плеере: клон hero стартует ровно из этого квадрата */}
      <div data-sewer-art={track.id} onClick={e=>{e.stopPropagation(); if(!isLoading) onCoverClick();}} style={{
        width:44, height:44, borderRadius:8, flexShrink:0,
        background:'#111116', overflow:'hidden', position:'relative',
        cursor: isLoading ? 'default' : 'pointer',
        /* на время полёта клона обложка прячется — иначе она осталась бы
           висеть в строке вторым экземпляром. ненавязчиво, потому что сам
           клон улетает отсюда и через 430мс её заменяет обложка плеера */
        opacity: artHidden ? 0 : 1, transition:'opacity 0.14s ease',
      }}>
        {track.coverUrl && <img src={track.coverUrl} loading="lazy" decoding="async" style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover',clipPath:'inset(0 round 8px)',display:'block'}}
          onError={e=>{e.currentTarget.style.display='none'}}/>}
        <CoverTint/>
        {isLoading
          ? <div style={{position:'absolute',inset:0,background:'rgba(0,0,0,0.55)',display:'flex',alignItems:'center',justifyContent:'center'}}>
              <div style={{width:14,height:14,border:'2px solid rgba(255,255,255,0.15)',borderTopColor:'rgba(255,255,255,0.6)',borderRadius:'50%',animation:'spin 0.75s linear infinite'}}/>
            </div>
          : <div style={{
              position:'absolute', inset:0, background:'rgba(0,0,0,0.5)',
              display:'flex', alignItems:'center', justifyContent:'center',
              opacity: hov ? 1 : 0, transition:'opacity 0.15s',
            }}>
              <svg width="13" height="13" fill="white" viewBox="0 0 24 24" style={{marginLeft:2}}><polygon points="5,3 19,12 5,21"/></svg>
            </div>
        }
      </div>
      {/* title + artist. строки чистим той же чисткой, что и запрос: в
          списке артиста треки приходят сырыми из api-v2, и «(archive)»,
          эмодзи-простыни и #хэштеги читались там как есть */}
      <div style={{flex:1, minWidth:0, cursor:'pointer'}} onClick={onClick}>
        <div style={{fontSize: 'var(--fs-md)', color:'rgba(255,255,255,0.86)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{squeezeScTitle(track.title) || track.title}</div>
        <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.3)', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{formatArtistDisplay(tidyScArtist(track.artist))}</div>
      </div>
      {/* ── числа ─────────────────────────────────────────────────────────────
          Четыре колонки фиксированной ширины, дальше — сердце со счётчиком.

          Раньше лайк был пилюлей с заливкой и рамкой, а рядом стояли голые
          цифры. Пилюля была единственным элементом строки с обводкой, и на
          тёмном фоне читалась как кнопка в интерфейсе — при том, что
          лайкнуть трек можно и в самом плеере, и по правому клику. Убрали
          и рамку, и заливку: сердце теперь просто тише проступает при
          наведении, а состояние «лайкнуто» держит цвет акцента.

          Ширины фиксированные не для красоты: без них «1.2K» и «61.2K»
          давали колонке разную длину, и при вертикальной прокрутке счётчики
          прыгали влево-вправо друг относительно друга. Пустые ячейки
          держат заглушку той же ширины — иначе трек без прослушиваний
          сдвинул бы всё, что правее. */}
      <div style={{
        display:'flex', alignItems:'center', gap:15, flexShrink:0,
        opacity: hov ? 1 : 0.82, transition:'opacity 0.18s ease',
      }}>
        {/* прослушивания. при нуле fmtCount отдаёт null, и раньше ячейка
            просто исчезала — теперь иконка и тире остаются на месте,
            приглушённые, чтобы колонка не схлопывалась */}
        <div title={track.playCount ? track.playCount.toLocaleString() : undefined} style={{
          display:'flex', alignItems:'center', justifyContent:'flex-end', gap:5,
          width:48, color:'rgba(255,255,255,0.34)',
        }}>
          <img src="../assets/vosproizvedenie.png" width="9" height="9"
            style={{display:'block', filter:'brightness(0) invert(1)',
              opacity: pc ? 0.55 : 0.22, flexShrink:0}}/>
          <span style={{
            fontSize: 'var(--fs-xs)', fontVariantNumeric:'tabular-nums',
            opacity: pc ? 1 : 0.28,
          }}>{pc || '—'}</span>
        </div>
        {/* год выхода. при отсутствии даты — пусто, а не тире: тире
            читалось бы как «нет данных» о треке, который тут может и не
            быть вовсе (акустика с чужого канала) */}
        <div title={fullDate} style={{
          width:32, textAlign:'right', flexShrink:0,
          fontSize: 'var(--fs-xs)', fontVariantNumeric:'tabular-nums',
          color:'rgba(255,255,255,0.3)',
        }}>{yr || ''}</div>
        {/* длительность / недоступен. само слово «недоступен» убрано — в
            колонке шириной 34px оно не влезало и вылезало за неё; тире
            читается однозначно, а точный текст остаётся в подсказке */}
        <div title={isError ? t('unavailable') : fmt(track.duration)} style={{
          width:34, textAlign:'right', flexShrink:0,
          fontSize: 'var(--fs-xs)', fontVariantNumeric:'tabular-nums',
          color: isError ? 'rgba(255,80,80,0.7)' : 'rgba(255,255,255,0.34)',
        }}>{isError ? '—' : fmt(track.duration)}</div>
      </div>

      {/* like — сердце и число, без рамки. число прижато вправо, поэтому
          колонка лайков тоже не дёргается при смене разрядности */}
      {onLike && (
        <div onClick={e=>{e.stopPropagation(); if (!isLiked) setPopKey(k=>k+1); onLike();}}
          title={t('likes')}
          /* отступы по вертикали — минимальная зона нажатия: сердце 13px
             на тач-экране мелкая цель. по горизонтали место не растёт,
             ширина зафиксирована */
          style={{
            marginLeft:4, flexShrink:0,
            display:'flex', alignItems:'center', gap:6,
            width:58, justifyContent:'flex-end',
            padding:'6px 0', cursor:'pointer',
          }}>
          <div data-motion-spatial="" style={{
            display:'flex', alignItems:'center', justifyContent:'flex-end',
            width: lc ? 38 : 12, flexShrink:0,
            color: isLiked ? 'var(--accent)' : 'rgba(255,255,255,0.3)',
            transform: hov ? 'scale(1.12)' : 'scale(1)',
            transition:'transform 0.16s cubic-bezier(0.34,1.56,0.64,1), color 0.18s ease',
          }}>
            <LikeHeart key={popKey} liked={isLiked} size={13}
              className={popKey ? 'like-pop like-glow' : undefined}/>
          </div>
          <span style={{
            fontSize: 'var(--fs-xs)', fontVariantNumeric:'tabular-nums',
            color: isLiked ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.28)',
            transition:'color 0.18s ease',
          }}>{lc || '—'}</span>
        </div>
      )}
    </div>
  );
}

/* ── SearchView ──────────────────────────────────────────────────────────── */
/* ── PlaylistCard ─────────────────────────────────────────────────────────── */
/* карточка плейлиста — скелет как у HomeCard: полоска-заголовок (владелец /
   название) + квадратная обложка + hover-оверлей с play. ✎ — только на своих
   плейлистах (SC не даёт редактировать чужие), трек-каунт — бейдж на обложке */
function PlaylistCard({ playlist, onOpen, onEdit }) {
  const reduced = useReducedMotion();
  const [hovered, setHovered] = useState(false);
  const t = useLang();
  const pl_edit_title = t('pl_edit');
  const cover = (
    <>
      {playlist.coverUrl
        ? <img src={playlist.coverUrl} loading="lazy" decoding="async"
            style={{position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover',
              clipPath:'inset(0 round 0 0 16px 16px)', display:'block'}}
            onError={e => { e.currentTarget.style.display = 'none'; }}/>
        : <img src="../assets/note.png" style={{width:24, height:24, filter:'brightness(0) invert(1)', opacity:0.13}}/>}
      <CoverTint/>
      {/* трек-каунт бейдж */}
      <div style={{
        position:'absolute', left:7, bottom:7,
        display:'flex', alignItems:'center', gap:4,
        padding:'3px 8px', borderRadius:999,
        background:'rgba(0,0,0,0.45)', backdropFilter:'blur(4px)', WebkitBackdropFilter:'blur(4px)',
        fontSize: 'var(--fs-eyebrow)', fontWeight:600, color:'rgba(255,255,255,0.8)',
        fontVariantNumeric:'tabular-nums', pointerEvents:'none',
      }}>{playlist.trackCount}</div>
      {/* hover: затемнение + play (оверлей абсолютный на всю обложку, как HomeCard) */}
      <div className="home-card-overlay" style={{
        position:'absolute', inset:0, background:'rgba(0,0,0,0.32)',
        display:'flex', alignItems:'center', justifyContent:'center',
      }}>
        <div className="home-card-play" style={{
          width:46, height:46, borderRadius:'50%',
          display:'flex', alignItems:'center', justifyContent:'center',
        }}>
          <svg width="26" height="26" fill="#fff" viewBox="0 0 24 24" style={{marginLeft:2}}><polygon points="6,4 20,12 6,20"/></svg>
        </div>
      </div>
      {playlist.isOwn && (
        <div className="home-card-like" style={{position:'absolute', right:6, bottom:6,
          width:26, height:26, display:'flex', alignItems:'center', justifyContent:'center'}}
          title={pl_edit_title}
          onClick={e => { e.stopPropagation(); onEdit(playlist); }}>
          {/* ассет чёрный на прозрачном → инвертим в белый, как note.png.
              100x100 → 14px, object-fit:contain чтобы не обрезало наконечник */}
          <img src="../assets/edit.png" alt="" draggable="false"
            style={{width:14, height:14, objectFit:'contain', opacity:0.75,
              filter:'brightness(0) invert(1)', transition:'opacity 0.15s'}}
            onMouseEnter={e => e.currentTarget.style.opacity = '0.95'}
            onMouseLeave={e => e.currentTarget.style.opacity = '0.75'}/>
        </div>
      )}
    </>
  );
  return (
    <motion.div className="home-card" data-motion-spatial=""
      onClick={() => onOpen(playlist)}
      initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: !reduced && hovered ? 1.03 : 1 }}
      onPointerEnter={event => { if (isFineHover(event)) setHovered(true); }}
      onPointerLeave={() => setHovered(false)}
      exit={{ opacity: 0, scale: 0.88 }}
      transition={{ type:'spring', stiffness: 380, damping: 32, mass: 0.6 }}
      style={{borderRadius:16, cursor:'pointer'}}>
      <div style={{padding:'8px 8px 7px', background:'rgba(255,255,255,0.05)', borderRadius:'16px 16px 0 0'}}>
        <div style={{fontSize: 'var(--fs-xs)', opacity:0.3, overflow:'hidden', textOverflow:'ellipsis',
          whiteSpace:'nowrap', marginBottom:2}}>{playlist.ownerName}</div>
        <div style={{fontSize: 'var(--fs-sm)', fontWeight:500, opacity:0.88, overflow:'hidden',
          textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{playlist.title}</div>
      </div>
      <div style={{width:'100%', aspectRatio:'1', position:'relative', background:'#111116',
        borderRadius:'0 0 16px 16px', display:'flex', alignItems:'center', justifyContent:'center',
        overflow:'hidden'}}>
        {cover}
      </div>
    </motion.div>
  );
}

/* ── PlaylistsView ────────────────────────────────────────────────────────── */
/* вкладка плейлистов: лайкнутые + свои SC-плейлисты, сетка как в home.
   ✎ на карточке / «✎» в чипе сайдбара → редактор; клик → плеер с плейлистом */
function PlaylistsView({ visible, scAuth, playlists, loading, error, creating,
                         onOpen, onEdit, onCreate, onRetry, onLogin }) {
  const t = useLang();
  return (
    <div style={{
      ...stackRoot(visible),
    }}>
      <div className="scroll-thin scroll-home" style={{
        position:'absolute', top:0, left:0, right:10, bottom:0,
        overflowY:'auto', padding:'32px 4px 32px 36px',
      }}>
        {!scAuth ? (
          /* не залогинен — подсказка со входом */
          <div style={{
            display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
            minHeight:'calc(100vh - 180px)', gap:22, textAlign:'center',
          }}>
            <div style={{
              width:72, height:72, borderRadius:20,
              background:'rgba(255,255,255,0.035)',
              display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0,
            }}>
              <img src="../assets/playlists.png" style={{width:32, height:32, display:'block',
                filter:'brightness(0) invert(1)', opacity:0.4}}/>
            </div>
            <div style={{fontSize: 'var(--fs-md)', color:'rgba(255,255,255,0.32)', lineHeight:1.6, maxWidth:340}}>
              {t('pl_login_hint').split('\n').map((l,i) => <span key={i}>{l}{i===0 && <br/>}</span>)}
            </div>
            <button onClick={onLogin} style={{
              display:'flex', alignItems:'center', gap:8,
              background:'rgba(255,85,0,0.1)', border:'none', borderRadius:10,
              padding:'9px 18px', fontSize: 'var(--fs-md)', fontWeight:500,
              color:'rgba(255,130,60,0.85)', cursor:'pointer', fontFamily:'inherit',
              transition:'background 0.15s',
            }}
              onMouseEnter={e => { e.currentTarget.style.background='rgba(255,85,0,0.17)'; }}
              onMouseLeave={e => { e.currentTarget.style.background='rgba(255,85,0,0.1)'; }}>
              <SoundCloudIcon size={14} fill="rgba(255,130,60,0.9)"/>
              {t('login_sc')}
            </button>
          </div>
        ) : (
          <>
            <div style={{display:'flex', alignItems:'center', gap:16, marginBottom:24}}>
              <div style={{fontSize: 'var(--fs-sm)', fontWeight:500, color:'rgba(255,255,255,0.22)',
                letterSpacing:'0.06em', textTransform:'uppercase', flexShrink:0}}>
                {t('nav_playlists')}
              </div>
              {loading && <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.32)'}}>{t('loading_dots')}</div>}
              {!loading && playlists && playlists.length > 0 && (
                <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.16)'}}>{playlists.length}</div>
              )}
              {error && (
                <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,80,60,0.75)', maxWidth:320, lineHeight:1.5, wordBreak:'break-all'}}>
                  {t('load_failed')} — <span style={{cursor:'pointer', textDecoration:'underline'}}
                    onClick={onRetry}>{t('retry')}</span>
                </div>
              )}
              {/* создать плейлист */}
              <div onClick={() => !creating && onCreate()} title={t('pl_new_title')} style={{
                marginLeft:'auto', width:28, height:28, borderRadius:9, flexShrink:0,
                display:'flex', alignItems:'center', justifyContent:'center',
                color:'rgba(255,255,255,0.35)', cursor:creating ? 'default' : 'pointer',
                background:'rgba(255,255,255,0.045)', transition:'background 0.15s, color 0.15s',
                opacity: creating ? 0.5 : 1,
              }}
                onMouseEnter={e => { if (!creating) { e.currentTarget.style.background='rgba(255,255,255,0.08)'; e.currentTarget.style.color='rgba(255,255,255,0.8)'; } }}
                onMouseLeave={e => { e.currentTarget.style.background='rgba(255,255,255,0.045)'; e.currentTarget.style.color='rgba(255,255,255,0.35)'; }}>
                {creating
                  ? <div style={{width:11, height:11, border:'2px solid rgba(255,255,255,0.15)', borderTopColor:'rgba(255,255,255,0.6)', borderRadius:'50%', animation:'spin 0.75s linear infinite'}}/>
                  : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>}
              </div>
            </div>
            {loading && (!playlists || playlists.length === 0) ? (
              <HomeGridSkeleton/>
            ) : playlists && playlists.length === 0 && !error ? (
              <div style={{
                display:'flex', alignItems:'center', justifyContent:'center',
                padding:'80px 20px', fontSize: 'var(--fs-md)', color:'rgba(255,255,255,0.32)', textAlign:'center',
              }}>{t('playlists_empty')}</div>
            ) : (
              <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(128px, 1fr))', gap:18}}>
                <AnimatePresence initial={false}>
                  {playlists && playlists.map(pl => (
                    <PlaylistCard key={pl.id} playlist={pl} onOpen={onOpen} onEdit={onEdit}/>
                  ))}
                </AnimatePresence>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ── PlaylistAddRow ───────────────────────────────────────────────────────── */
/* строка-кандидат добавления (поиск/рекомендации редактора): обложка кликабельна —
   превью-прослушивание через основной плеер (как обложки в поиске), справа + / ✓ */
function PlaylistAddRow({ tr, added, onAdd, onPlay, isLoading, isError }) {
  const [hov, setHov] = useState(false);
  return (
    <div style={{
      display:'flex', alignItems:'center', gap:12, padding:'7px 0',
      borderBottom:'1px solid rgba(255,255,255,0.032)',
    }}>
      <div onClick={e => { e.stopPropagation(); if (!isLoading) onPlay(tr); }}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{width:36, height:36, borderRadius:8, flexShrink:0, background:'#111116',
          overflow:'hidden', position:'relative',
          cursor: isLoading ? 'default' : 'pointer',
          outline: isError ? '1px solid rgba(255,80,60,0.55)' : 'none'}}>
        {tr.coverUrl
          ? <img src={tr.coverUrl} loading="lazy" style={{position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', clipPath:'inset(0 round 8px)', display:'block'}}
              onError={e => { e.currentTarget.style.display = 'none'; }}/>
          : <img src="../assets/note.png" style={{width:10, height:10, filter:'brightness(0) invert(1)', opacity:0.2, position:'absolute', inset:0, margin:'auto'}}/>}
        <CoverTint/>
        {isLoading
          ? <div style={{position:'absolute', inset:0, background:'rgba(0,0,0,0.55)', display:'flex', alignItems:'center', justifyContent:'center'}}>
              <div style={{width:12, height:12, border:'2px solid rgba(255,255,255,0.15)', borderTopColor:'rgba(255,255,255,0.6)', borderRadius:'50%', animation:'spin 0.75s linear infinite'}}/>
            </div>
          : <div style={{
              position:'absolute', inset:0,
              background: isError ? 'rgba(120,20,20,0.45)' : 'rgba(0,0,0,0.5)',
              display:'flex', alignItems:'center', justifyContent:'center',
              opacity: (hov || isError) ? 1 : 0, transition:'opacity 0.15s',
            }}>
              {isError
                ? <svg width="11" height="11" fill="none" stroke="rgba(255,120,110,0.95)" strokeWidth="2.4" strokeLinecap="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                : <svg width="11" height="11" fill="white" viewBox="0 0 24 24" style={{marginLeft:1}}><polygon points="6,4 20,12 6,20"/></svg>}
            </div>}
      </div>
      <div style={{flex:1, minWidth:0}}>
        <div style={{fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.85)', fontWeight:500,
          overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{tr.title}</div>
        <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.32)',
          overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{tr.artist}</div>
      </div>
      <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.28)', fontVariantNumeric:'tabular-nums', flexShrink:0}}>
        {fmt(tr.duration)}
      </div>
      <div onClick={() => !added && onAdd(tr)} style={{
        width:26, height:26, borderRadius:8, flexShrink:0,
        display:'flex', alignItems:'center', justifyContent:'center',
        cursor: added ? 'default' : 'pointer',
        color: added ? 'var(--accent)' : 'rgba(255,255,255,0.55)',
        background: added ? 'rgba(255,255,255,0.05)' : 'transparent',
        border: added ? '1px solid rgba(255,255,255,0.06)' : '1px solid rgba(255,255,255,0.08)',
        transition:'background 0.15s, color 0.15s',
      }}
        onMouseEnter={e => { if (!added) e.currentTarget.style.background='rgba(255,255,255,0.08)'; }}
        onMouseLeave={e => { if (!added) e.currentTarget.style.background='transparent'; }}>
        {added
          ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>}
      </div>
    </div>
  );
}

/* ── PlaylistEditor ───────────────────────────────────────────────────────── */
/* полноэкранный редактор своего плейлиста: Reorder-лист треков (drag, delete),
   панель добавления (Поиск / Рекомендации), автосейв в SC через ~1с */
const PlaylistEditor = React.forwardRef(function PlaylistEditor({ visible, playlist, scAuth, onClose, onUpdated, onDelete, fallbackTracks,
                         onPlayTrack, playingTrackId, loadingTrackId, errorTrackId }, ref) {
  const t = useLang();
  const [tracks, setTracks] = useState([]);
  const [loaded, setLoaded]   = useState(false);
  const [status, setStatus]   = useState('idle');   /* idle | saving | saved | error */
  const savedFeedbackRef = useSuccessFeedback(status, 180);
  const [tab, setTab]         = useState('recs');   /* recs | search */
  const addSearchRef          = useRef(null);       /* для focusSearch() сверху */
  const [query, setQuery]     = useState('');
  const [results, setResults] = useState([]);
  const [recs, setRecs]       = useState(null);
  const [recsLoading, setRecsLoading] = useState(false);
  const [searching, setSearching]     = useState(false);
  const debounceRef = useRef(null);
  const queryRef    = useRef('');
  const dirtyRef    = useRef(false);
  const tracksRef   = useRef([]);
  const plObjRef    = useRef(null); /* кэш сырого объекта плейлиста для PUT —
                                       GET один раз за сессию, меньше запросов
                                       (DataDome не любит частые) */
  tracksRef.current = tracks;
  const inList = useMemo(() => new Set(tracks.map(x => x.id)), [tracks]);
  /* название: инлайн-правка в шапке; коммит по Enter/blur → dirty */
  const [titleVal, setTitleVal]       = useState('');
  const [titleEditing, setTitleEditing] = useState(false);
  const titleRef = useRef('');
  titleRef.current = titleVal;
  const commitTitle = () => {
    setTitleEditing(false);
    const v = titleVal.trim().slice(0, 100);
    if (!v || v === (playlist?.title ?? '')) { setTitleVal(playlist?.title ?? ''); return; }
    setTitleVal(v); touch();
  };
  /* выбранная обложка: превью сразу, отправка — при «Сохранить».
     dataUrl — для превью, b64/mime/filename — для multipart PUT */
  const [pendingArt, setPendingArt] = useState(null);
  const [artErr, setArtErr]         = useState(false);
  const pendingArtRef = useRef(null);
  pendingArtRef.current = pendingArt;
  const pickArtwork = async () => {
    const picked = await window.electronAPI.selectImage?.();
    if (!picked?.dataUrl) return;
    const art = await prepareArtwork(picked); /* квадратный jpeg ≤1600px */
    if (!art) return;
    setPendingArt(art);
    touch();
  };

  /* сброс + загрузка полного списка треков при открытии */
  useEffect(() => {
    if (!visible || !playlist || !scAuth) return;
    let cancelled = false;
    setLoaded(false); setStatus('idle'); dirtyRef.current = false;
    setConfirmDel(false); setDeleting(false);
    setExitGuard(false); setGuardSaving(false);
    plObjRef.current = null;
    setTitleVal(playlist?.title ?? ''); setTitleEditing(false);
    setPendingArt(null); setArtErr(false);
    setQuery(''); queryRef.current = ''; setResults([]);
    setRecs(null); setTab('recs');
    (async () => {
      let list = playlist.tracks || [];
      if (list.length < (playlist.trackCount || 0)) {
        const full = await fetchPlaylistTracks(playlist.id, scAuth, t('no_title'));
        if (!cancelled && full.length) list = full;
      }
      if (cancelled) return;
      setTracks(list);
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [visible, playlist?.id, scAuth]);

  /* автосейв: debounce 1с после правки → PUT /playlists/{id}. формат — как у
     сайта (HAR): ПОЛНЫЙ объект плейлиста с tracks = голые id. сырой объект
     берём из кэша (GET один раз за сессию — беречь лимиты DataDome), запасной
     формат — только tracks. после PUT одна сверка порядка, без ретраев */
  /* сохранение вручную (автосейва НЕТ — беречь лимиты DataDome). порядок:
     1) если выбрана обложка — multipart PUT (фолбэк POST) с artwork_data;
        в тело дублируем title+tracks, чтобы ничего не потерялось
     2) JSON PUT как у веб-клиента (HAR): полный объект с tracks = голые id,
        + обновлённый title. после — одна сверка порядка, без ретраев */
  const saveNow = useCallback(async () => {
    if (!scAuth || !playlist) return;
    const snapshot = tracksRef.current;
    setStatus('saving'); setArtErr(false);
    const ids = snapshot.map(x => x.id);
    let newCover;
    let artFailed = false;
    const art = pendingArtRef.current;
    if (art) {
      /* обложка — ОТДЕЛЬНЫЙ json-PUT на .../artwork с base64-строкой
         (формат взят из HAR веб-клиента). не multipart: SC на этом пути
         всегда пытается json.parse и на multipart отвечает 400
         «Unable to parse JSON». urn плейлиста — soundcloud:playlists:{id},
         а не голый id. POST на /playlists/{id} не существует (404) */
      const res = await window.electronAPI.scFetch(
        `https://api-v2.soundcloud.com/playlists/soundcloud:playlists:${playlist.id}/artwork`,
        scAuth.token, scAuth.clientId, 'PUT',
        { image_data: art.b64 }
      );
      if (res.error) {
        console.error('[seWer] playlist artwork (PUT)', res);
        artFailed = true;
        setArtErr(true);          /* обложка не залилась — но треки/название ещё уйдут */
      } else {
        if (res.data?.id) plObjRef.current = res.data;
        const au = res.data?.artwork_url || res.data?.playlist?.artwork_url;
        if (au) newCover = au.replace('-large', '-t500x500');
        setPendingArt(null);
      }
    }
    if (!plObjRef.current) {
      const cur = await window.electronAPI.scFetch(
        `https://api-v2.soundcloud.com/playlists/${playlist.id}`, scAuth.token, scAuth.clientId);
      if (!cur.error && cur.data?.id) plObjRef.current = cur.data;
    }
    const newTitle = (titleRef.current && titleRef.current !== playlist.title) ? titleRef.current : null;
    const attempts = [];
    if (plObjRef.current) {
      attempts.push({ playlist: { ...plObjRef.current,
        ...(newTitle ? { title: newTitle } : {}),
        tracks: ids, track_count: ids.length } });
    }
    attempts.push({ playlist: { ...(newTitle ? { title: newTitle } : {}), tracks: ids } });
    const verify = async () => {
      /* Проверять надо GET /playlists/{id}: он отдаёт плейлист сразу со всеми
         треками. Эндпоинт /playlists/{id}/tracks у soundcloud на этот
         playlist отвечает 404 (проверено curl'ом на живой учётке), и раньше
         проверка на нём всегда падала. Хуже: при ошибке она возвращала
         true, то есть «не смогли проверить» выдавалось за «сохранено» —
         редактор радостно закрывался, ничего не изменив. */
      const check = await window.electronAPI.scFetch(
        `https://api-v2.soundcloud.com/playlists/${playlist.id}`,
        scAuth.token, scAuth.clientId);
      if (check.error) return false;
      const col = check.data?.tracks;
      if (!Array.isArray(col)) return false;
      return col.length === snapshot.length && snapshot.every((x, k) => col[k]?.id === x.id);
    };
    for (let i = 0; i < attempts.length; i++) {
      const res = await window.electronAPI.scFetch(
        `https://api-v2.soundcloud.com/playlists/${playlist.id}`,
        scAuth.token, scAuth.clientId, 'PUT', attempts[i]
      );
      if (res.error) {
        console.error(`[seWer] playlist PUT (формат ${i + 1})`, res);
        continue;
      }
      if (!(await verify())) {
        console.error(`[seWer] playlist PUT: 200, но порядок не применился (формат ${i + 1})`);
        if (i < attempts.length - 1) continue;
        setStatus('error');
        return;
      }
      dirtyRef.current = false;
      /* треки/название сохранены даже если обложка не залилась: показываем
         ошибку обложки с retry, но из редактора выпускаем (dirty снят) */
      setStatus(artFailed ? 'error' : 'saved');
      onUpdated?.(playlist.id, snapshot, { title: newTitle || undefined, coverUrl: newCover });
      return;
    }
    setStatus('error');
  }, [playlist, scAuth, onUpdated]);

  /* правка помечает несохранённость; сохранение — вручную (кнопка в шапке
     или при выходе), никакого автосейва — беречь лимиты анти-бота */
  const touch = () => {
    dirtyRef.current = true;
    setStatus('dirty');
  };

  /* рекомендации: station-эндпоинт по плейлисту → фолбэк station случайного
     трека из плейлиста (⟳ крутит выборку) → фолбэк последние лайкнутые
     (единственный вариант для пустого нового плейлиста) */
  const loadRecs = useCallback(async () => {
    if (!scAuth || !playlist || recsLoading) return;
    setRecsLoading(true);
    const noTitle = t('no_title');
    const mapped = arr => (arr || []).map(x => mapScTrack(x, noTitle));
    let items = [];
    const plRes = await window.electronAPI.scFetch(plRecsUrl(playlist.id), scAuth.token, scAuth.clientId);
    if (!plRes.error) items = mapped(plRes.data?.collection);
    if (items.length === 0 && tracksRef.current.length > 0) {
      const seed = tracksRef.current[Math.floor(Math.random() * tracksRef.current.length)];
      const trRes = await window.electronAPI.scFetch(
        `https://api-v2.soundcloud.com/stations/soundcloud:track-stations:${seed.id}/tracks?limit=50`,
        scAuth.token, scAuth.clientId
      );
      if (!trRes.error) items = mapped(trRes.data?.collection);
    }
    if (items.length === 0 && fallbackTracks && fallbackTracks.length > 0) {
      items = fallbackTracks.slice(0, 30); /* уже в mapScTrack-формате */
    }
    setRecs(items);
    setRecsLoading(false);
  }, [playlist, scAuth, recsLoading, fallbackTracks]);
  useEffect(() => {
    if (visible && tab === 'recs' && recs === null && !recsLoading && playlist && scAuth) loadRecs();
  }, [visible, tab, recs, playlist, scAuth]);

  /* поиск треков для добавления */
  const doSearch = useCallback(async (q) => {
    if (!q.trim() || !scAuth) { setResults([]); setSearching(false); return; }
    setSearching(true);
    const res = await window.electronAPI.scFetch(
      `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(scQueryFor(q))}&limit=20`,
      scAuth.token, scAuth.clientId
    );
    if (queryRef.current !== q) return;
    setResults((res.data?.collection || []).map(x => mapScTrack(x, t('no_title'))));
    setSearching(false);
  }, [scAuth]);
  const handleInput = e => {
    const q = e.target.value;
    setQuery(q); queryRef.current = q;
    clearTimeout(debounceRef.current);
    if (!q.trim()) { setResults([]); return; }
    debounceRef.current = setTimeout(() => doSearch(q), 380);
  };

  const addTrack = tr => {
    if (inList.has(tr.id)) return;
    setTracks(prev => [...prev, tr]);
    touch();
  };
  const removeTrack = id => {
    setTracks(prev => prev.filter(x => x.id !== id));
    touch();
  };
  const close = () => {
    if (dirtyRef.current) { setExitGuard(true); return; } /* предупреждение */
    onClose();
  };
  /* выход с несохранёнными изменениями: сохранить и выйти / не сохранять */
  const [exitGuard, setExitGuard] = useState(false);
  const [guardSaving, setGuardSaving] = useState(false);
  const guardSaveExit = async () => {
    if (guardSaving) return;
    setGuardSaving(true);
    await saveNow();
    setGuardSaving(false);
    if (!dirtyRef.current) { onClose(); return; } /* сохранилось — выходим */
    setExitGuard(false); /* ошибка — остаёмся, статус-пилюля покажет retry */
  };
  React.useImperativeHandle(ref, () => ({
    /* App зовёт это при выходе мышиной кнопкой «назад» / через вкладки */
    requestClose: () => { if (dirtyRef.current) setExitGuard(true); else onClose(); },
    /* ctrl+f должен приезжать сюда: редактор — полноэкранный оверлей, и без
       этого хоткей уводил фокус в невидимый поиск под ним. вкладку
       переключаем явно: иначе фокус уедет в поле, которого ещё нет в dom */
    focusSearch: () => {
      setTab('search');
      requestAnimationFrame(() => addSearchRef.current?.focus());
    },
  }), []);
  /* удаление плейлиста: подтверждение инлайном (🗑 → «удалить? ✓ ✕») */
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting]   = useState(false);
  const doDelete = async () => {
    if (!playlist || deleting) return;
    setDeleting(true);
    const ok = await onDelete?.(playlist);
    setDeleting(false);
    setConfirmDel(false); /* при неудаче App покажет тост, редактор остаётся */
  };
  /* плюрализация: 1 трек / 2 трека / 5 треков (en — track/tracks) */
  const countLabel = n =>
    (n % 10 === 1 && n % 100 !== 11) ? t('pl_count_1')
    : ([2,3,4].includes(n % 10) && ![12,13,14].includes(n % 100)) ? t('pl_count_2')
    : t('pl_count_5');

  const STATUS = {
    idle:   null,
    dirty:  { text: t('ed_dirty'), color: 'rgba(255,185,90,0.8)' },
    saving: { text: t('ed_saving'), color: 'rgba(255,255,255,0.4)' },
    saved:  { text: t('ed_saved'),  color: 'rgba(255,255,255,0.5)' },
    error:  { text: artErr ? t('ed_art_err') : t('ed_save_err'), color: 'rgba(255,80,60,0.85)', retry: true },
  }[status];

  return (
    <div style={{
      ...stackRoot(visible, 0.18),
      zIndex:60,
      background:'var(--bg)',
    }}>
      <div className="scroll-thin" style={{
        width:'100%', height:'100%', overflowY:'auto',
        padding:'28px 24px 48px',
        display:'flex', justifyContent:'center',
      }}>
        <div style={{width:'100%', maxWidth:560}}>
          {/* шапка — ОДНА строка: [выход] [обложка] [название / N ТРЕКА] [сохранить].
              раньше это были две строки (название отдельно, обложка+счётчик ниже),
              а до того — три зоны в шапке и ~200px до контента. иконка выхода —
              тот же ассет back.png, что в ArtistView; круглый оверлей с blur оттуда
              намеренно не перенесён — он сделан для поверхности-героя, на фоне
              страницы только шумит, здесь тихая иконка без подложки */}
          <div style={{display:'flex', alignItems:'center', gap:14, marginBottom:24}}>
            <div onClick={close} title={t('back')} style={{
              width:28, height:28, borderRadius:9, flexShrink:0,
              display:'flex', alignItems:'center', justifyContent:'center',
              background:'transparent', cursor:'pointer', transition:'background 0.15s',
            }}
              onMouseEnter={e => { e.currentTarget.style.background='rgba(255,255,255,0.06)'; }}
              onMouseLeave={e => { e.currentTarget.style.background='transparent'; }}>
              <img src="../assets/back.png" alt="" draggable="false"
                style={{width:15, height:15, objectFit:'contain', opacity:0.55,
                  filter:'brightness(0) invert(1)', transition:'opacity 0.15s'}}
                onMouseEnter={e => e.currentTarget.style.opacity='0.95'}
                onMouseLeave={e => e.currentTarget.style.opacity='0.55'}/>
            </div>
            {/* обложка (клик → выбор файла) — 112px, по схеме пользователя:
                одна строка [выход][обложка][название/счётчик][сохранить].
                высотой строка всё равно меряется по обложке, так что размер
                не съедает контент, а identity-блок читается увереннее */}
            <div onClick={pickArtwork} title={t('ed_art_pick')} style={{
              width:112, height:112, borderRadius:12, flexShrink:0, position:'relative',
              overflow:'hidden', cursor:'pointer', background:'#111116',
              boxShadow:'0 0 0 1px rgba(255,255,255,0.055)',
            }}>
              {pendingArt ? (
                <img src={pendingArt.dataUrl} style={{position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', display:'block'}}/>
              ) : playlist?.coverUrl ? (
                <img src={playlist.coverUrl} style={{position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', display:'block'}}/>
              ) : (
                <img src="../assets/note.png" style={{position:'absolute', inset:0, margin:'auto', width:22, height:22, filter:'brightness(0) invert(1)', opacity:0.16}}/>
              )}
              <CoverTint/>
              {/* hover-оверлей: камера + подсказка */}
              <div className="pl-art-hover" style={{
                position:'absolute', inset:0, display:'flex', flexDirection:'column',
                alignItems:'center', justifyContent:'center', gap:4,
                background:'rgba(8,8,12,0.6)',
                opacity:0, transition:'opacity 0.16s ease',
              }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)"
                  strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                  <circle cx="12" cy="13" r="4"/>
                </svg>
                <span style={{fontSize: 'var(--fs-eyebrow)', letterSpacing:'0.1em', textTransform:'uppercase',
                  color:'rgba(255,255,255,0.75)', fontWeight:600}}>{t('ed_art_pick')}</span>
              </div>
            </div>
            <div style={{flex:1, minWidth:0}}>
              {titleEditing ? (
                <input
                  autoFocus
                  onFocus={e => e.target.select()}
                  value={titleVal}
                  onChange={e => setTitleVal(e.target.value)}
                  onBlur={commitTitle}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitTitle();
                    if (e.key === 'Escape') { setTitleVal(playlist?.title ?? ''); setTitleEditing(false); }
                  }}
                  maxLength={100}
                  placeholder={t('ed_title_ph')}
                  style={{
                    width:'100%', background:'none', outline:'none',
                    border:'none', borderBottom:'1.5px solid var(--accent)',
                    padding:'2px 0 6px', color:'rgba(255,255,255,0.92)',
                    fontSize: 'var(--fs-display)', fontWeight:700, letterSpacing:'-0.02em',
                    fontFamily:'inherit',
                  }}/>
              ) : (
                <div className="pl-title-edit" onClick={() => { setTitleVal(playlist?.title ?? ''); setTitleEditing(true); }}
                  style={{display:'flex', alignItems:'center', gap:8, cursor:'text', padding:'2px 0 4px'}}>
                  <span style={{
                    fontSize: 'var(--fs-display)', fontWeight:700, letterSpacing:'-0.02em', color:'rgba(255,255,255,0.92)',
                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', minWidth:0}}>
                    {titleVal || playlist?.title || ''}
                  </span>
                  <svg className="pl-title-pencil" width="13" height="13" viewBox="0 0 24 24" fill="none"
                    stroke="rgba(255,255,255,0.35)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    style={{flexShrink:0, opacity:0, transition:'opacity 0.15s'}}>
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
                  </svg>
                </div>
              )}
              {/* счётчик треков под названием, обычным регистром через
                  countLabel (1 трек / 2 трека / 5 треков) — не капсом */}
              <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.32)', marginTop:2, fontVariantNumeric:'tabular-nums'}}>
                {tracks.length} {countLabel(tracks.length)}
                {!loaded && ' · …'}
              </div>
            </div>
            {/* сохранить вручную — появляется только когда есть изменения.
                заливка акцентом, а не рамка: рамка + серая заливка на ховере
                давали грязь, и при accentMode='cover' рамка вообще кричала */}
            {status === 'dirty' && (
              <motion.div data-motion-spatial="" onClick={saveNow}
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
                style={{
                  display:'flex', alignItems:'center', gap:6, flexShrink:0,
                  height:28, padding:'0 13px', borderRadius:8,
                  cursor:'pointer', userSelect:'none',
                  background:'rgba(var(--accent-rgb),0.9)', color:'#0a0a0c',
                  fontSize: 'var(--fs-xs)', fontWeight:600, letterSpacing:'0.01em',
                  transition:'background 0.15s',
                }}
                onMouseEnter={e => e.currentTarget.style.background='var(--accent)'}
                onMouseLeave={e => e.currentTarget.style.background='rgba(var(--accent-rgb),0.9)'}>
                {t('ed_save_btn')}
              </motion.div>
            )}
            {/* при dirty плашку не показываем — состояние уже читается по кнопке */}
            {STATUS && status !== 'dirty' && (
              <div onClick={STATUS.retry ? saveNow : undefined} style={{
                display:'flex', alignItems:'center', gap:6, flexShrink:0,
                fontSize: 'var(--fs-xs)', fontWeight:500, color: STATUS.color,
                cursor: STATUS.retry ? 'pointer' : 'default',
                userSelect:'none',
              }}>
                {status === 'saving' && <div style={{width:9, height:9, border:'1.5px solid rgba(255,255,255,0.15)', borderTopColor:'rgba(255,255,255,0.6)', borderRadius:'50%', animation:'spin 0.75s linear infinite'}}/>}
                <span ref={savedFeedbackRef} role="status">{STATUS.text}</span>
              </div>
            )}
          </div>

          {/* треки: Reorder-лист (drag за строку, ✕ удалить).
              ПОКА loaded=false — скелет на реальную высоту строки, причём
              число строк берётся из trackCount. раньше здесь был просто ноль
              высоты, и когда список наконец приезжал, панель добавления под ним
              прыгала вниз на всю его высоту. рекомендации приходят быстрее
              треков, из-за этого скачок и был таким резким */}
          {!loaded ? (
            <div>
              {Array.from({ length: Math.min(Math.max(playlist?.trackCount ?? 0, 3), 10) })
                .map((_, i) => <PlEditorRowSkeleton key={i} i={i}/>)}
            </div>
          ) : (
          <>
          {tracks.length === 0 && (
            /* empty-state с рамкой и иконкой: раньше был серый текст по центру
               на всю ширину контента — на 500px это выглядело потерянным.
               правило: либо рамка, либо иконка, либо ничего */
            <div style={{
              padding:'32px 24px', borderRadius:14, textAlign:'center',
              border:'1px dashed rgba(255,255,255,0.08)', background:'rgba(255,255,255,0.015)',
            }}>
              <img src="../assets/note.png" alt=""
                style={{width:22, height:22, filter:'brightness(0) invert(1)', opacity:0.18, marginBottom:10}}/>
              <div style={{fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.34)'}}>{t('ed_empty')}</div>
            </div>
          )}
          <Reorder.Group axis="y" values={tracks} onReorder={val => { setTracks(val); touch(); }}
            style={{listStyle:'none', margin:0, padding:0}}>
            {tracks.map(tr => {
              /* активная строка = то, что сейчас играет. это редактор
                 существующего плейлиста, а не абстрактный список: подсветка
                 даёт точку опоры и отличает «играет» от «просто есть» */
              const isPlaying = playingTrackId != null && tr.id === playingTrackId;
              return (
              <Reorder.Item key={tr.id} value={tr}
                whileDrag={{ scale: 1.015, boxShadow: '0 8px 28px rgba(0,0,0,0.45)', background: 'rgba(255,255,255,0.045)', zIndex: 2, borderRadius: 10 }}
                transition={{ type:'spring', stiffness: 500, damping: 40 }}
                style={{
                  display:'flex', alignItems:'center', gap:12, padding:'6px 8px',
                  borderRadius:10, cursor:'grab', userSelect:'none', position:'relative',
                  touchAction:'none',
                  background: isPlaying ? 'rgba(var(--accent-rgb),0.07)' : 'transparent',
                }}>
                {/* drag-хендл */}
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"
                  style={{flexShrink:0, color: isPlaying ? 'var(--accent)' : 'rgba(255,255,255,0.22)'}}>
                  <circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/>
                  <circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/>
                  <circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/>
                </svg>
                <div style={{width:36, height:36, borderRadius:8, flexShrink:0, background:'#111116',
                  overflow:'hidden', position:'relative', pointerEvents:'none',
                  /* играющий трек обведён акцентом, обложка чуть ярче */
                  boxShadow: isPlaying ? '0 0 0 1.5px rgba(var(--accent-rgb),0.75)' : 'none'}}>
                  {tr.coverUrl
                    ? <img src={tr.coverUrl} loading="lazy" style={{position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', clipPath:'inset(0 round 8px)', display:'block', opacity: isPlaying ? 1 : 0.88}}
                        onError={e => { e.currentTarget.style.display = 'none'; }}/>
                    : <img src="../assets/note.png" style={{width:10, height:10, filter:'brightness(0) invert(1)', opacity:0.2, position:'absolute', inset:0, margin:'auto'}}/>}
                  <CoverTint/>
                </div>
                <div style={{flex:1, minWidth:0}}>
                  <div style={{fontSize: 'var(--fs-sm)', color: isPlaying ? 'var(--accent)' : 'rgba(255,255,255,0.85)',
                    fontWeight: isPlaying ? 600 : 500,
                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{tr.title}</div>
                  <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.32)',
                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{tr.artist}</div>
                </div>
                <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.28)', fontVariantNumeric:'tabular-nums', flexShrink:0}}>
                  {fmt(tr.duration)}
                </div>
                <div onClick={() => removeTrack(tr.id)} title={t('ed_track_del')} style={{
                  width:26, height:26, borderRadius:8, flexShrink:0,
                  display:'flex', alignItems:'center', justifyContent:'center',
                  color:'rgba(255,255,255,0.25)', cursor:'pointer',
                  transition:'color 0.15s, background 0.15s',
                }}
                  onMouseEnter={e => { e.currentTarget.style.color='rgba(255,255,255,0.7)'; e.currentTarget.style.background='rgba(255,255,255,0.06)'; }}
                  onMouseLeave={e => { e.currentTarget.style.color='rgba(255,255,255,0.25)'; e.currentTarget.style.background='transparent'; }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                    <line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/>
                  </svg>
                </div>
              </Reorder.Item>
              );
            })}
          </Reorder.Group>
          </>
          )}

          {/* панель добавления — ОТДЕЛЬНЫЙ ВИЗУАЛЬНЫЙ СЛОЙ.
              раньше: marginTop 26, та же полупрозрачность и хайрлайн, что у
              строк списка → читалась как продолжение списка, и два фокуса на
              экране конкурировали (перетаскиваемый список vs поиск). теперь
              отступ 32 (ритм 8/12/16/24/32), плотная поверхность, своя тень —
              это «инструмент», а не контент */}
          <div style={{
            marginTop:32, borderRadius:16,
            background:'rgba(255,255,255,0.04)',
            border:'1px solid rgba(255,255,255,0.08)',
            padding:16,
            boxShadow:'0 8px 24px rgba(0,0,0,0.24)',
          }}>
            <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12}}>
              <div style={{fontSize: 'var(--fs-xs)', fontWeight:600, letterSpacing:'0.05em', textTransform:'uppercase',
                color:'rgba(255,255,255,0.35)'}}>
                {t('ed_add')}
              </div>
              <LayoutGroup>
                <div style={{display:'flex', gap:3, padding:3, borderRadius:10, background:'rgba(255,255,255,0.035)'}}>
                  {[['recs', t('ed_add_recs')], ['search', t('ed_add_search')]].map(([id, label]) => {
                    const active = tab === id;
                    return (
                      <div key={id} onClick={() => setTab(id)} style={{
                        position:'relative', padding:'5px 13px', borderRadius:8, cursor:'pointer', userSelect:'none',
                        fontSize: 'var(--fs-xs)', fontWeight: active ? 600 : 500,
                        color: active ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.38)',
                        transition:'color 0.18s ease',
                      }}>
                        <SelectionFill active={active}
                          style={{position:'absolute', inset:0, borderRadius:8, background:'rgba(255,255,255,0.07)'}}/>
                        <span style={{position:'relative'}}>{label}</span>
                      </div>
                    );
                  })}
                </div>
              </LayoutGroup>
            </div>

            {tab === 'search' ? (
              <>
                <div style={{
                  position:'relative',
                  background:'rgba(255,255,255,0.04)', borderRadius:10,
                }}>
                  <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2"
                    viewBox="0 0 24 24" style={{position:'absolute', left:12, top:'50%', translate:'0 -50%', pointerEvents:'none', color:'rgba(255,255,255,0.22)'}}>
                    <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                  </svg>
                  <input ref={addSearchRef} value={query} onChange={handleInput}
                    placeholder={t('search_hinted')}
                    style={{width:'100%', background:'none', border:'none', outline:'none',
                      padding:'8px 14px 8px 32px', color:'rgba(255,255,255,0.78)',
                      fontSize: 'var(--fs-sm)', fontFamily:'inherit'}}/>
                </div>
                <div style={{minHeight:40, maxHeight:320, overflowY:'auto', marginTop:6}} className="scroll-thin">
                  {searching && results.length === 0 && (
                    <div style={{display:'flex', justifyContent:'center', padding:'12px 0'}}>
                      <div style={{width:14, height:14, border:'2px solid rgba(255,255,255,0.15)', borderTopColor:'rgba(255,255,255,0.6)', borderRadius:'50%', animation:'spin 0.75s linear infinite'}}/>
                    </div>
                  )}
                  {!searching && query.trim() && results.length === 0 && (
                    <div style={{padding:'12px 0', fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.3)', textAlign:'center'}}>{t('not_found')}</div>
                  )}
                  {results.map(tr => (
                    <PlaylistAddRow key={tr.id} tr={tr} added={inList.has(tr.id)} onAdd={addTrack}
                      onPlay={onPlayTrack} isLoading={loadingTrackId === tr.id} isError={errorTrackId === tr.id}/>
                  ))}
                </div>
              </>
            ) : (
              /* maxHeight+скролл: список рекомендаций не должен расти без
                 границ — иначе приезд станции снова раздвигает страницу */
              <div style={{minHeight:40, maxHeight:280, overflowY:'auto'}} className="scroll-thin">
                {recsLoading && (
                  <div style={{padding:'12px 0', fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.32)', textAlign:'center', display:'flex', alignItems:'center', justifyContent:'center', gap:8}}>
                    <div style={{width:12, height:12, border:'2px solid rgba(255,255,255,0.15)', borderTopColor:'rgba(255,255,255,0.6)', borderRadius:'50%', animation:'spin 0.75s linear infinite'}}/>
                    {t('ed_rec_loading')}
                  </div>
                )}
                {!recsLoading && recs !== null && recs.length === 0 && (
                  <div style={{padding:'12px 0', fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.3)', textAlign:'center'}}>{t('ed_recs_empty')}</div>
                )}
                {!recsLoading && recs !== null && recs.length > 0 && (
                  <>
                    <div style={{display:'flex', justifyContent:'flex-end', marginBottom:2}}>
                      <div onClick={loadRecs} style={{
                        fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.3)', cursor:'pointer',
                        padding:'3px 10px', borderRadius:999, userSelect:'none',
                        border:'1px solid rgba(255,255,255,0.05)', transition:'color 0.15s, border-color 0.15s',
                      }}
                        onMouseEnter={e => { e.currentTarget.style.color='rgba(255,255,255,0.6)'; e.currentTarget.style.borderColor='rgba(255,255,255,0.12)'; }}
                        onMouseLeave={e => { e.currentTarget.style.color='rgba(255,255,255,0.3)'; e.currentTarget.style.borderColor='rgba(255,255,255,0.05)'; }}>
                        ⟳ {t('retry')}
                      </div>
                    </div>
                    {recs.map(tr => (
                      <PlaylistAddRow key={tr.id} tr={tr} added={inList.has(tr.id)} onAdd={addTrack}
                        onPlay={onPlayTrack} isLoading={loadingTrackId === tr.id} isError={errorTrackId === tr.id}/>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>

          {/* удаление плейлиста — внизу, под списком, тихой текстовой кнопкой.
              было в правом верхнем углу в 30px от «Сохранить»: два
              несовместимых намерения рядом, и постоянный розовый hover.
              здесь до него надо дочитать, и он не спорит с сохранением */}
          <div style={{
            marginTop:32, paddingTop:16, display:'flex', justifyContent:'center',
            borderTop:'1px solid rgba(255,255,255,0.055)',
          }}>
            {confirmDel ? (
              <div style={{display:'flex', alignItems:'center', gap:8}}>
                <span style={{fontSize: 'var(--fs-xs)', color:'rgba(255,80,60,0.8)'}}>{t('pl_del_sure')}</span>
                <div onClick={doDelete} title={t('pl_del')} style={{
                  width:24, height:24, borderRadius:8,
                  display:'flex', alignItems:'center', justifyContent:'center',
                  background:'rgba(255,80,60,0.14)', color:'rgba(255,105,90,0.95)',
                  cursor:deleting ? 'default' : 'pointer',
                }}>
                  {deleting
                    ? <div style={{width:10, height:10, border:'1.5px solid rgba(255,105,90,0.3)', borderTopColor:'rgba(255,105,90,0.9)', borderRadius:'50%', animation:'spin 0.75s linear infinite'}}/>
                    : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
                </div>
                <div onClick={() => setConfirmDel(false)} style={{
                  width:24, height:24, borderRadius:8,
                  display:'flex', alignItems:'center', justifyContent:'center',
                  background:'rgba(255,255,255,0.05)', color:'rgba(255,255,255,0.5)', cursor:'pointer',
                }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </div>
              </div>
            ) : (
              <div onClick={() => setConfirmDel(true)} title={t('pl_del')} style={{
                display:'flex', alignItems:'center', gap:6, padding:'6px 10px', borderRadius:8,
                cursor:'pointer', userSelect:'none',
                color:'rgba(255,255,255,0.28)', fontSize: 'var(--fs-xs)',
                transition:'color 0.15s, background 0.15s',
              }}
                onMouseEnter={e => { e.currentTarget.style.color='rgba(255,105,90,0.9)'; e.currentTarget.style.background='rgba(255,80,60,0.07)'; }}
                onMouseLeave={e => { e.currentTarget.style.color='rgba(255,255,255,0.28)'; e.currentTarget.style.background='transparent'; }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
                {t('pl_del')}
              </div>
            )}
          </div>

          {/* запас снизу: панель добавления не должна упираться в край —
              спейсер внутри колонки скроллится гарантированно */}
          <div style={{height:48}}/>
        </div>
      </div>

      {/* выход с несохранёнными изменениями: карточка с вертикальными
          полноразмерными кнопками — русские подписи влезают всегда */}
      <AnimatePresence>
        {exitGuard && visible && (
          <motion.div key="plExitGuard" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
            transition={{duration:0.16}}
            style={{position:'absolute', inset:0, zIndex:10, background:'rgba(4,4,8,0.55)',
              backdropFilter:'blur(12px)', WebkitBackdropFilter:'blur(12px)',
              display:'flex', alignItems:'center', justifyContent:'center'}}>
            <motion.div
              initial={{scale:0.97, y:10, opacity:0}}
              animate={{scale:1, y:0, opacity:1}}
              data-motion-spatial=""
              exit={{scale:0.98, y:6, opacity:0, transition:{duration:0.13, ease:[0.22,1,0.36,1]}}}
              transition={{type:'spring', stiffness:420, damping:32, mass:0.7}}
              style={{width:272,
                background:'var(--pop-bg)',
                backdropFilter:'blur(14px)', WebkitBackdropFilter:'blur(14px)',
                border:'1px solid rgba(255,255,255,0.055)', borderRadius:11,
                padding:'16px 12px 12px', transformOrigin:'center',
                boxShadow:'0 16px 44px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.32)'}}>
              <div style={{padding:'0 4px'}}>
                <div style={{fontSize: 'var(--fs-eyebrow)', letterSpacing:'0.13em', textTransform:'uppercase',
                  fontWeight:600, color:'rgba(255,255,255,0.26)', marginBottom:7}}>
                  {t('ed_dirty')}
                </div>
                <div style={{fontSize: 'var(--fs-md)', fontWeight:500, letterSpacing:'-0.01em',
                  lineHeight:1.36, color:'rgba(255,255,255,0.84)'}}>
                  {t('ed_unsaved')}
                </div>
                {playlist?.title && (
                  <div title={playlist.title} style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.25)',
                    marginTop:4, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                    {playlist.title}
                  </div>
                )}
              </div>
              {/* три ОДИНАКОВЫЕ кнопки: без акцента, без заливок, только хайрлайн.
                  единственный цвет — красный на hover у деструктивного */}
              <div style={{display:'flex', flexDirection:'column', gap:6, marginTop:14}}>
                <div onClick={guardSaveExit} style={{
                  display:'flex', alignItems:'center', justifyContent:'center', gap:7,
                  height:32, borderRadius:9, cursor:guardSaving ? 'default' : 'pointer',
                  background:'transparent', border:'1px solid rgba(255,255,255,0.075)',
                  color:'rgba(255,255,255,0.62)', fontSize: 'var(--fs-sm)', fontWeight:500,
                  userSelect:'none', transition:'background 0.14s, color 0.14s, border-color 0.14s',
                  opacity: guardSaving ? 0.55 : 1,
                }}
                  onMouseEnter={e => { if (!guardSaving) {
                    e.currentTarget.style.background='rgba(255,255,255,0.045)';
                    e.currentTarget.style.borderColor='rgba(255,255,255,0.13)';
                    e.currentTarget.style.color='rgba(255,255,255,0.92)'; } }}
                  onMouseLeave={e => { if (!guardSaving) {
                    e.currentTarget.style.background='transparent';
                    e.currentTarget.style.borderColor='rgba(255,255,255,0.075)';
                    e.currentTarget.style.color='rgba(255,255,255,0.62)'; } }}>
                  {guardSaving
                    ? <div style={{width:11, height:11, border:'1.5px solid rgba(255,255,255,0.6)', borderTopColor:'transparent', borderRadius:'50%', animation:'spin 0.75s linear infinite'}}/>
                    : null}
                  {t('ed_save_exit')}
                </div>
                <div onClick={() => { setExitGuard(false); onClose(); }} style={{
                  display:'flex', alignItems:'center', justifyContent:'center',
                  height:32, borderRadius:9, cursor:'pointer',
                  background:'transparent', border:'1px solid rgba(255,255,255,0.075)',
                  color:'rgba(255,255,255,0.45)', fontSize: 'var(--fs-sm)', fontWeight:500,
                  userSelect:'none', transition:'background 0.14s, color 0.14s, border-color 0.14s',
                }}
                  onMouseEnter={e => { e.currentTarget.style.background='rgba(255,80,60,0.07)';
                                       e.currentTarget.style.borderColor='rgba(255,80,60,0.2)';
                                       e.currentTarget.style.color='rgba(255,130,115,0.95)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background='transparent';
                                       e.currentTarget.style.borderColor='rgba(255,255,255,0.075)';
                                       e.currentTarget.style.color='rgba(255,255,255,0.45)'; }}>
                  {t('ed_discard')}
                </div>
                <div onClick={() => setExitGuard(false)} style={{
                  display:'flex', alignItems:'center', justifyContent:'center',
                  height:32, borderRadius:9, cursor:'pointer',
                  background:'transparent', border:'1px solid rgba(255,255,255,0.075)',
                  color:'rgba(255,255,255,0.32)', fontSize: 'var(--fs-sm)', fontWeight:500,
                  userSelect:'none', transition:'background 0.14s, color 0.14s, border-color 0.14s',
                }}
                  onMouseEnter={e => { e.currentTarget.style.background='rgba(255,255,255,0.045)';
                                       e.currentTarget.style.borderColor='rgba(255,255,255,0.13)';
                                       e.currentTarget.style.color='rgba(255,255,255,0.8)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background='transparent';
                                       e.currentTarget.style.borderColor='rgba(255,255,255,0.075)';
                                       e.currentTarget.style.color='rgba(255,255,255,0.32)'; }}>
                  {t('cancel')}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

/* ── recent searches ─────────────────────────────────────────────────────────
   Живут в localStorage, а не в settings: это не настройка, а личная история
   вкладки, и тащить её в settings.json (который переписывается целиком при
   каждом сохранении) незачем. Ключ читается один раз при монтировании —
   вкладка перерисовывается на каждый кадр лерпа акцента, а список запросов
   за это время не меняется. */
const RECENT_KEY  = 'sewer.search.recent';
const RECENT_MAX  = 6;
function loadRecent() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(x => typeof x === 'string' && x.trim()).slice(0, RECENT_MAX) : [];
  } catch { return []; }
}
function saveRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch {}
}

/* ── SearchTopResult ───────────────────────────────────────────────────────
   «Лучшее» — первый результат крупной карточкой над списком. Приём взят с
   главной: тот же hover-оверлей с play (классы .home-card-*), то же сердце
   с пружинным pop, и то же пятно цвета обложки, каким AmbientGlow светит
   в плеере — цвет берём из самой картинки тем же extractAccentColor
   (кэш по url + один кадр 32×32). Без filter:blur — мягкость даёт сам
   градиент, ровно как в ArtistView.

   Смысл не только в украшении: первый результат — самый релевантный, и
   раньше он ничем не отличался от остальных строк, поэтому его приходилось
   искать глазами по первому месту в списке. */
function SearchTopResult({ track, isLiked, onLike, onPlay, onSelect, isLoading, isError, artHidden, glowOff }) {
  const t = useLang();
  const [popKey, setPopKey] = useState(0);
  const [glow, setGlow] = useState(null);

  useEffect(() => {
    if (!track.coverUrl) { setGlow(null); return; }
    let dead = false;
    extractAccentColor(track.coverUrl).then(c => {
      if (!dead && c) setGlow(`${c.r}, ${c.g}, ${c.b}`);
    });
    return () => { dead = true; };
  }, [track.coverUrl]);

  const pc = fmtCount(track.playCount);
  const yr = fmtYear(track.releasedAt);

  return (
    /* className="home-card" — не для вида, а ради `.home-card:hover
       .home-card-overlay`: оверлей с play и сердце проявляются на карточке
       целиком, ровно как на главной. Сама карточка тут широкая, поэтому
       её фон и рамка заданы инлайном, а не классом. */
    <div className="home-card" onClick={onSelect}
      style={{
        position:'relative', display:'flex', alignItems:'center', gap:18,
        padding:'13px 16px 13px 13px', borderRadius:16, overflow:'hidden', cursor:'pointer',
        background:'rgba(255,255,255,0.045)', border:'1px solid rgba(255,255,255,0.045)',
        transition:'background 0.18s ease, border-color 0.18s ease',
      }}
      onMouseEnter={e => { e.currentTarget.style.background='rgba(255,255,255,0.075)';
                           e.currentTarget.style.borderColor='rgba(255,255,255,0.08)'; }}
      onMouseLeave={e => { e.currentTarget.style.background='rgba(255,255,255,0.045)';
                           e.currentTarget.style.borderColor='rgba(255,255,255,0.045)'; }}>
      {/* пятно цвета обложки — прижато к обложке и обрезано карточкой,
          поэтому уезжает наружу ровно настолько, насколько хватает
          скруглённого угла, и не ложится пятном на весь блок.
          glowOff — тот же тумблер, что у AmbientGlow в плеере и у пятна за
          аватаром артиста: выключенные свечения должны гаснуть везде */}
      <div style={{
        position:'absolute', left:-26, top:'-50%', width:180, height:'200%',
        background: glow && !glowOff
          ? `radial-gradient(ellipse closest-side at center, rgba(${glow},0.20) 0%, rgba(${glow},0.08) 48%, transparent 100%)`
          : 'none',
        opacity: glow && !glowOff ? 1 : 0, transition:'opacity 0.5s ease', pointerEvents:'none',
      }}/>
      {/* обложка. data-sewer-art — точка отрыва для hero: клик по карточке
          уводит в плеер, и клон обложки стартует ровно отсюда, как на
          главной (см. findArtEl и openSearchTrack) */}
      <div data-sewer-art={track.id} onClick={e => { e.stopPropagation(); if (!isLoading) onPlay(); }} style={{
        position:'relative', width:92, height:92, borderRadius:14, flexShrink:0,
        background:'#111116', overflow:'hidden',
        cursor: isLoading ? 'default' : 'pointer',
        opacity: artHidden ? 0 : 1, transition:'opacity 0.14s ease',
      }}>
        {track.coverUrl
          ? <img src={track.coverUrl} loading="lazy" decoding="async"
              style={{position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', clipPath:'inset(0 round 14px)', display:'block'}}
              onError={e => { e.currentTarget.style.display = 'none'; }}/>
          : <img src="../assets/note.png" alt="" style={{width:24, height:24, filter:'brightness(0) invert(1)', opacity:0.13}}/>}
        <CoverTint/>
        <div className="home-card-overlay" style={{
          position:'absolute', inset:0, background:'rgba(0,0,0,0.36)',
          display:'flex', alignItems:'center', justifyContent:'center',
        }}>
          <div className="home-card-play" style={{
            width:44, height:44, borderRadius:'50%',
            display:'flex', alignItems:'center', justifyContent:'center',
          }}>
            <svg width="24" height="24" fill="#fff" viewBox="0 0 24 24" style={{marginLeft:2}}><polygon points="6,4 20,12 6,20"/></svg>
          </div>
        </div>
        {isLoading && <div style={{position:'absolute', inset:0, background:'rgba(0,0,0,0.55)',
          display:'flex', alignItems:'center', justifyContent:'center'}}>
          <div style={{width:15, height:15, border:'2px solid rgba(255,255,255,0.15)', borderTopColor:'rgba(255,255,255,0.6)', borderRadius:'50%', animation:'spin 0.75s linear infinite'}}/>
        </div>}
      </div>
      {/* название / исполнитель / числа */}
      <div style={{flex:1, minWidth:0, position:'relative'}}>
        <div style={{fontSize:'var(--fs-lg)', fontWeight:500, color:'rgba(255,255,255,0.9)',
          letterSpacing:'-0.01em', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
          {track.title}
        </div>
        <div style={{fontSize:'var(--fs-sm)', color:'rgba(255,255,255,0.42)', marginTop:3,
          overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
          {formatArtistDisplay(track.artist)}
        </div>
        <div style={{
          display:'flex', alignItems:'center', gap:15, marginTop:9,
          fontSize:'var(--fs-xs)', color:'rgba(255,255,255,0.3)', fontVariantNumeric:'tabular-nums',
        }}>
          {pc && <span style={{display:'flex', alignItems:'center', gap:5}}>
            <img src="../assets/vosproizvedenie.png" alt="" width="9" height="9"
              style={{display:'block', filter:'brightness(0) invert(1)', opacity:0.5, flexShrink:0}}/>
            {pc}
          </span>}
          {yr && <span>{yr}</span>}
          <span style={{color: isError ? 'rgba(255,80,80,0.7)' : undefined}}>{isError ? '—' : fmt(track.duration)}</span>
        </div>
      </div>
      {/* сердце — без цифры: у лучшего результата счётчики уже есть слева,
          а второе число читалось бы как «лайков столько-то» про то же самое.
          Видно всегда, а не по наведению, как на карточках главной: здесь
          карточка широкая, и без него вся правая половина пустует. Инлайновый
          opacity перебивает `.home-card-like { opacity:0 }` из стилей. */}
      {onLike && (
        <div title={t('likes')}
          onClick={e => { e.stopPropagation(); if (!isLiked) setPopKey(k => k + 1); onLike(); }}
          style={{
            position:'relative', width:36, height:36, flexShrink:0, borderRadius:'50%',
            display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer',
            opacity:1,
            color: isLiked ? 'var(--accent)' : 'rgba(255,255,255,0.36)',
            transition:'color 0.18s ease, background 0.15s ease',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
          <LikeHeart key={popKey} liked={isLiked} size={16}
            className={popKey ? 'like-pop like-glow' : undefined}/>
        </div>
      )}
    </div>
  );
}

/* ── SearchArtistCard ──────────────────────────────────────────────────────
   Исполнитель в результатах. Раньше это была клетка с заливкой И рамкой —
   единственное место на вкладке, где фон и граница стояли одновременно, и на
   общем тёмном фоне четыре такие клетки читались сеткой таблицы.

   Теперь это та же карточка, что на главной, только круглая: аватар сверху,
   имя под ним. Горизонтальный вариант в четырёх колонках не выжил — на
   ~165px на колонку от аватара и подписи оставалось меньше 80px, и имена
   обрезались до «aphex-…», а счётчики подписчиков — до «8 400 00…».
   Вертикальная карточка даёт имени всю ширину колонки. */
function SearchArtistCard({ user, onClick }) {
  const t = useLang();
  return (
    <div onClick={onClick}
      style={{
        display:'flex', flexDirection:'column', alignItems:'center',
        padding:'12px 8px 11px', borderRadius:14, cursor:'pointer', minWidth:0,
        transition:'background 0.16s ease',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
      {user.avatarUrl
        ? <img src={user.avatarUrl} loading="lazy" decoding="async"
            style={{width:'100%', maxWidth:124, aspectRatio:'1', borderRadius:'50%', objectFit:'cover', background:'#111116'}}/>
        : <div style={{width:'100%', maxWidth:124, aspectRatio:'1', borderRadius:'50%', background:'rgba(255,255,255,0.05)',
            display:'flex', alignItems:'center', justifyContent:'center'}}>
            <svg width="26" height="26" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.6" viewBox="0 0 24 24">
              <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
            </svg>
          </div>}
      <div style={{fontSize:'var(--fs-md)', fontWeight:500, color:'rgba(255,255,255,0.84)',
        marginTop:11, maxWidth:'100%', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
        {tidyScArtist(user.username)}
      </div>
      {user.followersCount > 0 && (
        <div style={{fontSize:'var(--fs-xs)', color:'rgba(255,255,255,0.3)', marginTop:2,
          maxWidth:'100%', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
          {/* fmtCount, а не toLocaleString: «8.4M» помещается в колонку,
              «8 400 000» — нет, и строка обрезалась на середине числа */}
          {fmtCount(user.followersCount)} {t('followers')}
        </div>
      )}
    </div>
  );
}

const SearchView = React.forwardRef(function SearchView({ visible, scAuth, likedIds, onLike, onPlayTrack, onSelectTrack, onResultsLoaded, onArtistClick, loadingTrackId, errorTrackId, hideDividers, heroId, glowOff, onLogin }, ref) {
  const T = useLang();
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const [query,   setQuery]   = useState('');
  const [results, setResults] = useState([]);
  const [users,   setUsers]   = useState([]);
  const [loading, setLoading] = useState(false);
  const [offset,  setOffset]  = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [focused, setFocused] = useState(false);
  const [recent,  setRecent]  = useState(loadRecent);
  const debounceRef  = useRef(null);
  const queryRef     = useRef('');
  const loadingRef   = useRef(false);
  const hasMoreRef   = useRef(false);
  const offsetRef    = useRef(0);
  /* номер последнего запроса выдачи (см. doSearch) */
  const reqSeq       = useRef(0);
  hasMoreRef.current = hasMore;
  offsetRef.current  = offset;
  React.useImperativeHandle(ref, () => ({
    focus: () => { inputRef.current?.focus(); inputRef.current?.select(); },
    loadMore: () => {
      if (!hasMoreRef.current || loadingRef.current) return;
      doSearch(queryRef.current, offsetRef.current);
    },
    /* Обложка трека в этом списке — для hero-перелёта в плеер. Ищем только
       ВНУТРИ своей вёрстки, а не по всему экрану: те же data-sewer-art стоят
       на строках экрана артиста и на карточках главной, и общий поиск отдал бы
       hero элемент из невидимой вкладки — клон улетел бы из пустоты. */
    findArt: (id) => listRef.current?.querySelector(`[data-sewer-art="${CSS.escape(String(id))}"]`) || null,
  }));

  const hasResults = results.length > 0 || users.length > 0;
  /* состояние «пусто»: нечего искать, и поле стоит по центру крупным.
     Поле то же самое, что и с результатами — меняются только отступы и
     кегль, одним transition'ом (см. шапку ниже) */
  const idle = !query.trim() && !loading && !hasResults;

  const doSearch = async (q, off = 0) => {
    if (!q.trim() || !scAuth) return;
    const seq = ++reqSeq.current;
    /* в soundcloud уходит очищенный запрос: «lux aeterna (archive)» и
       «✞трек✞» там не находятся — скобок и крестов в индексе нет */
    const sq = scQueryFor(q);
    loadingRef.current = true;
    setLoading(true);
    try {
      const [tracksRes, usersRes] = await Promise.all([
        window.electronAPI.scFetch(
          `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(sq)}&limit=20&offset=${off}`,
          scAuth.token, scAuth.clientId
        ),
        off === 0
          ? window.electronAPI.scFetch(
              `https://api-v2.soundcloud.com/search/users?q=${encodeURIComponent(sq)}&limit=4`,
              scAuth.token, scAuth.clientId
            )
          : Promise.resolve(null),
      ]);
      /* ⚠️ Здесь был `queryRef.current !== q` и `return` — то есть устаревший
         ответ уходил, не погасив `loading`. Пока следующий запрос в пути, это
         незаметно, но если поле к тому моменту уже очистили, спиннер оставался
         крутиться в пустом поле навсегда, а вкладка — в состоянии «идёт
         поиск». Теперь запрос помечен номером: состояние правит только
         последний, а гашение `loading` — ниже, общим путём */
      if (seq !== reqSeq.current) return;
      const newTracks = (tracksRes?.data?.collection || []).map(raw => {
        const mapped = mapScTrack(raw, T('no_title'));
        /* переименованный вручную трек не чистим: это имя дал человек */
        return SC_TITLES.has(scTitleKey(mapped.id)) ? mapped : cleanScTrackForSearch(mapped);
      });
      if (off === 0) {
        setResults(newTracks);
        setUsers((usersRes?.data?.collection || []).map(u => ({
          id: u.id, username: u.username,
          avatarUrl: u.avatar_url,
          followersCount: u.followers_count,
          bannerUrl: u.visuals?.visuals?.[0]?.visual_url || null,
        })));
        /* запрос в историю — только когда он что-то нашёл. Иначе список
           забивался бы опечатками и пустыми результатами, а он для того
           и нужен, чтобы по нему возвращаться к удачному запросу */
        if (newTracks.length > 0 || usersRes?.data?.collection?.length > 0) pushRecent(q);
      } else {
        setResults(prev => [...prev, ...newTracks]);
        if (newTracks.length > 0) onResultsLoaded?.(newTracks);
      }
      setHasMore(!!tracksRes?.data?.next_href);
      setOffset(off + 20);
    } catch {
      /* мост отказал (уходящее окно, не дошла команда): выдача остаётся
         прежней, но спиннер обязан погаснуть */
    }
    if (seq !== reqSeq.current) return;
    loadingRef.current = false;
    setLoading(false);
  };

  /* История запросов. Список без повторов (регистр не важен: «Travis» и
     «travis» — один и тот же запрос) и всегда свежие первыми. Запись
     делается здесь, а не в useEffect на results: апдейт-эффект сработал бы
     и при догрузке второй страницы, где запрос прежний.
     На диск пишем отдельным эффектом: localStorage внутри апдейтера —
     побочный эффект во время рендера, и StrictMode вызвал бы его дважды. */
  const pushRecent = (q) => {
    const s = q.trim();
    if (!s) return;
    setRecent(prev => [s, ...prev.filter(x => x.toLowerCase() !== s.toLowerCase())].slice(0, RECENT_MAX));
  };
  useEffect(() => { saveRecent(recent); }, [recent]);

  /* Уход со вкладки должен уводить и фокус. `pointerEvents:'none'` на корне
     блокирует мышь, но не фокус: поле остаётся активным элементом — курсор
     мигает в невидимом вводе, клавиатура (Enter, стрелки, Ctrl+F-состояния)
     продолжает жить в скрытой вкладке. blur здесь, а не в App: ref на поле
     живёт в этом компоненте. */
  useEffect(() => {
    if (!visible && document.activeElement === inputRef.current) inputRef.current?.blur();
  }, [visible]);

  /* Переезд поля сделан transform'ом, а не `top`. `top` в процентах ↔ `top`
     в пикселях — это layout на каждом кадре перехода, и в WebView2 поле
     дёргалось, а не ехало. transform уходит на композитор, layout не трогает.
     26% — та же точка покоя, что была у `top:26%`: высоту вкладки меряем
     ResizeObserver'ом, чтобы переезд оставался честным при ресайзе окна. */
  const rootRef = useRef(null);
  const [rootH, setRootH] = useState(0);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setRootH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scAuth]);
  const idleShift = Math.max(0, rootH * 0.26 - 22);

  const applyRecent = (q) => {
    setQuery(q);
    queryRef.current = q;
    setResults([]); setUsers([]); setOffset(0);
    doSearch(q, 0);
    inputRef.current?.focus();
  };

  const clearRecent = () => { setRecent([]); saveRecent([]); };

  /* Поле опустело: всё, что «в пути», больше не нужно. Номер запроса
     сдвигаем — ответ, пришедший позже, уже не тронет ни выдачу, ни спиннер
     (раньше он возвращался по проверке queryRef и оставлял `loading`
     включённым: спиннер крутился в пустом поле до следующего поиска). */
  const resetSearch = () => {
    /* и таймер тоже: иначе отложенный поиск по прошлому запросу прилетит
       уже в очищенное поле — с номером запроса он станет «последним» и
       нарисует выдачу для стёртого запроса */
    clearTimeout(debounceRef.current);
    reqSeq.current++;
    loadingRef.current = false;
    setLoading(false);
    setResults([]); setUsers([]); setOffset(0); setHasMore(false);
  };

  const handleInput = e => {
    const q = e.target.value;
    setQuery(q);
    queryRef.current = q;
    clearTimeout(debounceRef.current);
    if (!q.trim()) { resetSearch(); return; }
    /* 150 мс: api-v2 отвечает за 200–500 мс, так что 380 мс дебаунса были
       самой большой задержкой на пути «отпустил клавишу → увидел выдачу» —
       больше, чем сам запрос. Устаревшие ответы отсекает queryRef ниже, а
       лишние запросы гасит сам дебаунс: печатают быстрее 6–7 символов в
       секунду редко */
    debounceRef.current = setTimeout(() => doSearch(q, 0), 150);
  };

  const clear = () => {
    setQuery(''); queryRef.current = '';
    resetSearch();
    inputRef.current?.focus();
  };

  const handleKey = e => {
    if (e.key === 'Escape') { e.stopPropagation(); if (query) clear(); }
    /* Enter отменяет дебаунс и ищет сразу — иначе пришлось бы ждать 380ms
       после того, как человек уже отпустил кнопку и начал нажимать трек */
    else if (e.key === 'Enter') {
      clearTimeout(debounceRef.current);
      if (query.trim()) doSearch(query.trim(), 0);
    }
  };

  const handleScroll = e => {
    if (!hasMore || loadingRef.current) return;
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) doSearch(query, offset);
  };

  /* подложка-подсказка под полем в состоянии покоя. Раньше вместо неё
     стоял одинокий хайдрайвер «Ctrl+F» в плейсхолдере: подсказка исчезала
     на первом же напечатанном символе, то есть ровно тогда, когда она
     нужна. Здесь она живёт отдельно от поля и не конкурирует с текстом. */
  const keycap = (text) => (
    <span style={{
      display:'inline-block', padding:'2px 6px', margin:'0 2px', borderRadius:5,
      background:'rgba(255,255,255,0.055)', border:'1px solid rgba(255,255,255,0.05)',
      fontSize:'var(--fs-xs)', color:'rgba(255,255,255,0.32)', fontFamily:'inherit',
    }}>{text}</span>
  );

  const top = results[0];
  const rest = results.slice(1);

  /* ⚠️ `visibility` здесь не для анимации, а для hit-testing. В WebView2
     (как и в Chromium вообще) `opacity:0` НЕ исключает элемент из hit-test:
     он невидим, но клики по-прежнему ловит, если у потомков свой
     `pointerEvents`. `pointerEvents:'none'` на корне это чинит только пока
     потомок не переопределил его обратно ('auto' на результатах, на карточке
     пользователя). Вкладка поиска лежит в дереве ПОСЛЕ плеера, то есть
     выше его по порядку отрисовки — и её невидимые результаты перехватывали
     клики в плеере. Ровно жалоба «ушёл с поиска, а он всё ещё нажимается».
     `visibility:hidden` выключает hit-test гарантированно на всём поддереве,
     а transition на visibility возвращает элемент в поток мгновенно при
     появлении (задержка только на скрытие — чтобы не рубить анимацию opacity).
     Тот же приём теперь общий для всех вкладок — stackRoot; здесь остаётся
     короткий fade (0.14s), отличный от остальных. */
  const rootStyle = stackRoot(visible);

  /* Без входа в soundcloud искать нечем: doSearch выходит на первой строке,
     и вкладка выглядела как рабочая — можно было напечатать запрос и
     получить «ничего не найдено», то есть вины поиска, хотя запрос не
     уходил никуда. Показываем то же приглашение, что на вкладке
     плейлистов и на экране артиста: иконка, одна фраза, кнопка входа.
     Ранний return — хуков после useImperativeHandle в SearchView нет,
     так что порядок вызовов не ломается. */
  if (!scAuth) {
    return (
      <div style={rootStyle}>
        <div style={{
          display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
          minHeight:'calc(100vh - 180px)', gap:22, textAlign:'center', padding:'0 40px',
        }}>
          <div style={{
            width:72, height:72, borderRadius:20,
            background:'rgba(255,255,255,0.035)',
            display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0,
          }}>
            <svg width="32" height="32" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35" strokeLinecap="round"/>
            </svg>
          </div>
          <div style={{fontSize:'var(--fs-md)', color:'rgba(255,255,255,0.32)', lineHeight:1.6, maxWidth:340}}>
            {T('sc_hint').split('\n').map((l, i) => <span key={i}>{l}{i === 0 && <br/>}</span>)}
          </div>
          <button onClick={onLogin} style={{
            display:'flex', alignItems:'center', gap:8,
            background:'rgba(255,85,0,0.1)', border:'none', borderRadius:10,
            padding:'9px 18px', fontSize:'var(--fs-md)', fontWeight:500,
            color:'rgba(255,130,60,0.85)', cursor:'pointer', fontFamily:'inherit',
            transition:'background 0.15s',
          }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,85,0,0.17)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,85,0,0.1)'; }}>
            <SoundCloudIcon size={14} fill="rgba(255,130,60,0.9)"/>
            {T('login_sc')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={rootStyle} ref={rootRef}>
      {/* ── шапка ───────────────────────────────────────────────────────────
          Одно поле в обоих состояниях: в покое оно крупнее и стоит ниже,
          с результатами — прижато к верху, но остаётся читаемым: кегль
          опускается до --fs-lg, а ширина ограничена 560px, чтобы это не была
          растянутая на весь экран тонкая полоска. Переезжает не сам элемент,
          а контейнер — через transform, а не top: top в процентах и top в
          пикселях анимируются через layout, и поле дёргалось. */}
      <div data-motion-position="" style={{
        position:'absolute', left:0, right:0, top:22,
        transform: idle ? `translateY(${idleShift}px)` : 'translateY(0)',
        /* пока высота не измерена, переезда нет: иначе первый рендер даёт
           translateY(0) и браузер «доезжает» до правильной точки сам */
        transition: rootH ? 'transform 0.42s cubic-bezier(0.22,1,0.36,1)' : 'none',
        padding:'0 52px', zIndex:2, pointerEvents:'none',
      }}>
        <div data-motion-position="" style={{
          position:'relative', margin:'0 auto', width:'100%',
          maxWidth: idle ? 420 : 560,
          background: focused
            ? 'rgba(255,255,255,0.075)'
            : (hasResults || query.trim() ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.035)'),
          /* Рамки нет ни в одном состоянии, включая фокус. Акцентная обводка
             была единственной цветной линией на вкладке и читалась рамкой поля
             ввода из чужого интерфейса — ровно то, за что уже ругали кнопку
             лайка (см. комментарий в SearchTrackRow). Остаётся только фон:
             он и говорит «здесь печатают», но не диктует форму. */
          border:'1px solid transparent',
          borderRadius: idle ? 18 : 14,
          transition:'background 0.2s ease, border-radius 0.42s cubic-bezier(0.22,1,0.36,1), max-width 0.42s cubic-bezier(0.22,1,0.36,1)',
          pointerEvents:'auto',
        }}>
          <svg width={idle ? 18 : 16} height={idle ? 18 : 16} fill="none" stroke="currentColor"
            strokeWidth="2.2" viewBox="0 0 24 24"
            style={{
              position:'absolute', left: idle ? 22 : 18, top:'50%', translate:'0 -50%',
              pointerEvents:'none', flexShrink:0,
              color: focused ? 'rgba(255,255,255,0.42)' : 'rgba(255,255,255,0.24)',
              transition:'color 0.2s ease',
            }}>
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35" strokeLinecap="round"/>
          </svg>
          <input data-motion-position=""
            ref={inputRef}
            value={query}
            onChange={handleInput}
            onKeyDown={handleKey}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={idle ? T('search_ph') : T('search_hinted')}
            style={{
              width:'100%', background:'transparent', border:'none', outline:'none',
              padding: idle ? '15px 52px' : '14px 48px 14px 46px',
              color: idle ? '#ededf4' : 'rgba(255,255,255,0.86)',
              fontSize: idle ? 'var(--fs-xl)' : 'var(--fs-lg)',
              fontFamily:'inherit', textAlign:'center',
              transition:'padding 0.42s cubic-bezier(0.22,1,0.36,1), font-size 0.42s cubic-bezier(0.22,1,0.36,1)',
            }}
          />
          {/* крестик и спиннер делят одно место: пока идёт запрос, крестик
              убирать нельзя — он отменяет ввод, а не запрос */}
          {loading
            ? <div style={{position:'absolute', right: idle ? 20 : 17, top:'50%', translate:'0 -50%',
                width:14, height:14, borderRadius:'50%', pointerEvents:'none',
                border:'2px solid rgba(255,255,255,0.14)', borderTopColor:'rgba(255,255,255,0.5)',
                animation:'spin 0.7s linear infinite'}}/>
            : query && (
              <div onClick={clear} title={T('del')}
                style={{
                  position:'absolute', right: idle ? 18 : 15, top:'50%', translate:'0 -50%',
                  width: idle ? 20 : 19, height: idle ? 20 : 19, borderRadius:'50%',
                  display:'flex', alignItems:'center', justifyContent:'center',
                  color:'rgba(255,255,255,0.28)', cursor:'pointer',
                  transition:'background 0.15s, color 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background='rgba(255,255,255,0.08)'; e.currentTarget.style.color='rgba(255,255,255,0.6)'; }}
                onMouseLeave={e => { e.currentTarget.style.background='transparent'; e.currentTarget.style.color='rgba(255,255,255,0.28)'; }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2.4" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </div>
            )}
        </div>
      </div>

      {/* ── покой: поле по центру, под ним история запросов ─────────────────
          Раньше здесь была пустота до самого низа. Теперь то же пустое
          место занято историей — она и есть ответ на «что тут вообще
          делать», и она же убирает необходимость запоминать, что поиск
          существует. */}
      {idle && (
        <div data-motion-position="" style={{
          position:'absolute', left:0, right:0, top:'26%',
          marginTop: idle ? 96 : 0,
          padding:'0 52px', pointerEvents:'none',
          transition:'margin-top 0.42s cubic-bezier(0.22,1,0.36,1)',
        }}>
          {recent.length > 0 && (
            <div style={{maxWidth:420, margin:'0 auto', pointerEvents:'auto'}}>
              <div style={{display:'flex', alignItems:'center', gap:12, marginBottom:12}}>
                <div style={{fontSize:'var(--fs-eyebrow)', letterSpacing:'0.12em', textTransform:'uppercase',
                  color:'rgba(255,255,255,0.2)', fontWeight:500, flexShrink:0}}>
                  {T('search_recent')}
                </div>
                <div style={{flex:1, height:1, background:'rgba(255,255,255,0.05)'}}/>
                <div onClick={clearRecent} title={T('search_recent_clear')}
                  style={{
                    fontSize:'var(--fs-xs)', color:'rgba(255,255,255,0.22)',
                    cursor:'pointer', padding:'3px 9px', borderRadius:999, flexShrink:0,
                    transition:'color 0.15s, background 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color='rgba(255,255,255,0.5)'; e.currentTarget.style.background='rgba(255,255,255,0.055)'; }}
                  onMouseLeave={e => { e.currentTarget.style.color='rgba(255,255,255,0.22)'; e.currentTarget.style.background='transparent'; }}>
                  {T('search_recent_clear')}
                </div>
              </div>
              <div style={{display:'flex', flexWrap:'wrap', gap:7}}>
                {recent.map(q => (
                  <div key={q} onClick={() => applyRecent(q)}
                    style={{
                      display:'flex', alignItems:'center', gap:7,
                      padding:'7px 13px', borderRadius:999,
                      background:'rgba(255,255,255,0.04)',
                      color:'rgba(255,255,255,0.6)',
                      fontSize:'var(--fs-sm)', cursor:'pointer',
                      transition:'background 0.15s, color 0.15s',
                      maxWidth:'100%',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background='rgba(255,255,255,0.08)'; e.currentTarget.style.color='rgba(255,255,255,0.85)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background='rgba(255,255,255,0.04)'; e.currentTarget.style.color='rgba(255,255,255,0.6)'; }}>
                    <svg width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2"
                      strokeLinecap="round" style={{flexShrink:0, opacity:0.5}} viewBox="0 0 24 24">
                      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                    </svg>
                    <span style={{overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{q}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div style={{
            marginTop: recent.length > 0 ? 30 : 0, textAlign:'center',
            fontSize:'var(--fs-md)', color:'rgba(255,255,255,0.24)', lineHeight:1.65,
          }}>
            {T('search_hint').split('\n').map((l, i) => <span key={i}>{l}{i === 0 && <br/>}</span>)}
          </div>
          <div style={{marginTop:16, textAlign:'center', fontSize:'var(--fs-xs)', color:'rgba(255,255,255,0.16)'}}>
            {keycap('Ctrl')} {keycap('F')}
          </div>
        </div>
      )}

      {/* скелет первой загрузки — до первых результатов */}
      {!idle && !hasResults && loading && (
        <div style={{position:'absolute', left:52, right:52, top:'calc(22px + 64px)'}}>
          <SearchSkeleton/>
        </div>
      )}

      {/* пустой результат */}
      {!idle && !hasResults && !loading && query.trim() && (
        <div style={{
          position:'absolute', left:0, right:0, top:'calc(22px + 100px)', textAlign:'center',
          padding:'0 52px',
        }}>
          <div style={{
            width:64, height:64, borderRadius:20, margin:'0 auto 16px',
            background:'rgba(255,255,255,0.03)',
            display:'flex', alignItems:'center', justifyContent:'center',
          }}>
            <svg width="27" height="27" fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="1.7" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35" strokeLinecap="round"/>
            </svg>
          </div>
          <div style={{fontSize:'var(--fs-md)', color:'rgba(255,255,255,0.3)'}}>{T('not_found')}</div>
          <div style={{
            marginTop:14, display:'inline-flex', alignItems:'center', gap:8,
            padding:'7px 14px', borderRadius:999, background:'rgba(255,255,255,0.04)',
            fontSize:'var(--fs-sm)', color:'rgba(255,255,255,0.55)', cursor:'pointer',
            transition:'background 0.15s, color 0.15s',
          }}
            onMouseEnter={e => { e.currentTarget.style.background='rgba(255,255,255,0.08)'; e.currentTarget.style.color='rgba(255,255,255,0.8)'; }}
            onMouseLeave={e => { e.currentTarget.style.background='rgba(255,255,255,0.04)'; e.currentTarget.style.color='rgba(255,255,255,0.55)'; }}
            onClick={clear}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.2" strokeLinecap="round">
              <polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>
            </svg>
            {T('search_ph')}
          </div>
        </div>
      )}

      {/* ── результаты ────────────────────────────────────────────────────
          Лучшее → исполнители → треки. Лучшее вынесено из списка треков,
          чтобы один и тот же результат не печатался дважды; список
          начинается со второго. */}
      {hasResults && (
        <div ref={listRef} onScroll={handleScroll}
          className="scroll-thin"
          style={{
            position:'absolute', left:0, right:10,
            top: idle ? 0 : 'calc(22px + 64px)', bottom:0,
            overflowY:'auto', padding:'16px 52px 32px',
            /* ❌ был `willChange:'transform'`, хотя transform у этого
               элемента НИКОГДА не меняется — он просто скроллится.
               подсказка браузеру «готовь слой под transform» тут
               бессмысленна: держала лишний слой на всю область
               результатов поиска на всё время её жизни. */
          }}>
          {/* «Лучшее» и исполнители стоят друг ПОД ДРУГОМ, а не рядом.
              Рядом они съедали бы ширину: карточке «лучшего» в колонке
              340px имя трека обрезалось на втором-третьем слове, а ради
              одного трека, который и так вынесен наверх, это плохой размен.
              Широкая полоса — та же, что была на главной, и заголовок читается. */}
          {top && (
            <div style={{marginBottom:28}}>
              <div style={{fontSize:'var(--fs-eyebrow)', letterSpacing:'0.12em', textTransform:'uppercase',
                color:'rgba(255,255,255,0.22)', fontWeight:500, marginBottom:11}}>
                {T('search_best')}
              </div>
              <SearchTopResult track={top}
                isLiked={likedIds.has(top.id)}
                onLike={() => onLike(top)}
                onSelect={() => onSelectTrack(top, results)}
                onPlay={() => onPlayTrack(top, results)}
                isLoading={loadingTrackId === top.id}
                isError={errorTrackId === top.id}
                artHidden={heroId != null && top.id === heroId}
                glowOff={glowOff}/>
            </div>
          )}

          {users.length > 0 && (
            <div style={{marginBottom:28}}>
              <div style={{fontSize:'var(--fs-eyebrow)', letterSpacing:'0.12em', textTransform:'uppercase',
                color:'rgba(255,255,255,0.22)', fontWeight:500, marginBottom:9}}>
                {T('artists')}
              </div>
              {/* Ровно четыре колонки, а не auto-fill: исполнителей в выдаче
                  всегда ≤4, и при auto-fill на ~720px колонки выходили три —
                  четвёртый падал на вторую строку и висел в ней один.
                  Окно не изменяется размером (resizable:false), места хватает. */}
              <div style={{display:'grid', gridTemplateColumns:'repeat(4, minmax(0, 1fr))', gap:10}}>
                {users.slice(0, 4).map(u => (
                  <SearchArtistCard key={u.id} user={u} onClick={() => onArtistClick?.(u)}/>
                ))}
              </div>
            </div>
          )}

          {rest.length > 0 && (
            <div>
              <div style={{fontSize:'var(--fs-eyebrow)', letterSpacing:'0.12em', textTransform:'uppercase',
                color:'rgba(255,255,255,0.22)', fontWeight:500, marginBottom:8}}>
                {T('tracks_label')}
              </div>
              {rest.map(t => (
                <SearchTrackRow key={t.id} track={t}
                  isLiked={likedIds.has(t.id)}
                  onLike={() => onLike(t)}
                  onClick={() => onSelectTrack(t, results)}
                  onCoverClick={() => onPlayTrack(t, results)}
                  isLoading={loadingTrackId === t.id}
                  isError={errorTrackId === t.id}
                  artHidden={heroId != null && t.id === heroId}
                  hideDividers={hideDividers}/>
              ))}
              {loading && (
                <div style={{display:'flex', justifyContent:'center', padding:'20px 0'}}>
                  <div style={{width:15, height:15, borderRadius:'50%',
                    border:'2px solid rgba(255,255,255,0.14)', borderTopColor:'rgba(255,255,255,0.45)',
                    animation:'spin 0.7s linear infinite'}}/>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/* ── ArtistView ──────────────────────────────────────────────────────────── */
function ArtistView({ artist, visible, onClose, scAuth, likedIds, onLike, onPlayTrack, onSelectTrack,
                      loadingTrackId, errorTrackId, artistCacheRef, onFollow, onCheckFollow,
                      onTracksAppended, onLogin, hideDividers, glowOff }) {
  const t = useLang();
  const [tab, setTab] = useState('popular');
  const [fetched, setFetched] = useState(null);
  const [artistTracks, setArtistTracks] = useState([]);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [tracksError, setTracksError] = useState(null);
  const [fetchKey, setFetchKey] = useState(0);
  const [nextHref, setNextHref] = useState(null);
  const nextHrefRef = useRef(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const tabCacheRef = useRef({});
  const scrollContainerRef = useRef(null);
  const tabReqRef = useRef(0);
  const [isFollowing, setIsFollowing] = useState(null);
  const [followBusy, setFollowBusy] = useState(false);
  const [glowRgb, setGlowRgb] = useState(null);
  const [avatarBroken, setAvatarBroken] = useState(false);

  const mapTrack = tr => mapScTrack(tr);

  const TABS = [
    { id: 'popular', label: t('artist_popular') },
    { id: 'tracks',  label: t('artist_tracks')  },
  ];

  useEffect(() => {
    if (!artist) return;
    tabCacheRef.current = {};
    setTab('popular'); setFetched(null); setArtistTracks([]);
    setIsFollowing(null); setFollowBusy(false);
    setAvatarBroken(false); setGlowRgb(null);
  }, [artist?.id, artist?.username]);

  useEffect(() => {
    if (!visible || !scAuth || (!artist?.id && !artist?.username)) return;
    const cacheKey = artist.id ? String(artist.id) : artist.username?.toLowerCase();
    const cached = artistCacheRef?.current?.get(cacheKey);
    if (cached) { setFetched(cached); return; }
    let cancelled = false;
    (async () => {
      try {
        let userId = artist.id;
        if (!userId) {
          const s = await window.electronAPI.scFetch(
            `https://api-v2.soundcloud.com/search/users?q=${encodeURIComponent(softenScName(artist.username))}&limit=1`,
            scAuth.token, scAuth.clientId
          );
          if (cancelled) return;
          userId = s.data?.collection?.[0]?.id;
          if (!userId) return;
        }
        const res = await window.electronAPI.scFetch(
          `https://api-v2.soundcloud.com/users/${userId}`,
          scAuth.token, scAuth.clientId
        );
        if (cancelled) return;
        const u = res.data;
        if (!u) return;
        const data = {
          id: u.id,
          username: u.username,
          avatarUrl: u.avatar_url ? u.avatar_url.replace('-large', '-t500x500') : null,
          followersCount: u.followers_count,
          bannerUrl: u.visuals?.visuals?.[0]?.visual_url || null,
        };
        artistCacheRef?.current?.set(cacheKey, data);
        setFetched(data);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [visible, artist?.id, artist?.username]);

  const profileId = fetched?.id || artist?.id || null;

  useEffect(() => {
    if (!visible || !scAuth || !profileId || !onCheckFollow) return;
    let cancelled = false;
    (async () => {
      const f = await onCheckFollow(profileId);
      if (!cancelled) setIsFollowing(!!f);
    })();
    return () => { cancelled = true; };
  }, [visible, profileId, onCheckFollow, scAuth]);

  const handleSubscribeClick = async () => {
    if (!profileId || !onFollow || followBusy) return;
    setFollowBusy(true);
    const result = await onFollow(profileId, isFollowing);
    setFollowBusy(false);
    if (result !== null) setIsFollowing(result);
  };

  useEffect(() => {
    if (!visible || !scAuth || !profileId) return;

    const cached = tabCacheRef.current[tab];
    if (cached) {
      setTracksLoading(false);
      setTracksError(null);
      setArtistTracks(cached.tracks);
      nextHrefRef.current = cached.nextHref;
      setNextHref(cached.nextHref);
      return;
    }

    const reqId = ++tabReqRef.current;
    setArtistTracks([]);
    setTracksError(null);
    nextHrefRef.current = null;
    setNextHref(null);
    setTracksLoading(true);
    const urls = {
      popular: `https://api-v2.soundcloud.com/users/${profileId}/toptracks?limit=20`,
      tracks:  `https://api-v2.soundcloud.com/users/${profileId}/tracks?limit=20`,
    };
    const url = urls[tab];
    if (!url) { setTracksLoading(false); return; }
    window.electronAPI.scFetch(url, scAuth.token, scAuth.clientId).then(res => {
      if (tabReqRef.current !== reqId) return;
      const items = res.data?.collection || [];
      const mapped = items.map(mapTrack);
      const nh = res.data?.next_href || null;
      tabCacheRef.current[tab] = { tracks: mapped, nextHref: nh };
      setArtistTracks(mapped);
      nextHrefRef.current = nh;
      setNextHref(nh);
    }).catch(() => {
      if (tabReqRef.current === reqId) setTracksError(t('error_retry') || 'Ошибка загрузки');
    }).finally(() => { if (tabReqRef.current === reqId) setTracksLoading(false); });
  }, [tab, profileId, visible, fetchKey]);

  useEffect(() => {
    if (tracksLoading || loadingMore || !nextHrefRef.current) return;
    const el = scrollContainerRef.current;
    if (!el || el.scrollHeight > el.clientHeight) return;
    loadMore();
  }, [tracksLoading, loadingMore]);

  const loadMore = async () => {
    if (!nextHrefRef.current || loadingMoreRef.current || !scAuth) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const href = nextHrefRef.current;
    const currentTab = tab;
    try {
      const res = await window.electronAPI.scFetch(href, scAuth.token, scAuth.clientId);
      const newTracks = (res.data?.collection || []).map(mapTrack);
      const nh = res.data?.next_href || null;
      nextHrefRef.current = nh;
      setNextHref(nh);
      setArtistTracks(prev => {
        const updated = [...prev, ...newTracks];
        if (tabCacheRef.current[currentTab]) {
          tabCacheRef.current[currentTab] = { tracks: updated, nextHref: nh };
        }
        return updated;
      });
      /* очередью играет сам список артиста (см. onCoverClick ниже), поэтому
         догруженные треки надо в неё доставить — иначе next упрётся в
         конец снимка, сделанного в момент клика, и уйдёт в лайки */
      onTracksAppended?.(newTracks);
    } catch {}
    loadingMoreRef.current = false;
    setLoadingMore(false);
  };

  const profile = fetched ? { ...artist, ...fetched } : artist;
  const avatarUrl = profile?.avatarUrl || null;

  /* мягкое пятно за аватаром — цвет берём из самой картинки тем же
     extractAccentColor, что и акцент обложки (кэш по url + один кадр
     32×32, размер пятна на работу не влияет). Без filter:blur() — мягкость
     даёт сам градиент, а блюр на боксе в три аватара это ровно тот
     полноэкранный фильтр, от которого отказались в AmbientGlow */
  useEffect(() => {
    if (!avatarUrl) { setGlowRgb(null); return; }
    let dead = false;
    extractAccentColor(avatarUrl).then(c => {
      if (dead || !c) return;
      setGlowRgb(`${c.r}, ${c.g}, ${c.b}`);
    });
    return () => { dead = true; };
  }, [avatarUrl]);

  const AV = 168;                                   /* аватар */
  /* суммарная длительность загруженного — второе число в строке мета.
     пересчитывается на каждой подгрузке, поэтому мемо не нужен: список
     треков и так меняет рендер */
  const totalDur = artistTracks.reduce((s, x) => s + (x.duration || 0), 0);
  /* что сейчас в колонке — вкладка + состояние. ключ меняется при
     переключении вкладки и при появлении списка после скелета, и вся колонка
     один раз коротко проявляется. это единственная анимация смены: строки
     сами ничего не анимируют, иначе двадцать отдельных анимаций на
     переключении и давали лаг */
  const contentKey = `${tab}|${tracksLoading ? 'load' : tracksError ? 'err' : artistTracks.length ? 'list' : 'empty'}`;
  const rise = (delay) => ({
    initial: false,
    animate: visible ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 },
    transition: { duration: 0.42, ease: [0.22, 1, 0.36, 1], delay: visible ? delay : 0 },
  });
  const canPlay = !!(onPlayTrack && artistTracks.length && !tracksLoading);

  return (
    <div style={{
      ...stackRoot(visible, 0.18),
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* ── шапка ───────────────────────────────────────────────────────────
          Одна колонка по центру, без фоновой картинки. Раньше здесь был баннер
          на blur(56px) во всю ширину: он съедал ~230px высоты, превращал
          страницу в мутное пятно и стоил полноэкранного блюра на каждом
          пересчёте. Теперь верх держат аватар, одно слово имени и волосок —
          остальное контент, а не декор. */}
      <div style={{ position: 'relative', flexShrink: 0, padding: '0 24px' }}>
        {/* назад — тихая квадратная кнопка, как в редакторе плейлиста:
            круглая с blur была сделана под поверхность-герой и на странице
            только шумела */}
        <div onClick={onClose} title={t('back')} style={{
          position: 'absolute', top: 14, left: 18, zIndex: 4,
          width: 28, height: 28, borderRadius: 9,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'transparent', cursor: 'pointer', transition: 'background 0.15s',
        }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
        >
          <img src="../assets/back.png" alt="" draggable="false"
            style={{ width: 15, height: 15, objectFit: 'contain', opacity: 0.5,
              filter: 'brightness(0) invert(1)', transition: 'opacity 0.15s' }}
            onMouseEnter={e => e.currentTarget.style.opacity = '0.95'}
            onMouseLeave={e => e.currentTarget.style.opacity = '0.5'}/>
        </div>

        <motion.div data-motion-spatial="" {...rise(0.02)} style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          padding: '30px 24px 14px',
        }}>
          {/* «артист» — НАД аватаром: подпись относится к тому, что ниже, и
              работает как заголовок блока, а не как подпись к картинке */}
          <div style={{
            marginBottom: 12,
            fontSize: 'var(--fs-eyebrow)', letterSpacing: '0.19em', textTransform: 'uppercase',
            color: 'rgba(255,255,255,0.34)', fontWeight: 600,
          }}>{t('artist_label')}</div>

          {/* аватар в пятне своего цвета */}
          <div style={{ position: 'relative', display: 'grid', placeItems: 'center' }}>
            {glowRgb && !glowOff && (
              <div style={{
                position: 'absolute',
                width: AV * 3.6, height: AV * 3.6, borderRadius: '50%',
                background: `radial-gradient(circle closest-side at center,
                  rgba(${glowRgb},0.20) 0%, rgba(${glowRgb},0.11) 30%, rgba(${glowRgb},0.045) 55%,
                  rgba(${glowRgb},0.012) 76%, rgba(${glowRgb},0) 100%)`,
                pointerEvents: 'none',
              }}/>
            )}
            <div style={{
              position: 'relative', width: AV, height: AV, borderRadius: 30, overflow: 'hidden',
              background: '#111116',
              boxShadow: '0 0 0 1px rgba(255,255,255,0.075), 0 18px 44px rgba(0,0,0,0.55)',
            }}>
              {avatarUrl && !avatarBroken
                ? <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    onError={() => setAvatarBroken(true)}/>
                : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="56" height="56" fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="1.3" viewBox="0 0 24 24">
                      <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                    </svg>
                  </div>}

              {/* тень под ником: снизу вверх и только на нижнюю половину. Без
                  неё белое имя на светлой аватарке пропадает; полноэкранный
                  скрим затемнил бы всю картинку, а тут гаснет только подпись.
                  сам ник — поверх тени, с двойной тенью для контраста */}
              <div aria-hidden="true" style={{
                position: 'absolute', left: 0, right: 0, bottom: 0, height: '52%',
                background: 'linear-gradient(to top, rgba(0,0,0,0.70) 0%, rgba(0,0,0,0.34) 42%, rgba(0,0,0,0) 100%)',
                pointerEvents: 'none',
              }}/>
              <div style={{
                position: 'absolute', left: 12, right: 12, bottom: 12,
                textAlign: 'center',
                fontSize: 'clamp(15px, 2vw, 22px)', fontWeight: 700,
                letterSpacing: '-0.022em', lineHeight: 1.12,
                color: 'rgba(255,255,255,0.97)',
                textShadow: '0 1px 3px rgba(0,0,0,0.9), 0 2px 14px rgba(0,0,0,0.6)',
                overflowWrap: 'anywhere',
                display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
              }}>{tidyScArtist(profile?.username || artist?.username || '') || '—'}</div>
            </div>
          </div>

          {/* мета: подписчики и длительность загруженного — цифры
              tabular, иначе при подгрузке колонка дёргается по ширине */}
          {((profile?.followersCount > 0) || artistTracks.length > 0) && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginTop: 12,
              fontSize: 'var(--fs-sm)', color: 'rgba(255,255,255,0.42)',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {profile?.followersCount > 0 && (
                <span>{profile.followersCount.toLocaleString()} {t('followers')}</span>
              )}
              {profile?.followersCount > 0 && artistTracks.length > 0 && (
                <span style={{ color: 'rgba(255,255,255,0.2)' }}>·</span>
              )}
              {artistTracks.length > 0 && <span>{fmtHMS(totalDur)}</span>}
            </div>
          )}

          {/* два действия. заливка акцентом только у «слушать всё» — это
              главное действие страницы; подписка остаётся контуром, чтобы
              два залитых пилюля не спорили друг с другом */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button type="button" className="artist-play-all" disabled={!canPlay}
              onPointerDown={event => { if (canPlay && event.button === 0) event.currentTarget.dataset.pointerPressed = 'true'; }}
              onPointerUp={event => { delete event.currentTarget.dataset.pointerPressed; }}
              onPointerCancel={event => { delete event.currentTarget.dataset.pointerPressed; }}
              onPointerLeave={event => { delete event.currentTarget.dataset.pointerPressed; if (canPlay) event.currentTarget.style.background = 'rgba(var(--accent-rgb),0.92)'; }}
              onBlur={event => { delete event.currentTarget.dataset.pointerPressed; }}
              onKeyDown={event => { delete event.currentTarget.dataset.pointerPressed; }}
              onClick={() => canPlay && onPlayTrack(artistTracks[0], artistTracks)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                height: 32, padding: '0 18px 0 15px', borderRadius: 999, border: 'none',
                background: canPlay ? 'rgba(var(--accent-rgb),0.92)' : 'rgba(255,255,255,0.05)',
                color: canPlay ? '#0a0a0c' : 'rgba(255,255,255,0.28)',
                fontSize: 'var(--fs-sm)', fontWeight: 600, fontFamily: 'inherit',
                letterSpacing: '0.01em', cursor: canPlay ? 'pointer' : 'default',
                transition: 'background 0.18s, color 0.18s, transform 120ms var(--ease-out)',
              }}
              onPointerEnter={e => { if (canPlay && isFineHover(e)) e.currentTarget.style.background = 'var(--accent)'; }}
            >
              <svg width="9" height="10" viewBox="0 0 10 12" fill="currentColor" aria-hidden="true">
                <polygon points="0,0 10,6 0,12"/>
              </svg>
              {t('artist_play_all')}
            </button>

            {profileId && scAuth && isFollowing !== null && (
              <button
                disabled={followBusy}
                onClick={handleSubscribeClick}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7,
                  height: 32, padding: '0 18px', borderRadius: 999,
                  background: isFollowing ? 'rgba(255,255,255,0.045)' : 'transparent',
                  border: `1px solid ${isFollowing ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.22)'}`,
                  color: isFollowing ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.9)',
                  fontSize: 'var(--fs-sm)', fontWeight: 600, fontFamily: 'inherit',
                  letterSpacing: '0.01em',
                  cursor: followBusy ? 'default' : 'pointer',
                  opacity: followBusy ? 0.55 : 1,
                  transition: 'background 0.18s, color 0.18s, border-color 0.18s, opacity 0.18s',
                }}
                onMouseEnter={e => {
                  if (followBusy) return;
                  e.currentTarget.style.background = isFollowing ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.06)';
                  e.currentTarget.style.color = '#fff';
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.34)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = isFollowing ? 'rgba(255,255,255,0.045)' : 'transparent';
                  e.currentTarget.style.color = isFollowing ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.9)';
                  e.currentTarget.style.borderColor = isFollowing ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.22)';
                }}
              >
                {isFollowing && (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
                {isFollowing ? t('subscribed') : t('subscribe')}
              </button>
            )}
          </div>
        </motion.div>
      </div>

      {/* ── вкладки ─────────────────────────────────────────────────────────
          Не пилюли с заливкой, а подпись + волосок акцента, который едет за
          активной. Пилюля была отдельной формой на фоне и читалась как
          segmented control из другого приложения; здесь у вкладок нет
          рамок, только вес цветом и линия.

          Волосок и вкладки — в той же колонке 760, что и строки треков.
          раньше вкладки стояли по центру шапки, а список центрирован
          отдельно: на широком окне подписи уезжали влево от своих треков */}
      <div style={{ flexShrink: 0, padding: '0 34px' }}>
        <div style={{ width: '100%', maxWidth: 760, margin: '0 auto' }}>
        <div style={{ height: 1, background: 'rgba(255,255,255,0.055)' }}/>
        <LayoutGroup id="artistTabs">
          <div style={{ display: 'flex', gap: 26, alignItems: 'flex-end', height: 42 }}>
            {TABS.map(tb => (
              <button key={tb.id}
                onClick={() => setTab(tb.id)}
                style={{
                  position: 'relative',
                  background: 'none', border: 'none', padding: 0,
                  height: 42, lineHeight: '42px',
                  fontSize: 'var(--fs-sm)', fontWeight: 600, fontFamily: 'inherit',
                  letterSpacing: '0.015em',
                  color: tab === tb.id ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.34)',
                  cursor: 'pointer',
                  transition: 'color 0.18s ease',
                }}
                onMouseEnter={e => { if (tab !== tb.id) e.currentTarget.style.color = 'rgba(255,255,255,0.58)'; }}
                onMouseLeave={e => { if (tab !== tb.id) e.currentTarget.style.color = 'rgba(255,255,255,0.34)'; }}
              >
                {tb.label}
                <SelectionFill active={tab === tb.id} style={{
                  position: 'absolute', left: 0, right: 0, bottom: 0, height: 1.5,
                  background: 'var(--accent)', borderRadius: 2,
                }}/>
              </button>
            ))}
          </div>
        </LayoutGroup>
        </div>
      </div>

      {/* ── контент ─────────────────────────────────────────────────────────
          Колонка ограничена шириной и центрирована: на широком окне строки
          во всю ширину растягиваются, и промах по play/like становится
          неточным. Маска сверху — список растворяется под волоском, а не
          упирается в него. */}
      <div ref={scrollContainerRef} className="scroll-thin" style={{
        flex: 1, overflowY: 'auto', padding: '6px 34px 40px',
        maskImage: 'linear-gradient(to bottom, transparent 0, #000 18px)',
        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, #000 18px)',
      }}
        onScroll={e => {
          const el = e.currentTarget;
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 180) loadMore();
        }}>
        <div key={contentKey} style={{
          width: '100%', maxWidth: 760, margin: '0 auto',
          animation: 'setIn 0.16s ease',
        }}>
        {!scAuth ? (
          /* без входа soundcloud треки не отдадут: раньше это выглядело как
             «ничего не найдено» — то есть как пустой артист, а не как
             «нечем смотреть» */
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 18, minHeight: 220, textAlign: 'center', padding: '0 20px',
          }}>
            <SoundCloudIcon size={26} fill="rgba(255,255,255,0.2)"/>
            <div style={{ fontSize: 'var(--fs-md)', color: 'rgba(255,255,255,0.34)', lineHeight: 1.6, maxWidth: 320 }}>
              {t('sc_hint').split('\n').map((l, i) => <span key={i}>{l}{i === 0 && <br/>}</span>)}
            </div>
            {onLogin && (
              <button onClick={onLogin} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: 'rgba(255,85,0,0.1)', border: 'none', borderRadius: 10,
                padding: '9px 18px', fontSize: 'var(--fs-md)', fontWeight: 500,
                color: 'rgba(255,130,60,0.85)', cursor: 'pointer', fontFamily: 'inherit',
                transition: 'background 0.15s',
              }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,85,0,0.17)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,85,0,0.1)'; }}
              >
                <SoundCloudIcon size={14} fill="rgba(255,130,60,0.9)"/>
                {t('login_sc')}
              </button>
            )}
          </div>
        ) : tracksLoading ? (
          <div>{[0,1,2,3,4,5].map(i => <TrackRowSkeleton key={i} i={i}/>)}</div>
        ) : tracksError ? (
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:12, padding:'48px 0' }}>
            <div style={{ fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.3)' }}>{tracksError}</div>
            <button onClick={() => { delete tabCacheRef.current[tab]; setFetchKey(k => k + 1); }}
              style={{ background:'rgba(255,255,255,0.06)', border:'none', borderRadius:8, padding:'6px 16px',
                fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.55)', cursor:'pointer', fontFamily:'inherit',
                transition:'background 0.15s' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}>
              {t('retry') || 'Повторить'}
            </button>
          </div>
        ) : artistTracks.length === 0 ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
            padding: '56px 0', textAlign: 'center',
          }}>
            <img src="../assets/note.png" alt="" style={{ width: 20, height: 20, opacity: 0.16, filter: 'brightness(0) invert(1)' }}/>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'rgba(255,255,255,0.24)' }}>{t('not_found')}</div>
          </div>
        ) : (
          artistTracks.map(tr => (
            /* очередь = весь список артиста, а не один трек. Раньше
               onPlayTrack/onSelectTrack звались без второго аргумента,
               searchQueueRef оставался null, и next/prev после трека
               артиста уезжали в лайки — то есть в другой список */
            <SearchTrackRow key={tr.id} track={tr}
              isLiked={likedIds?.has(tr.id) || false}
              onLike={onLike ? () => onLike(tr) : null}
              onClick={() => onSelectTrack?.(tr, artistTracks)}
              onCoverClick={() => onPlayTrack?.(tr, artistTracks)}
              isLoading={loadingTrackId === tr.id}
              isError={errorTrackId === tr.id}
              hideDividers={hideDividers}/>
          ))
        )}
        {loadingMore && (
          <div style={{ display:'flex', justifyContent:'center', padding:'16px 0' }}>
            <div style={{ width:20, height:20, border:'2px solid rgba(255,255,255,0.07)', borderTopColor:'rgba(255,255,255,0.22)', borderRadius:'50%', animation:'spin 1s linear infinite' }}/>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

/* ── App ─────────────────────────────────────────────────────────────────── */
/* заглушка «трека нет». раньше она была литералом прямо в выражении
   `const track = …`, то есть новый объект на каждом рендере; здесь она одна
   на всё приложение. Поля те же, что нужны потребителям: пустой путь — по
   нему эффект смены трека сбрасывает src вместо попытки грузить файл */
const BLANK_TRACK = { id: 0, title: '', artist: '', duration: 0, color: '#333' };

/* Разделители между пунктами и треками: тумблер «Отключить разделители»
   удалён по просьбе, поведение осталось включённым (разделителей нет).

   Именно константа, а не чтение настройки: ключ `hideDividers` остался бы в
   `%APPDATA%\sewer-tauri\settings.json` у всех, кто успел его получить, и
   `...saved` в загрузке настроек вернул бы `false` — разделители появились бы
   сами. Единственное место, где это можно перевернуть обратно. */
const HIDE_DIVIDERS = true;

function App() {
  const reduced = useReducedMotion();
  const [view, commitView] = useState('home');
  const navigationRef = useRef(null);
  if (!navigationRef.current) navigationRef.current = createNavigationOwner(commitView);
  const setView = useCallback(destination => navigationRef.current.commit(destination), []);
  useEffect(() => () => navigationRef.current.cancel(), []);
  const [tracks,        setTracks]        = useState([]);
  const [trackIdx,      setTrackIdx]      = useState(-1);   /* -1 = трек не выбран */
  const [isPlaying,     setIsPlaying]     = useState(false);
  const progressRef = useRef(0);
  const [shuffle,       setShuffle]       = useState(false);
  const [repeat,        setRepeat]        = useState('off');
  const [navActive,     setNavActive]     = useState('home');
  const [search,        setSearch]        = useState('');
  const [volume,        setVolume]        = useState(0.7);
  const [hero,               setHero]               = useState(null);
  const [playerVisible,      setPlayerVisible]      = useState(false);
  const [homeVisible,        setHomeVisible]        = useState(true);
  const [heroExiting,        setHeroExiting]        = useState(false);
  const [reverseHero,        setReverseHero]        = useState(null);
  const [reverseHeroExiting, setReverseHeroExiting] = useState(false);
  const [artistView,         setArtistView]         = useState(null);
  const [libCollapsed,  setLibCollapsed]  = useState(false);
  const [partyOpen, setPartyOpen] = useState(false);
  const [partyInstant, setPartyInstant] = useState(false);
  const [partyState, partyDispatch] = useReducer(partyReducer, initialPartyState);
  const partyClientRef = useRef(null);
  const partyCallbacksRef = useRef(null);
  const partyActive = !!partyState.room;
  const partyLocked = partyState.busy || partyActive && (partyState.room.role === 'guest' || partyState.connection !== 'connected');
  const partyTriggerRef = useRef(null);
  const closeParty = useCallback(event => {
    setPartyInstant(event?.detail === 0 || event?.key === 'Escape');
    setPartyOpen(false);
  }, []);
  /* текст песни: перекрывает библиотеку в колонке слева */
  const [lyricsOpen,   setLyricsOpen]   = useState(false);
  /* эффекты (эквалайзер, скорость, тон) — тоже в колонке слева. одновременно
     с текстом открытыми быть не могут: обе панели `inset:0` в одном
     контейнере, и вторая просто накрыла бы первую */
  const [fxOpen,       setFxOpen]       = useState(false);
  const [lyrics,       setLyrics]       = useState(null);   /* { status, lines, synced, source, alts } */
  const [lyricsActive, setLyricsActive] = useState(-1);
  /* id источника, выбранного кликом по плашке в шапке панели. null — тот,
     что победил по приоритету. Живёт в App, а не в панели, потому что по
     выбранному тексту считаются и подсветка строки, и перемотка по строке. */
  const [lyricsAlt,    setLyricsAlt]    = useState(null);
  const [lyricsNonce,  setLyricsNonce]  = useState(0);      /* ретрай: тот же эффект заново */
  const lyricsReqRef = useRef(0);
  /* «найти заново» должен обходить кеш: иначе та же кнопка вернула бы ровно
     тот текст, который уже на экране, и выглядела бы сломанной */
  const lyricsBypassRef = useRef(false);
  const [settings,      setSettings]      = useState({
    autoplay:false, crossfade:0, crossfadeCurve:'power', crossfadeSmart:true, crossfadeIntro:0, defaultRepeat:false,
    startWithWindows:false, minimizeToTray:false, musicFolder:'', downloadsFolder:'',
    customTitles: {}, scTitles: {}, minDuration: 30, soundcloudAuth: null,
    /* найденный текст по запросу и ручные пары «артист / название» по треку
       (см. lyricsQueryKey / lyricsTrackKey). и то и другое переживает
       перезапуск — ровно ради этого и живёт в настройках */
    lyricsCache: {}, lyricsQueries: {},
    listeningHistory: [],
    /* прокси для soundcloud (см. карточку аккаунта): пусто — напрямую */
    scProxy: '',
    sourceMode: 'local', discordRpc: true,
    discordTimestamp: 'progress', discordPause: 'show', discordCover: true,
    /* Акцент по умолчанию берётся с обложки, а не задаётся цветом: тема,
     которая едет за треком, и есть то, ради чего открывают плеер. До
     первого трека (или у трека без обложки) остаётся дефолтный серый —
     это осознанно, подставлять «что-нибудь цветное» было бы враньём. */
    accentMode: 'cover', accentPreset: 'default',
    /* тема — новый источник правды для цвета и фона. accentPreset остался
       только миграцией старых файлов настроек: в themes.accent живёт тот же
       цвет плюс всё остальное, и держать два места, где он записан, —
       значит гарантированно получить из них разные */
    /* дефолтная тема — «Обложка»: фон едет за треком, зерно выключено
       (см. набор). Раньше здесь был THEME_DEFAULT, то есть серый акцент и
       стоковый фон, и первый же запуск выглядел мёртвым */
    theme: defaultTheme(),
    themeDefaults: THEME_DEFAULTS_VERSION,
    userThemes: [],      /* сохранённые вручную темы: [{id, name, v}] */
    ambientGlow: true,   /* пятно за обложкой в плеере; false = не рисуем вовсе */
    /* «Обложки в цвет»: сила тонирования 0…1 (0 — выключено), источник цвета
       и сам цвет для ручного режима. `cover` (дефолт) — ОДИН цвет на всё
       приложение, взятый с текущей обложки: переключил трек — перекрасилось
       всё. `color` — ручной из колор-пикера (дефолт чёрный: цветной дефолт
       навязывал бы палитру, а ч/б читается как «выключить цвет», а не
       «покрасить в синий»). */
    coverTint: 0.45, coverTintMode: 'cover', coverTintColor: '#000000',
    uiHidden: { ...UI_HIDDEN_NONE },   /* спрятанные куски интерфейса, см. выше */
    windowEffect: 'off',   /* 'off' | 'mica' — применяется эффектом ниже */
    lyricsSources: LYRICS_SOURCE_IDS.slice(),  /* включённые источники, сверху вниз */
    volume: 0.7,   /* gain 0..1 (не позиция ползунка) — переживает перезапуск */
    /* эквалайзер и транспорт (см. блок afx* выше). eqGains — дБ по полосам
       EQ_BANDS, порядок и длина заданы там; здесь только значения. speed —
       множитель, shiftPitch — высота едет вместе со скоростью (по умолчанию
       да, как у любой скорости на кассете), pitch — полутона поверх неё */
    eqOn: false, eqGains: EQ_FLAT.slice(),
    speed: 1, shiftPitch: true, pitch: 0,
    width: 1,
  });
  const [sort,         setSort]         = useState('added');
  const [editingTitle, setEditingTitle] = useState(false);
  const [editValue,    setEditValue]    = useState('');
  const [scTracks,      setScTracks]      = useState([]);
  const [scLoading,     setScLoading]     = useState(false);
  const [scUpdating,    setScUpdating]    = useState(false);
  const [scError,       setScError]       = useState(null);
  const [toast,         setToast]         = useState(null);
  const [toastExiting,  setToastExiting]  = useState(false);
  const [trackMenu,     setTrackMenu]     = useState(null);
  const [dlTrack,       setDlTrack]       = useState(null);   /* трек в диалоге скачивания */
  const [stationActive, setStationActive] = useState(null);
  /* плейлисты: список во вкладке + активный (паттерн станции) + редактор */
  const [playlistActive, setPlaylistActive] = useState(null);
  const [playlists, setPlaylists]               = useState(null);
  const [playlistsLoading, setPlaylistsLoading] = useState(false);
  const [playlistsError,   setPlaylistsError]   = useState(null);
  const [creatingPlaylist, setCreatingPlaylist] = useState(false);
  const [editingPlaylist,  setEditingPlaylist]  = useState(null); /* { playlist, from } */
  /* состав плейлистов для чекбоксов в контекст-меню: { [plId]: Set<trackId> }.
     ref-версия не даёт плодить одинаковые запросы на каждый ре-рендер */
  const [plMembers, setPlMembers] = useState({});
  const plMembersRef = useRef({});
  const [accentRGB,     setAccentRGB]     = useState(null);
  /* Акцент Windows ('#rrggbb') — только для тонировки обложек «в цвет
     системы» и превью набора «Материал». null = ещё не спросили/система не
     отдала; тогда работает нейтральный серый. */
  const [winAccent,     setWinAccent]     = useState(null);
  const [loadingTrackId, setLoadingTrackId] = useState(null);
  const [errorTrackId,   setErrorTrackId]   = useState(null);
  const errorTimerRef = useRef(null);
  const [scPlayingTrack, setScPlayingTrack] = useState(null);
  const [scPlayingIdx,   setScPlayingIdx]   = useState(-1);
  const [libScrollTrigger,  setLibScrollTrigger]  = useState(0);
  const [libScrollTargetId, setLibScrollTargetId] = useState(null);
  const [searchFocused,    setSearchFocused]    = useState(false);
  const editCancelRef  = useRef(false);

  const lang = (settings.language || 'RU').toLowerCase();
  const langRef = useRef(lang);
  langRef.current = lang;
  const t = key => STRINGS[lang]?.[key] ?? STRINGS.ru[key] ?? key;

  /* ⚠️ подписи таитлбара назначаются ПО ИНДЕКСУ кнопки, а не по её
     смыслу. кнопки разворачивания больше нет, и если бы массив остался
     прежним, `titles[1]` достался бы кнопке «Свернуть» — она подписалась бы
     «Развернуть». при дальнейшем изменении набора кнопок править надо и
     сам набор, и этот массив — они связаны позицией. */
  useEffect(() => {
    const btns = document.querySelectorAll('#titlebar .win-btn');
    const titles = [t('minimize'), t('close')];
    btns.forEach((b, i) => { if (titles[i]) b.title = titles[i]; });
  }, [lang]);

  const customTitlesRef = useRef({});
  customTitlesRef.current = settings.customTitles || {};

  const minDurationRef = useRef(30);
  minDurationRef.current = settings.minDuration ?? 30;

  const artRefs       = useRef({});
  const artRefCacheRef = useRef({});
  const getArtRef = useCallback((id) => {
    if (!artRefCacheRef.current[id]) {
      artRefCacheRef.current[id] = (el) => { artRefs.current[id] = el; };
    }
    return artRefCacheRef.current[id];
  }, []);
  const playerArtRef  = useRef(null);
  const audioRef      = useRef(null);
  const hlsRef        = useRef(null);
  const handleNextRef  = useRef(null);
  const handlePrevRef  = useRef(null);
  /* для медиа-панели ОС: seek/позиция нужны вне рендера, из обработчиков
     setActionHandler, которые регистрируются ОДИН раз на пустой deps */
  const handleSeekRef  = useRef(null);
  const trackRef       = useRef(null);
  /* для History API: обработчик popstate читает ТЕКУЩИЙ view, чтобы понять,
     куда вообще возвращаемся. нужен ref, а не замыкание — эффект подписан
     один раз и не должен переподписываться на каждый view.
     ⚠️ само присваивание handleNavRef.current — НИЖЕ по файлу, сразу после
     определения handleNav: здесь он ещё в TDZ и чтение упало бы */
  const viewRef        = useRef('home');
  const handleNavRef   = useRef(null);
  /* в какой view нас должен был привести popstate. сверяется по ФАКТУ
     достижения, а не гасится флагом: handleNav умеет не переключить view
     (гард редактора плейлиста), и флаг в этом случае залипал бы навсегда,
     тихо отключив запись в истории навсегда */
  const popTargetRef   = useRef(null);
  /* монтирование ≠ переход: первый прогон эффекта истории запись не пушит */
  const histInitRef    = useRef(false);
  const artEntranceRef    = useRef(null);
  const playerInfoRef  = useRef(null);
  const isPlayingRef   = useRef(false);
  const homeScrollRef     = useRef(null);
  const scTracksRef       = useRef([]);
  const scAuthRef         = useRef(null);
  const scCacheRef        = useRef([]);
  const scCacheMapRef     = useRef(new Map());
  const artistCacheRef    = useRef(new Map());
  const followedIdsRef    = useRef(new Set());
  const prevSearchRef     = useRef('');
  const prevViewRef       = useRef('search');
  const homeSearchRef     = useRef(null);
  const libSearchRef      = useRef(null);
  const searchViewRef     = useRef(null);
  const discordTimerRef    = useRef(null);
  const discordPushRef     = useRef(null);
  const discordProgressRef = useRef(0);
  /* статус rpc приходит из main ('off'|'connecting'|'connected'|'disconnected').
     раньше ошибки подключения глотались пустым catch и в ui было видно ровно
     то же, что при «всё работает» — отличить нельзя было */
  const [discordStatus, setDiscordStatus] = useState('off');
  /* null = настройки ещё не прочитаны (см. эффект включения rpc ниже) */
  const [rpcWanted, setRpcWanted] = useState(null);
  const trackSwitchingRef  = useRef(false);
  const filteredRef       = useRef([]);
  const filteredScRef     = useRef([]);
  const searchRef         = useRef('');
  const searchQueueRef    = useRef(null);
  /* токен текущей загрузки SC-трека: handleScTrackClick делает await'ы, и без
     guard'а два быстрых клика давали гонку — включался не тот трек */
  const scReqRef          = useRef(0);
  const stationQueueRef   = useRef(null);
  const playlistQueueRef  = useRef(null);
  const playlistsRef      = useRef(null);
  const membersBusyRef    = useRef({});   /* plId -> true, пока едет состав для чекбоксов */
  const albumKindLogged   = useRef(false); /* один лог playlist_kind за сессию */
  const playlistActiveRef = useRef(null); /* зеркало playlistActive для хендлеров вне рендера */
  /* Порядок перемешивания — перестановка + курсор внутри одного объекта (см.
     src/shuffle.js). Раньше здесь были три отдельных ref'а: массив порядка,
     курсор и флаг «не пересобирай» для эффекта [shuffle]. Перестановку двигали
     руками десять мест, и все они должны были сходиться; теперь у движка есть
     peek() (ничего не меняет) и commit() (двигает). */
  const shuffleStateRef = useRef(null);
  const scPlayingTrackRef = useRef(null);
  const volumeRef         = useRef(0.7);
  const settingsRef       = useRef({});
  /* Две разные деки меняются ролями после каждого перехода. */
  const xfadeRafRef     = useRef(null);   // rAF-цикл громкости двух дек
  const deckBRef        = useRef(null);   // второй <audio> — «standby»
  const deckBHlsRef     = useRef(null);   // hls-инстанс второй деки
  const outgoingRef     = useRef(null);   // { audio, hls } — уходящая дека
  const xfadeRef        = useRef(null);   // { from, to, envelope } — идущее перекрытие
  const xfadePrimeRef   = useRef(null);   // предзагруженный следующий трек
  const xfadeTickRef    = useRef(null);
  const localTracksRef  = useRef([]);
  /* очередь/режим нужны peek'у следующего трека, а он крутится из setInterval
     с пустым списком deps — читать state он не увидит, поэтому зеркалим */
  const shuffleOnRef      = useRef(false);
  const repeatRef       = useRef('off');
  /* Движок перемешивания один на приложение и создаётся один раз: он держит
     позицию, и пересоздание на каждом рендере обнуляло бы её. */
  if (!shuffleStateRef.current) {
    shuffleStateRef.current = new Shuffle({ repeat: () => repeatRef.current });
  }
  /* Узел обложки карточки в сетке — для hero (вперёд и назад). Кеш ref'ов берём
     ТОЛЬКО если узел живой: React вешает ref в null при размонтировании, но
     после перестановки списка (сортировка, оптимистичный лайк, догрузка
     обложек) в кеше может остаться уже отсоединённый узел, и
     getBoundingClientRect() у него отдаёт нули. Тогда hero стартует из (0,0) с
     scale(0) — клон не виден вообще, а `opacity: hero ? 0 : 1` на обложке
     плеера держит её пустой ещё 300мс. В сумме это и читается как «кликнул
     карточку — перехода нет, ничего не происходит». Фолбэк — поиск по
     data-sewer-art прямо в DOM (общий для selectTrack и обоих hero в
     handleNav: раньше фолбэк был только в selectTrack, и обратный hero
     молча пропускался) */
  const findArtEl = useCallback((id) => {
    const cached = artRefs.current[id];
    if (cached && cached.isConnected) return cached;
    return homeScrollRef.current?.querySelector(`[data-sewer-art="${CSS.escape(String(id))}"]`) || null;
  }, []);
  scTracksRef.current = scTracks;
  searchRef.current   = search;
  scAuthRef.current   = settings.soundcloudAuth;
  isPlayingRef.current = isPlaying;
  volumeRef.current    = volume;
  scPlayingTrackRef.current = scPlayingTrack;
  playlistActiveRef.current = playlistActive;
  shuffleOnRef.current = shuffle;
  repeatRef.current  = repeat;
  settingsRef.current  = settings;
  localTracksRef.current = tracks;
  /* `trackIdx === -1` — «трек не выбран». Раньше индекс начинался с нуля, и
     `tracks[trackIdx]` отдавал первый файл папки ещё до всякого клика: в
     плеере сразу стоял первый трек каталога, и он же считался текущим для
     подсветки строк библиотеки и присутствия discord. Теперь выбор делает
     пользователь, а до выбора плеер пустой.

     ⚠️ `|| tracks[0]` из старого выражения убран СОЗНАТЕЛЬНО: именно он
     молча подставлял первый трек, даже когда индекс пуст. */
  const track = scPlayingTrack || (trackIdx >= 0 ? tracks[trackIdx] : null) || BLANK_TRACK;
  /* есть ли что показывать в плеере. Имя и мысль совпадают с локальной
     проверкой в обработчике перетаскивания (строка ниже по файлу): она
     читает refs намеренно, чтобы не тащить себя в deps обработчика
     mouseup, — поэтому это отдельная переменная, а не эта */
  const hasTrack = !!scPlayingTrack || (trackIdx >= 0 && !!tracks[trackIdx]);

  useEffect(() => {
    if (!track?.coverUrl) { setAccentRGB(null); return; }
    let cancelled = false;
    extractAccentColor(track.coverUrl).then(c => {
      if (!cancelled) setAccentRGB(c);
    });
    return () => { cancelled = true; };
  }, [track?.id, track?.coverUrl]);

  // computed app-wide accent: cover-derived when mode='cover', preset when 'color',
  // дефолтный серый когда 'off' (и пока у cover-режима нет извлечённого цвета)
  const appAccent = useMemo(() => {
    if (settings.accentMode === 'cover' && accentRGB) {
      // boost too-dark colors so var(--accent) text stays readable
      let { r, g, b } = accentRGB;
      const lum = (r + g + b) / 3;
      if (lum < 110) {
        const k = 110 / Math.max(1, lum);
        r = Math.min(255, Math.round(r * k));
        g = Math.min(255, Math.round(g * k));
        b = Math.min(255, Math.round(b * k));
      }
      return { r, g, b };
    }
    if (settings.accentMode === 'color') {
      /* произвольный цвет из темы, а не один из пяти образцов. Раньше здесь
         стояло `ACCENT_PRESETS[settings.accentPreset]` — те самые пять */
      return hexToRgb(cleanTheme(settings.theme).accent) || ACCENT_PRESETS.default;
    }
    return ACCENT_PRESETS.default;
  }, [settings.accentMode, settings.theme, accentRGB]);

  /* Тема → css-переменные. Единственное место, где тема покидает react и
     попадает в документ: всё остальное читает `var(...)` и потому не знает,
     откуда взялось значение.

     Порядок важен. Переменные пишутся на :root инлайном, а `--bg` у
     материала окна переопределён на body — то есть НАСЛЕДУЕТСЯ вниз и
     перебивает наше. Поэтому при материале свои --bg/--bg-image снимаются
     совсем (removeProperty), а не пишутся «правильным» значением: иначе мы
     бы затирали полупрозрачность мики своим сплошным цветом.

     Второй момент: --accent и --accent-rgb лерпятся отдельным эффектом
     ниже, и --accent-line-b завязан на --accent2-rgb, а НЕ на --accent.
     Иначе при градиентном акценте левый край догонял бы правый по
     полсекунды — левая половина палочки была бы старым цветом, правая
     новым, и градиент выглядел бы как полоса смаза. */
  useEffect(() => {
    const t = cleanTheme(settings.theme);
    const st = document.documentElement.style;
    const mica = settings.windowEffect === 'mica';
    /* Материал окна рисует под собой СВОЙ фон, и наш поверх класть нельзя:
       два слоя, и верхний просто закрывает материал. Поэтому при mica фон
       выключается в «стандарт», а --bg-image снимается совсем — removeProperty,
       а не запись «правильным» значением. --bg тоже снимается: его на body
       переопределяет body.effect-mica, и наша запись на :root была бы просто
       лишней (а при выключенном материале — ещё и мешала бы переходу). */
    const bgMode = mica ? 'default' : t.bgMode;
    const solid  = t.bgMode === 'default' ? THEME_DEFAULT.bgColor : t.bgColor;
    if (bgMode === 'default') st.removeProperty('--bg');
    else st.setProperty('--bg', solid);
    if (bgMode === 'color' || bgMode === 'default') st.removeProperty('--bg-image');
    else st.setProperty('--bg-image', themeBgImage({ ...t, bgMode }));
    /* Поверхность всплывающих панелей. Оттенок — от фона темы, но только
       когда фон действительно цветной: в «Стандарте», под материалом окна и
       на «Обложке» (там фон рисует живой градиент, а bgColor — просто
       оставшееся от прошлой темы значение) берём стоковый тёмный. */
    st.setProperty('--pop-bg', popupSurface(
      (bgMode === 'default' || bgMode === 'cover') ? THEME_DEFAULT.bgColor : t.bgColor));
    st.setProperty('--glow-strength', String(t.glowStrength));
    st.setProperty('--radius', `${t.radius}px`);
    st.setProperty('--grain', String(t.grain));
    st.setProperty('--vignette', String(t.vignette));
    /* Второй цвет полоски прогресса (см. #accent-fill в styles.css) отдельного
       класса не требует: правый край градиента ссылается на --accent2-rgb с
       fallback на --accent-rgb. Пока «второй цвет» выключен, переменная снята
       и градиент схлопывается в один цвет. */
    const a2 = t.accentGrad && hexToRgb(t.accent2);
    if (a2) {
      st.setProperty('--accent2',     `rgb(${a2.r}, ${a2.g}, ${a2.b})`);
      st.setProperty('--accent2-rgb', `${a2.r}, ${a2.g}, ${a2.b}`);
    } else {
      st.removeProperty('--accent2');
      st.removeProperty('--accent2-rgb');
    }
  }, [settings.theme, settings.windowEffect]);

  /* режим «Выкл»: глушим все свечения — body-класс для css-правил,
     --glow-opacity для inline-глоу, LIVE_GLOW для canvas; подписчики
     акцента дёргаются чтобы слайдер громкости перерисовался */
  useEffect(() => {
    const off = settings.accentMode === 'off';
    document.body.classList.toggle('glow-off', off);
    document.documentElement.style.setProperty('--glow-opacity', off ? '0' : '1');
    LIVE_GLOW.on = !off;
    _accentSubs.forEach(fn => fn());
  }, [settings.accentMode]);

  /* Акцент Windows. Спрашиваем сразу при старте, а не только при включении
     режима: превью набора «Материал» в настройках красится этим же цветом, и
     серое превью обещало бы не то. На focus перезапрашиваем: человек мог
     поменять акцент в параметрах Windows, не закрывая плеер. Один вызов DWM —
     цена нулевая. */
  useEffect(() => {
    let alive = true;
    const load = () => {
      window.electronAPI.systemAccent?.().then(hex => {
        if (alive && typeof hex === 'string' && hex) setWinAccent(hex);
      }).catch(() => {});
    };
    load();
    window.addEventListener('focus', load);
    return () => {
      alive = false;
      window.removeEventListener('focus', load);
    };
  }, []);

  /* «Обложки в цвет»: две css-переменные, которые читает CoverTint.
     Сила — прямо из настроек; ноль тоже валиден (слой просто прозрачный),
     поэтому отдельного «рендерить или нет» не нужно — и обложки в десяти
     местах не пришлось бы обвязывать условием.
     Цвет — один на всё приложение, см. эффект ниже. */
  useEffect(() => {
    document.documentElement.style.setProperty('--cover-tint', String(settings.coverTint ?? 0));
  }, [settings.coverTint]);

  /* цвет: ОДИН на всё приложение. В режиме «от обложки» это оттенок ТЕКУЩЕГО
     трека — переключил трек, и перекрасился весь список (переход делает
     css-транзишн на самом слое, см. CoverTint).
     оттенок берём из accentRGB, а не из appAccent: appAccent зависит от
     «режима акцента» (бывает фиксированным цветом) и поднят по светлоте ради
     читаемости текста, а обложкам нужен именно цвет картинки.
     насыщенность поднимаем: у средней по обложке она 30–40%, и бленд color с
     таким источником не дал бы цвета вовсе. ч/б обложку не трогаем — у серой
     картинки оттенка нет, принудительная насыщенность дала бы случайный
     красный. */
  useEffect(() => {
    let c;
    if (settings.coverTintMode === 'color') {
      c = hexToRgb(settings.coverTintColor || '#000000') || { r: 0, g: 0, b: 0 };
    } else if (settings.coverTintMode === 'accent') {
      /* системный акцент: оттенок и насыщенность берутся как есть — под
         `mix-blend-mode: color` яркость всё равно остаётся у обложки, а
         подкручивать системный цвет значило бы врать про «цвет Windows».
         пока цвет не пришёл, нейтральный серый: чёрный дал бы на первом
         кадре рывок в десатурацию */
      c = hexToRgb(winAccent || '') || { r: 178, g: 178, b: 178 };
    } else if (accentRGB) {
      const hsv = rgbToHsv(accentRGB.r, accentRGB.g, accentRGB.b);
      c = hsvToRgb(hsv.h, hsv.s < 10 ? hsv.s : 82, 55);
    } else {
      /* трека нет — тонировать нечем: нейтральный серый даёт мягкую
         десатурацию вместо чужого цвета */
      c = { r: 178, g: 178, b: 178 };
    }
    document.documentElement.style.setProperty('--cover-tint-rgb', `${c.r}, ${c.g}, ${c.b}`);
  }, [settings.coverTintMode, settings.coverTintColor, accentRGB, winAccent]);

  // push accent to CSS var so var(--accent) works everywhere
  // animated lerp: акцент плавно перетекает от текущего цвета к целевому
  const accentAnimRef = useRef({ r: 178, g: 178, b: 178 });
  const accentRafRef  = useRef(0);
  useEffect(() => {
    const target = appAccent;
    const from   = { ...accentAnimRef.current };
    const root   = document.documentElement.style;
    const DUR = 400;
    const t0  = performance.now();
    const ease = x => x < 0.5 ? 4*x*x*x : 1 - Math.pow(-2*x + 2, 3) / 2;
    cancelAnimationFrame(accentRafRef.current);
    /* ⚠️ CSS-ПЕРЕМЕННЫЕ пишутся НЕ каждый кадр, а раз в ACCENT_STEP_MS.
       каждый setProperty на :root инвалидирует стиль ВСЕХ 25 потребителей
       --accent-rgb, и крупнее всех — AmbientGlow (2× обложки). плюс
       _accentSubs дёргает перерисовку canvas-слайдера громкости с shadowBlur.
       400мс × 60 = 24 полных инвалидации, при шаге 40мс — их ~10.
       НО это НЕ причина затормозов: пользовательский тест с фиксированным
       цветом (вместо «от обложки») лерп вообще не запускает — и полёт
       всё равно дёргался. троттлинг остался просто как дешёвый выигрыш. */
    const ACCENT_STEP_MS = 40;
    let lastWrite = -1e9, lastKey = -1;
    const step = now => {
      const p = Math.min(1, (now - t0) / DUR);
      const e = ease(p);
      const c = {
        r: Math.round(from.r + (target.r - from.r) * e),
        g: Math.round(from.g + (target.g - from.g) * e),
        b: Math.round(from.b + (target.b - from.b) * e),
      };
      accentAnimRef.current = c;
      /* `p >= 1` — обязательное исключение: иначе последний
         кадр, где цвет доехал до цели, попадёт в окно троттлинга и
         целевой цвет просто не запишется. пропуск по key — второй
         предохранитель */
      if (now - lastWrite >= ACCENT_STEP_MS || p >= 1) {
        const key = (c.r << 16) | (c.g << 8) | c.b;
        if (key !== lastKey) {
          lastKey = key; lastWrite = now;
          LIVE_ACCENT.r = c.r; LIVE_ACCENT.g = c.g; LIVE_ACCENT.b = c.b;
          root.setProperty('--accent',     `rgb(${c.r}, ${c.g}, ${c.b})`);
          root.setProperty('--accent-rgb', `${c.r}, ${c.g}, ${c.b}`);
          _accentSubs.forEach(fn => fn());
        }
      }
      if (p < 1) accentRafRef.current = requestAnimationFrame(step);
    };
    accentRafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(accentRafRef.current);
  }, [appAccent]);

  /* Полоска прогресса у верхнего края окна (вне плеера). Заполнение двигается
     на timeupdate, поэтому элемент держим в ref, а не в state: ререндер App на
     каждый тик не нужен. Ищем лениво — разметка живёт в index.html, вне React. */
  const miniFillRef = useRef(null);
  const setMiniProgress = useCallback((p) => {
    const el = miniFillRef.current || (miniFillRef.current = document.getElementById('accent-fill'));
    if (!el) return;
    const k = p < 0 ? 0 : p > 1 ? 1 : p;
    el.style.transform = `scaleX(${k.toFixed(4)})`;
  }, []);

  /* Видимость полоски: ВНЕ плеера и только пока трек играет. Раньше на этом
     месте была статичная палочка акцента, горевшая ровно в плеере — то есть
     там, где прогресс и так есть на слайдере. Теперь наоборот: ушёл в
     библиотеку/поиск — сверху едет тонкая акцентная полоска, и по ней видно,
     что трек идёт, не возвращаясь в плеер.
     Считаем по паре view + playerVisible, а не по одному view: при уходе в
     настройки setView отложен на 300мс, и полоска успела бы выехать поверх ещё
     видимого плеера. */
  useEffect(() => {
    const inPlayer = view === 'player' && playerVisible;
    /* трек проверяем по источнику, а не по `track`: он всегда объект (фолбэк
       BLANK_TRACK), и это условие было бы всегда истинным */
    const hasTrack = !!scPlayingTrack || trackIdx >= 0;
    const show = !inPlayer && !!isPlaying && hasTrack;
    document.body.classList.toggle('mini-progress', show);
    /* при показе подтягиваем текущую позицию: пока полоска была скрыта,
       timeupdate её не двигал, а после смены трека progressRef уже обнулён */
    if (show) setMiniProgress(progressRef.current);
  }, [view, playerVisible, isPlaying, trackIdx, scPlayingTrack, setMiniProgress]);

  /* ❌ УДАЛЁН эффект подсветки тайтлбара в плеере.
     Здесь стояло `tb.style.background = linear-gradient(90deg, var(--bg),
     rgba(accent) 9% в центре, var(--bg))` — горизонтальное свечение акцентом
     через всю ширину полосы.
     Почему это и было то самое «свечение, из-за которого создаётся граница
     тайтлбара»: заливка ставилась ИНЛАЙНО, то есть перебивала и `background`
     из css, и `background: transparent` — тайтлбар снова становился
     единственной непрозрачной полосой в окне.
     Осталось только это затирание инлайнового стиля (на случай, если он
     остался в разметке от прошлой сборки): ❌ свой фон тайтлбару больше не
     ставим, он обязан быть прозрачным. */
  useEffect(() => {
    const tb = document.getElementById('titlebar');
    if (tb) tb.style.background = '';
  }, [view, playerVisible]);

  /* загружаем настройки и треки при старте */
  useEffect(() => {
    (async () => {
      try {
        const saved = await window.electronAPI.loadSettings();
        /* решение на подключение принимаем только после чтения файла настроек.
           ВНУТРИ async: `saved` объявлен тут же, и снаружи это ReferenceError.
           сразу после чтения, а не в конце: до сканa папки и остальной разбор —
           упало бы что-то одно, а rpc не включился бы вовсе */
        setRpcWanted(!!(saved?.discordRpc !== false));
        if (saved && Object.keys(saved).length) {
          setSettings(s => {
            const m = { ...s, ...saved };
            /* миграция старого accentMode ('default'|'lavender'|...|'cover')
               на новую пару accentMode ('off'|'color'|'cover') + accentPreset */
            if (!['off','color','cover'].includes(m.accentMode)) {
              if (m.accentMode !== 'cover' && ACCENT_PRESETS[m.accentMode]) m.accentPreset = m.accentMode;
              m.accentMode = (saved.accentMode === 'cover') ? 'cover' : 'color';
            }
            if (!ACCENT_PRESETS[m.accentPreset]) m.accentPreset = 'default';
            /* Перенос пресета в тему. accentPreset живёт только для этого:
               после переноса цвет лежит в theme.accent, и правка пикера уже
               не должна зависеть от того, какой образец был выбран.

               Уже существующую тему НЕ трогаем: первый же запуск после
               обновления затирал бы всё, что набрано руками. Второй цвет
               тоже — при переносе он обязан совпасть с первым, иначе
               включение «второго цвета» дало бы оттенок, которого никто
               не выбирал. */
            if (!m.theme || typeof m.theme !== 'object') {
              const p = ACCENT_PRESETS[m.accentPreset] || ACCENT_PRESETS.default;
              const hex = rgbToHex(p.r, p.g, p.b);
              m.theme = { ...THEME_DEFAULT, accent: hex, accent2: hex };
            }
            m.theme = cleanTheme(m.theme);
            /* свои темы: тот же фильтр, что у всего остального — мусор из
               старого файла не должен ни упасть в рендер, ни затереть id */
            m.userThemes = cleanUserThemes(m.userThemes);
            /* Одноразовая миграция дефолтов темы. Маркер берём из `saved`, а НЕ из
               слитого `m`: сливание идёт как `{...s, ...saved}`, и в нём
               marker уже стоял бы из начального состояния — то есть всегда
               текущей версии, и миграция не сработала бы НИКОГДА, молча
               выглядя как «дефолт применился». Тронуты только активная тема
               и режим акцента — папка музыки, логин, переименования и
               список своих тем остаются как были. */
            if (saved.themeDefaults !== THEME_DEFAULTS_VERSION) {
              m.theme = defaultTheme();
              m.accentMode = 'cover';
              m.themeDefaults = THEME_DEFAULTS_VERSION;
            }
            /* список источников текста: выкидываем мусор и дубли, отсутствие
               поля (старый файл настроек) → все источники по умолчанию */
            m.lyricsSources = cleanLyricsSources(m.lyricsSources);
            /* найденный текст и ручные пары из карандаша — тот же фильтр,
               что у scTitles: мусор из старого файла не должен попасть ни в
               панель, ни обратно на диск */
            m.lyricsCache   = cleanLyricsCache(m.lyricsCache);
            m.lyricsQueries = cleanLyricsQueries(m.lyricsQueries);
            /* те же ворота для rpc: без них мусорное значение из старого файла
               настроек уезжало в main как есть (см. cleanDiscordSettings) */
            cleanDiscordSettings(m);
            cleanCrossfadeSettings(m);
            /* булев гейт по образцу cleanDiscordSettings: мусор из старого
               файла настроек не должен превращать тумблер в «включено» */
            m.ambientGlow = m.ambientGlow !== false;
            m.scTitles = cleanScTitles(m.scTitles);
            m.listeningHistory = cleanListeningHistory(m.listeningHistory);
            return m;
          });
          /* SC_TITLES заполняем СРАЗУ и СИНХРОННО, до всего, что зовёт
             mapScTrack (лайки, папка, станция). mapScTrack — функция
             модуля и settings не видит, а подмена должна попасть в трек уже
             в момент его создания. берём из `saved`, а не из `settings`:
             в этом замыкании settings ещё старое состояние, слитое значение
             живёт только внутри апдейтера */
          SC_TITLES.clear();
          const st0 = cleanScTitles(saved.scTitles);
          for (const id in st0) SC_TITLES.set(scTitleKey(id), st0[id]);
          /* Гонка: лайки грузятся из кэша своим эффектом и могут прийти
             РАНЬШЕ, чем прочитается settings.json — оба ждут ipc. Тогда в
             момент вызова mapScTrack Map была пуста, и переименования
             не оказалось. Переподставляем по месту. Кэш на диске НЕ трогаем
             (там должен лежать оригинал, см. applyScTitles) */
          if (SC_TITLES.size) {
            setScTracks(prev => applyScTitles(prev));
            setScPlayingTrack(p => (p ? applyScTitles([p])[0] : p));
          }
          if (typeof saved.volume === 'number') {
            /* громкость живёт и отдельным state (её ест audio и кроссфейд), но
               хранится в settings — иначе каждый запуск сбрасывалась на 0.7 */
            const g = Math.max(0, Math.min(1, saved.volume));
            setVolume(g);
            volumeRef.current = g;  /* до первого кадра, иначе звук рванёт на дефолте */
          }
          if (saved.musicFolder) {
            const local = await window.electronAPI.scanMusicFolder(saved.musicFolder);
            if (local.length > 0) {
              const ct = saved.customTitles || {};
              const withCustom = local.map(t => ct[t.path] ? { ...t, title: ct[t.path] } : t);
              setTracks(withCustom);
              loadCovers(withCustom);
            }
          }
        }
      } catch {}
    })();
  }, []);

  /* Сохраняем настройки при изменении — с отложкой.
   *
   * ⚠️ Раньше здесь стоял прямой вызов на каждое изменение state, и это было
   * почти незаметно: настройки меняли раз в минуту. С редактором темы так
   * перестало быть — протяжка по квадрату цвета даёт изменение на КАЖДЫЙ
   * сдвиг мыши, то есть 60 раз в секунду, и каждый раз шла запись JSON на
   * диск через ipc. Отсюда было «всё приложение перекрашивается и лагает».
   *
   * Отложка в 350мс: правка цвета идёт непрерывно, а на диск должно уехать
   * одно состояние после того, как пользователь отпустит мышь. Таймер
   * перезаписывается, поэтому за 350мс тишины уедет ровно последняя запись,
   * а не каждая.
   *
   * ⚠️ Пишем в ref, а не в замыкание: значение `settings` на момент
   * постановки таймера устареет уже на первом же кадре, и на диск уехал
   * бы ПЕРВЫЙ цвет, а не последний.
   *
   * Про сам лаг. Запись на диск была лишь половиной: каждое движение мыши по
   * пикеру ещё и пересобирало весь интерфейс, потому что состояние настроек
   * лежит в App и меняет его целиком. Пикер поэтому обновляет цвет не на
   * каждое событие мыши, а раз в кадр (см. ColorPad). */
  const saveTimerRef = useRef(0);
  /* Последние настройки — отдельным ref'ом. Слушатель закрытия подписан
     один раз, поэтому из его замыкания он видел бы настройки ПЕРВОГО
     рендера, и на диск уехал бы дефолтный акцент вместо того, что
     человек выбрал секунду назад. Ref обновляется на каждом рендере, и
     сброс читает всегда актуальное значение. */
  const latestSettingsRef = useRef(settings);
  latestSettingsRef.current = settings;
  useEffect(() => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      try { window.electronAPI.saveSettings(latestSettingsRef.current); } catch {}
    }, 350);
    /* ⛔ cleanup здесь НЕ вызывает сохранение: тема перерисовывается по
       ходу effect'а смены фона (см. выше), и сохранение на каждом таком
       переходе означало бы ровно то же, что и до отложки. */
  }, [settings]);
  /* Сброс отложки при закрытии окна: без него последнее изменение
     съедалось бы, если закрыть плеер быстрее, чем прошло 350мс. Закрывают
     его сразу, это кнопка в тайтлбаре.
     ⚠️ В webview beforeunload срабатывает ненадёжно (окно закрывает rust,
     а не документ), поэтому это подстраховка, а не основной путь. */
  useEffect(() => {
    const flush = () => {
      clearTimeout(saveTimerRef.current);
      try { window.electronAPI.saveSettings(latestSettingsRef.current); } catch {}
    };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
    /* settings в зависимостях нет намеренно: ref обновляется на каждом
     рендере, а слушатель достаточно подписать один раз */
  }, []);

  useEffect(() => {
    try { window.electronAPI.setLoginItem?.(settings.startWithWindows); } catch {}
  }, [settings.startWithWindows]);

  /* Материал окна. Настройка тянет ДВА эффекта: класс на body — оболочка
     становится полупрозрачной (styles.css), вызов в rust — DWM рисует
     материал под окном. Порядок здесь и есть всё «плавно»: раньше класс
     ставился СРАЗУ, а IPC летел следом, и на те самые десятки миллисекунд
     окно было уже прозрачным, а материала под ним ещё не было — отсюда
     вспышка «на секунду прозрачное всё». Теперь при включении сначала
     дожидаемся материала и только потом двигаем фон; при выключении наоборот,
     фон первым: материал гаснет под уже непрозрачной панелью, а не сквозь
     прозрачную. */
  const micaFirstRef = useRef(true);
  /* Окно проявляется целиком после монтирования. Пока стоит класс `booting`
     (см. index.html и #app-shell.booting в styles.css) оболочка невидима:
     она и тайтлбар статичны, рисовались до react и давали секунду пустого
     окна с кнопками «свернуть» и «×». Снимаем на следующем кадре — к этому
     моменту содержимое уже в dom. */
  useEffect(() => {
    const el = document.getElementById('app-shell');
    if (!el) return;
    const id = requestAnimationFrame(() => el.classList.remove('booting'));
    return () => cancelAnimationFrame(id);
  }, []);
  useEffect(() => {
    const on = settings.windowEffect === 'mica';
    const setClass = v => document.body.classList.toggle('effect-mica', v);
    /* Первое срабатывание приходит с дефолтом 'off' — настройки ещё не
       прочитаны. Звать rust в этот момент нельзя: он снял бы материал,
       применённый в setup по файлу настроек, и окно мигнуло бы дважды.
       Пропускаем первый запуск — к этому моменту rust уже всё применил */
    if (micaFirstRef.current) {
      micaFirstRef.current = false;
      setClass(on);
      return;
    }
    /* Акцент с материалом несовместимы, и это правило обеспечивает тумблер.
       Здесь — страховка на случай старого файла настроек, где могли прийти
       оба значения сразу: иначе окно окажется с материалом и подсветкой, а
       сегменты в настройках будут заблокированы при «выкл», что выглядит как
       баг. Эффект не зациклится: в deps только windowEffect */
    if (on && settings.accentMode && settings.accentMode !== 'off') {
      setSettings(s => (s.accentMode === 'off' ? s : { ...s, accentMode: 'off' }));
    }
    if (!on) { setClass(false); window.electronAPI.setWindowEffect('off').catch(() => {}); return; }
    window.electronAPI.setWindowEffect('mica').then(ok => {
      if (!ok) {
        setSettings(s => ({ ...s, windowEffect: 'off' }));
        showToast(t('mica_unsupported'));
        return;
      }
      /* фон двигаем следующим кадром: к этому моменту DWM уже нарисовал
         материал, и переход идёт «по уже готовому», без кадра без фона */
      requestAnimationFrame(() => setClass(true));
    }).catch(() => {});
  }, [settings.windowEffect]);

  /* инициализация Audio */
  useEffect(() => {
    /* после hot-reload это ТОТ ЖЕ элемент, что играет прямо сейчас: новый дал
       бы тишину в интерфейсе, а старый остался бы в графе и продолжал играть
       мимо наших обработчиков, паузы и ползунков */
    const audio = audioRef.current || HOT_STORE.audio || new Audio();
    HOT_STORE.audio = audio;
    /* ⚠️ ДО первого `src` и всегда, даже если эквалайзер не включён.
       Как только элемент попадёт в AudioContext (createMediaElementSource),
       кросс-доменный поток без CORS-режима Chromium глушит целиком — трек
       просто замолкает. Поставить `crossOrigin` позже, чем присвоен `src`,
       уже бесполезно: запрос ушёл в no-cors, и лечится это только перезагрузкой
       трека. Проверено: CDN soundcloud отдаёт `access-control-allow-origin: *`,
       asset-протокол tauri — заголовок с origin окна, hls идёт через MSE
       (blob:), где CORS не участвует. */
    audio.crossOrigin = 'anonymous';
    audio.volume = volume;
    audioRef.current = audio;
    // React Refresh keeps refs. Settle an old transition without stopping the
    // current deck, then bind both elements to this version of the handlers.
    abortCrossfade();

    /* ⚠️ Обработчики общие для ОБЕИХ дек, а не только для первой. Проверка
       «эта дека вообще текущая» обязательна: уходящая дека во время
       перекрытия продолжает слать timeupdate, и без фильтра она перетирала
       progressRef у следующего трека — шкала и полоса в дискорде прыгали
       назад на каждом кадре кроссфейда. */
    const onTime  = handleDeckTime(audio);
    const onEnded = handleDeckEnded(audio);
    bindDeck(audio, onTime, onEnded, handleDeckPlayback(audio));
    const standby = deckBRef.current;
    if (standby && standby !== audio) bindDeck(standby, handleDeckTime(standby), handleDeckEnded(standby), handleDeckPlayback(standby));

    return () => {
      if (audio.__sewTime)  audio.removeEventListener('timeupdate', audio.__sewTime);
      if (audio.__sewEnded) audio.removeEventListener('ended',      audio.__sewEnded);
      audio.__sewTime = audio.__sewEnded = null;
      if (audio.__sewRpc) {
        for (const event of ['playing', 'pause', 'waiting', 'seeking', 'seeked', 'ratechange', 'loadedmetadata', 'durationchange', 'ended', 'emptied', 'timeupdate']) audio.removeEventListener(event, audio.__sewRpc);
        audio.__sewRpc = null;
      }
      /* подмена модуля: элемент и граф продолжают жить, обработчики заново
         навесит следующий mount. всё, что ниже, оборвало бы трек — а значит
         обрывало бы музыку на каждой правке файла */
      if (hotSwapping) return;
      abortCrossfade();
      audioRef.current?.pause();
      if (audioRef.current) audioRef.current.src = '';
      if (audio.__sewTransport) audio.removeEventListener('loadstart', audio.__sewTransport);
      audio.__sewTransport = null;
      destroyHls();
      cancelAnimationFrame(xfadeRafRef.current);
      /* вторая дека жила своей жизнью и про этот cleanup ничего не знала:
         на размонтировании оставался висящий hls и играющий <audio> */
      if (deckBRef.current) {
        deckBRef.current.pause();
        deckBRef.current.src = '';
      }
      if (deckBHlsRef.current) { try { deckBHlsRef.current.destroy(); } catch {} }
      if (outgoingRef.current?.hls) { try { outgoingRef.current.hls.destroy(); } catch {} }
      deckBRef.current = deckBHlsRef.current = outgoingRef.current = xfadeRef.current = null;
    };
  }, []);

  /* настройки → звуковой граф: эквалайзер, скорость, тон.

     Один эффект на всё, а не два: `afxAttach` умеет подключить деку и сразу
     применить уже сложившийся профиль, но порядок «включить полосы → потом
     подключить» пришлось бы держать вручную, и однажды он бы разъехался.
     Деки подключаются здесь на каждой правке просто потому, что `afxAttach`
     идемпотентен: уже подключённый элемент он возвращает из Map.

     Первые две деки создаются лениво (вторая — на первом кроссфейде), и
     `ensureDeckB` подключает себя сам: иначе она играла бы в обход фильтров. */
  useEffect(() => {
    const gains = Array.isArray(settings.eqGains) && settings.eqGains.length === EQ_BANDS.length
      ? settings.eqGains.map(v => Math.max(-EQ_GAIN_MAX, Math.min(EQ_GAIN_MAX, Number(v) || 0)))
      : EQ_FLAT;
    const speed = partyActive ? 1 : Math.min(SPEED_MAX, Math.max(SPEED_MIN, Number(settings.speed) || 1));
    const pitch = partyActive ? 0 : Math.max(-PITCH_MAX, Math.min(PITCH_MAX, Math.round(Number(settings.pitch) || 0)));
    const eqOn  = !!settings.eqOn;
    const width = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Number(settings.width) || 1));
    const keep  = settings.shiftPitch === false;   /* false = высота едет со скоростью */

    /* ширина — тоже повод поднять граф: раньше при выключенном эквалайзере
       и скорости 1× он не создавался, и кнопка была бы декорацией. при
       значениях по умолчанию поведение ровно прежнее. */
    if (!eqOn && speed === 1 && pitch === 0 && width === 1) {
      /* всё по умолчанию. Граф, если он уже поднят, не рвём: createMediaElementSource
         необратим, деки пришлось бы пересоздавать, а это потеря текущего
         воспроизведения ради нулевой экономии */
      afxApplyEq(false);
      afxTransport({ speed: 1, pitch: 0, preserve: keep });
      afxApplyWidth(1);
      return;
    }

    afx();
    afxAttach(audioRef.current);
    afxAttach(deckBRef.current);
    afxApplyEq(eqOn, gains);
    afxTransport({ speed, pitch, preserve: keep });
    afxApplyWidth(width);
    afxResume();     /* контекст мог родиться посреди уже играющего трека */
  }, [settings.eqOn, settings.eqGains, settings.speed, settings.pitch, settings.shiftPitch, settings.width, partyActive]);

  /* Автоплей-политика: контекст, созданный не в жесте, стартует suspended, а
     звук из media-элемента идёт ТОЛЬКО через граф — то есть играет трек и
     молчит. Один слушатель на документ дешевле, чем ловить каждый play. */
  useEffect(() => {
    const wake = () => afxResume();
    window.addEventListener('pointerdown', wake, true);
    window.addEventListener('keydown', wake, true);
    return () => {
      window.removeEventListener('pointerdown', wake, true);
      window.removeEventListener('keydown', wake, true);
    };
  }, []);

  /* смена трека — обновляем src */
  useEffect(() => {
    if (partyClientRef.current?.role === 'guest') return;
    const audio = audioRef.current;
    if (!audio || !track) return;
    if (scPlayingTrack) return; // SC-трек управляется через handleScTrackClick
    /* hot-reload: тот же src уже стоит, а повторный `load()` начал бы трек с
       нуля прямо посреди прослушивания */
    const want = track.path ? fileSrc(track.path) : '';
    if (HOT_STORE.trackSrc === want && audio.__sewTrackPath === track.path) return;
    abortCrossfade();
    ++scReqRef.current; // a pending SoundCloud URL must not replace this local track
    HOT_STORE.trackSrc = want;
    destroyHls(); // если был HLS — уничтожить при переключении на локальный трек
    if (track.path) {
      audio.src = fileSrc(track.path);
      audio.__sewTrackPath = track.path;
      audio.load();
      audio.addEventListener('loadedmetadata', () => {
        if (audio.__sewTrackPath !== track.path || audioRef.current !== audio) return;
        const dur = Math.floor(audio.duration);
        if (Number.isFinite(dur) && dur > 0) setTracks(prev => prev.map(t => t.path === track.path ? { ...t, duration: dur } : t));
      }, { once: true });
      if (isPlayingRef.current) {
        restorePlaybackVolume(audio);
        audio.play().then(() => {
          if (audioRef.current === audio && audio.__sewTrackPath === track.path) restorePlaybackVolume(audio);
        }).catch(() => {
          if (audioRef.current === audio && audio.__sewTrackPath === track.path) setIsPlaying(false);
        });
      }
    } else {
      audio.src = '';
    }
    progressRef.current = 0;
    /* без этого в присутствие уезжал прогресс ПРЕДЫДУЩЕГО трека: если новый
       не играет (пауза, ошибка загрузки), timeupdate не придёт и не поправит */
    discordProgressRef.current = 0;
  }, [trackIdx, track?.path, scPlayingTrack]);

  /* play / pause */
  useEffect(() => {
    if (partyClientRef.current?.role === 'guest') return; // The room follower owns guest playback.
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      restorePlaybackVolume(audio);
      audio.play().catch(() => setIsPlaying(false));
    } else {
      /* Пауза посреди перекрытия: уходящая дека встаёт на паузу и
         выбрасывается, следующая остаётся текущей. Раньше её просто не
         трогали — она продолжала играть в наушниках после того, как
         кнопка показала паузу. */
      if (xfadeRef.current || outgoingRef.current || xfadePrimeRef.current) abortCrossfade();
      if (!trackSwitchingRef.current) audio.volume = volumeRef.current;
      audio.pause();
    }
  }, [isPlaying]);

  /* громкость */
  useEffect(() => {
    /* Во время перекрытия обе деки живут по своей кривой, и их громкость
       пересчитывает rAF из volumeRef на каждом кадре. Присваивать полную
       громкость audioRef здесь нельзя — входящая дека отсахнёт в тишину
       ровно на один кадр и щёлкнет. */
    const xf = xfadeRef.current;
    if (xf) {
      const g = xfadeGains(xf);
      if (xf.from) xf.from.volume = g.out * volume;
      xf.to.volume = g.in * volume;
    } else if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume]);

  /* live-применение громкости при драге слайдера — без ререндера App.
     state коммитится один раз на mouseup */
  const handleVolumeLive = useCallback((v) => {
    volumeRef.current = v;
    const xf = xfadeRef.current;
    if (xf) {
      const g = xfadeGains(xf);
      if (xf.from) xf.from.volume = g.out * v;
      xf.to.volume = g.in * v;
    } else if (audioRef.current) {
      audioRef.current.volume = v;
    }
  }, []);

  /* коммит (mouseup): state + запись в settings, чтобы громкость помнилась
     между запусками. файл переписывается раз за отпускание ползунка */
  const handleVolumeCommit = useCallback((v) => {
    setVolume(v);
    setSettings(s => (s.volume === v ? s : { ...s, volume: v }));
  }, []);

  /* медиаклавиши */
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onMediaPlayPause) return;
    api.onMediaPlayPause(() => togglePlayback());
    api.onMediaNext(() => handleNextRef.current?.());
    api.onMediaPrev(() => handlePrevRef.current?.());
  }, []);

  /* Снятие hero-клона — по готовности новой обложки, а не по слепому
     таймеру. Таймер остаётся как страховка (ART_READY_WAIT_MS), потому что
     обложка может не загрузиться вообще (retry исчерпан, onFailed).

     ⚠️ И ждём ещё как минимум собственный фейд клона. Без этого условия
     клон снимался НА ПЕРВОМ ЖЕ кадре после `heroExiting`: обложка под ним к
     этому моменту обычно уже отрисована, `artReady` true, а фейд ещё не
     проиграл — обложка пропадала раньше, чем клон успевал погаснуть, и на
     кадр мелькала подмена. Теперь снятие ждёт конец фейда. */
  const ART_READY_WAIT_MS = 900;
  useEffect(() => {
    if (!hero || !heroExiting) return;
    let alive = true, raf = 0;
    const t0 = performance.now();
    const wait = () => {
      if (!alive) return;
      const elapsed = performance.now() - t0;
      const faded = elapsed >= HERO_FADE_MS + 20;
      if (!faded || (!artReadyRef.current && elapsed < ART_READY_WAIT_MS)) {
        raf = requestAnimationFrame(wait); return;
      }
      setHero(null); setHeroExiting(false);
    };
    raf = requestAnimationFrame(wait);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [hero, heroExiting]);

  /* gsap грузится лениво (см. шапку модуля) для анимаций входа в плеер.
     Прогреваем чанк в простое, чтобы разбор модуля не
     приходился на анимацию. Полёт обложки от gsap больше не зависит
     (он на Web Animations), это страховка для остальных твинов. */
  useEffect(() => {
    const ric = window.requestIdleCallback;
    if (!ric) { const t = setTimeout(() => { loadGsap(); }, 1200); return () => clearTimeout(t); }
    const id = ric(() => { loadGsap(); }, { timeout: 2500 });
    return () => window.cancelIdleCallback?.(id);
  }, []);

  /* анимация обложки при входе в плеер не из home */
  /* 🚨 готовность НОВОЙ обложки в AlbumArt. hero-клон снимается по таймеру
     на 510мс, а AlbumArt к этому моменту под клоном ещё рисует ПРЕДЫДУЩУЮ
     обложку (новый слой = загрузка + decode + draw в canvas). снятие клона
     показывало её на кадр — «вспышка старой обложки» после прилёта.
     Теперь клон ждёт готовности, но не дольше ART_READY_WAIT_MS, иначе
     при неудачной загрузке обложки клон зависнет навсегда. */
  const artReadyRef = useRef(true);
  useLayoutEffect(() => { artReadyRef.current = false; }, [track?.id, track?.coverUrl]);
  const handleArtReady = useCallback(() => { artReadyRef.current = true; }, []);

  useLayoutEffect(() => {
    if (!reverseHero) return;
    setReverseHeroExiting(false);
    let alive = true, closing = false, remove;
    const beginExit = () => {
      if (!alive || closing) return;
      closing = true;
      clearTimeout(exit);
      setReverseHeroExiting(true);
      remove = setTimeout(() => {
        if (!alive) return;
        setReverseHero(null); setReverseHeroExiting(false);
      }, HERO_FADE_MS + 20);
    };
    const exit = setTimeout(beginExit, reducedMotionNow() ? 0 : HERO_DUR_MS);
    const unsubscribe = subscribeReducedMotion(event => { if (event.matches) beginExit(); });
    return () => { alive = false; unsubscribe(); clearTimeout(exit); clearTimeout(remove); };
  }, [reverseHero]);

  // Normal handoff keeps 430ms travel / 140ms fade. Reduced motion skips only
  // travel: retain the new clone until decode/draw reports readiness (bounded).
  useLayoutEffect(() => {
    if (!hero) return;
    setHeroExiting(false);
    let alive = true, revealed = false, frame = 0, timer;
    const started = performance.now();
    const reveal = () => {
      if (!alive || revealed) return;
      revealed = true;
      setHeroExiting(true);
    };
    const wait = () => {
      frame = 0;
      if (!alive || revealed) return;
      if (!heroMayReveal(artReadyRef.current, performance.now() - started, ART_READY_WAIT_MS)) {
        frame = requestAnimationFrame(wait); return;
      }
      reveal();
    };
    const skipTravel = () => {
      if (!alive || revealed) return;
      clearTimeout(timer);
      if (!frame) frame = requestAnimationFrame(wait);
    };
    const unsubscribe = subscribeReducedMotion(event => { if (event.matches) skipTravel(); });
    if (reducedMotionNow()) skipTravel();
    else timer = setTimeout(reveal, HERO_DUR_MS);
    return () => { alive = false; unsubscribe(); clearTimeout(timer); cancelAnimationFrame(frame); };
  }, [hero]);

  const artEntranceTweenRef = useRef(null);
  const artEntranceViewRef = useRef(null);
  useEffect(() => {
    const entered = artEntranceViewRef.current !== view;
    artEntranceViewRef.current = view;
    if (reduced) {
      artEntranceTweenRef.current?.kill();
      if (artEntranceRef.current) {
        artEntranceRef.current.style.opacity = '1';
        artEntranceRef.current.style.transform = 'none';
      }
      return;
    }
    if (entered && view === 'player' && !hero && artEntranceRef.current) {
      artEntranceTweenRef.current?.kill();
      let alive = true;
      loadGsap().then(gsap => {
        if (!alive || !artEntranceRef.current) return;
        artEntranceTweenRef.current = gsap.fromTo(artEntranceRef.current,
          { opacity: 0, y: 14 },
          { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out' }
        );
      });
      return () => { alive = false; artEntranceTweenRef.current?.kill(); };
    }
  }, [view, reduced]);

  /* плавный ресайз — отключаем transitions пока тянут окно */
  useEffect(() => {
    let t;
    const onResize = () => {
      document.body.classList.add('resizing');
      clearTimeout(t);
      t = setTimeout(() => document.body.classList.remove('resizing'), 150);
    };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); clearTimeout(t); };
  }, []);

  /* ctrl+f → фокус на поиск */
  useEffect(() => {
    const handler = (e) => {
      if (e.ctrlKey && (e.key === 'f' || e.key === 'а')) {
        e.preventDefault();
        /* редактор плейлиста — оверлей поверх всего, и его поиск единственный
           видимый: без этой ветки ctrl+f уводил фокус под оверлей */
        if (view === 'playlistEditor' && editingPlaylist) { plEditorRef.current?.focusSearch?.(); }
        else if (view === 'search') { searchViewRef.current?.focus(); }
        else if (view === 'player') { libSearchRef.current?.focus(); libSearchRef.current?.select(); }
        else { homeSearchRef.current?.focus(); homeSearchRef.current?.select(); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [view, editingPlaylist]);

  /* Один снимок текущей деки; backend хранит последний и доставляет его
     независимо от обложки, сети и переподключения Discord. */
  const pushDiscord = useCallback((delay) => {
    clearTimeout(discordTimerRef.current);
    discordTimerRef.current = setTimeout(() => {
      const s = settingsRef.current;
      const currentTrack = trackRef.current;
      if (!s.discordRpc) return;
      const snapshot = discordSnapshot({
        track: currentTrack,
        originalTrack: scPlayingTrackRef.current ? scCacheMapRef.current.get(currentTrack?.id) : null,
        audio: audioRef.current, settings: s, playing: isPlayingRef.current,
        switching: trackSwitchingRef.current, progress: discordProgressRef.current,
      });
      if (!snapshot) { window.electronAPI?.discordClear?.(); return; }
      window.electronAPI?.discordUpdate?.(snapshot)?.catch?.(error => console.warn('[discord]', error));
    }, delay);
  }, [track, scPlayingTrack]);
  discordPushRef.current = pushDiscord;

  /* deps по полям трека, а не по track?.id: coverUrl у локальных приезжает
     асинхронно (loadCovers), duration уточняется в loadedmetadata. при
     deps по id эффект не перезапускался, и дискорд весь трек показывал
     не ту длительность и без обложки — он сам activity не перерисовывает.
     pushDiscord в списке обязателен: он пересобирается на каждый новый объект
     трека, и без него переименование (commitEdit) меняло title в state, но
     эффект держал старое замыкание — присутствие оставалось с прежним названием */
  useEffect(() => { pushDiscord(0); },
    [pushDiscord, track?.id, track?.coverUrl, track?.duration, isPlaying, scPlayingTrack,
      rpcWanted, settings.discordRpc, settings.discordTimestamp, settings.discordPause, settings.discordCover]);

  useEffect(() => {
    const timer = setInterval(() => discordPushRef.current?.(0), 5000);
    const wake = () => discordPushRef.current?.(0);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      clearInterval(timer);
      clearTimeout(discordTimerRef.current);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, []);

  /* ── Медиа-панель ОС (Windows «Сейчас играет» / громкость) ────────────────
     ⚠️ ЭТО НЕ ДУБЛИРУЕТ globalShortcut в main.js, а дополняет его.
     globalShortcut перехватывает клавиши громкости/плеера ВСЕЙ СИСТЕМЫ
     и рисует своё уведомление; панель ОС при этом остаётся пустой — там
     нет ни названия трека, ни обложки, ни полосы прогресса, и кнопки в ней
     не работают. `navigator.mediaSession` — штатный путь: ОС сама рисует
     карточку с обложкой/названием/временем и вызывает наши обработчики.
     mediaSession и globalShortcut умеют сосуществовать: аппаратные клавиши
     уходят обоим, но аппаратные события ОС (`navigator.mediaSession` с
     `setActionHandler`) обрабатываются ОС самой и globalShortcut их не
     дублирует — дублирование возможно только если ОС шлёт и то и другое,
     поэтому play/pause/next/prev здесь просто зовут те же ref-обёртки. */
  useEffect(() => {
    if (!navigator.mediaSession) return;
    const ms = navigator.mediaSession;
    /* ⚠️ setActionHandler бросает TypeError на действиях, которых текущая
       браузерная сборка не знает. каждый в try/catch, иначе один
       неподдерживаемый action (напр. seekto на старом Electron) роняет
       весь эффект и не ставит НИ ОДНОЙ кнопки */
    const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch {} };
    /* ⚠️ объявлено ДО регистрации обработчиков: колбэки сработали бы и
       после (они вызываются ОС позже), но полагаться на порядок инициализации
       здесь нельзя — при любой перестановке строк это молча падает в TDZ */
    const seekTarget = (dir, d) => {
      const a = audioRef.current;
      const dur = a?.duration || 0;
      if (!dur) return 0;
      const jump = Math.max(1, Number(d?.seekOffset) || 10);
      const base = a.currentTime || 0;
      return Math.max(0, Math.min(1, (base + (dir === 'backward' ? -jump : jump)) / dur));
    };
    set('play',          () => { if (partyCanControl()) setIsPlaying(true); });
    set('pause',         () => { if (partyCanControl()) setIsPlaying(false); });
    set('previoustrack', () => { handlePrevRef.current?.(); });
    set('nexttrack',     () => { handleNextRef.current?.(); });
    set('stop',          () => { if (partyCanControl()) setIsPlaying(false); });
    set('seekbackward',  d => handleSeekRef.current?.(seekTarget('backward', d)));
    set('seekforward',   d => handleSeekRef.current?.(seekTarget('forward',  d)));
    /* seekto принимает абсолютное время — прокручивать надо от currentTime */
    set('seekto', d => {
      const t = d?.seekTime;
      if (typeof t === 'number' && Number.isFinite(t)) {
        const a = audioRef.current;
        const dur = a?.duration || trackRef.current?.duration || 0;
        if (dur > 0) handleSeekRef.current?.(Math.max(0, Math.min(1, t / dur)));
      }
    });
  }, []);

  /* метаданные + позиция для панели ОС. duration нужен числом и >0, иначе
     панель показывает «--:--» и прячет полосу прогресса */
  useEffect(() => {
    if (!navigator.mediaSession) return;
    const ms = navigator.mediaSession;
    if (!track) { try { ms.metadata = null; } catch {} return; }

    const dur = Number(track.duration) > 0 ? Number(track.duration) : 0;
    const artwork = [];
    if (track.coverUrl) {
      /* ⚠️ Windows из panel'а не грузит локальные data-url и sc-кэш по
         http без расширения — такую картинку панель молча не рисует.
         отдаём то, что гарантированно распознаётся, и только если это
         реально URL. data-url оставляем: часть версий панели их берёт */
      const src = track.coverUrl;
      const usable = src.startsWith('http') || src.startsWith('data:image');
      if (usable) {
        artwork.push({ src, sizes: '512x512', type: src.startsWith('data:') ? src.slice(5, src.indexOf(';')) : 'image/jpeg' });
        artwork.push({ src, sizes: '256x256', type: src.startsWith('data:') ? src.slice(5, src.indexOf(';')) : 'image/jpeg' });
      }
    }
    try {
      ms.metadata = new MediaMetadata({
        title:   track.title   || '',
        artist:  track.artist  || '',
        album:   track.album   || '',
        artwork,
      });
      ms.playbackState = isPlaying ? 'playing' : 'paused';
    } catch {}

    /* setPositionState должен вызываться только с валидными значениями:
       исключение на duration<=0 или NaN ломает панель до перезагрузки */
    const a = audioRef.current;
    const aDur = Number(a?.duration);
    const useDur = Number.isFinite(aDur) && aDur > 0 ? aDur : dur;
    if (useDur > 0) {
      const ct = Math.max(0, Number(a?.currentTime) || 0);
      try {
        ms.setPositionState({
          duration: useDur,
          position: Math.min(ct, useDur),
          /* не 1: при скорости ≠ 1 панель ОС рисовала бы ползунок не там, где
             реально играет — позиция и duration считаются в медиа-времени,
             а отображаются в реальном */
          playbackRate: a?.playbackRate || 1,
        });
      } catch {}
    }
  }, [track?.id, track?.title, track?.artist, track?.album, track?.coverUrl, track?.duration, isPlaying]);

  /* ⚠️ позиция панели ОС обновляется раз в ~1с, а не каждый кадр:
     setPositionState дёргает IPC/браузерное событие наружу, и на 60fps
     это лишняя работа впустую — панель всё равно перерисовывается раз
     в секунду. тот же троттлинг по времени, что и у лерпа акцента */
  useEffect(() => {
    if (!navigator.mediaSession || !track) return;
    const id = setInterval(() => {
      const a = audioRef.current;
      const d = Number(a?.duration);
      if (!Number.isFinite(d) || d <= 0) return;
      try {
        navigator.mediaSession.setPositionState({
          duration: d,
          position: Math.min(Math.max(0, Number(a.currentTime) || 0), d),
          playbackRate: a.playbackRate || 1,
        });
      } catch {}
    }, 1000);
    return () => clearInterval(id);
  }, [track?.id, track?.duration]);

  /* тумблер = решение на подключение вообще. раньше initDiscord() дёргался
     из app.whenReady безусловно: rpc выключен — а сокет в дискорд уже открыт,
     и наоборот, включить его было нельзя, не перезапустив приложение.
     null = настройки ещё не прочитаны: дефолт discordRpc:true успевал увести
     main в connect, и пользователь с выключенным rpc получал лишний
     connect/disconnect на каждом запуске. реальное значение ставит
     загрузка настроек ниже (cleanDiscordSettings) */
  useEffect(() => {
    window.electronAPI?.discordSetEnabled?.(rpcWanted !== null && settings.discordRpc !== false);
  }, [rpcWanted, settings.discordRpc]);

  useEffect(() => {
    const off = window.electronAPI?.onDiscordStatus?.(setDiscordStatus);
    return () => { off?.(); };
  }, []);

  useEffect(() => () => window.electronAPI?.discordClear?.(), []);

  useEffect(() => {
    const eng = shuffleStateRef.current;
    if (!shuffle) { eng.clear(); return; }
    /* Порядок обычно уже собран тем, кто перемешивание включил
       (handleShuffleToggle / handleShuffleStart) — и пересобирать его здесь
       было бы ровно то, от чего раньше спасал флаг shuffleKeepRef. Пересборка
       теперь живёт в самом движке и зовётся оттуда, где очередь правда
       сменилась. Этот эффект остался только для кнопки в мини-плеере: она
       включает перемешивание голым setShuffle, без выбора списка. */
    if (eng.active) return;
    const cur = scPlayingTrackRef.current;
    if (cur) eng.start(activeQueueList(), cur.id);
  }, [shuffle]);

  /* список, из которого реально играет next/prev — тот же приоритет, что и
     везде: станция > плейлист > очередь поиска > лайки. нужен кнопке
     «случайно» в плеере, чтобы она перемешивала ИМЕННО то, что играет.
     режим берём из settingsRef, а не из замыкания: эффект [shuffle] не
     перезапускается на смене режима и держал бы старый */
  function activeQueueList() {
    const s = settingsRef.current;
    const sc = (s?.soundcloudAuth && s?.sourceMode === 'sc') ? 'sc' : 'local';
    if (sc === 'sc') return scQueueList();
    return searchRef.current ? filteredRef.current : tracks;
  }

  /* переключатель режима, а не «перемешать ещё раз». второй клик ВЫКЛЮЧАЕТ
     shuffle: порядок сбрасывает эффект [shuffle], и дальше next идёт в обычном
     порядке. включение — как handleShuffleStart: случайный трек + переход в
     плеер. список приходит с места нажатия, потому что он у всех трёх кнопок
     разный (лайки / активная очередь / треки плейлиста) */
  function handleShuffleToggle(list) {
    if (!partyCanControl()) return;
    if (shuffle) { setShuffle(false); return; }
    handleShuffleStart(list);
  }

  /* «случайно»: перемешать переданный список, включить первый случайный трек
     и уйти в плеер. список приходит снаружи — по нажатию не угадать, что
     имеется в виду: с главного экрана это лайки, в плеере — активная очередь,
     в чипе плейлиста — треки плейлиста */
  function handleShuffleStart(list) {
    if (!partyCanSelect(settingsRef.current.sourceMode !== 'sc')) return;
    const pool = (list || []).filter(Boolean);
    if (!pool.length) { showToast(t('shuffle_empty')); return; }
    setShuffle(true);
    const eng = shuffleStateRef.current;
    const s = settingsRef.current;
    const sc = (s?.soundcloudAuth && s?.sourceMode === 'sc') ? 'sc' : 'local';
    if (sc === 'sc') {
      /* Порядок строим ЗДЕСЬ, из того списка, на который нажали. Ниже
         handleScTrackClick идёт с autoSkip=true — пересборку «от клика» он
         пропускает, и порядок остаётся выбранным пользователем, а не
         активной очередью. Если эти списки разошлись, движок сам пересоберёт
         порядок на следующем peek — раньше next в этом случае просто
         останавливал плеер. */
      eng.start(pool, null);
      const first = eng.track(eng.order[0]) || pool[0];
      handleScTrackClick(first, -1, true, 0, -1);
    } else {
      const cur = tracks[trackIdx];
      let n; do { n = Math.floor(Math.random() * pool.length); } while (pool[n] === cur && pool.length > 1);
      const at = tracks.indexOf(pool[n]);
      if (at >= 0) { setTrackIdx(at); setIsPlaying(true); }
    }
    /* уводим в плеер без hero-анимации: клика по карточке не было, и
       искать artRef для случайного трека незачем */
    setHomeVisible(false);
    setPlayerVisible(true);
    setView('player');
    setNavActive('library');
  }

  function handleNext() {
    if (!partyCanControl()) return;
    if (partyClientRef.current?.active && !scPlayingTrackRef.current) return;
    /* Входящий трек уже текущий. Завершаем микс, не откатывая очередь. */
    if (xfadeRef.current || xfadePrimeRef.current) abortCrossfade();
    if (repeat === 'one') {
      const audio = audioRef.current;
      if (audio) { audio.currentTime = 0; audio.play().catch(() => {}); }
      progressRef.current = 0;
      /* ⚠️ Здесь pushDiscord обязателен, иначе полоса в присутствии
         замирает на последней секунде. Трек не меняется (тот же id, та же
         длительность), поэтому НИ ОДИН dep эффекта обновления не меняется и
         update сам не уйдёт. А дискорд рисует полосу сам, по
         timestamps.start, и пересчитывает её на своей стороне каждую секунду:
         без свежего SET_ACTIVITY start остаётся от первого проигрывания, и
         на репите полоса доезжает до конца и навсегда встаёт на 100%.

         discordProgressRef обнуляем явно: timeupdate после currentTime = 0
         придёт уже после вызова pushDiscord и не успеет поправить ушедшую
         позицию. */
      discordProgressRef.current = 0;
      pushDiscord(0);
      return;
    }
    if (scPlayingTrack) {
      const list = scQueueList();
      if (shuffle) {
        const eng = shuffleStateRef.current;
        eng.sync(list);
        if (searchQueueRef.current && eng.left() <= 3) searchViewRef.current?.loadMore();
        const step = eng.peek(1);
        if (!step) { setIsPlaying(false); return; }
        eng.commit(step);
        const nextTrack = eng.track(step.id);
        if (nextTrack) handleScTrackClick(nextTrack, scTracksRef.current.indexOf(nextTrack), true);
        else setIsPlaying(false);
        return;
      }
      const curIdx = list.findIndex(t => t.id === scPlayingTrack.id);
      const ni = curIdx + 1;
      if (searchQueueRef.current && ni >= list.length - 3) searchViewRef.current?.loadMore();
      if (ni < list.length) handleScTrackClick(list[ni], scTracksRef.current.indexOf(list[ni]), true);
      else if (repeat === 'all') handleScTrackClick(list[0], scTracksRef.current.indexOf(list[0]), true);
      else setIsPlaying(false);
      return;
    }
    /* Локальная ветка. В режиме sc сюда попадают только когда SC-трек ещё не
       играет — и тогда она молча двигала trackIdx по ЛОКАЛЬНОМУ списку, чего
       в режиме sc вообще не должно быть: пользователь жмёт «вперёд» и получает
       перемотку невидимого локального трека вместо следующего SC. Возвращаемся
       явно. */
    if (sourceMode === 'sc') { setIsPlaying(false); return; }
    const list = searchRef.current ? filteredRef.current : tracks;
    if (!list.length) { setIsPlaying(false); return; }
    if (shuffle) {
      const cur = tracks[trackIdx];
      let n; do { n = Math.floor(Math.random()*list.length); } while (list[n] === cur && list.length > 1);
      setTrackIdx(tracks.indexOf(list[n]));
      progressRef.current = 0; return;
    }
    /* curIdx может быть -1: текущий трек не попал в отфильтрованный список
       (поиск его отсеял). Раньше next = 0 и мы просто прыгали на первый
       элемент списка — визуально это выглядело как «следующий трек включился
       рандомно». Считаем позицию по общему списку и берём её +1. */
    const curIdx = list.indexOf(tracks[trackIdx]);
    if (curIdx < 0) {
      const firstInList = list[0];
      if (!firstInList) { setIsPlaying(false); return; }
      setTrackIdx(tracks.indexOf(firstInList));
      progressRef.current = 0; return;
    }
    const next = curIdx + 1;
    if (next >= list.length) {
      if (repeat === 'all') { setTrackIdx(tracks.indexOf(list[0])); }
      else { setIsPlaying(false); }
    } else {
      setTrackIdx(tracks.indexOf(list[next]));
    }
    progressRef.current = 0;
  }
  handleNextRef.current = handleNext;

  function handlePrev() {
    if (!partyCanControl()) return;
    if (partyClientRef.current?.active && !scPlayingTrackRef.current) return;
    /* «Назад» считается относительно уже выбранного входящего трека. */
    if (xfadeRef.current || xfadePrimeRef.current) abortCrossfade();
    if (progressRef.current > 0.05) {
      progressRef.current = 0;
      if (audioRef.current) audioRef.current.currentTime = 0;
      /* тот же трек, тот же id — эффект обновления присутствия не
         сработает, поэтому двигаем его руками, как в ветке repeat === 'one' */
      discordProgressRef.current = 0;
      pushDiscord(0);
      return;
    }
    if (scPlayingTrack) {
      const list = scQueueList();
      if (shuffle) {
        /* Назад по перемешанному порядку. Раньше здесь курсор двигали руками
           прямо в обработчике; peek/commit делают то же, но позиция остаётся
           в движке, а не в ref'е на стороне. */
        const eng = shuffleStateRef.current;
        eng.sync(list);
        const step = eng.peek(-1);
        if (!step) return;
        eng.commit(step);
        const prevTrack = eng.track(step.id);
        if (prevTrack) handleScTrackClick(prevTrack, scTracksRef.current.indexOf(prevTrack), true, 0, -1);
        return;
      }
      const curIdx = list.findIndex(t => t.id === scPlayingTrack.id);
      const pi = curIdx - 1;
      if (pi >= 0) handleScTrackClick(list[pi], scTracksRef.current.indexOf(list[pi]), true, 0, -1);
      return;
    }
    /* тот же случай, что в handleNext: в режиме sc локальный список трогать
       нельзя, и пустой список делить на ноль нельзя */
    if (sourceMode === 'sc' || !tracks.length) return;
    const list = searchRef.current ? filteredRef.current : tracks;
    if (!list.length) return;
    const curIdx = list.indexOf(tracks[trackIdx]);
    /* curIdx === -1 бывает двух видов: трек не выбран (trackIdx -1, список
       пустой) или он отсеян поиском. Формула «назад» в обоих случаях
       молча давала предпоследний элемент — из пустого плеера «назад» уезжало
       в произвольное место. Начинаем с первого */
    const to = curIdx < 0 ? 0 : (curIdx - 1 + list.length) % list.length;
    setTrackIdx(tracks.indexOf(list[to]));
    progressRef.current = 0;
  }
  handlePrevRef.current = handlePrev;

  const handleSeek = useCallback((v) => {
    if (!partyCanControl()) return;
    progressRef.current = v;
    discordProgressRef.current = v;
    /* Перемотка посреди перекрытия: обе деки надо остановить, иначе ушедшая
       продолжит играть на прежней позиции (звук идёт не с той точки, где
       стоит шкала). Позицию в очереди не откатываем — следующий трек к
       этому моменту уже текущий по-настоящему. */
    if (xfadeRef.current || outgoingRef.current || xfadePrimeRef.current) abortCrossfade();
    const audio = audioRef.current;
    const duration = mediaDuration(audio, trackRef.current);
    if (audio && duration) {
      audio.currentTime = v * duration;
      audio.volume = volumeRef.current; // восстанавливаем громкость после seek
    }
    /* pushDiscord сам гасит прошлый таймер. раньше здесь стоял отдельный
       clearTimeout того же ref — из-за него seek отменял дебаунс эффекта,
       и задержка обновления присутствия становилась случайной */
    pushDiscord(400);
    partyClientRef.current?.sync();
  }, [track, scPlayingTrack, pushDiscord]);
  /* ref-обёртка для медиа-панели ОС: обработчики setActionHandler
     регистрируются один раз и не видят свежих deps */
  handleSeekRef.current = handleSeek;
  trackRef.current = track;

  useEffect(() => { setEditingTitle(false); }, [trackIdx]);

  useEffect(() => {
    if (prevSearchRef.current && !search && scPlayingTrack) {
      setLibScrollTargetId(null);
      setLibScrollTrigger(v => v + 1);
    }
    prevSearchRef.current = search;
  }, [search]);

  /* Переименование sc-трека. ЛОКАЛЬНОЕ: на soundcloud ничего не уходит,
     переименование живёт в settings.scTitles и подмешивается в mapScTrack.
     Обновляем всё, где трек уже лежит объектом, иначе подмена видна только
     в следующей загрузке лайков, а не сразу: текущий (он же `track` в
     плеере и в discord rpc), сетка лайков, плейлист, станция, очередь поиска */
  const renameScTrack = (id, title) => {
    SC_TITLES.set(scTitleKey(id), title);
    setSettings(s => ({ ...s, scTitles: { ...s.scTitles, [id]: title } }));
    const withTitle = t => (t && t.id === id ? { ...t, title } : t);
    setScPlayingTrack(p => (p ? withTitle(p) : p));
    setScTracks(prev => prev.map(withTitle));
    setPlaylistActive(p => (p ? { ...p, tracks: p.tracks.map(withTitle) } : p));
    setStationActive(p => (p ? { ...p, tracks: p.tracks.map(withTitle) } : p));
    if (searchQueueRef.current) searchQueueRef.current = searchQueueRef.current.map(withTitle);
    if (playlistQueueRef.current) playlistQueueRef.current = playlistQueueRef.current.map(withTitle);
    if (stationQueueRef.current)  stationQueueRef.current  = stationQueueRef.current.map(withTitle);
    const c = scCacheMapRef.current.get(id);
    if (c) scCacheMapRef.current.set(id, { ...c, title });
  };

  const commitEdit = () => {
    const trimmed = editValue.trim();
    /* пустая строка — отмена правки, а не «трек без названия» */
    if (trimmed) {
      const sc = scPlayingTrackRef.current;
      /* `track = scPlayingTrack || tracks[trackIdx]`, поэтому если играет
         sc-трек, то и подпись в плеере, и коммит — это он. Отдельной
         проверки «локальный ли» не нужно: у локального scPlayingTrack пуст */
      if (sc) {
        if (sc.title !== trimmed) renameScTrack(sc.id, trimmed);
      } else {
        setTracks(prev => prev.map((t, i) => i === trackIdx ? { ...t, title: trimmed } : t));
        const path = tracks[trackIdx]?.path;
        if (path) setSettings(s => ({ ...s, customTitles: { ...s.customTitles, [path]: trimmed } }));
      }
    }
    setEditingTitle(false);
  };

  async function loadCovers(tracksArr) {
    const pending = tracksArr.filter(t => t.path);
    if (!pending.length) return;
    let next = 0;
    const acc = {};
    let newSinceFlush = 0;

    const flush = () => {
      if (!newSinceFlush) return;
      newSinceFlush = 0;
      const snap = { ...acc };
      setTracks(prev => prev.map(t => snap[t.id] ? { ...t, coverUrl: snap[t.id] } : t));
    };

    async function worker() {
      while (next < pending.length) {
        const t = pending[next++];
        try {
          const url = await window.electronAPI.getCoverArt(t.path);
          if (url) { acc[t.id] = url; newSinceFlush++; }
        } catch {}
        if (newSinceFlush >= 16) flush();
      }
    }

    await Promise.all(Array.from({ length: Math.min(16, pending.length) }, worker));
    flush();
  }

  const handleScanTracks = useCallback(async (folder) => {
    try {
      const local = await window.electronAPI.scanMusicFolder(folder, minDurationRef.current);
      if (local.length > 0) {
        const ct = customTitlesRef.current;
        const withCustom = local.map(t => ct[t.path] ? { ...t, title: ct[t.path] } : t);
        setTracks(withCustom);
        /* ⚠️ здесь стояло `setTrackIdx(0)`, и это был источник «первый трек
           сам включается на старте»: скан папки при запуске приложения
           выбирал файл №0, и плеер показывал его до первого клика. Сброса
           индекса больше нет — текущий трек (если он играет) переживает
           пересканирование, а на старте остаётся «не выбран» */
        setIsPlaying(false);
        progressRef.current = 0;
        loadCovers(withCustom);
      }
    } catch {}
  }, []);

  const handleClearCoversCache = useCallback(async () => {
    await window.electronAPI.scClearCoversCache();
    setScTracks(t => t.map(tr => ({ ...tr, coverUrl: null })));
  }, []);

  const handleClearLikesCache = useCallback(async () => {
    await window.electronAPI.scClearLikesCache();
    setScTracks([]);
    scCacheRef.current = [];
    scCacheMapRef.current = new Map();
  }, []);

  const handleClearFolder = useCallback(() => {
    setSettings(s => ({ ...s, musicFolder: null }));
    setTracks([]);
    setTrackIdx(-1);
    setIsPlaying(false);
    progressRef.current = 0;
  }, []);

  const loadScLikes = useCallback(async (auth, opts = {}) => {
    const silent = opts.silent === true;
    if (silent) setScUpdating(true);
    else { setScLoading(true); setScTracks([]); }
    setScError(null);
    const all = [];
    let userId = auth.userId;
    if (!userId) {
      const me = await window.electronAPI.scFetch('https://api-v2.soundcloud.com/me', auth.token, auth.clientId);
      if (me.data?.id) userId = me.data.id;
      else {
        const tL = k => STRINGS[langRef.current]?.[k] ?? STRINGS.ru[k] ?? k;
        setScError(`${tL('userid_err')}: ${me.error ?? '—'}`);
        if (silent) setScUpdating(false); else setScLoading(false);
        return;
      }
    }
    let url = `https://api-v2.soundcloud.com/users/${userId}/likes?limit=200`;
    let pages = 0;
    try {
      while (url && pages < 20) {
        const res = await window.electronAPI.scFetch(url, auth.token, auth.clientId);
        if (res.error) {
          /* 401 — это не «ошибка api», а мёртвый токен: сессию надо получить
             заново, и человек должен увидеть это прямо здесь, а не гадать,
             почему лаки пустые. */
          const tL = k => STRINGS[langRef.current]?.[k] ?? STRINGS.ru[k] ?? k;
          setScError(res.error === 401 ? tL('sc_err_expired') : `${tL('api_err')}: ${res.error}`);
          break;
        }
        if (!res.data?.collection) break;
        for (const item of res.data.collection) {
          const t = item.track;
          if (!t?.id) continue;
          all.push(mapScTrack(t, STRINGS[langRef.current]?.no_title ?? 'Без названия'));
        }
        url = res.data.next_href || null;
        pages++;
      }
    } catch (e) {
      setScError(String(e));
      console.error('loadScLikes:', e);
    }
    if (all.length) {
      scCacheRef.current = all;
      scCacheMapRef.current = new Map(all.map(t => [t.id, t]));
      window.electronAPI.scSaveLikesCache(all);
      const cached = await window.electronAPI.scCheckCovers(all.map(t => t.id));
      const withCache = all.map(t => cached[t.id] ? withScArtwork(t, cached[t.id]) : t);
      setScTracks(withCache);
      if (silent) setScUpdating(false); else setScLoading(false);
      loadScCovers(withCache.filter(t => !cached[t.id]));
    } else {
      if (!silent) setScTracks(all);
      if (silent) setScUpdating(false); else setScLoading(false);
    }
  }, []);

  const loadScCovers = useCallback(async (tracksArr) => {
    const pending = tracksArr.filter(t => t.coverUrl);
    if (!pending.length) return;
    let next = 0;
    const acc = {};
    let newSinceFlush = 0;
    const flush = () => {
      if (!newSinceFlush) return;
      newSinceFlush = 0;
      const snap = { ...acc };
      setScTracks(prev => prev.map(t => snap[t.id] ? withScArtwork(t, snap[t.id]) : t));
    };
    async function worker() {
      while (next < pending.length) {
        const t = pending[next++];
        try {
          const local = await window.electronAPI.scCacheCover(t.id, t.coverUrl);
          if (local) { acc[t.id] = local; newSinceFlush++; }
        } catch {}
        if (newSinceFlush >= 20) flush();
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, pending.length) }, worker));
    flush();
  }, []);

  const incrementalScUpdate = useCallback(async (auth) => {
    if (!auth?.userId) return;
    setScUpdating(true);
    setScError(null);
    const knownIds = new Set(scCacheRef.current.map(t => t.id));
    const newest = [];
    let url = `https://api-v2.soundcloud.com/users/${auth.userId}/likes?limit=200`;
    let pages = 0;
    let foundKnown = false;
    try {
      while (url && pages < 20 && !foundKnown) {
        const res = await window.electronAPI.scFetch(url, auth.token, auth.clientId);
        if (res.error) {
          /* 401 — это не «ошибка api», а мёртвый токен: сессию надо получить
             заново, и человек должен увидеть это прямо здесь, а не гадать,
             почему лаки пустые. */
          const tL = k => STRINGS[langRef.current]?.[k] ?? STRINGS.ru[k] ?? k;
          setScError(res.error === 401 ? tL('sc_err_expired') : `${tL('api_err')}: ${res.error}`);
          break;
        }
        if (!res.data?.collection) break;
        for (const item of res.data.collection) {
          const t = item.track;
          if (!t?.id) continue;
          if (knownIds.has(t.id)) { foundKnown = true; break; }
          newest.push(mapScTrack(t, STRINGS[langRef.current]?.no_title ?? 'Без названия'));
        }
        if (foundKnown) break;
        url = res.data.next_href || null;
        pages++;
      }
    } catch (e) {
      setScError(String(e));
      console.error('incrementalScUpdate:', e);
      setScUpdating(false);
      return;
    }
    if (foundKnown) {
      if (newest.length > 0) {
        const cachedCovers = await window.electronAPI.scCheckCovers(newest.map(t => t.id));
        const newestWithCovers = newest.map(t => cachedCovers[t.id] ? withScArtwork(t, cachedCovers[t.id]) : t);
        setScTracks(prev => [...newestWithCovers, ...prev]);
        scCacheRef.current = [...newest, ...scCacheRef.current];
        newest.forEach(t => scCacheMapRef.current.set(t.id, t));
        window.electronAPI.scSaveLikesCache(scCacheRef.current);
        loadScCovers(newestWithCovers.filter(t => !cachedCovers[t.id]));
      }
      setScUpdating(false);
    } else {
      setScUpdating(false);
      loadScLikes(auth, { silent: true });
    }
  }, [loadScLikes, loadScCovers]);

  const initScLikes = useCallback(async (auth) => {
    const cache = await window.electronAPI.scLoadLikesCache();
    const cacheValid = cache && cache.length > 0
      && Object.prototype.hasOwnProperty.call(cache[0], 'hlsUrl')
      && Object.prototype.hasOwnProperty.call(cache[0], 'permalinkUrl');
    if (cacheValid) {
      scCacheRef.current = cache;
      scCacheMapRef.current = new Map(cache.map(t => [t.id, t]));
      const cachedCovers = await window.electronAPI.scCheckCovers(cache.map(t => t.id));
      /* applyScTitles обязателен: кэш идёт в state напрямую, минуя mapScTrack,
         поэтому переименования в нём не было и после перезапуска название
         откатывалось к оригиналу */
      const withCovers = applyScTitles(
        cache.map(t => cachedCovers[t.id] ? withScArtwork(t, cachedCovers[t.id]) : t));
      setScTracks(withCovers);
      setScLoading(false);
      loadScCovers(withCovers.filter(t => t.coverUrl && !t.coverUrl.startsWith('file:')));
      incrementalScUpdate(auth);
    } else {
      loadScLikes(auth);
    }
  }, [loadScLikes, loadScCovers, incrementalScUpdate]);

  useEffect(() => {
    if (settings.soundcloudAuth?.token) initScLikes(settings.soundcloudAuth);
    else { setScTracks([]); scCacheRef.current = []; scCacheMapRef.current = new Map(); }
  }, [settings.soundcloudAuth]);

  const handleScLogin = useCallback((auth) => {
    setSettings(s => ({ ...s, soundcloudAuth: auth, sourceMode: 'sc' }));
  }, []);
  /* Выход — через rust: он закрывает окно сессии и удаляет куки soundcloud.
     Раньше здесь только чистились настройки, а сессия webview оставалась
     живой — следующий вход проходил без пароля, и сменить аккаунт было
     невозможно. Ошибку выхода не глотаем: если куки удалить не удалось,
     в логе и в консоли останется след, а сессия — живой. */
  const handleScLogout = useCallback(async () => {
    try { await window.electronAPI.scLogout(); }
    catch (e) { console.error('scLogout:', e); }
    scCacheRef.current = [];
    scCacheMapRef.current = new Map();
    try { window.electronAPI.scSaveLikesCache([]); } catch {}
    setSettings(s => ({ ...s, soundcloudAuth: null, sourceMode: 'local' }));
  }, []);
  const handleToggleSource = useCallback(() => setSettings(s => ({ ...s, sourceMode: s.sourceMode === 'sc' ? 'local' : 'sc' })), []);
  const sourceMode = (settings.soundcloudAuth && settings.sourceMode === 'sc') ? 'sc' : 'local';
  /* какие куски интерфейса спрятаны (Оформление → «Элементы интерфейса») */
  const uiHidden = uiHiddenOf(settings);

  /* ── плейлисты ─────────────────────────────────────────────────────────── */

  /* лайкнутые + свои плейлисты; свой перекрывает лайкнутый, свои сверху.
     Свои: users/{id}/playlists (публичный, проверенный), фолбэк /me/playlists.
     Лайкнутые: users/{id}/playlist_likes, фолбэк — смешанные users/{id}/likes
     (там item.playlist — этот эндпоинт точно работает, лайки треков уже с него).
     Ошибки не глотаем: при полном фейле показываем в интерфейсе + console для
     девтулзов, playlistsRef не заполняем — «повторить» сработает */
  const loadPlaylists = useCallback(async (auth, force = false) => {
    if (!auth) return;
    if (!force && playlistsRef.current) return;
    setPlaylistsLoading(true);
    setPlaylistsError(null);
    try {
      let userId = auth.userId;
      if (!userId) {
        const me = await window.electronAPI.scFetch('https://api-v2.soundcloud.com/me', auth.token, auth.clientId);
        if (me.data?.id) userId = me.data.id;
        else {
          setPlaylistsError(`${STRINGS[langRef.current]?.userid_err ?? 'user id'}: ${me.error ?? '—'}`);
          return;
        }
      }
      const auth2 = { ...auth, userId };
      const fetchAll = async (startUrl, extract, maxPages = 10) => {
        const out = [];
        let url = startUrl;
        let pages = 0;
        let lastErr = null;
        while (url && pages < maxPages) {
          const res = await window.electronAPI.scFetch(url, auth.token, auth.clientId);
          if (res.error) { lastErr = res.error; break; }
          const col = res.data?.collection;
          if (!col) break;
          for (const item of col) {
            const p = extract(item);
            if (p?.id) out.push(p);
          }
          url = res.data.next_href || null;
          pages++;
        }
        return { items: out, error: lastErr };
      };
      /* свои плейлисты */
      let own = await fetchAll(
        `https://api-v2.soundcloud.com/users/${userId}/playlists?limit=50`, p => p);
      if (own.error) {
        console.error('[seWer] users/playlists →', own.error);
        const viaMe = await fetchAll('https://api-v2.soundcloud.com/me/playlists?limit=50', p => p);
        if (!viaMe.error) own = viaMe;
      }
      /* лайкнутые плейлисты (+ фолбэк через общий список лайков) */
      let liked = await fetchAll(
        `https://api-v2.soundcloud.com/users/${userId}/playlist_likes?limit=50`,
        it => it?.playlist ?? it);
      if (liked.error || liked.items.length === 0) {
        const mixed = await fetchAll(
          `https://api-v2.soundcloud.com/users/${userId}/likes?limit=200`,
          it => it?.playlist ?? null, 20);
        if (mixed.error || mixed.items.length === 0) {
          if (liked.error) console.error('[seWer] playlist_likes →', liked.error, '| likes →', mixed.error);
          if (liked.error && mixed.error) liked = { items: [], error: liked.error };
        } else {
          liked = mixed;
        }
      }
      if (own.error && (liked.error || liked.items.length === 0)) {
        setPlaylistsError(`${STRINGS[langRef.current]?.api_err ?? 'api error'}: ${own.error}`);
        return;
      }
      const map = new Map();
      for (const p of liked.items) if (isScPlaylist(p)) map.set(p.id, mapScPlaylist(p, auth2));
      for (const p of own.items) if (isScPlaylist(p)) map.set(p.id, mapScPlaylist(p, auth2));
      const list = [...map.values()].sort((a, b) => (b.isOwn ? 1 : 0) - (a.isOwn ? 1 : 0));
      playlistsRef.current = list;
      setPlaylists(list);
      /* один раз показываем, чем SC реально помечает альбомы: и значения
         предполагаемых полей, и все ключи ответа — чтобы выбрать верный
         признак, а не гадать (всё это их собственные данные, только в их
         же консоли) */
      if (!albumKindLogged.current) {
        albumKindLogged.current = true;
        const all = [...own.items, ...liked.items];
        const uniqOf = key => [...new Set(all.map(p => String(p?.[key])))];
        console.log('[seWer] album probe · playlist_kind:', JSON.stringify(uniqOf('playlist_kind')));
        console.log('[seWer] album probe · type:          ', JSON.stringify(uniqOf('type')));
        console.log('[seWer] album probe · kind:          ', JSON.stringify(uniqOf('kind')));
        console.log('[seWer] album probe · set_type:      ', JSON.stringify(uniqOf('set_type')));
        console.log('[seWer] album probe · is_album:      ', JSON.stringify(uniqOf('is_album')));
        console.log('[seWer] album probe · sharing:       ', JSON.stringify(uniqOf('sharing')));
        console.log('[seWer] album probe · titles:         ', JSON.stringify(all.map(p => `${p?.title}|${p?.set_type}|${p?.is_album}`)));
      }
    } catch (e) {
      setPlaylistsError(String(e));
      console.error('[seWer] loadPlaylists:', e);
    } finally {
      setPlaylistsLoading(false);
    }
  }, []);

  /* вход в плейлист: догружаем треки при необходимости, очередь = плейлист,
     станция/поиск выключаются, плеер + автоплей первого трека */
  /* записать известный состав плейлиста в кеш чекбоксов (один вход для всех).
     объявлено до хендлеров: они берут его в deps */
  const rememberMember = useCallback((plId, ids) => {
    plMembersRef.current = { ...plMembersRef.current, [plId]: { ids: new Set(ids) } };
    setPlMembers(plMembersRef.current);
  }, []);

  const handleOpenPlaylist = useCallback(async (pl) => {
    const auth = scAuthRef.current;
    if (!auth) return;
    let tracks = pl.tracks || [];
    if (tracks.length < (pl.trackCount || 0)) {
      const full = await fetchPlaylistTracks(pl.id, auth, STRINGS[langRef.current]?.no_title ?? 'Без названия');
      if (full.length) { /* пустой результат не затирает встроенные */
        tracks = full;
        const withTracks = { ...pl, tracks };
        playlistsRef.current = (playlistsRef.current || []).map(p => p.id === pl.id ? withTracks : p);
        setPlaylists(playlistsRef.current);
        /* полный состав известен — кладём в кеш чекбоксов, чтоб не перезапрашивать */
        rememberMember(pl.id, full.map(x => x.id));
      }
    }
    playlistQueueRef.current = tracks;
    stationQueueRef.current = null;
    searchQueueRef.current = null;
    setStationActive(null);
    setPlaylistActive({ playlist: pl, tracks });
    setHomeVisible(false);
    setPlayerVisible(true);
    setView('player');
    setNavActive('library');
    if (tracks.length) handleScTrackClick(tracks[0], -1);
  }, [rememberMember]);

  const handleExitPlaylist = useCallback(() => {
    playlistQueueRef.current = null;
    setPlaylistActive(null);
  }, []);

  /* создать пустой свой плейлист → сразу в редактор */
  const handleCreatePlaylist = useCallback(async () => {
    const auth = scAuthRef.current;
    if (!auth || creatingPlaylist) return;
    setCreatingPlaylist(true);
    try {
      const res = await window.electronAPI.scFetch(
        'https://api-v2.soundcloud.com/playlists',
        auth.token, auth.clientId, 'POST',
        { playlist: { title: STRINGS[langRef.current]?.pl_new_title ?? 'Новый плейлист', tracks: [], sharing: 'private' } }
      );
      if (res.error || !res.data?.id) { showToast(t('pl_create_err')); return; }
      const pl = { ...mapScPlaylist(res.data, auth), isOwn: true }; /* создали — значит наше */
      playlistsRef.current = [pl, ...(playlistsRef.current || [])];
      setPlaylists(playlistsRef.current);
      setEditingPlaylist({ playlist: pl, from: 'playlists' });
      setView('playlistEditor');
    } catch {
      showToast(t('pl_create_err'));
    } finally {
      setCreatingPlaylist(false);
    }
  }, [creatingPlaylist, t]);

  const handleOpenPlEditor = useCallback((pl, from) => {
    if (!pl.isOwn) return;
    if (from === 'player') setPlayerVisible(false);
    setEditingPlaylist({ playlist: pl, from });
    setView('playlistEditor');
  }, []);

  /* ПКМ по треку → «добавить в плейлист»: свежий GET объекта плейлиста
     (встроенные tracks приходят неполными), id дописывается в конец, PUT.
     живо обновляем кеш списка и активную очередь, если плейлист играет */
  const handleAddToPlaylist = useCallback(async (track, pl) => {
    const auth = scAuthRef.current;
    if (!auth || !pl?.id || track?.id == null) return 'error';
    const cur = await window.electronAPI.scFetch(
      `https://api-v2.soundcloud.com/playlists/${pl.id}`, auth.token, auth.clientId);
    if (cur.error || !cur.data?.id) {
      showToast(cur.blocked ? t('sc_blocked') : t('pl_add_err'));
      return 'error';
    }
    const raw = cur.data;
    const ids = (raw.tracks || []).map(x => x?.id).filter(v => v != null);
    /* трек уже внутри — запрос не шлём, но статус честно отдаём, чтобы чекбокс не мигал */
    if (ids.includes(track.id)) {
      rememberMember(pl.id, ids);
      return 'exists';
    }
    ids.push(track.id);
    const res = await window.electronAPI.scFetch(
      `https://api-v2.soundcloud.com/playlists/${pl.id}`, auth.token, auth.clientId, 'PUT',
      { playlist: { ...raw, tracks: ids, track_count: ids.length } });
    if (res.error) {
      showToast(res.blocked ? t('sc_blocked') : t('pl_add_err'));
      return 'error';
    }
    rememberMember(pl.id, ids);
    const count = ids.length;
    playlistsRef.current = (playlistsRef.current || []).map(p => {
      if (p.id !== pl.id) return p;
      const tracks = (p.tracks?.length === p.trackCount) ? [...p.tracks, track] : p.tracks;
      return { ...p, trackCount: count, tracks };
    });
    setPlaylists(playlistsRef.current);
    setPlaylistActive(pa => {
      if (!pa || pa.playlist.id !== pl.id) return pa;
      const q = [...pa.tracks, track];
      playlistQueueRef.current = q;
      return { playlist: { ...pa.playlist, trackCount: count }, tracks: q };
    });
    showToast(`${t('added_to')} «${pl.title}»`);
    return 'added';
  }, [t, rememberMember]);

  /* ПКМ → снять трек с плейлиста: у SoundCloud нет DELETE-трека из плейлиста,
     поэтому тот же приём — свежий GET, фильтруем id, PUT обратно */
  const handleRemoveFromPlaylist = useCallback(async (track, pl) => {
    const auth = scAuthRef.current;
    if (!auth || !pl?.id || track?.id == null) return 'error';
    const cur = await window.electronAPI.scFetch(
      `https://api-v2.soundcloud.com/playlists/${pl.id}`, auth.token, auth.clientId);
    if (cur.error || !cur.data?.id) {
      showToast(cur.blocked ? t('sc_blocked') : t('pl_rm_err'));
      return 'error';
    }
    const raw = cur.data;
    const ids = (raw.tracks || []).map(x => x?.id).filter(v => v != null);
    const next = ids.filter(id => id !== track.id);
    if (next.length === ids.length) { rememberMember(pl.id, ids); return 'absent'; }
    const res = await window.electronAPI.scFetch(
      `https://api-v2.soundcloud.com/playlists/${pl.id}`, auth.token, auth.clientId, 'PUT',
      { playlist: { ...raw, tracks: next, track_count: next.length } });
    if (res.error) {
      showToast(res.blocked ? t('sc_blocked') : t('pl_rm_err'));
      return 'error';
    }
    rememberMember(pl.id, next);
    playlistsRef.current = (playlistsRef.current || []).map(p =>
      p.id === pl.id ? { ...p, trackCount: next.length, tracks: (p.tracks || []).filter(x => x.id !== track.id) } : p);
    setPlaylists(playlistsRef.current);
    /* работа с активным плейлистом — ВНЕ апдейтера setState: там нельзя дёргать
       другие setState (иначе React ругается на апдейты во время рендера) */
    const pa = playlistActiveRef.current;
    if (pa && pa.playlist.id === pl.id) {
      const q = pa.tracks.filter(x => x.id !== track.id);
      if (!q.length) {
        handleExitPlaylist();               /* плейлист опустел — выходим из режима */
      } else {
        playlistQueueRef.current = q;
        setPlaylistActive({ playlist: { ...pa.playlist, trackCount: q.length }, tracks: q });
        /* сняли текущий трек — иначе плеер останется на воздухе */
        if (scPlayingTrackRef.current?.id === track.id) {
          const at = Math.min(pa.tracks.findIndex(x => x.id === track.id), q.length - 1);
          handleScTrackClick(q[Math.max(at, 0)], Math.max(at, 0));
        }
      }
    }
    showToast(`${t('removed_from')} «${pl.title}»`);
    return 'removed';
  }, [t, rememberMember, handleExitPlaylist, handleScTrackClick]);

  /* ПКМ → «новый плейлист»: создаём приватный сразу с этим треком */
  const handleCreatePlaylistWithTrack = useCallback(async (track) => {
    const auth = scAuthRef.current;
    if (!auth || track?.id == null) return 'error';
    const res = await window.electronAPI.scFetch(
      'https://api-v2.soundcloud.com/playlists', auth.token, auth.clientId, 'POST',
      { playlist: { title: STRINGS[langRef.current]?.pl_new_title ?? 'Новый плейлист', tracks: [track.id], sharing: 'private' } }
    );
    if (res.error || !res.data?.id) { showToast(res.blocked ? t('sc_blocked') : t('pl_create_err')); return 'error'; }
    const pl = { ...mapScPlaylist(res.data, auth), isOwn: true };
    playlistsRef.current = [pl, ...(playlistsRef.current || [])];
    setPlaylists(playlistsRef.current);
    rememberMember(pl.id, [track.id]); /* сразу известен состав — чекбокс не грузится */
    showToast(`${t('added_to')} «${pl.title}»`);
    return 'created';
  }, [t, rememberMember]);

  /* чекбокс в пикере: снимат трек если он внутри, кладёт если нет */
  const handleToggleInPlaylist = useCallback((track, pl, isIn) =>
    isIn ? handleRemoveFromPlaylist(track, pl) : handleAddToPlaylist(track, pl),
    [handleAddToPlaylist, handleRemoveFromPlaylist]);

  /* пикер плейлистов в контекст-меню: подтягиваем список по требованию */
  const ensurePlaylists = useCallback((force = false) => {
    const auth = scAuthRef.current;
    if (auth) loadPlaylists(auth, force);
  }, [loadPlaylists]);

  /* состав для чекбоксов: догружаем недостающие плейлисты пачками по 4,
     каждый запрос помечаем busy, чтобы не плодить дубли на ре-рендерах.
     запись в plMembers: { pending:true } в полёте → { ids:Set } успех →
     { ids:null } провал. БЫЛО: голый Set/null, где null читался как «грузятся»
     вечно, и без .catch() — отклонённый промис навсегда оставлял busy=true */
  const ensurePlaylistMembers = useCallback((list) => {
    const auth = scAuthRef.current;
    if (!auth) return;
    const pending = [];
    for (const p of (list || [])) {
      if (!p?.isOwn || p.id == null) continue;
      const e = plMembersRef.current[p.id];
      if (e && 'ids' in e) continue;      /* уже знаем (Set) или уже упали (null) */
      if (membersBusyRef.current[p.id]) continue;
      pending.push(p);
    }
    for (let i = 0; i < pending.length; i += 4) {
      for (const p of pending.slice(i, i + 4)) {
        membersBusyRef.current[p.id] = true;
        plMembersRef.current = { ...plMembersRef.current, [p.id]: { pending: true } };
        setPlMembers(plMembersRef.current);
        const settle = entry => {
          delete membersBusyRef.current[p.id];
          plMembersRef.current = { ...plMembersRef.current, [p.id]: entry };
          setPlMembers(plMembersRef.current);
        };
        fetchPlaylistTrackIds(p.id, auth, p.trackCount).then(
          ids => settle({ ids }),
          () => settle({ ids: null })   /* провал: чекбокс станет «нет» и останется кликабельным */
        );
      }
    }
  }, []);

  const handleClosePlEditor = useCallback(() => {
    const from = editingPlaylist?.from;
    setEditingPlaylist(null);
    if (from === 'player') {
      setHomeVisible(false);
      setPlayerVisible(true);
      setView('player');
      setNavActive('library');
    } else {
      setView('playlists');
    }
  }, [editingPlaylist]);

  /* колбэк сохранения редактора: обновляем список плейлистов и, если редактируем
     активный плейлист, — живо обновляем его очередь и сайдбар. meta может
     принести новый title/coverUrl (правка шапки редактора) */
  const handlePlaylistUpdated = useCallback((id, newTracks, meta) => {
    playlistsRef.current = (playlistsRef.current || []).map(p =>
      p.id === id ? { ...p, tracks: newTracks, trackCount: newTracks.length,
        ...(meta?.title ? { title: meta.title } : {}),
        ...(meta?.coverUrl ? { coverUrl: meta.coverUrl } : {}) } : p);
    setPlaylists(playlistsRef.current);
    setEditingPlaylist(ep => {
      if (!ep || ep.playlist.id !== id) return ep;
      /* НЕ спредим meta как есть: там coverUrl === undefined, когда обложку не
         меняли, а спред копирует такой ключ и затирает coverUrl в undefined —
         обложка в редакторе исчезала на заглушку до переоткрытия */
      const patch = {};
      if (meta?.title) patch.title = meta.title;
      if (meta?.coverUrl) patch.coverUrl = meta.coverUrl;
      return { ...ep, playlist: { ...ep.playlist, ...patch } };
    });
    setPlaylistActive(pa => {
      if (!pa || pa.playlist.id !== id) return pa;
      playlistQueueRef.current = newTracks;
      return { playlist: { ...pa.playlist, ...(meta || {}) }, tracks: newTracks };
    });
  }, []);

  /* удаление плейлиста: DELETE /playlists/{id}, вычищаем из списка/режима
     прослушивания, закрываем редактор; возвращает true/false для редактора */
  const handleDeletePlaylist = useCallback(async (pl) => {
    const auth = scAuthRef.current;
    if (!auth || !pl?.id) return false;
    const res = await window.electronAPI.scFetch(
      `https://api-v2.soundcloud.com/playlists/${pl.id}`,
      auth.token, auth.clientId, 'DELETE'
    );
    if (res.error) { showToast(t('pl_del_err')); return false; }
    playlistsRef.current = (playlistsRef.current || []).filter(p => p.id !== pl.id);
    setPlaylists(playlistsRef.current);
    setPlaylistActive(pa => {
      if (!pa || pa.playlist.id !== pl.id) return pa;
      playlistQueueRef.current = null;
      return null; /* удалили активный плейлист — выходим из его режима */
    });
    setEditingPlaylist(null);
    setView('playlists');
    return true;
  }, [t]);

  const handleOpenArtist = useCallback((artist) => {
    prevViewRef.current = view;
    setArtistView(artist);
    if (view === 'player') setPlayerVisible(false);
    if (view === 'home')   setHomeVisible(false);
    setView('artist');
  }, [view]);

  const handleCloseArtist = useCallback(() => {
    const prev = prevViewRef.current || 'search';
    setView(prev);
    if (prev === 'player') setPlayerVisible(true);
    if (prev === 'home')   setHomeVisible(true);
  }, []);

  // mouse side-buttons: back (3) / forward (4)
  useEffect(() => {
    function onMouseUp(e) {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.button === 3) {
        if (view === 'artist') {
          handleCloseArtist();
        } else if (view === 'playlistEditor') {
          if (plEditorRef.current) plEditorRef.current.requestClose();
          else handleClosePlEditor();
        } else if (view === 'player') {
          setPlayerVisible(false);
          setHomeVisible(true);
          setView('home');
        } else if (view === 'settings' || view === 'search' || view === 'playlists') {
          setHomeVisible(true);
          setView('home');
        }
      } else {
        const hasTrack = scPlayingTrackRef.current || (tracks.length > 0 && tracks[trackIdx]);
        if (view !== 'player' && view !== 'artist' && hasTrack) {
          setHomeVisible(false);
          setPlayerVisible(true);
          setView('player');
        }
      }
    }
    window.addEventListener('mouseup', onMouseUp);
    return () => window.removeEventListener('mouseup', onMouseUp);
  }, [view, tracks, trackIdx, handleCloseArtist, handleClosePlEditor]);

  /* грузим плейлисты при заходе во вкладку; при ошибке НЕ перезагружаем
     автоматически (иначе петля запросов) — только по клику «повторить» */
  useEffect(() => {
    if (view === 'playlists' && settings.soundcloudAuth
        && !playlists && !playlistsError && !playlistsLoading) {
      loadPlaylists(settings.soundcloudAuth);
    }
  }, [view, settings.soundcloudAuth, playlists, playlistsError, playlistsLoading, loadPlaylists]);

  const toastOwnerRef = useRef(null);
  if (!toastOwnerRef.current) toastOwnerRef.current = createToastOwner(setToast, setToastExiting);
  useEffect(() => () => toastOwnerRef.current.cancel(), []);
  function handleSearchResultsLoaded(newTracks) {
    if (!searchQueueRef.current) return;
    searchQueueRef.current = [...searchQueueRef.current, ...newTracks];
    /* Движок допишет новые id в конец порядка и запомнит их треки. Проверять
       флаг перемешивания не нужно: при выключенном порядок пуст и extend() —
       no-op. */
    shuffleStateRef.current.extend(newTracks);
  }

  function showToast(msg) {
    toastOwnerRef.current.show(msg);
  }

  function destroyHls() {
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
  }

  /* Один переход для локальных файлов и SoundCloud: сначала декодируем
     следующую деку, затем запускаем, и только после play() меняем очередь.
     Нет отдельного fade-out, который гасил трек ещё до готовности следующего. */

  const XFADE_PRIME_LEAD = 10;
  /* Обычный запуск не зависит от UI-кадров или события playing: текущая
     дека получает громкость синхронно. Ноль допустим лишь на standby,
     во время настоящего перекрытия или при пользовательском mute. */
  function restorePlaybackVolume(audio) {
    if (!audio || audio !== audioRef.current) return;
    afxResume();
    const xf = xfadeRef.current;
    if (xf) {
      const gains = xfadeGains(xf);
      xf.from.volume = gains.out * volumeRef.current;
      xf.to.volume = gains.in * volumeRef.current;
    } else {
      audio.volume = volumeRef.current;
    }
  }

  function handleDeckPlayback(audio) {
    return event => {
      if (audioRef.current !== audio) return;
      if (event.type === 'playing') restorePlaybackVolume(audio);
      if (partyClientRef.current?.role === 'guest') {
        if (event.type === 'playing') setIsPlaying(true);
        else if (event.type === 'pause' || event.type === 'ended') setIsPlaying(false);
      } else partyClientRef.current?.sync();
      discordPushRef.current?.(0);
    };
  }
  /* Те же коэффициенты для любого момента перекрытия. Используется в rAF,
     в эффекте громкости и при драге ползунка — кривую нельзя дублировать,
     иначе правки в одном месте разъезжаются с остальными. */
  function xfadeGains(xf) {
    return xf.envelope.sample(xf.to.currentTime, xf.to.playbackRate);
  }

  /* Список, по которому играет SC-очередь. Порядок веток повторяет
     handleScTrackClick — иначе префетч тянул бы не тот трек. */
  function scQueueList() {
    return stationQueueRef.current || playlistQueueRef.current
      || searchQueueRef.current
      || (searchRef.current ? filteredScRef.current : scTracksRef.current);
  }

  /* Кто играет следующим. НИЧЕГО не меняет — только читает. Коммит позиции
     в shuffle-порядке делает сам startCrossfade. */
  function peekNextSc() {
    const list = scQueueList();
    const cur  = scPlayingTrackRef.current;
    if (!cur || !list.length) return null;
    const eng = shuffleStateRef.current;
    eng.sync(list);
    if (shuffleOnRef.current) {
      const step = eng.peek(1);
      if (!step) return null;
      const t = eng.track(step.id);
      return t ? { track: t, step } : null;
    }
    const ni = list.findIndex(t => t.id === cur.id) + 1;
    if (ni >= 0 && ni < list.length) return { track: list[ni], step: null };
    if (repeatRef.current === 'all' && list.length) return { track: list[0], step: null };
    return null;
  }

  /* Резолв CDN-ссылки. Вынесено из handleScTrackClick, чтобы префетч и
     обычное переключение шли через один и тот же код.

     Ошибку сети глотаем и возвращаем null. Раньше scFetch мог отклониться и
     уронить handleScTrackClick целиком — спиннер загрузки оставался на
     экране навсегда. Для префетча это тем более важно: необработанный reject
     оставил бы prime без url, и кроссфейд молча выключился бы до конца трека. */
  async function resolveScUrl(t) {
    const auth = scAuthRef.current;
    if (!auth) return null;
    try {
      let url = null, isHls = false;
      if (t.streamUrl) {
        const res = await window.electronAPI.scFetch(t.streamUrl, auth.token, auth.clientId);
        if (res?.data?.url) url = res.data.url;
      }
      if (!url && t.hlsUrl) {
        const res = await window.electronAPI.scFetch(t.hlsUrl, auth.token, auth.clientId);
        if (res?.data?.url) { url = res.data.url; isHls = true; }
      }
      return url ? { url, isHls } : null;
    } catch {
      return null;
    }
  }

  function ensureDeckB() {
    if (deckBRef.current && deckBRef.current !== audioRef.current) return deckBRef.current;
    const b = HOT_STORE.deckB && HOT_STORE.deckB !== audioRef.current ? HOT_STORE.deckB : new Audio();
    HOT_STORE.deckB = b;
    /* см. инициализацию Audio: атрибут обязан стоять до первого src */
    b.crossOrigin = 'anonymous';
    b.preload = 'auto';
    b.volume = 0;
    bindDeck(b, handleDeckTime(b), handleDeckEnded(b), handleDeckPlayback(b));
    deckBRef.current = b;
    /* вторая дека создаётся лениво, уже после того, как могли включить
       эквалайзер — иначе она играла бы в обход фильтров */
    afxAttach(b);
    return b;
  }

  /* Обработчики дека. Общие для обеих деок, поэтому принимают свой элемент
     и отличают «меня забыли» от «мне нельзя трогать шкалу». */
  function handleDeckTime(audio) {
    return () => {
      /* уходящая дека шкалой не управляет: иначе прогресс-бар и полоса
         в дискорде откатывались бы назад на каждом её timeupdate */
      if (audioRef.current !== audio) return;
      const duration = mediaDuration(audio, trackRef.current);
      if (!duration) return;
      progressRef.current = Math.min(1, audio.currentTime / duration);
      discordProgressRef.current = progressRef.current;
      /* полоска прогресса у края окна (вне плеера). Тот же timeupdate, что и у
         слайдера: своего rAF-цикла не заводим — плавность между тиками даёт
         linear-transition у #accent-fill */
      setMiniProgress(progressRef.current);
      xfadeTickRef.current?.();
    };
  }

  function handleDeckEnded(audio) {
    return () => {
      /* Уходящая дека доиграла. Не зовём handleNext — иначе перескочим
         трек: следующий уже играет, он и есть текущий. Просто заканчиваем
         перекрытие (на всякий случай: если окно не доделалось). */
      if (outgoingRef.current?.audio === audio) { finishCrossfade(); return; }
      /* Standby тоже может прислать ended после очистки src. */
      if (audioRef.current !== audio) return;
      if (partyClientRef.current?.active) { pausePartyPlayback(); partyClientRef.current.sync(); return; }
      const prime = xfadePrimeRef.current;
      if (prime?.ready && startCrossfade(prime.next, prime)) return;
      handleNextRef.current?.();
    };
  }

  /* Стадия 1: заранее резолвим и монтируем следующий трек. */
  const playbackKey = t => t?.path ? `local:${t.path}` : `sc:${t?.id}`;

  function peekNextPlayback() {
    if (scPlayingTrackRef.current) return peekNextSc();
    const current = trackRef.current;
    if (!current?.path) return null;
    const list = searchRef.current ? filteredRef.current : localTracksRef.current;
    if (!list.length) return null;
    if (shuffleOnRef.current) {
      const candidates = list.filter(t => t.path !== current.path);
      if (!candidates.length) return null;
      return { track: candidates[Math.floor(Math.random() * candidates.length)], step: null };
    }
    const index = list.findIndex(t => t.path === current.path);
    const next = list[index + 1] || (repeatRef.current === 'all' ? list[0] : null);
    return next && next.path !== current.path ? { track: next, step: null } : null;
  }

  function primeStillValid(prime) {
    if (!prime || prime.forId !== playbackKey(trackRef.current)
      || prime.intro !== crossfadeSettings(settingsRef.current).intro
      || prime.shuffle !== shuffleOnRef.current || prime.repeat !== repeatRef.current) return false;
    const list = scPlayingTrackRef.current ? scQueueList()
      : searchRef.current ? filteredRef.current : localTracksRef.current;
    if (!list.some(t => playbackKey(t) === prime.trackId)) return false;
    if (prime.shuffle) {
      // peek() may construct a fresh random cycle at repeat-all. Keep the first
      // reserved step, rather than drawing a different next track every tick.
      const eng = shuffleStateRef.current;
      return !scPlayingTrackRef.current || (prime.shuffleOrder === eng.order && prime.shufflePos === eng.pos);
    }
    return playbackKey(peekNextPlayback()?.track) === prime.trackId;
  }

  async function primeNextPlayback(current, next) {
    const b = ensureDeckB();
    if (!b) return;
    const config = crossfadeSettings(settingsRef.current);
    const prime = { forId: playbackKey(current), trackId: playbackKey(next.track), next,
      url: null, isHls: false, failed: false, ready: false, starting: false,
      intro: config.intro, controller: new AbortController(), audio: b };
    prime.shuffle = shuffleOnRef.current;
    prime.repeat = repeatRef.current;
    prime.shuffleOrder = shuffleStateRef.current.order;
    prime.shufflePos = shuffleStateRef.current.pos;
    xfadePrimeRef.current = prime;
    b.__sewPrime = prime;
    b.pause();
    b.volume = 0;
    const r = next.track.path ? { url: fileSrc(next.track.path), isHls: false } : await resolveScUrl(next.track);
    /* Пока шли запросы, могли сменить трек, ползунок или уйти из плейера —
       тогда prime уже никому не нужен, а смонтированный hls надо убить. */
    if (xfadePrimeRef.current !== prime) return;
    if (!r) { prime.failed = true; return; }
    prime.url = r.url; prime.isHls = r.isHls;
    if (r.isHls) {
      const Hls = await loadHls();
      /* Пока грузился чанк hls, префетч могли отменить (сменили трек,
         ушли из плеера) — тогда смонтированный инстанс некому гасить,
         кроме нас: deckBHlsRef принадлежит уже другому префетчу, а этот
         осиротевший держал бы открытый стрим вечно. */
      if (xfadePrimeRef.current !== prime) return;
      if (Hls.isSupported()) {
        const hls = new Hls({ maxBufferLength: 20, maxMaxBufferLength: 30,
          startPosition: crossfadeIntroPosition(config.intro, next.track.duration) });
        deckBHlsRef.current = hls;
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal && xfadePrimeRef.current === prime) {
            prime.failed = true;
            prime.controller.abort();
          }
        });
        hls.loadSource(r.url);
        hls.attachMedia(b);
      } else {
        b.src = r.url;
        b.load();
      }
    } else {
      b.src = r.url;
      b.load();
    }
    try {
      await waitForDeck(b, { position: prime.intro, duration: next.track.duration,
        bufferSeconds: Math.min(6, config.seconds + 1) * (b.playbackRate || 1), signal: prime.controller.signal });
      if (xfadePrimeRef.current === prime) { prime.ready = true; xfadeTickRef.current?.(); }
    } catch {
      if (xfadePrimeRef.current === prime) prime.failed = true;
    }
  }

  /* Стадия 2: включаем вторую деку и пускаем перекрытие. */
  function startCrossfade(peek, prime) {
    if (partyClientRef.current?.active) return false;
    const cur = audioRef.current;
    const b = prime?.audio;
    const curTrack = trackRef.current;
    if (prime?.starting && xfadePrimeRef.current === prime) return true;
    if (!cur || !b || cur === b || !prime?.ready || prime.failed || !peek
      || !isPlayingRef.current || cur.seeking || trackSwitchingRef.current || repeatRef.current === 'one'
      || !primeStillValid(prime) || xfadePrimeRef.current !== prime
      || crossfadeSettings(settingsRef.current).seconds <= 0) return false;
    prime.starting = true;
    cur.volume = volumeRef.current;
    b.volume = 0;
    let timer;
    const fail = () => {
      clearTimeout(timer);
      if (xfadePrimeRef.current !== prime) return;
      prime.failed = true;
      prime.starting = false;
      b.pause();
      cur.volume = volumeRef.current;
      if (cur.ended && audioRef.current === cur) handleNextRef.current?.();
    };
    (async () => {
      try {
        await Promise.race([b.play(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('crossfade play timeout')), 4000);
        })]);
        clearTimeout(timer);
        if (xfadePrimeRef.current !== prime || audioRef.current !== cur) {
          if (b.__sewPrime === prime && b !== audioRef.current) b.pause();
          return;
        }
        if (prime.controller.signal.aborted || !isPlayingRef.current || b.paused || b.ended
          || !primeStillValid(prime) || crossfadeSettings(settingsRef.current).seconds <= 0) { fail(); return; }
        const config = crossfadeSettings(settingsRef.current);
        const rate = Math.max(0.1, cur.playbackRate || 1);
        const duration = mediaDuration(cur, curTrack);
        const nextDuration = mediaDuration(b, peek.track);
        const seconds = Math.min(crossfadeDuration(config, duration, nextDuration, rate),
          Math.max(0, (duration - cur.currentTime) / rate));
        const xf = { from: cur, to: b,
          envelope: new CrossfadeEnvelope({ seconds, curve: config.curve, position: b.currentTime }) };
        if (peek.step) shuffleStateRef.current.commit(peek.step);
        const pair = rotateDecks(cur, b);
        outgoingRef.current = { audio: cur, hls: hlsRef.current };
        hlsRef.current = deckBHlsRef.current;
        deckBHlsRef.current = null;
        audioRef.current = pair.current;
        deckBRef.current = pair.standby;
        HOT_STORE.audio = pair.current;
        HOT_STORE.deckB = pair.standby;
        xfadeRef.current = xf;
        xfadePrimeRef.current = null;
        b.__sewPrime = null;
        trackSwitchingRef.current = false;
        const resolved = { ...peek.track, duration: nextDuration || peek.track.duration, resolvedUrl: prime.url };
        // Refs are updated before any playback event can publish the old track.
        trackRef.current = resolved;
        if (peek.track.path) {
          b.__sewTrackPath = peek.track.path;
          HOT_STORE.trackSrc = fileSrc(peek.track.path);
          scPlayingTrackRef.current = null;
          setScPlayingTrack(null);
          setTrackIdx(localTracksRef.current.findIndex(t => t.path === peek.track.path));
        } else {
          HOT_STORE.trackSrc = null;
          scPlayingTrackRef.current = resolved;
          setScPlayingTrack(resolved);
          setScPlayingIdx(scTracksRef.current.findIndex(t => t.id === peek.track.id));
        }
        progressRef.current = nextDuration > 0 ? b.currentTime / nextDuration : 0;
        discordProgressRef.current = progressRef.current;
        setMiniProgress(progressRef.current);
        discordPushRef.current?.(0);
        const run = () => {
          if (xfadeRef.current !== xf) return;
          const gains = xfadeGains(xf);
          xf.from.volume = gains.out * volumeRef.current;
          xf.to.volume = gains.in * volumeRef.current;
          if (xf.envelope.done || xf.from.ended) { finishCrossfade(); return; }
          xfadeRafRef.current = requestAnimationFrame(run);
        };
        run();
      } catch { fail(); }
    })();
    return true;
  }

  function finishCrossfade() {
    /* Вызывается и из конца rAF-кривой, и из 'ended' уходящей деки — то
       есть потенциально дважды. Второй вызов обязан быть полным no-op: иначе
       он сбросил бы громкость треку, который в этот момент уже сам
       проигрывается (например, начался fade-in после ручного переключения). */
    if (!xfadeRef.current) return;
    cancelAnimationFrame(xfadeRafRef.current);
    xfadeRafRef.current = 0;
    xfadeRef.current = null;
    const o = outgoingRef.current;
    outgoingRef.current = null;
    if (o) {
      o.audio.pause();
      o.audio.src = '';
      o.audio.__sewTrackPath = null;
      o.audio.volume = 0;
      if (o.hls) { try { o.hls.destroy(); } catch {} }
    }
    trackSwitchingRef.current = false;
    if (audioRef.current && audioRef.current.volume !== volumeRef.current) {
      audioRef.current.volume = volumeRef.current;
    }
    discordPushRef.current?.(0);
  }

  /* После коммита входящий трек действительно текущий. Отмена не откатывает
     очередь: «вперёд» во время перехода должно брать следующий после него. */
  function abortCrossfade() {
    const prime = xfadePrimeRef.current;
    xfadePrimeRef.current = null;
    prime?.controller?.abort();
    if (prime && prime.audio.__sewPrime === prime) prime.audio.__sewPrime = null;
    cancelAnimationFrame(xfadeRafRef.current);
    xfadeRafRef.current = 0;
    xfadeRef.current = null;
    const o = outgoingRef.current;
    outgoingRef.current = null;
    if (o) {
      o.audio.pause();
      o.audio.src = '';
      o.audio.__sewTrackPath = null;
      o.audio.volume = 0;
      if (o.hls) { try { o.hls.destroy(); } catch {} }
    }
    /* Сбрасываем standby и его HLS, даже если был лишь фоновый префетч. */
    if (deckBHlsRef.current) { try { deckBHlsRef.current.destroy(); } catch {} }
    deckBHlsRef.current = null;
    if (deckBRef.current && deckBRef.current !== audioRef.current) {
      deckBRef.current.pause();
      try { deckBRef.current.src = ''; } catch {}
    }
    xfadePrimeRef.current = null;
    trackSwitchingRef.current = false;
    if (audioRef.current) audioRef.current.volume = volumeRef.current;
  }

  /* Расписание обеих дек использует актуальные refs и аудиопозицию.
     timeupdate дополняет интервал, в том числе в свёрнутом окне. */
  function xfadeTick() {
    if (partyClientRef.current?.active) return;
    const config = crossfadeSettings(settingsRef.current);
    if (config.seconds <= 0 || !isPlayingRef.current) return;
    const cur = audioRef.current;
    const curTrack = trackRef.current;
    if (!cur || !curTrack || cur.paused || cur.seeking || trackSwitchingRef.current) return;
    /* Перекрытие уже идёт — крутим rAF, ничего трогать нельзя */
    if (xfadeRef.current) {
      const xf = xfadeRef.current;
      const gains = xfadeGains(xf);
      xf.from.volume = gains.out * volumeRef.current;
      xf.to.volume = gains.in * volumeRef.current;
      if (xf.envelope.done || xf.from.ended) finishCrossfade();
      return;
    }
    /* repeat-one — это перезапуск того же трека, кроссфейдить нечего */
    if (repeatRef.current === 'one') {
      if (xfadePrimeRef.current) abortCrossfade();
      return;
    }
    /* hls-стрим иногда отдаёт duration = Infinity (плейлист ещё не разобран).
       Без подпорки окно не открылось бы никогда и кроссфейд молча
       не работал бы на части треков. */
    const dur = mediaDuration(cur, curTrack);
    if (!dur) return;
    const rate = Math.max(0.1, cur.playbackRate || 1);
    const remaining = (dur - cur.currentTime) / rate;
    let prime = xfadePrimeRef.current;
    if (prime && (prime.forId !== playbackKey(curTrack) || prime.intro !== config.intro)) {
      abortCrossfade();
      prime = null;
    }
    if (prime) {
      if (!primeStillValid(prime)) { abortCrossfade(); return; }
      if (prime.failed || prime.starting) return;
      const seconds = crossfadeDuration(config, dur, mediaDuration(prime.audio, prime.next.track), rate);
      if (remaining <= seconds && prime.ready) startCrossfade(prime.next, prime);
      return;
    }
    /* Сеть и декодер получают запас до начала перекрытия. */
    const primeAt = config.seconds + XFADE_PRIME_LEAD;
    if (remaining <= primeAt) {
      /* Догрузка бесконечной ленты: без неё очередь кончится и кроссфейд
         выключится на середине альбома. Условия те же, что в handleNext. */
      const list = scQueueList();
      if (scPlayingTrackRef.current && searchQueueRef.current) {
        const eng = shuffleStateRef.current;
        if (shuffleOnRef.current) {
          if (eng.left() <= 3) searchViewRef.current?.loadMore();
        } else if (list.findIndex(t => t.id === curTrack.id) + 1 >= list.length - 3) {
          searchViewRef.current?.loadMore();
        }
      }
      const next = peekNextPlayback();
      if (next && playbackKey(next.track) !== playbackKey(curTrack)) primeNextPlayback(curTrack, next)
        .catch(() => { if (xfadePrimeRef.current?.forId === playbackKey(curTrack)) xfadePrimeRef.current.failed = true; });
    }
  }

  xfadeTickRef.current = xfadeTick;
  useEffect(() => {
    if (!isPlaying || !settings.crossfade) return;
    const id = setInterval(() => xfadeTickRef.current?.(), 150);
    return () => clearInterval(id);
  }, [isPlaying, settings.crossfade]);

  useEffect(() => {
    if (crossfadeSettings(settings).seconds <= 0 && (xfadeRef.current || xfadePrimeRef.current)) abortCrossfade();
  }, [settings.crossfade]);

  /* Local observer only: no SoundCloud history request or listening telemetry. */
  const onHistoryListen = useCallback(entry => setSettings(s => ({
    ...s, listeningHistory: addListeningHistory(s.listeningHistory, entry),
  })), []);
  useListeningHistory({ track: hasTrack ? track : null, source: scPlayingTrack ? 'sc' : 'local', audioRef,
    playingRef: isPlayingRef, switchingRef: trackSwitchingRef, onListen: onHistoryListen });
  const listeningHistory = useMemo(() => cleanListeningHistory(settings.listeningHistory), [settings.listeningHistory]);
  const historyCovers = useHistoryCovers({ visible: view === 'history', entries: listeningHistory, auth: settings.soundcloudAuth });
  const [historyLoadingId, setHistoryLoadingId] = useState(null);
  const [historyErrorId, setHistoryErrorId] = useState(null);
  const historyRequestRef = useRef(0);

  const handleHistoryPlay = async entry => {
    if (!partyCanSelect(entry.source === 'local')) return;
    const request = ++historyRequestRef.current;
    setHistoryErrorId(null);
    if (historyTrackKey(track, scPlayingTrack ? 'sc' : 'local') === entry.key) {
      // Resuming a local selection also cancels a pending SC request.
      if (entry.source === 'local') {
        ++scReqRef.current;
        trackSwitchingRef.current = false;
        setLoadingTrackId(null);
      }
      setIsPlaying(true);
      setHistoryLoadingId(null);
      return;
    }
    if (entry.source === 'local') {
      const idx = tracks.findIndex(local => local.path?.toLowerCase() === entry.track.path.toLowerCase());
      if (idx < 0) { setHistoryLoadingId(null); showToast(t('history_unavailable')); return; }
      ++scReqRef.current;
      if (xfadeRef.current || xfadePrimeRef.current) abortCrossfade();
      trackSwitchingRef.current = false;
      setLoadingTrackId(null);
      setHistoryLoadingId(null);
      stationQueueRef.current = playlistQueueRef.current = searchQueueRef.current = null;
      setStationActive(null);
      setPlaylistActive(null);
      setSettings(s => ({ ...s, sourceMode: 'local' }));
      setScPlayingTrack(null);
      setTrackIdx(idx);
      progressRef.current = 0;
      setIsPlaying(true);
      return;
    }
    const auth = scAuthRef.current;
    if (!auth) { setHistoryLoadingId(null); showToast(t('history_login')); return; }
    setHistoryLoadingId(entry.id);
    const scRequest = scReqRef.current;
    const previousTrack = trackRef.current;
    const stale = () => request !== historyRequestRef.current || scRequest !== scReqRef.current
      || auth.token !== scAuthRef.current?.token || auth.userId !== scAuthRef.current?.userId
      || previousTrack !== trackRef.current;
    try {
      let fresh = scCacheMapRef.current.get(Number(entry.track.id));
      if (!fresh?.streamUrl && !fresh?.hlsUrl) {
        const result = await window.electronAPI.scFetch(`https://api-v2.soundcloud.com/tracks/${entry.track.id}`, auth.token, auth.clientId);
        if (stale()) return;
        if (result?.error || String(result?.data?.id) !== String(entry.track.id)) throw new Error('unavailable');
        fresh = mapScTrack(result.data, t('track_untitled'));
      }
      if (stale()) return;
      if (!fresh.streamUrl && !fresh.hlsUrl) throw new Error('unavailable');
      // Replay in the normal library context, never in an unrelated old station.
      stationQueueRef.current = playlistQueueRef.current = null;
      setStationActive(null);
      setPlaylistActive(null);
      searchQueueRef.current = [fresh, ...scTracksRef.current.filter(item => item.id !== fresh.id)];
      setSettings(s => ({ ...s, sourceMode: 'sc' }));
      await handleScTrackClick(fresh, scTracksRef.current.findIndex(item => item.id === fresh.id));
    } catch {
      if (!stale()) { setHistoryErrorId(entry.id); showToast(t('history_play_error')); }
    } finally {
      if (request === historyRequestRef.current) setHistoryLoadingId(null);
    }
  };

  async function handleScTrackClick(scTrack, idx, autoSkip = false, skipCount = 0, direction = 1) {
    if (!partyCanSelect(false)) return;
    if (partyClientRef.current?.active) { await partyClientRef.current.selectTrack(scTrack); return; }
    /* Токен запроса. handleScTrackClick делает await'ы (streamUrl, потом HLS),
       и без guard'а два быстрых клика давали гонку: первый запрос резолвился
       вторым и перебивал setScPlayingTrack — включался не тот трек, на который
       кликнули. Сейчас устаревший запрос просто выходит. */
    const req = ++scReqRef.current;
    const stale = () => req !== scReqRef.current;
    /* Явное переключение отменяет идущее перекрытие и сбрасывает префетч:
       он сделан для ДРУГОГО следующего трека. Откатывать позицию очереди
       не нужно — ниже для ручного клика она и так пересобирается по shuffle. */
    if (xfadeRef.current || xfadePrimeRef.current) abortCrossfade();
    trackSwitchingRef.current = true;
    setScPlayingIdx(idx);
    progressRef.current = 0;
    /* Здесь стояло setIsPlaying(false) — и это была причина, по которой
       кнопка play дёргалась на каждом переключении трека. У sc-трека между
       началом переключения и setIsPlaying(true) проходит около секунды
       (резолв streamUrl через api), и всё это время иконка показывала
       «паузу», хотя музыка не прерывалась. Переключение не должно менять
       состояние воспроизведения: если играли — играем дальше, если стояли
       — стоим. Сброс переехал в точки, где переключение реально
       заканчивается ничем (нет авторизации, поток не резолвился, ошибка). */
    setLoadingTrackId(scTrack.id);
    destroyHls();

    const auth = scAuthRef.current;
    if (!auth) { trackSwitchingRef.current = false; setLoadingTrackId(null); setIsPlaying(false); return; }

    if (!autoSkip && shuffle) {
      /* Клик по треку в перемешанном режиме: он встаёт первым, остальное
         перемешивается заново. Пул синхронизируем с реальной очередью, а не с
         тем списком, который пришёл кнопкой — иначе порядок остался бы от
         чужого списка. */
      const eng = shuffleStateRef.current;
      eng.sync(scQueueList());
      eng.rebuild(scTrack.id);
    }

    const markError = () => {
      clearTimeout(errorTimerRef.current);
      setErrorTrackId(scTrack.id);
      errorTimerRef.current = setTimeout(() => setErrorTrackId(null), 2200);
    };

    const skipInDirection = () => {
      const list = scQueueList();
      if (shuffle) {
        /* Обход битых треков: идём по порядку в заданную сторону и не даём
           себе закрутиться — skipCount ограничивает количество шагов размером
           порядка. */
        const eng = shuffleStateRef.current;
        eng.sync(list);
        if (skipCount < eng.order.length) {
          const step = eng.peek(direction);
          if (step) {
            eng.commit(step);
            const nextTrack = eng.track(step.id);
            if (nextTrack) { handleScTrackClick(nextTrack, scTracksRef.current.indexOf(nextTrack), true, skipCount + 1, direction); return; }
          }
          /* Шаг упёрся в конец порядка. Заворачиваем только вперёд и только
             при repeat-all: в этом случае движок сам вернёт новый порядок. */
          if (direction > 0 && repeat === 'all') {
            const nextStep = eng.peek(1);
            if (nextStep) {
              eng.commit(nextStep);
              const nextTrack = eng.track(nextStep.id);
              if (nextTrack) handleScTrackClick(nextTrack, scTracksRef.current.indexOf(nextTrack), true, skipCount + 1, direction);
              else setIsPlaying(false);
              return;
            }
          }
        }
        setIsPlaying(false);
        return;
      }
      const curIdx = list.findIndex(t => t.id === scTrack.id);
      const ni = curIdx + direction;
      if (skipCount < list.length && ni >= 0 && ni < list.length) {
        handleScTrackClick(list[ni], scTracksRef.current.indexOf(list[ni]), true, skipCount + 1, direction);
      } else if (repeat === 'all' && direction > 0 && skipCount < list.length) {
        handleScTrackClick(list[0], scTracksRef.current.indexOf(list[0]), true, skipCount + 1, direction);
      } else {
        setIsPlaying(false);
      }
    };

    if (!scTrack.streamUrl && !scTrack.hlsUrl) {
      trackSwitchingRef.current = false;
      setLoadingTrackId(null);
      setIsPlaying(false);
      markError();
      if (autoSkip) { skipInDirection(); }
      return;
    }

    /* Резолв CDN-ссылки вынесен в resolveScUrl: префетч кроссфейда обязан
       идти ровно тем же кодом, иначе один из путей однажды начнёт брать
       другую ветку (progressive/hls) и кроссфейд будет стыковать не то. */
    const r = await resolveScUrl(scTrack);
    /* успел протухнуть, пока грузили: не снимаем индикатор загрузки и не
       трогаем markError — этим занимается тот запрос, который актуален */
    if (stale()) return;

    const resolvedUrl = r?.url || null;
    const isHls = !!r?.isHls;

    if (!resolvedUrl) {
      trackSwitchingRef.current = false;
      setLoadingTrackId(null);
      setIsPlaying(false);
      markError();
      if (autoSkip) { skipInDirection(); }
      return;
    }

    const resolved = { ...scTrack, resolvedUrl };
    scPlayingTrackRef.current = resolved;
    trackRef.current = resolved;
    setScPlayingTrack(resolved);

    const audio = audioRef.current;
    if (!audio) { setLoadingTrackId(null); return; }
    /* дальше в этом элементе живёт чужой поток — тег «какой src уже стоит»
       обязан сброситься, иначе после правки файла локальный трек, выбранный
       следом, не перезагрузится в элемент */
    HOT_STORE.trackSrc = null;
    audio.__sewTrackPath = null;

    restorePlaybackVolume(audio);
    audio.addEventListener('playing', () => {
      if (stale() || audioRef.current !== audio || scPlayingTrackRef.current?.id !== scTrack.id) return;
      trackSwitchingRef.current = false;
      restorePlaybackVolume(audio);
    }, { once: true });

    if (isHls) {
      const Hls = await loadHls();
      /* после await: за это время могли кликнуть другой трек (req сменился)
         или уйти из плеера. Тогда смонтированный hls повис бы на живом
         элементе и тянул буфер чужого трека. */
      if (stale()) { setLoadingTrackId(null); return; }
      if (!Hls.isSupported()) {
        audio.src = resolvedUrl;
        audio.load();
        audio.play().then(() => setLoadingTrackId(null)).catch(() => { setLoadingTrackId(null); setIsPlaying(false); });
        setIsPlaying(true);
        return;
      }
      const hls = new Hls();
      hlsRef.current = hls;
      hls.loadSource(resolvedUrl);
      hls.attachMedia(audio);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (stale() || audioRef.current !== audio) return;
        audio.play().then(() => setLoadingTrackId(null)).catch(() => { setLoadingTrackId(null); setIsPlaying(false); });
        setIsPlaying(true);
      });
      hls.on(Hls.Events.LEVEL_LOADED, (_, data) => {
        if (stale() || audioRef.current !== audio || scPlayingTrackRef.current?.id !== scTrack.id) return;
        const dur = Math.floor(data.details.totalduration || 0);
        if (dur) setScPlayingTrack(prev => prev ? { ...prev, duration: dur } : prev);
      });
    } else {
      audio.src = resolvedUrl;
      audio.load();
      audio.addEventListener('loadedmetadata', () => {
        if (stale() || audioRef.current !== audio || scPlayingTrackRef.current?.id !== scTrack.id) return;
        const dur = Math.floor(audio.duration);
        if (Number.isFinite(dur) && dur > 0) setScPlayingTrack(prev => prev ? { ...prev, duration: dur } : prev);
      }, { once: true });
      audio.play().then(() => setLoadingTrackId(null)).catch(() => { setLoadingTrackId(null); setIsPlaying(false); });
      setIsPlaying(true);
    }
  }

  function partyCanControl() {
    const client = partyClientRef.current;
    if (client?.request) return false;
    return !client?.active || (client.role === 'host' && client.status === 'connected');
  }
  function partyCanSelect(local) {
    const client = partyClientRef.current;
    if (client?.request) return false;
    if (!client?.active) return true;
    const labels = partyLabels(langRef.current);
    if (!partyCanControl()) { showToast(labels.error_host_only); return false; }
    if (local) { showToast(labels.error_soundcloud_only); return false; }
    return true;
  }
  function togglePlayback() {
    if (partyCanControl() && (scPlayingTrackRef.current || trackRef.current?.path)) setIsPlaying(p => !p);
  }
  function pausePartyPlayback() {
    isPlayingRef.current = false;
    audioRef.current?.pause();
    setIsPlaying(false);
  }
  function seekPartyPlayback(position) {
    const audio = audioRef.current;
    if (!audio) return;
    const duration = mediaDuration(audio, trackRef.current);
    audio.currentTime = Math.min(duration, Math.max(0, position));
    progressRef.current = duration ? audio.currentTime / duration : 0;
    discordProgressRef.current = progressRef.current;
    setMiniProgress(progressRef.current);
    discordPushRef.current?.(0);
  }
  async function playPartyPlayback({ signal } = {}) {
    const audio = audioRef.current;
    if (!audio) throw new Error('track_unavailable');
    const request = scReqRef.current, source = audio.src;
    if (signal?.aborted) throw new Error('cancelled');
    restorePlaybackVolume(audio);
    await audio.play();
    if (audioRef.current !== audio || source !== audio.src) return;
    if (signal?.aborted || request !== scReqRef.current || !partyClientRef.current?.active
      || partyClientRef.current.status !== 'connected') { pausePartyPlayback(); return; }
    if (audioRef.current === audio && partyClientRef.current?.active) {
      isPlayingRef.current = !audio.paused;
      setIsPlaying(!audio.paused);
    }
  }
  async function loadPartySoundCloudTrack(shared, { signal, position }) {
    const auth = scAuthRef.current;
    if (!auth) throw new Error('login_required');
    const req = ++scReqRef.current;
    const stale = () => signal.aborted || req !== scReqRef.current || !partyClientRef.current?.active
      || auth.token !== scAuthRef.current?.token || auth.userId !== scAuthRef.current?.userId;
    if (xfadeRef.current || xfadePrimeRef.current) abortCrossfade();
    pausePartyPlayback();
    destroyHls();
    trackSwitchingRef.current = true;
    setLoadingTrackId(Number(shared.id));
    const localTrack = [scPlayingTrackRef.current, ...scTracksRef.current].find(track => String(track?.id) === shared.id);
    const localCover = localTrack?.coverUrl;
    const pendingTrack = withScArtwork({ ...shared, id: Number(shared.id) }, localCover || shared.coverUrl);
    scPlayingTrackRef.current = trackRef.current = pendingTrack;
    setScPlayingTrack(pendingTrack);
    const deck = audioRef.current;
    if (deck) { deck.src = ''; deck.load(); }
    HOT_STORE.trackSrc = null;
    progressRef.current = discordProgressRef.current = 0;
    setMiniProgress(0);
    const aborted = () => {
      if (req !== scReqRef.current) return;
      ++scReqRef.current;
      pausePartyPlayback(); destroyHls();
      trackSwitchingRef.current = false;
      setLoadingTrackId(null);
    };
    signal.addEventListener('abort', aborted, { once: true });
    try {
      // A saved transcoding may have expired or belong to an earlier login.
      // Resolve fresh metadata with this listener's access, never the host's URL.
      const result = await window.electronAPI.scFetch(`https://api-v2.soundcloud.com/tracks/${shared.id}`, auth.token, auth.clientId);
      if (stale()) throw new Error('cancelled');
      if (result?.error || String(result?.data?.id) !== shared.id) throw new Error('track_unavailable');
      const fresh = mapScTrack(result.data, t('track_untitled'));
      const stream = await resolveScUrl(fresh);
      if (stale()) throw new Error('cancelled');
      if (!stream) throw new Error('track_unavailable');
      const audio = audioRef.current;
      if (!audio) throw new Error('track_unavailable');
      const artwork = withScArtwork({ ...fresh, coverUrl: shared.coverUrl || fresh.coverUrl }, localCover || fresh.coverUrl || shared.coverUrl);
      const resolved = { ...fresh, ...shared, id: Number(shared.id), resolvedUrl: stream.url,
        coverUrl: artwork.coverUrl, remoteCoverUrl: artwork.remoteCoverUrl };
      scPlayingTrackRef.current = trackRef.current = resolved;
      setScPlayingTrack(resolved);
      // Artwork runs separately: slow CDN/cache IO must never delay room audio.
      resolvePartyArtwork(resolved, { api: window.electronAPI, cancelled: stale }).then(coverUrl => {
        const current = scPlayingTrackRef.current;
        if (!coverUrl || stale() || String(current?.id) !== shared.id || current.coverUrl === coverUrl) return;
        const updated = { ...current, coverUrl };
        scPlayingTrackRef.current = trackRef.current = updated;
        setScPlayingTrack(updated);
      }).catch(() => {});
      setScPlayingIdx(scTracksRef.current.findIndex(item => String(item.id) === shared.id));
      HOT_STORE.trackSrc = null;
      audio.__sewTrackPath = null;
      audio.src = '';
      audio.load();
      if (stream.isHls) {
        const Hls = await loadHls();
        if (stale()) throw new Error('cancelled');
        if (Hls.isSupported()) {
          const hls = new Hls({ startPosition: position() });
          hlsRef.current = hls;
          hls.on(Hls.Events.ERROR, (_, data) => {
            if (data.fatal && !stale() && hlsRef.current === hls) partyClientRef.current?.failPlayback('track_unavailable');
          });
          hls.loadSource(stream.url);
          hls.attachMedia(audio);
        } else { audio.src = stream.url; audio.load(); }
      } else { audio.src = stream.url; audio.load(); }
      await waitForPartyAudio(audio, { signal, position, duration: shared.duration });
      if (stale()) throw new Error('cancelled');
      trackSwitchingRef.current = false;
      restorePlaybackVolume(audio);
      setLoadingTrackId(null);
    } catch (error) {
      if (req === scReqRef.current) {
        trackSwitchingRef.current = false;
        setLoadingTrackId(null);
        destroyHls();
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', aborted);
    }
  }
  partyCallbacksRef.current = { load: loadPartySoundCloudTrack, pause: pausePartyPlayback, play: playPartyPlayback, seek: seekPartyPlayback,
    empty: () => {
      ++scReqRef.current;
      pausePartyPlayback(); destroyHls();
      scPlayingTrackRef.current = null; trackRef.current = BLANK_TRACK;
      setScPlayingTrack(null); setTrackIdx(-1);
      if (audioRef.current) { audioRef.current.src = ''; audioRef.current.load(); }
      progressRef.current = discordProgressRef.current = 0;
      trackSwitchingRef.current = false;
      setMiniProgress(0); setLoadingTrackId(null);
    },
  };
  useEffect(() => {
    const client = new PartyClient({ onState: partyDispatch,
      getPlayer: () => ({ track: scPlayingTrackRef.current, audio: audioRef.current, switching: trackSwitchingRef.current }),
      loadTrack: (...args) => partyCallbacksRef.current.load(...args),
      pause: () => partyCallbacksRef.current.pause(), play: (...args) => partyCallbacksRef.current.play(...args),
      seek: position => partyCallbacksRef.current.seek(position),
      empty: () => partyCallbacksRef.current.empty(),
      onActive: role => {
        ++scReqRef.current;
        ++historyRequestRef.current;
        abortCrossfade();
        afxTransport({ speed: 1, pitch: 0, preserve: settingsRef.current.shiftPitch === false });
        if (role === 'guest') { pausePartyPlayback(); destroyHls(); trackSwitchingRef.current = true; }
      },
    });
    partyClientRef.current = client;
    const leave = () => client.leave();
    window.addEventListener('beforeunload', leave);
    return () => {
      window.removeEventListener('beforeunload', leave);
      client.dispose();
      if (partyClientRef.current === client) partyClientRef.current = null;
    };
  }, []);
  useEffect(() => {
    if (!settings.soundcloudAuth && partyClientRef.current?.active) partyClientRef.current.leave();
  }, [settings.soundcloudAuth]);
  const startParty = kind => {
    if (!scAuthRef.current) { partyDispatch({ type: 'failed', error: 'login_required' }); return; }
    if (kind === 'create' && trackRef.current?.path) { partyDispatch({ type: 'failed', error: 'soundcloud_only' }); return; }
    if (kind === 'create' && trackSwitchingRef.current) { partyDispatch({ type: 'failed', error: 'track_loading' }); return; }
    if (kind === 'create' && scPlayingTrackRef.current && !sharedPartyTrack(scPlayingTrackRef.current)) {
      partyDispatch({ type: 'failed', error: 'track_unavailable' }); return;
    }
    partyClientRef.current?.start(kind, { code: partyState.draft, user: scAuthRef.current, track: scPlayingTrackRef.current });
  };

  async function selectTrack(t) {
    if (!partyCanSelect(!!t.path)) return;
    const startPlayLocal = (idx) => {
      setScPlayingTrack(null);
      setTrackIdx(idx);
      progressRef.current = 0;
      setIsPlaying(true);
    };
    const startPlay = () => {
      if (sourceMode === 'sc') {
        /* Клик по карточке сетки — такой же библиотечный контекст, как клик в
           списке слева, и очередь поиска должна сброситься. В onClickItem
           библиотеки это есть, здесь забыли: после поиска в SearchView очередь
           оставалась живой, и next/prev/skip шли по ней — играл трек из
           старого поиска, а не тот, что в списке */
        searchQueueRef.current = null;
        const scIdx = scTracks.indexOf(t);
        if (scIdx >= 0) handleScTrackClick(t, scIdx);
      } else {
        const li = tracks.indexOf(t);
        if (li >= 0) startPlayLocal(li);
      }
    };

    if (view === 'player') {
      startPlay();
      return;
    }

    /* Ищем обложку карточки (findArtEl — см. ref): кеш берём только если узел
       живой, иначе ищем прямо в DOM по data-атрибуту. Отсоединённый узел в
       кеше даёт нулевой rect, и hero стартует из (0,0) с scale(0) — картинка
       телепортировалась без анимации, а обложка плеера ещё 300мс пустая. */
    const findArt = () => findArtEl(t.id);

    // scroll target card into view if needed (mirrors handleNav home→player)
    const initialEl = findArt();
    const scrollEl = homeScrollRef.current;
    if (initialEl && scrollEl) {
      const box = scrollEl.getBoundingClientRect();
      const cr  = initialEl.getBoundingClientRect();
      if (cr.top < box.top || cr.bottom > box.bottom) {
        const offset = cr.top - box.top + scrollEl.scrollTop;
        scrollEl.scrollTop = Math.max(0, offset - box.height / 2 + cr.height / 2);
        await new Promise(r => requestAnimationFrame(r));
      }
    }

    const artEl = findArt();
    const par = playerArtRef.current?.getBoundingClientRect();

    /* Клик по карточке того трека, что УЖЕ играет: НЕ перезапускать.
       раньше здесь звался `startPlay()` безусловно, и для локального трека
       это `progressRef.current = 0; setIsPlaying(true)` — то есть клик по
       СЕБЕ перематывал трек в начало. для sc — полный резолв стрима и
       перезагрузка `audio.src`. теперь только hero + переход, воспроизведение
       не трогаем вообще (даже scPlayingTrack не сбрасываем).
       `activeListPlayingId` — id играющего трека ВНУТРИ активного списка:
       для sc это scPlayingTrack?.id, для local — track?.id при null
       scPlayingTrack. если играет трек из ДРУГОГО источника (например в
       режиме local выбран sc-трек), сигнал null и клик честно переключает. */
    const isCurrent = t.id === activeListPlayingId;
    if (!isCurrent) startPlay();

    if (artEl && par) {
      const startRect = artEl.getBoundingClientRect();
      const targetRect = { left: par.left, top: par.top, size: par.width };
      setHero({ track: t, startRect, targetRect, corners: cssCorners(artEl) });
      setHomeVisible(false);
      setPlayerVisible(true);
      setView('player');
      setNavActive('library');
      setLibScrollTargetId(t.id);
      setLibScrollTrigger(v => v + 1);
    } else {
      // refs not ready — skip hero, just switch view
      setHomeVisible(false);
      setPlayerVisible(true);
      setView('player');
      setNavActive('library');
      setLibScrollTargetId(t.id);
      setLibScrollTrigger(v => v + 1);
    }
  }

  const selectTrackRef = useRef(null);
  selectTrackRef.current = selectTrack;
  const selectTrackStable = useCallback((t) => selectTrackRef.current(t), []);

  /* Открыть трек из ВЫДАЧИ ПОИСКА в плеере — с тем же перелётом обложки,
     что и на главной.
     ⚠️ Раньше здесь был голый `setView('player')` без hero: из поиска трек
     просто появлялся в плеере, и переход читался как мгновенный прыжок
     между двумя вкладками. Теперь клон обложки отрывается от найденной
     карточки и садится на место обложки плеера — как при клике по карточке
     на главной.

     Обложку ищем через `searchViewRef.findArt`, а не общим findArtEl: те же
     data-sewer-art стоят на карточках главной и на строках экрана артиста,
     и общий поиск отдал бы элемент из невидимой вкладки — клон улетел бы
     из пустоты. Если обложки нет (трек ещё не отрисовался, список
     перерисовывается), переход всё равно происходит, просто без анимации. */
  const openSearchTrack = (t) => {
    if (!partyCanSelect(false)) return;
    handleScTrackClick(t, -1);
    const artEl = searchViewRef.current?.findArt?.(t.id);
    const par   = playerArtRef.current?.getBoundingClientRect();
    /* строка может быть за нижним краем списка — подкручиваем к ней, иначе
       клон стартует из-под нижней кромки и перелёт выглядит обрезанным.
       'nearest' двигает ровно настолько, чтобы элемент стал виден */
    if (artEl) artEl.scrollIntoView({ block: 'nearest' });
    if (artEl && par) {
      const startRect = artEl.getBoundingClientRect();
      setHero({
        track: t,
        startRect,
        targetRect: { left: par.left, top: par.top, size: par.width },
        corners: cssCorners(artEl),
      });
    }
    setHomeVisible(false);
    setPlayerVisible(true);
    setView('player');
    setNavActive('library');
  };

  /* клик по строке библиотеки. ⚠️ раньше это был инлайновый стрелочный
     проп прямо в JSX, то есть НОВАЯ функция на каждом рендере App.
     `TrackRow` обёрнут в React.memo, а `onContextMenu` в него приходит
     напрямую (`onContextMenuItem`), так что identity ломался у обеих
     пропсов — и любое состояние App (ввод в поиск, lyricsActive, volume,
     toast, searchFocused) перерендеривало ВСЕ ~35 видимых строк целиком.
     обёртка через ref держит identity постоянной и не требует перечислять
     deps (тело читает stationActive/playlistActive/tracks/trackIdx) */
  const libClickRef = useRef(null);
  libClickRef.current = t => {
    if (!partyCanSelect(!!t.path)) return;
    if (stationActive) { handleScTrackClick(t, -1); return; }
    if (playlistActive) {
      searchQueueRef.current = null;
      handleScTrackClick(t, -1);
      return;
    }
    if (sourceMode === 'sc') {
      searchQueueRef.current = null;
      handleScTrackClick(t, scTracksRef.current.indexOf(t));
      return;
    }
    const idx = tracks.indexOf(t);
    if (idx < 0) return;
    if (xfadeRef.current || xfadePrimeRef.current) abortCrossfade();
    setScPlayingTrack(null);
    if (idx === trackIdx) {
      /* Клик по уже загруженному треку. Раньше здесь был
         `setIsPlaying(true); return` — и это был ПОЛНЫЙ no-op, если
         трек уже играет: клик по первой строке (trackIdx = 0 из
         коробки, до первого запуска) не давал вообще ничего — ни
         звука, ни перемотки, ни смены кадра. Плюс progressRef
         обнулялся без audio.currentTime, и шкала прыгала в ноль
         поверх продолжавшей играть дорожки. Теперь это честный
         «переиграть с начала», как в любом плеере. */
      const audio = audioRef.current;
      if (audio && audio.src) {
        if (audio.currentTime > 0.05) audio.currentTime = 0;
        progressRef.current = 0;
        /* перезапуск того же трека с нуля: dep'ы эффекта присутствия не
           меняются (id/duration/isPlaying те же), поэтому обновление надо
           отправить вручную — иначе полоса в дискорде останется на старой
           позиции. Подробности в ветке repeat === 'one' */
        discordProgressRef.current = 0;
        pushDiscord(0);
        restorePlaybackVolume(audio);
        audio.play().catch(() => setIsPlaying(false));
      }
      setIsPlaying(true);
      return;
    }
    setTrackIdx(idx);
    progressRef.current = 0;
    setIsPlaying(true);
  };
  const libClickStable = useCallback(t => libClickRef.current(t), []);
  const libCtxStable   = useCallback((tr, x, y) => setTrackMenu({ track: tr, x, y }), []);

  const likedIds = useMemo(() => new Set(scTracks.map(t => t.id)), [scTracks]);

  const handleLike = useCallback(async (track) => {
    const auth = scAuthRef.current;
    if (!auth) return;
    const already = scTracksRef.current.some(t => t.id === track.id);
    /* оптимистично: сердце заливается сразу, при ошибке API откатываем */
    const apply = (liked) => {
      if (liked) {
        setScTracks(prev => [track, ...prev]);
        scCacheRef.current = [track, ...scCacheRef.current];
        scCacheMapRef.current.set(track.id, track);
      } else {
        setScTracks(prev => prev.filter(t => t.id !== track.id));
        scCacheRef.current = scCacheRef.current.filter(t => t.id !== track.id);
        scCacheMapRef.current.delete(track.id);
      }
      window.electronAPI.scSaveLikesCache(scCacheRef.current);
    };
    apply(!already);
    const res = await window.electronAPI.scFetch(
      `https://api-v2.soundcloud.com/users/${auth.userId}/track_likes/${track.id}`,
      auth.token, auth.clientId, already ? 'DELETE' : 'PUT'
    );
    if (res.error) {
      apply(already);
      showToast((res.error === 403 || res.error === 429) ? t('sc_blocked')
        : already ? t('unlike_err') : t('like_err'));
    }
  }, []);

  const handleFollow = useCallback(async (userId, currentlyFollowing) => {
    const auth = scAuthRef.current;
    if (!auth || !userId) return false;
    const url = `https://api-v2.soundcloud.com/me/followings/${userId}`;
    const method = currentlyFollowing ? 'DELETE' : 'POST';
    const res = await window.electronAPI.scFetch(url, auth.token, auth.clientId, method);
    if (res.error) {
      showToast((res.error === 403 || res.error === 429) ? t('sc_blocked')
        : currentlyFollowing ? t('unfollow_err') : t('follow_err'));
      return null;
    }
    if (currentlyFollowing) followedIdsRef.current.delete(userId);
    else followedIdsRef.current.add(userId);
    return !currentlyFollowing;
  }, [t]);

  const handleStartStation = useCallback(async (track) => {
    const auth = scAuthRef.current;
    if (!auth || !track?.id) { showToast(t('station_err')); return; }
    /* станцию можно запустить на треке, который прямо сейчас играет. тогда
       он НЕ должен начинаться заново: плеер продолжает с той же секунды,
       меняется только очередь — под ней станция. */
    const cur = scPlayingTrackRef.current;
    const keepCurrent = !!cur && cur.id === track.id;
    try {
      const res = await window.electronAPI.scFetch(
        `https://api-v2.soundcloud.com/stations/soundcloud:track-stations:${track.id}/tracks?limit=50`,
        auth.token, auth.clientId
      );
      const items = res?.data?.collection || [];
      if (items.length === 0) { showToast(t('station_err')); return; }
      const mapped = items.map(it => mapScTrack(it, STRINGS[langRef.current]?.no_title ?? 'Без названия'));
      /* играющий трек обязан быть в очереди станции: следующий берётся по
         его позиции в списке. api обычно отдаёт сид первым, но не обещает —
         если его нет, ставим сами в начало */
      const queue = keepCurrent && !mapped.some(x => x.id === track.id)
        ? [cur, ...mapped]
        : mapped;
      stationQueueRef.current = queue;
      playlistQueueRef.current = null;
      searchQueueRef.current = null;
      setPlaylistActive(null);
      setStationActive({ origTrack: track, tracks: queue });
      setHomeVisible(false);
      setPlayerVisible(true);
      setView('player');
      setNavActive('library');
      /* трек уже звучит — не трогаем элемент. иначе играл бы с нуля */
      if (!keepCurrent) handleScTrackClick(mapped[0], -1);
    } catch {
      showToast(t('station_err'));
    }
  }, [t]);

  const handleExitStation = useCallback(() => {
    stationQueueRef.current = null;
    setStationActive(null);
  }, []);

  const handleCopyTrackLink = useCallback(async (track) => {
    if (!track?.permalinkUrl) { showToast(t('copy_link_err')); return; }
    const auth = scAuthRef.current;
    let link = track.permalinkUrl;
    if (auth) {
      try {
        const res = await window.electronAPI.scFetch(
          `https://api-v2.soundcloud.com/share/short-link?url=${encodeURIComponent(track.permalinkUrl)}`,
          auth.token, auth.clientId
        );
        const short = res?.data?.short_url || res?.data?.shortUrl;
        if (short) link = short;
      } catch {}
    }
    try {
      await navigator.clipboard.writeText(link);
      showToast(t('link_copied'));
    } catch {
      showToast(t('copy_link_err'));
    }
  }, [t]);

  /* ─── скачивание ────────────────────────────────────────────────────────
     Папку выбираем нативным диалогом (обойти ФС из рендерера нельзя) и
     запоминаем: дальше диалог сохранения полностью свой. */
  const handleOpenDownload = useCallback((track) => {
    if (!track) return;
    setDlTrack(track);
  }, []);

  const handlePickDlDir = useCallback(async () => {
    const folder = await window.electronAPI.selectMusicFolder();
    if (folder) setSettings(s => ({ ...s, downloadsFolder: folder }));
    return folder || null;
  }, []);

  const handleDlSaved = useCallback((res) => {
    setDlTrack(null);
    const name = (res?.path || '').split(/[\\/]/).pop();
    /* файл сохранён всегда, но без тегов он неполноценен — говорим прямо,
       иначе «скачалось» выглядит как «приложение забыло обложку» */
    if (res && res.tagsOk === false) {
      showToast(`${t('dl_no_tags')}${name ? ' — ' + name : ''}`);
      return;
    }
    /* теги записались, а картинку взять неоткуда — тоже говорим, иначе
       «скачалось» выглядит как «приложение забыло обложку» */
    if (res && res.coverOk === false) {
      showToast(`${t('dl_no_cover')}${name ? ' — ' + name : ''}`);
      return;
    }
    /* hls-трек не перекодировался в mp3: ffmpeg не нашёлся или отказал.
       расширение в имени будет .m4a — лучше сказать вслух, чем молча */
    if (res && res.format === 'm4a') {
      showToast(`${t('dl_m4a')}${name ? ' — ' + name : ''}`);
      return;
    }
    showToast(name ? `${t('dl_ok')} — ${name}` : t('dl_ok'));
  }, [t]);

  const checkFollow = useCallback(async (userId) => {
    if (!userId) return false;
    if (followedIdsRef.current.has(userId)) return true;
    const auth = scAuthRef.current;
    if (!auth) return false;
    const res = await window.electronAPI.scFetch(
      `https://api-v2.soundcloud.com/me/followings/${userId}`,
      auth.token, auth.clientId
    );
    const following = !res.error && res.data;
    if (following) followedIdsRef.current.add(userId);
    return !!following;
  }, []);

  const sortedTracks = useMemo(() => {
    const arr = [...tracks];
    if (sort === 'artist')   arr.sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
    else if (sort === 'title')    arr.sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === 'duration') arr.sort((a, b) => (b.duration || 0) - (a.duration || 0));
    return arr;
  }, [tracks, sort]);

  /* Поиск: ввод не должен ждать фильтра. `search` — то, что в поле
     (обновляется сразу, буква появляется без задержки), `deferredSearch` —
     то, по чему строится список и сетка. React отрисует фильтр с низким
     приоритетом, и набор не залипает на сотнях карточек библиотеки. */
  const deferredSearch = useDeferredValue(search);
  const searchLower = useMemo(() => deferredSearch.toLowerCase(), [deferredSearch]);
  const filtered = useMemo(() =>
    sortedTracks.filter(t =>
      t.title.toLowerCase().includes(searchLower) ||
      t.artist.toLowerCase().includes(searchLower)
    ),
  [sortedTracks, searchLower]);
  filteredRef.current = filtered;
  const filteredSc = useMemo(() =>
    scTracks.filter(t =>
      t.title.toLowerCase().includes(searchLower) ||
      t.artist.toLowerCase().includes(searchLower)
    ),
  [scTracks, searchLower]);
  filteredScRef.current = filteredSc;
  const activeList = sourceMode === 'sc' ? filteredSc : filtered;
  const activeListPlayingId = sourceMode === 'sc'
    ? (scPlayingTrack ? scPlayingTrack.id : null)
    : (scPlayingTrack ? null : track?.id);

  /* ── «сейчас играет» над библиотекой ──────────────────────────────────────
     Трек мог прийти не из этого списка: включил из поиска, из волны (и волну
     закрыл), с экрана артиста. В лайках его нет — строка исчезала из
     библиотеки вместе с меню ПКМ, и доиграть/перемотать его из списка было
     нельзя. Такой трек пришпиливается первым, за чертой.
     Не дублируем: если он и так есть в ПОЛНОМ списке (даже когда список
     отфильтрован поиском), пришпиливать нечего.
     Станция и плейлист — исключение: их список и есть источник, трек в нём.
     Тип трека обязан совпадать с режимом: строка кликается, а клик умеет
     играть либо sc-трек, либо локальный файл — не то и другое сразу. */
  const pinnedTrack = useMemo(() => {
    if (stationActive || playlistActive) return null;
    const playing = sourceMode === 'sc'
      ? scPlayingTrack
      : (scPlayingTrack ? null : (trackIdx >= 0 ? tracks[trackIdx] : null));
    if (!playing) return null;
    const full = sourceMode === 'sc' ? scTracks : tracks;
    return full.some(x => x.id === playing.id) ? null : playing;
  }, [stationActive, playlistActive, sourceMode, scPlayingTrack, trackIdx, tracks, scTracks]);

  /* сумма длительностей плейлиста для чипа в плеере. считается в useMemo
     по playlistActive, а не на каждом рендере App: у треков duration
     обычно есть сразу (mapScTrack делит мс на 1000), но у догруженных
     заглушек он проставляется позже, и список меняет ссылку — так что
     зависимость одна и та же */
  const plTotalDur = useMemo(() => playlistActive
    ? playlistActive.tracks.reduce((a, tr) => a + (Number(tr.duration) || 0), 0)
    : 0, [playlistActive]);

  const showWelcome = !settings.musicFolder && !settings.soundcloudAuth;

  const handleToggleLyrics = () => {
    const next = !lyricsOpen;
    setLyricsOpen(next);
    /* обе панели живут в одной колонке: вторая открытая накрыла бы первую */
    if (next) { setLibCollapsed(false); setFxOpen(false); }
  };

  /* эффекты: та же колонка, тот же разворот свёрнутой библиотеки */
  const handleToggleFx = () => {
    const next = !fxOpen;
    setFxOpen(next);
    if (next) { setLibCollapsed(false); setLyricsOpen(false); }
  };

  /* панель уезжает вместе с плеером, а не остаётся висеть на чужом экране */
  useEffect(() => {
    if (!playerVisible) { setLyricsOpen(false); setFxOpen(false); }
  }, [playerVisible]);

  /* Escape закрывает и эффекты — та же причина, что у текста: панель накрывает
     колонку целиком, и «как отсюда выйти» не должно быть загадкой */
  useEffect(() => {
    if (!fxOpen) return;
    const onKey = e => { if (e.key === 'Escape') setFxOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fxOpen]);

  /* Панель текста занимает ВСЮ колонку библиотеки (position:absolute inset:0
     поверх слоя списка) и глушит его pointerEvents — то есть выглядит как
     «вся левая колонка не работает». Выход был один: кнопка «список» 12px в
     углу панели (и та же кнопка textt в ряду управления). Escape — выход,
     о котором не надо вспоминать. Тот же приём, что у TrackContextMenu */
  useEffect(() => {
    if (!lyricsOpen) return;
    const onKey = e => { if (e.key === 'Escape') setLyricsOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lyricsOpen]);

  /* Что ищем в источниках для текущего трека: ручная пара из карандаша, если
     она закреплена за треком, иначе метаданные файла. `lyricsPinned` заодно
     решает, показывать ли в форме «сбросить». */
  const lyricsPinned = settings.lyricsQueries?.[lyricsTrackKey(track)];
  const lyricsQuery  = lyricsQueryFor(track, lyricsPinned);

  /* тянем текст только пока панель открыта — незачем грузить то, чего не видно.
     lyricsReqRef защищает от гонки: сменился трек/порядок, старый ответ
     пришёл последним и затёр бы новый

     ⚠️ `track.title` в deps — ОБЯЗАТЕЛЬНО, не лишняя зависимость.
     `fetchLyrics` ищет по `track.title`, а не по имени файла и не по id.
     переименование меняет ТОЛЬКО title: id локального трека — это индекс
     скана (`id: i + 1`), у sc-трека id не меняется вовсе, а `lyricsNonce`
     растёт только от кнопки «повторить». без title в deps переименование при
     ОТКРЫТОЙ панели оставляло текст, найденный по старому названию.
     Строка, а не объект: `track` пересоздаётся на каждом списке sc, и
     ссылка в deps гоняла бы перезапросы. */
  useEffect(() => {
    if (!lyricsOpen) return;
    const req = ++lyricsReqRef.current;
    const order = cleanLyricsSources(settingsRef.current?.lyricsSources);
    setLyricsActive(-1);
    /* выбранный кликом по плашке источник относится к прошлому тексту */
    setLyricsAlt(null);
    /* Кеш проверяем ПЕРВЫМ, до проверки источников: найденный текст лежит
       локально, и открытие панели с ним не должно зависеть от сети вовсе.
       Никакого «ищем текст…», никакого запроса — на этом и держится
       «открылся сразу». Обход кеша есть только у «найти заново» и у ручного
       поиска (lyricsBypassRef). */
    const skipCache = lyricsBypassRef.current;
    lyricsBypassRef.current = false;
    const key = lyricsQueryKey(lyricsQuery.artist, lyricsQuery.title);
    const hit = skipCache ? null : settingsRef.current?.lyricsCache?.[key];
    if (hit?.alts?.length) {
      /* вариантов может быть два — оба кладём в состояние, чтобы
         переключатель в шапке работал и на кеше */
      const [first] = hit.alts;
      setLyrics({
        status: 'ready', lines: first.lines, synced: !!first.synced,
        source: first.source, tried: [], alts: hit.alts,
      });
      return;
    }
    if (!order.length) { setLyrics({ status: 'empty', tried: [] }); return; }
    setLyrics({ status: 'loading', tried: [] });
    /* Отчёт по источникам приходит по мере их ответов: плашка источника
       гаснет сразу, как он ответил, а не когда весь поиск закончится.
       Дописываем и в готовое состояние тоже: пока источник отвечал, панель уже
       могла получить текст от другого, и его плашка иначе осталась бы висеть
       серой — как будто источника и не спрашивали. `lines` при этом не
       трогаем, поэтому волна появления от такой дописи не перезапускается. */
    const onTried = entry => {
      if (req !== lyricsReqRef.current) return;
      setLyrics(prev => {
        if (!prev) return prev;
        if (prev.status !== 'loading' && prev.status !== 'ready') return prev;
        if ((prev.tried || []).some(x => x.id === entry.id)) return prev;
        return { ...prev, tried: [...(prev.tried || []), entry] };
      });
    };
    /* Второй источник нашёл свой текст уже после того, как панель показала
       первый. Дописываем его и в состояние (отсюда берётся переключатель), и
       в кеш — иначе на следующем открытии переключаться было бы не с чем. */
    const onFound = v => {
      if (req !== lyricsReqRef.current) return;
      setLyrics(prev => {
        if (!prev || prev.status !== 'ready') return prev;  /* ещё грузим — доедет в alts ответа */
        const old = prev.alts || [];
        if (old.some(a => a.source === v.source)) return prev;
        return { ...prev, alts: [...old, v] };
      });
      setSettings(s => {
        const cur = s.lyricsCache?.[key];
        if (!cur || cur.alts?.some(a => a.source === v.source)) return s;
        return { ...s, lyricsCache: {
          ...s.lyricsCache,
          [key]: { ...cur, alts: [...(cur.alts || []), v] },
        }};
      });
    };
    fetchLyrics(track, order, lyricsQuery, onTried, onFound).then(r => {
      if (req !== lyricsReqRef.current) return;
      setLyrics(r);
      if (r.status !== 'ready' || !r.lines?.length) return;
      /* нашли — сразу в кеш: в состояние (панель уже показывает текст) и в
         файл настроек отложенной записью (см. saveTimerRef). ключ — по
         запросу, а не по треку: у двух треков с одинаковыми метаданными
         текст один и тот же */
      setSettings(s => ({ ...s, lyricsCache: putLyricsCache(s.lyricsCache, key, {
        alts: r.alts || [{ source: r.source, lines: r.lines, synced: !!r.synced }],
        at: Date.now(),
      })}));
    }).catch(e => {
      if (req !== lyricsReqRef.current) return;
      console.warn('[lyrics] fetch failed', e);
      setLyrics({ status: 'error', tried: [], why: String(e?.message || e) });
    });
  }, [lyricsOpen, track.id, track.title, lyricsNonce, lyricsQuery.artist, lyricsQuery.title]);

  /* Перечитать текст. Тот же `lyricsNonce`, что у кнопки «попробовать
     снова»: побочный эффект ровно тот же — эффект выше видит новое значение
     и запускает поиск заново, с чистого состояния. отдельный рефреш со
     своей логикой не нужен. */
  const handleLyricsRefresh = useCallback(() => {
    lyricsBypassRef.current = true;      /* кеш не трогаем, ищем заново */
    setLyricsNonce(n => n + 1);
  }, []);

  /* Переключение источника кликом по плашке. Индекс активной строки
     сбрасываем сразу: он относится к тексту, который был на экране, и по нему
     панель сбрасывает скролл — со старым номером она встала бы не туда. */
  const handleLyricsPickSource = useCallback((id) => {
    setLyricsAlt(id || null);
    setLyricsActive(-1);
  }, []);

  /* Ручная пара из карандаша. Закрепляется за ТРЕКОМ и живёт в настройках,
     поэтому переживает перезапуск: в следующий раз этот же трек ищется по
     ней же, даже если теги в файле кривые («3.mp3 (2022)»).

     `lyricsNonce` здесь не «ещё одна зависимость», а необходимость: если
     человек ввёл ровно ту пару, что уже ищется, deps эффекта не изменятся и
     поиск молча не перезапустился бы. Кеш при этом обходим — «найти» значит
     «пойти и поискать», а не «достать прошлый ответ». */
  const handleLyricsFind = useCallback((artist, title) => {
    const a  = String(artist || '').trim();
    const ti = String(title || '').trim();
    if (!ti) return;                    /* без названия искать нечего */
    const key = lyricsQueryKey(track.artist, track.title);
    lyricsBypassRef.current = true;
    setSettings(s => ({ ...s, lyricsQueries: {
      ...(s.lyricsQueries || {}), [key]: { artist: a, title: ti },
    }}));
    setLyricsNonce(n => n + 1);
  }, [track.artist, track.title]);

  const handleLyricsUnpin = useCallback(() => {
    const key = lyricsQueryKey(track.artist, track.title);
    setSettings(s => {
      if (!s.lyricsQueries?.[key]) return s;
      const next = { ...s.lyricsQueries };
      delete next[key];
      return { ...s, lyricsQueries: next };
    });
  }, [track.artist, track.title]);

  /* То, что реально на экране. `lyrics` — победитель по приоритету (в нём же
     лежит весь набор вариантов и то, что ушло в кеш), `lyricsView` — выбранный
     кликом по плашке. useMemo, а не объект прямо в разметке: от него зависит
     зависимость эффекта подсветки, и новый объект на каждом рендере App
     перезапускал бы rAF вхолостую. */
  const lyricsView = useMemo(() => {
    if (!lyrics || lyrics.status !== 'ready' || !lyricsAlt) return lyrics;
    const v = lyrics.alts?.find(a => a.source === lyricsAlt);
    return v ? { ...lyrics, lines: v.lines, synced: !!v.synced, source: v.source } : lyrics;
  }, [lyrics, lyricsAlt]);

  /* активная строка. rAF нужен, чтобы догонять play/pause/seek и
     переключение скорости: timeupdate даёт 4 отсчёта в секунду, и на 2×
     подсветка отставала бы на полсекунды. setState с bailout'ом не даёт
     ререндерить App каждый кадр: значение меняется на строку пару раз за
     трек, не 60 раз в секунду */
  useEffect(() => {
    if (!lyricsOpen || lyricsView?.status !== 'ready' || !lyricsView.synced) {
      if (lyricsActive !== -1) setLyricsActive(-1);
      return;
    }
    let raf = 0;
    const tick = () => {
      /* Время берём С ЭЛЕМЕНТА, а не через progressRef × duration. Причин
         две, и обе ощутимы:
         · progressRef обновляется событием timeupdate, то есть примерно
           четыре раза в секунду. На 2× это шаг в полсекунды медиа —
           подсветка и отстаёт, и прыгает. currentTime читается каждый кадр;
         · progressRef — доля от `audio.duration`, а метки в LRC размечены
           по длительности из метаданных. Если они расходятся (округление,
           другой битрейт, обрезка), подсветка уезжает ПРОПОРЦИОНАЛЬНО и к
           концу трека расходится на секунды.
         currentTime — ровно та шкала, в которой размечен текст, и от
         скорости воспроизведения она не зависит: элемент сам отдаёт её в
         секундах медиа, при 2× просто идёт вдвое быстрее. поэтому ускорил
         трек — подсветка едет с ним, а не живёт по своим часам. */
      const el  = audioRef.current;
      const dur = track.duration || 0;
      const t   = el && el.duration > 0 ? el.currentTime
                : dur > 0 ? progressRef.current * dur
                : -1;
      if (t >= 0) {
        const ls = lyricsView.lines;
        /* Ищем строку с САМОЙ ПОЗДНЕЙ меткой, которая уже наступила.
           Просто «последняя, что ≤ t, до первого перелёта» — не то же
           самое: в LRC попадаются строки не по порядку, и обрыв на первой
           «будущей» оставлял бы подсветку на предыдущей, хотя ниже уже
           есть подходящая. Сотня строк за кадр — ничто. */
        let idx = -1, best = -Infinity;
        for (let i = 0; i < ls.length; i++) {
          const lt = ls[i].t;
          if (lt == null || lt > t) continue;     /* секция или ещё не время */
          if (lt >= best) { best = lt; idx = i; }
        }
        setLyricsActive(prev => (prev === idx ? prev : idx));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [lyricsOpen, lyricsView, track.id]);

  const handleLyricsSeek = useCallback((t) => {
    const el = audioRef.current;
    /* Долю считаем от длительности ЭЛЕМЕНТА, а не из метаданных: метки строк
       живут в шкале currentTime (см. tick выше), а handleSeek умножает долю
       обратно на audio.duration. Перекрёстно их мешать — значит целиться в
       одну точку, а попадать в соседнюю. */
    const dur = el && el.duration > 0 ? el.duration : (track.duration || 0);
    if (t == null || dur <= 0) return;
    handleSeek(t / dur);
  }, [track.duration, handleSeek]);

  const handlePickFolderFromWelcome = async () => {
    const folder = await window.electronAPI.selectMusicFolder();
    if (folder) {
      setSettings(s => ({ ...s, musicFolder: folder }));
      handleScanTracks(folder);
    }
  };

  const [settingsSec, setSettingsSec] = useState('playback');
  const [crossfadeFocus, setCrossfadeFocus] = useState(0);
  const plEditorRef = useRef(null);
  const handleNav = async (id) => {
    navigationRef.current.cancel();
    /* из редактора плейлиста выходим только через его гарды — если есть
       несохранённые изменения, редактор сам покажет предупреждение */
    if (view === 'playlistEditor' && editingPlaylist) {
      if (plEditorRef.current) plEditorRef.current.requestClose();
      return;
    }
    setNavActive(id);
    if (id === 'home') {
      if (view === 'player') {
        const artEl = findArtEl(track.id);
        const par = playerArtRef.current?.getBoundingClientRect();
        if (artEl && par) {
          const scrollEl = homeScrollRef.current;
          if (scrollEl) {
            const box     = scrollEl.getBoundingClientRect();
            const cr      = artEl.getBoundingClientRect();
            const visible = cr.top >= box.top && cr.bottom <= box.bottom;
            if (!visible) {
              const cardOffsetInScroll = cr.top - box.top + scrollEl.scrollTop;
              const targetTop = Math.max(0, cardOffsetInScroll - box.height / 2 + cr.height / 2);
              scrollEl.scrollTop = targetTop;
            }
          }

          const cardRect = artEl.getBoundingClientRect();
          setReverseHero({
            track: track,
            targetRect: { left: par.left, top: par.top, size: par.width },
            startRect:  { left: cardRect.left, top: cardRect.top, width: cardRect.width, height: cardRect.height },
            corners: cssCorners(artEl),
          });
        }
        setPlayerVisible(false);
        setHomeVisible(true);
        setView('home');
      } else if (view === 'settings' || view === 'search' || view === 'history' || view === 'artist' || view === 'playlists' || view === 'playlistEditor') {
        setHomeVisible(true);
        setView('home');
      } else if (view === 'home') {
        setHomeVisible(true);
        const el = homeScrollRef.current;
        if (el) smoothScroll(el, 0, 420);
      }
    } else if (id === 'search') {
      if (view === 'home') setHomeVisible(false);
      if (view === 'player') setPlayerVisible(false);
      setView('search');
    } else if (id === 'playlists') {
      if (view === 'home') setHomeVisible(false);
      if (view === 'player') setPlayerVisible(false);
      setView('playlists');
    } else if (id === 'history') {
      if (view === 'home') setHomeVisible(false);
      if (view === 'player') setPlayerVisible(false);
      setView('history');
    } else if (id === 'settings') {
      if (view === 'player') setPlayerVisible(false);
      if (view === 'home') setHomeVisible(false);
      navigationRef.current.settings(reduced ? 0 : view === 'home' ? 240 : 300);
    } else if (view === 'home') {
      const artEl = findArtEl(track.id);
      const par = playerArtRef.current?.getBoundingClientRect();
      if (artEl && par) {
        const scrollEl = homeScrollRef.current;
        if (scrollEl) {
          const box = scrollEl.getBoundingClientRect();
          const cr  = artEl.getBoundingClientRect();
          if (cr.top < box.top || cr.bottom > box.bottom) {
            const offset = cr.top - box.top + scrollEl.scrollTop;
            scrollEl.scrollTop = Math.max(0, offset - box.height / 2 + cr.height / 2);
            await new Promise(r => requestAnimationFrame(r));
          }
        }
        const startRect = artEl.getBoundingClientRect();
        const targetRect = { left: par.left, top: par.top, size: par.width };
        setHero({ track: track, startRect, targetRect, corners: cssCorners(artEl) });
      }
      setHomeVisible(false);
      setPlayerVisible(true);
      setView('player');
    } else if (view === 'settings') {
      setPlayerVisible(true);
      setView('player');
    } else if (view === 'search' || view === 'history') {
      setPlayerVisible(true);
      setView('player');
    } else if (view === 'artist') {
      setPlayerVisible(true);
      setView('player');
    } else if (view === 'playlists') {
      setPlayerVisible(true);
      setView('player');
    } else if (view === 'playlistEditor') {
      setPlayerVisible(true);
      setView('player');
      setNavActive('library');
    } else if (view === 'player') {
      setPlayerVisible(true);
      setLibScrollTargetId(track.id);
      setLibScrollTrigger(v => v + 1);
    }
  };
  handleNavRef.current = handleNav;
  const openCrossfadeSettings = () => {
    setSettingsSec('playback');
    setCrossfadeFocus(value => value + 1);
    handleNav('settings');
  };

  const toggleParty = event => {
    // Keep the playlist editor's unsaved-work guard. Room view itself never changes playback.
    if (view === 'playlistEditor' && editingPlaylist) { plEditorRef.current?.requestClose(); return; }
    const opening = !partyOpen || view !== 'player';
    setPartyInstant(event.detail === 0);
    setPartyOpen(opening);
    if (opening && view !== 'player') {
      setHomeVisible(false);
      setPlayerVisible(true);
      setView('player');
      setNavActive('library');
    }
  };

  /* ── Кнопки «назад/вперёд» мыши → hero-клон ───────────────────────────────
     ⚠️ ЗАЧЕМ. До этого история браузера вообще не участвовала: приложение
     живёт на `file://` и меняет `view` реактом, не трогая History API.
     Нажатие «назад» на мыши уходило на ПУСТУЮ предыдущую запись файла —
     то есть либо ничего, либо выход из приложения. Привычный жест работал
     только внутри Chromium, но не как у пользователя ожидается: «назад»
     должен возвращать на главную, а он её не возвращал.

     Теперь home↔player — это две записи истории, и `popstate` приводит
     приложение к состоянию из записи, ПРОИГРЫВАЯ тот же hero-клон, что и
     при клике. То есть «назад» из плеера → обложка улетает на карточку
     (обратный hero), «вперёд» → прилетает в плеер (прямой hero). Анимация
     одна и та же, потому что переиспользуем `handleNav`/`selectTrack`
     ровно те, что зовут кнопки в UI. */

  /* какие записи истории «наши». чужие (about:blank, служебные) трогать
     нельзя — иначе «назад» уводил бы в никуда */
  const HISTORY_TAG = 'sewer';
  /* ⚠️ храним ТОЛЬКО факт «home или player». трек сюда намеренно не кладём:
     состояние плеера и так живёт в react, а копия id в истории дала бы
     второй источник правды — при расхождении «вперёд» возвращал бы на
     карточку трека, которого уже нет в сетке */
  const pushView = (v) => {
    try {
      history.pushState({ [HISTORY_TAG]: 1, view: v }, '');
    } catch {}
  };
  /* ⚠️ первая запись: `pushState` на САМОМ старте оставил бы «назад» в
     никуда. `replaceState` переписывает текущую запись, поэтому «назад»
     сразу после запуска корректно ничего не делает */
  useEffect(() => {
    try {
      history.replaceState({ [HISTORY_TAG]: 1, view: viewRef.current }, '');
    } catch {}
  }, []);

  const onPop = useRef(null);
  useEffect(() => {
    const handler = () => {
      const st = history.state;
      /* ⚠️ запись не наша (первый запуск, служебная страница) — не реагируем,
         иначе «назад» с главной выкидывал бы из приложения */
      if (!st || !st[HISTORY_TAG]) return;
      if (st.view === 'player' && viewRef.current !== 'player') onPop.current?.('player');
      else if (st.view === 'home' && viewRef.current !== 'home') onPop.current?.('home');
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  /* обработчик popstate. ведёт себя ровно как нажатие соответствующей
     кнопки UI: handleNav('home') уносит обложку на карточку, handleNav
     любого другого раздела возвращает в плеер */
  onPop.current = (target) => {
    /* запоминаем, В КАКОЙ view нас должны были привести — и идём туда же,
       куда вёл бы клик по кнопке UI */
    popTargetRef.current = target;
    if (target === 'home') handleNavRef.current?.('home');
    else handleNavRef.current?.('library');
  };

  /* ⚠️ ЗАПИСЫВАТЬ ИСТОРИЮ НАДО ЗДЕСЬ, а не внутри handleNav/selectTrack:
     popstate сам зовёт handleNav, и если бы тот же код пушил запись, то
     «назад» породил бы новую запись и вперёд стал бы бесконечным.
     Поэтому пишем историю в ОДНОМ месте — на факте смены `view`.
     viewRef обновляется здесь же, он же читается обработчиком popstate. */
  useEffect(() => {
    viewRef.current = view;
    /* ⚠️ ПЕРВЫЙ прогон эффекта — это монтирование, а не переход.
       без этой проверки на старте пушилась лишняя запись «home» рядом с
       той, что сделал replaceState, и первое нажатие «назад» уходило в
       неё: view и так home, обработчик молчал, и пользователь терял
       одно нажатие — «назад не работает» */
    if (!histInitRef.current) { histInitRef.current = true; return; }

    /* ⚠️ Отличает нашу обработку popstate от обычного перехода ПО ФАКТУ
       достижения целевого view, а не флагом «я сейчас обрабатываю».
       Флаг залипал: `handleNav` умеет НЕ переключить view (из редактора
       плейлиста с несохранёнными правками выход только через его гарды —
       он показывает предупреждение и остаётся на месте). тогда view не
       менялся, эффект не срабатывал, флаг ждал следующего перехода и
       гасил его запись — после чего «назад» переставал работать навсегда
       и без единой ошибки. сверка цели самовосстанавливается: если
       перехода не случилось, цель просто перезапишется следующим
       popstate, а реальные переходы пушатся всегда. */
    if (popTargetRef.current === view) { popTargetRef.current = null; return; }
    popTargetRef.current = null;

    if (view !== 'home' && view !== 'player') return;   /* остальные разделы в историю не пишем */
    pushView(view);
  }, [view]);

  if (!track) return null;

  return (
    <LangContext.Provider value={lang}>
    <div style={{
      display:'flex', width:'100%', height:'100%',
      /* По вертикали не режем — см. контейнер центральной колонки ниже:
         пятно за обложкой перелезало через эту границу и обрезалось по ней.
         По горизонтали clip оставлен, чтобы колонки не наезжали друг на друга */
      overflow:'clip visible',
    }}>
      {hero && hero.targetRect && <HeroClone hero={hero} exiting={heroExiting}/>}
      {reverseHero && reverseHero.targetRect && <HeroClone hero={reverseHero} exiting={reverseHeroExiting} reverse={true}/>}
      <TopBar navActive={navActive} onNav={handleNav}
        libCollapsed={libCollapsed} onToggleLib={event=>{ setPartyInstant(event.detail === 0); setLibCollapsed(v=>!v); }}
        inPlayer={view==='player'} scAuth={settings.soundcloudAuth||null}
        track={track} hasTrack={hasTrack} isPlaying={isPlaying} onPrev={handlePrev} onNext={handleNext}
        onTogglePlayback={togglePlayback}
        sourceMode={sourceMode} onToggleSource={handleToggleSource} hideSource={uiHidden.source}
        hideMiniPlayer={uiHidden.miniPlayer} partyOpen={partyOpen && view === 'player'} partyActive={partyActive} partyLocked={partyLocked}
        onToggleParty={toggleParty} partyTriggerRef={partyTriggerRef}/>

      <div style={{
        position:'relative', flex:1, height:'100%',
        /* Этот контейнер — граница, по которой раньше срезалось пятно за
           обложкой: колонка начинается на 46px, ровно под тайтлбаром, и
           `overflow:hidden` обрезал свечение по этой линии — получалась ровная
           граница поперёк окна. По вертикали теперь `visible`, пятно уходит под
           тайтлбар и гаснет естественно.

           Именно `clip visible`, а не `hidden visible`: в паре, где одно
           значение visible, а другое не visible/clip, браузер превращает
           visible в auto — и колонка стала бы прокручиваемой по вертикали.
           Горизонтальный clip оставлен: колонка не должна наезжать на
           библиотеку и на панель громкости. */
        overflow:'clip visible',
      }}>

        {(
          <div ref={homeScrollRef} className="scroll-thin scroll-home" style={{
            /* раньше здесь был только opacity + pointerEvents, и скрытая
               главная ловила клики у вкладок поверх неё — тот же баг, что у
               поиска. visibility из stackRoot гасит hit-test на поддереве */
            ...stackRoot(homeVisible, 0.18),
            top:0, left:0, right:10, bottom:0,
            overflowY:'auto', padding:'18px 4px 32px 36px',
            /* та же причина, что у списка в библиотеке: на главной поиск
               сокращает сетку, полоса пропадает, и все карточки разом
               сдвигаются на ширину скроллбара. `both-edges` резервирует
               жёлоб и слева — поиск и сетка встают ровно по центру колонки
               и не зависят от того, есть полоса или нет. */
            scrollbarGutter:'stable both-edges',
          }}>
            {!showWelcome && <div style={{
              display:'flex', alignItems:'center', gap:14, marginBottom:22,
            }}>
              {/* порядок: подпись слева, поиск по центру, действие справа.
                  подпись можно спрятать (Оформление → Элементы интерфейса):
                  при этом поиск остаётся один и встаёт по центру сам */}
              {!uiHidden.caption && (
              <div style={{flexShrink:0, lineHeight:1.3}}>
                <div style={{fontSize: 'var(--fs-eyebrow)', fontWeight:500, color:'rgba(255,255,255,0.22)',
                  letterSpacing:'0.12em', textTransform:'uppercase'}}>
                  {sourceMode === 'sc' ? t('likes') : t('all_tracks')}
                </div>
                {sourceMode === 'sc' && (scLoading || scUpdating) ? (
                  <div style={{fontSize:'var(--fs-eyebrow)', color:'rgba(255,255,255,0.32)', marginTop:2}}>
                    {scLoading ? t('loading_dots') : t('updating')}
                  </div>
                ) : (sourceMode === 'sc' ? scTracks.length : tracks.length) > 0 ? (
                  <div style={{fontSize:'var(--fs-eyebrow)', color:'rgba(255,255,255,0.16)',
                    marginTop:2, fontVariantNumeric:'tabular-nums'}}>
                    {sourceMode === 'sc' ? scTracks.length : tracks.length}
                  </div>
                ) : null}
              </div>
              )}
              {sourceMode === 'sc' && scError && (
                <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,80,60,0.75)', maxWidth:240, lineHeight:1.5, wordBreak:'break-all', flexShrink:0}}>
                  {scError} — <span style={{cursor:'pointer', textDecoration:'underline'}}
                    onClick={() => loadScLikes(settings.soundcloudAuth)}>{t('retry')}</span>
                </div>
              )}
              {/* обёртка flex:1 центрирует поле между подписью и кнопкой —
                  на самом инпуте flex:1 прижимал его влево */}
              <div style={{flex:1, display:'flex', justifyContent:'center', minWidth:0}}>
              <div style={{
                position:'relative',
                background: searchFocused ? 'rgba(255,255,255,0.065)' : 'rgba(255,255,255,0.04)',
                borderRadius:13, width:'100%', maxWidth:400, flexShrink:0,
                transition:'background 0.18s',
              }}>
                  <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2"
                    viewBox="0 0 24 24" style={{position:'absolute', left:13, top:'50%', translate:'0 -50%', pointerEvents:'none', color: searchFocused ? 'rgba(255,255,255,0.38)' : 'rgba(255,255,255,0.22)', transition:'color 0.18s'}}>
                    <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                  </svg>
                  <input
                    ref={homeSearchRef}
                    type="text"
                    placeholder={t('search_hinted')}
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    onFocus={() => setSearchFocused(true)}
                    onBlur={() => setSearchFocused(false)}
                    style={{
                      background:'transparent', border:'none', outline:'none',
                      padding:'10px 34px',
                      color:'rgba(255,255,255,0.78)', fontSize: 'var(--fs-sm)',
                      width:'100%', userSelect:'text', fontFamily:'inherit', textAlign:'center',
                    }}
                  />
                  {search && (
                    <div onClick={() => setSearch('')} style={{
                      position:'absolute', right:14, top:'50%', translate:'0 -50%',
                      color:'rgba(255,255,255,0.28)', cursor:'pointer',
                      fontSize: 'var(--fs-lg)', lineHeight:1, transition:'color 0.15s',
                    }}>×</div>
                  )}
              </div>
              </div>
              {/* чипсы сортировки можно спрятать: сортировка остаётся той,
                  что выбрана, и вернуть ряд — там же в «Оформлении» */}
              {sourceMode !== 'sc' && !uiHidden.sort && (
                <div style={{display:'flex', gap:3, flexShrink:0}}>
                  {[['added',t('sort_added')],['artist',t('sort_artist')],['title',t('sort_title')],['duration',t('sort_dur')]].map(([k,label]) => (
                    <button key={k} onClick={() => setSort(k)} style={{
                      background: sort===k ? 'rgba(255,255,255,0.07)' : 'none',
                      border: 'none',
                      borderRadius:6, padding:'3px 9px',
                      fontSize: 'var(--fs-eyebrow)', fontWeight:500, letterSpacing:'0.05em', textTransform:'uppercase',
                      color: sort===k ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.2)',
                      cursor:'pointer', fontFamily:'inherit',
                      transition:'color 0.15s, background 0.15s, border-color 0.15s',
                    }}>{label}</button>
                  ))}
                </div>
              )}
              <ShuffleBtn variant="pill" h={38} on={shuffle} style={{alignSelf:'center'}}
                onClick={() => handleShuffleToggle(sourceMode === 'sc' ? scTracks : tracks)}
                disabled={(sourceMode === 'sc' ? scTracks.length : tracks.length) === 0}/>
            </div>}
            {showWelcome ? (
              <div style={{
                display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
                minHeight:'calc(100vh - 120px)', gap:22, textAlign:'center',
              }}>
                <div style={{
                  width:72, height:72, borderRadius:20,
                  background:'rgba(255,255,255,0.035)',
                  display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0,
                  color:'rgba(255,255,255,0.4)',
                }}>
                  <svg width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                    <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                  </svg>
                </div>
                <div>
                  <div style={{fontSize: 'var(--fs-xl)', fontWeight:600, letterSpacing:'-0.02em',
                    color:'rgba(255,255,255,0.78)', marginBottom:8}}>
                    {t('welcome_title')}
                  </div>
                  <div style={{fontSize: 'var(--fs-md)', color:'rgba(255,255,255,0.32)', lineHeight:1.6, maxWidth:340}}>
                    {t('welcome_sub').split('\n').map((l,i) => <span key={i}>{l}{i===0 && <br/>}</span>)}
                  </div>
                </div>
                <div style={{display:'flex', gap:10, marginTop:6, flexWrap:'wrap', justifyContent:'center'}}>
                  <button onClick={handlePickFolderFromWelcome} style={{
                    display:'flex', alignItems:'center', gap:8,
                    background:'rgba(255,255,255,0.04)',
                    border:'none', borderRadius:10, padding:'9px 18px',
                    fontSize: 'var(--fs-md)', fontWeight:500, color:'rgba(255,255,255,0.7)',
                    cursor:'pointer', fontFamily:'inherit',
                    transition:'background 0.15s, color 0.15s',
                  }}
                    onMouseEnter={e=>{ e.currentTarget.style.background='rgba(255,255,255,0.07)'; e.currentTarget.style.color='rgba(255,255,255,0.9)'; }}
                    onMouseLeave={e=>{ e.currentTarget.style.background='rgba(255,255,255,0.04)'; e.currentTarget.style.color='rgba(255,255,255,0.7)'; }}
                  >
                    <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                    </svg>
                    {t('pick_folder')}
                  </button>
                  <button onClick={() => { if (!settings.soundcloudAuth) setSettingsSec('account'); handleNav('settings'); }} style={{
                    display:'flex', alignItems:'center', gap:8,
                    background:'rgba(255,85,0,0.1)',
                    border:'none', borderRadius:10, padding:'9px 18px',
                    fontSize: 'var(--fs-md)', fontWeight:500, color:'rgba(255,130,60,0.85)',
                    cursor:'pointer', fontFamily:'inherit',
                    transition:'background 0.15s, color 0.15s',
                  }}
                    onMouseEnter={e=>{ e.currentTarget.style.background='rgba(255,85,0,0.17)'; }}
                    onMouseLeave={e=>{ e.currentTarget.style.background='rgba(255,85,0,0.1)'; }}
                  >
                    <SoundCloudIcon size={14} fill="rgba(255,130,60,0.9)"/>
                    {t('login_sc')}
                  </button>
                </div>
              </div>
            ) : activeList.length === 0 && (sourceMode === 'sc' || search) ? (
              scLoading ? <HomeGridSkeleton/> : (
                <div style={{
                  display:'flex', alignItems:'center', justifyContent:'center',
                  padding:'80px 20px', fontSize: 'var(--fs-md)', color:'rgba(255,255,255,0.32)',
                  textAlign:'center',
                }}>
                  {scError ? t('load_failed') : (search ? t('not_found') : t('no_likes'))}
                </div>
              )
            ) : (
              <HomeGrid
                list={activeList}
                likedIds={sourceMode === 'sc' ? likedIds : null}
                onLike={sourceMode === 'sc' ? handleLike : null}
                onSelect={selectTrackStable}
                getArtRef={getArtRef}
                heroId={hero && !heroExiting ? hero.track.id : null}
                reverseId={reverseHero && !reverseHeroExiting ? track.id : null}/>
            )}
          </div>
        )}

        {(
          <div style={{
            /* то же, что у главной: скрытый слой плеера не должен ловить
               клики у видимых вкладок (см. stackRoot). opacity-переход
               здесь короткий — 0.1s, как было */
            ...stackRoot(playerVisible, 0.1),
            display:'flex',
          }}>
        {/* library panel */}
        <div data-motion-spatial="" style={{
          width: libCollapsed ? 0 : 260,
          flexShrink:0, height:'100%',
          background:'transparent',
          zIndex:9, overflow:'hidden',
          opacity: playerVisible ? 1 : 0,
          transform: playerVisible ? 'translateX(0)' : 'translateX(-28px)',
          transition: playerVisible
            ? 'opacity 0.36s ease 0.1s, transform 0.44s cubic-bezier(0.22,1,0.36,1) 0.1s, width 0.44s cubic-bezier(0.4,0,0.2,1)'
            : 'opacity 0.14s ease, transform 0.18s ease, width 0.44s cubic-bezier(0.4,0,0.2,1)',
        }}>
          {/* оба слоя абсолютные и всегда смонтированы: список уезжает влево,
              текст приезжает справа. ширина родителя схлопывается до 0 и
              клипует всё лишнее, поэтому за колонку ничего не вылезает */}
          <div style={{width:260, flexShrink:0, height:'100%', position:'relative'}}>
          <div data-motion-spatial="" style={{
            position:'absolute', inset:0, display:'flex', flexDirection:'column',
            /* уступает место любой из двух панелей колонки — тексту и эффектам:
               обе приезжают справа на месте списка */
            opacity: (lyricsOpen || fxOpen) ? 0 : 1,
            /* !playerVisible — ОБЯЗАТЕЛЬНО, иначе невидимый список ест клики
               по сетке на главной. `pointer-events:none` на слое плеера
               (строка выше) НЕ выключает клики в поддереве: по спеке CSS
               потомок с `pointer-events:auto` снова становится целью, событие
               просто идёт к нему через родителя. Этот слой — ровно такой
               потомок (pointer-events:auto), а сам он `position:absolute
               inset:0` в колонке 260px. На главной слой плеера opacity:0,
               но opacity НЕ влияет на hit-testing → невидимая полоса
               шириной 260px перехватывала клики по первому столбцу сетки.
               Клик уходил в невидимую строку VirtualTrackList: звук шёл от
               3-й/4-й строки (смещение по вертикали), экран не менялся,
               hero не запускался. */
            pointerEvents: playerVisible && !lyricsOpen && !fxOpen ? 'auto' : 'none',
            transform: (lyricsOpen || fxOpen) ? 'translateX(-14px)' : 'translateX(0)',
            transition: (lyricsOpen || fxOpen)
              ? 'opacity 0.16s ease, transform 0.16s ease'
              : 'opacity 0.3s ease 0.08s, transform 0.44s cubic-bezier(0.22,1,0.36,1) 0.08s',
          }}>
          <AnimatePresence initial={false} mode="wait">
          {stationActive ? (
            <motion.div key="station-chip" data-motion-spatial=""
              initial={{ opacity: 0, y: -10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98, transition: { duration: 0.14, ease: [0.22, 1, 0.36, 1] } }}
              transition={{ type: 'spring', stiffness: 440, damping: 30, mass: 0.7 }}
              style={{padding:'10px 10px 8px', flexShrink:0}}>
              {/* контекст-чип станции: обложка + мини-эквалайзер + выход */}
              <div style={{
                display:'flex', alignItems:'center', gap:9,
                padding:'7px 8px', borderRadius:11,
                background:'rgba(255,255,255,0.04)',
                border:'1px solid rgba(255,255,255,0.045)',
              }}>
                {stationActive.origTrack.coverUrl ? (
                  <div style={{
                    position:'relative', width:26, height:26, borderRadius:7,
                    flexShrink:0, overflow:'hidden', background:'#111116'}}>
                    <img src={stationActive.origTrack.coverUrl} style={{
                      width:'100%', height:'100%', objectFit:'cover', display:'block'}}/>
                    <CoverTint/>
                  </div>
                ) : (
                  <div style={{
                    width:26, height:26, borderRadius:7, background:'rgba(255,255,255,0.06)', flexShrink:0,
                    display:'flex', alignItems:'center', justifyContent:'center'}}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)"
                      strokeWidth="2" strokeLinecap="round">
                      <circle cx="12" cy="12" r="2"/>
                      <path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19.1 4.9a10 10 0 0 1 0 14.2M4.9 19.1a10 10 0 0 1 0-14.2"/>
                    </svg>
                  </div>
                )}
                <div style={{flex:1, minWidth:0}}>
                  <div style={{display:'flex', alignItems:'center', gap:6, marginBottom:1}}>
                    <span style={{fontSize: 'var(--fs-eyebrow)', letterSpacing:'0.13em', textTransform:'uppercase',
                      color:'rgba(255,255,255,0.34)', fontWeight:600}}>
                      {t('station_label')}
                    </span>
                    <span className="st-eq" style={{display:'inline-flex', alignItems:'flex-end', gap:1.5, height:7}}>
                      <i/><i/><i/>
                    </span>
                  </div>
                  <div style={{
                    fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.78)', fontWeight:500,
                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                  }}>{stationActive.origTrack.title}</div>
                </div>
                <div onClick={handleExitStation} title={t('station_exit')} style={{
                  width:26, height:26, borderRadius:8, flexShrink:0,
                  display:'flex', alignItems:'center', justifyContent:'center',
                  color:'rgba(255,255,255,0.32)', cursor:'pointer',
                  transition:'background 0.15s, color 0.15s',
                }}
                  onMouseEnter={e => { e.currentTarget.style.background='rgba(255,255,255,0.07)'; e.currentTarget.style.color='rgba(255,255,255,0.75)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background='transparent'; e.currentTarget.style.color='rgba(255,255,255,0.32)'; }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2.4" strokeLinecap="round">
                    <line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/>
                  </svg>
                </div>
              </div>
            </motion.div>
          ) : playlistActive ? (
            <motion.div key="playlist-chip"
              initial={{ opacity: 0, y: -10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              data-motion-spatial=""
              exit={{ opacity: 0, y: -8, scale: 0.98, transition: { duration: 0.14, ease: [0.22, 1, 0.36, 1] } }}
              transition={{ type: 'spring', stiffness: 440, damping: 30, mass: 0.7 }}
              style={{padding:'10px 10px 8px', flexShrink:0}}>
              {/* контекст-чип плейлиста: обложка + счётчик + выход/редактор */}
              <div style={{
                display:'flex', alignItems:'center', gap:9,
                padding:'7px 8px', borderRadius:11,
                background:'rgba(255,255,255,0.04)',
                border:'1px solid rgba(255,255,255,0.045)',
              }}>
                {playlistActive.playlist.coverUrl ? (
                  <div style={{
                    position:'relative', width:26, height:26, borderRadius:7,
                    flexShrink:0, overflow:'hidden', background:'#111116'}}>
                    <img src={playlistActive.playlist.coverUrl} style={{
                      width:'100%', height:'100%', objectFit:'cover', display:'block'}}/>
                    <CoverTint/>
                  </div>
                ) : (
                  <div style={{
                    width:26, height:26, borderRadius:7, background:'rgba(255,255,255,0.06)', flexShrink:0,
                    display:'flex', alignItems:'center', justifyContent:'center'}}>
                    <img src="../assets/note.png" style={{width:11, height:11, filter:'brightness(0) invert(1)', opacity:0.35}}/>
                  </div>
                )}
                <div style={{flex:1, minWidth:0}}>
                  {/* капс «ПЛЕЙЛИСТ» убран: он только повторял то, что уже
                      сказано названием, и занимал целую строку. сверху —
                      название, под ним мета: счётчик треков и суммарная
                      длительность списка H:MM:SS (tabular-nums, иначе цифры
                      разъезжаются при пересчёте) */}
                  <div title={playlistActive.playlist.title} style={{
                    fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.78)', fontWeight:500,
                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                  }}>{playlistActive.playlist.title}</div>
                  <div style={{
                    display:'flex', alignItems:'center', gap:5, marginTop:1,
                    fontSize: 'var(--fs-eyebrow)', color:'rgba(255,255,255,0.24)',
                    fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap',
                  }}>
                    <span>{playlistActive.tracks.length}</span>
                    {plTotalDur > 0 && (<>
                      <span style={{opacity:0.5}}>·</span>
                      <span>{fmtHMS(plTotalDur)}</span>
                    </>)}
                  </div>
                </div>
                <ShuffleBtn variant="icon" on={shuffle} title={t('shuffle_all')}
                  onClick={() => handleShuffleToggle(playlistActive.tracks)}
                  disabled={!playlistActive.tracks.length}/>
                {playlistActive.playlist.isOwn && (
                  <div onClick={() => handleOpenPlEditor(playlistActive.playlist, 'player')}
                    title={t('pl_edit')} style={{
                    width:26, height:26, borderRadius:8, flexShrink:0,
                    display:'flex', alignItems:'center', justifyContent:'center',
                    color:'rgba(255,255,255,0.32)', cursor:'pointer',
                    transition:'background 0.15s, color 0.15s',
                  }}
                    onMouseEnter={e => { e.currentTarget.style.background='rgba(255,255,255,0.07)'; e.currentTarget.style.color='rgba(255,255,255,0.75)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background='transparent'; e.currentTarget.style.color='rgba(255,255,255,0.32)'; }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>
                    </svg>
                  </div>
                )}
                <div onClick={handleExitPlaylist} title={t('back')} style={{
                  width:26, height:26, borderRadius:8, flexShrink:0,
                  display:'flex', alignItems:'center', justifyContent:'center',
                  color:'rgba(255,255,255,0.32)', cursor:'pointer',
                  transition:'background 0.15s, color 0.15s',
                }}
                  onMouseEnter={e => { e.currentTarget.style.background='rgba(255,255,255,0.07)'; e.currentTarget.style.color='rgba(255,255,255,0.75)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background='transparent'; e.currentTarget.style.color='rgba(255,255,255,0.32)'; }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2.4" strokeLinecap="round">
                    <line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/>
                  </svg>
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div key="lib-search"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
              style={{padding:'12px 10px 8px', flexShrink:0}}>
              {/* поиск + кнопка «случайно» в ряд. поиск отдал ей ширину
                  (flex:1 при фиксированной кнопке справа) — колонка 260px,
                  иначе инпут сжимался бы в ничто */}
              <div style={{display:'flex', alignItems:'center', gap:6}}>
              <div style={{
                position:'relative', flex:1, minWidth:0,
                background: searchFocused ? 'rgba(255,255,255,0.065)' : 'rgba(255,255,255,0.04)',
                borderRadius:11,
                transition:'background 0.18s',
              }}>
                <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2"
                  viewBox="0 0 24 24" style={{position:'absolute', left:13, top:'50%', translate:'0 -50%', pointerEvents:'none', color: searchFocused ? 'rgba(255,255,255,0.38)' : 'rgba(255,255,255,0.22)', transition:'color 0.18s'}}>
                  <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                </svg>
                <input
                  ref={libSearchRef}
                  value={search}
                  onChange={e=>setSearch(e.target.value)}
                  onFocus={() => setSearchFocused(true)}
                  onBlur={() => setSearchFocused(false)}
                  placeholder={t('search_hinted')}
                  style={{width:'100%', background:'none', border:'none', outline:'none',
                          padding:'10px 34px',
                          color:'rgba(255,255,255,0.78)', fontSize: 'var(--fs-sm)', fontFamily:'inherit', textAlign:'center'}}/>
                {search && (
                  <div onClick={() => setSearch('')} style={{
                    position:'absolute', right:13, top:'50%', translate:'0 -50%',
                    color:'rgba(255,255,255,0.28)', cursor:'pointer',
                    fontSize: 'var(--fs-lg)', lineHeight:1, transition:'color 0.15s',
                  }}>×</div>
                )}
              </div>
              <ShuffleBtn variant="icon" field h={34} on={shuffle} onClick={() => handleShuffleToggle(activeQueueList())}/>
              </div>
            </motion.div>
          )}
          </AnimatePresence>
          <VirtualTrackList
            items={stationActive ? stationActive.tracks : playlistActive ? playlistActive.tracks : activeList}
            pinned={pinnedTrack}
            revealKey={deferredSearch}
            activeId={stationActive || playlistActive ? (scPlayingTrack ? scPlayingTrack.id : null) : activeListPlayingId}
            loadingId={loadingTrackId}
            errorId={errorTrackId}
            onClickItem={libClickStable}
            scrollToActive={libScrollTrigger}
            scrollTargetId={libScrollTargetId}
            onContextMenuItem={libCtxStable}
          />
          </div>
          <LyricsPanel open={lyricsOpen} inPlayer={playerVisible} state={lyricsView} activeLine={lyricsActive}
            onSeek={handleLyricsSeek} onRetry={handleLyricsRefresh}
            onRefresh={handleLyricsRefresh}
            sources={settings.lyricsSources}
            query={lyricsQuery} pinned={lyricsPinned}
            onPickSource={handleLyricsPickSource}
            onFindLyrics={handleLyricsFind} onUnpin={handleLyricsUnpin}/>
          <FxPanel open={fxOpen} inPlayer={playerVisible} settings={settings} partyActive={partyActive}
            onSettings={setSettings} onClose={() => setFxOpen(false)} onOpenCrossfade={openCrossfadeSettings}/>
          </div>
        </div>

        {/* drag handle — positioned relative to flex parent, sits on library's right edge */}
        {/* center player */}
        <div style={{
          flex:1, minWidth:0, height:'100%',
          display:'flex', alignItems:'center', justifyContent:'center',
        }}>
          <PartyPlayerLayout open={partyOpen} controlsAligned={partyOpen && libCollapsed} instant={partyInstant}
            enabled={view === 'player' && playerVisible && !hero && !reverseHero} className="player-composition" style={{
            width:'calc(100% - 48px)',
            maxWidth:partyOpen ? 'none' : 'clamp(380px, 55vw, 900px)', minWidth:220,
            display:'flex', flexDirection:'column',
            alignItems:'center', gap:0,
          }}>
            <div className={`player-stage${partyOpen ? ' player-stage-party' : ''}`}>
              <ListeningParty visible={partyOpen && playerVisible} instant={partyInstant} state={partyState} dispatch={partyDispatch}
                onClose={closeParty} triggerRef={partyTriggerRef} user={settings.soundcloudAuth} locale={lang}
                onCreate={()=>startParty('create')} onJoin={()=>startParty('join')}
                onLeave={()=>partyClientRef.current?.leave()} onRetry={()=>partyClientRef.current?.retry()}
                onLogin={()=>{ setSettingsSec('account'); handleNav('settings'); }}/>
            <div className="player-stage-media">
            <div data-party-motion="info" style={{width:'100%', minWidth:0}}>
            <div ref={playerInfoRef} className="player-info" data-visible={playerVisible ? 'true' : 'false'}>
              {/* Пустой плеер. Ничего не выбрано — стоит только этот текст:
                  артиста и названия нет, а рисовать их пустыми строками
                  значило бы оставить двадцать пикселей мёртвого места и
                  подсказку, что это ошибка загрузки. */}
              {!hasTrack ? (
                <div style={{
                  textAlign:'center', marginBottom:14, width:'100%',
                  fontSize:'clamp(15px, 2vw, 24px)', fontWeight:600,
                  letterSpacing:'-0.022em', color:'rgba(255,255,255,0.28)',
                }}>{t('player_pick')}</div>
              ) : (<>
              {/* artist */}
              <div style={{
                display:'flex', alignItems:'center', flexWrap:'wrap', justifyContent:'center',
                fontSize:'clamp(12px, 1.5vw, 16px)', marginBottom:5,
              }}>
                {scPlayingTrack
                  ? splitArtists(track.artist).map(({ name, sep }, i) => {
                      const isUploader = track.uploaderUsername
                        ? name.toLowerCase() === track.uploaderUsername.toLowerCase()
                        : i === 0;
                      return (
                        <React.Fragment key={i}>
                          <span
                            onClick={() => handleOpenArtist(
                              isUploader
                                ? { id: track.artistId, username: name, avatarUrl: track.artistAvatarUrl }
                                : { username: name }
                            )}
                            onMouseEnter={e => e.currentTarget.style.color='rgba(255,255,255,0.65)'}
                            onMouseLeave={e => e.currentTarget.style.color='rgba(255,255,255,0.28)'}
                            style={{ color:'rgba(255,255,255,0.28)', cursor:'pointer', transition:'color 0.15s' }}
                          >{name}</span>
                          {sep && <span style={{ color:'rgba(255,255,255,0.16)' }}>{/^[,.]$/.test(sep.trim()) ? ', ' : ` ${sep.trim()} `}</span>}
                        </React.Fragment>
                      );
                    })
                  : <span style={{ color:'rgba(255,255,255,0.28)' }}>{formatArtistDisplay(track.artist)}</span>
                }
              </div>
              {/* title */}
              <div style={{textAlign:'center', marginBottom:14, width:'100%'}}>
                {editingTitle ? (
                  <div style={{display:'flex', justifyContent:'center', width:'100%'}}>
                    <div style={{
                      display:'inline-flex', alignItems:'center',
                      background:'rgba(255,255,255,0.055)',
                      borderRadius:11, padding:'7px 18px',
                      boxShadow:'0 4px 28px rgba(0,0,0,0.45)',
                      maxWidth:'100%',
                    }}>
                      <input
                        autoFocus
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter')  { editCancelRef.current = false; commitEdit(); }
                          if (e.key === 'Escape') { editCancelRef.current = true;  setEditingTitle(false); }
                        }}
                        onBlur={() => { if (!editCancelRef.current) commitEdit(); editCancelRef.current = false; }}
                        style={{
                          background:'none', border:'none', outline:'none',
                          fontSize:'clamp(15px, 2vw, 24px)', fontWeight:600, letterSpacing:'-0.022em',
                          color:'#ededf4', textAlign:'center',
                          fontFamily:'Space Grotesk,sans-serif',
                          width: Math.max(80, editValue.length * 13) + 'px',
                          maxWidth:'100%',
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <div style={{
                    display:'flex', alignItems:'center', justifyContent:'center', width:'100%',
                  }}>
                    <MarqueeText
                      text={track.title}
                      onClick={e => {
                        if (e.shiftKey) { editCancelRef.current = false; setEditValue(track.title); setEditingTitle(true); }
                        else { setLibScrollTargetId(track.id); setLibScrollTrigger(v => v + 1); }
                      }}
                      style={{fontSize:'clamp(18px, 2.6vw, 28px)', fontWeight:600, letterSpacing:'-0.022em'}}
                      maxWidth={'min(clamp(280px, 38vw, 520px), 88%)'}
                    />
                  </div>
                )}
              </div>
              </>)}
            </div>{/* playerInfoRef end */}
            </div>
              {/* album art with ambient glow */}
              <div data-party-motion="art" style={{
                width:'min(100%, clamp(320px, 54vw, 760px), clamp(240px, 58vh, 760px))',
                marginBottom:24,
                position:'relative',
              }}>
                {/* ambient glow blob — uses app accent (cover-derived or preset) */}
                <AmbientGlow off={settings.accentMode==='off' || settings.ambientGlow === false}
                  visible={!((hero && !heroExiting) || reverseHero)}/>
                <div id="player-album-art" ref={playerArtRef}
                  style={{opacity: ((hero && !heroExiting) || reverseHero) ? 0 : 1, position:'relative', zIndex:1}}>
                  <div ref={artEntranceRef}>
                    <AlbumArt track={track} isPlaying={isPlaying}
                      instant={!!(hero || reverseHero)} onReady={handleArtReady}/>
                  </div>
                </div>
              </div>
            <div data-party-motion="progress" style={{width:'100%'}}>
            <div className="player-stage-progress" data-motion-spatial="" style={{
              width:partyOpen
                ? 'min(100%, clamp(320px, 54vw, 760px), clamp(240px, 58vh, 760px))'
                : 'min(100%, clamp(260px, 34vw, 520px))', margin:'0 auto 0',
              opacity: playerVisible ? 1 : 0,
              /* visibility, а не только opacity: скрытый слайдер всё равно
                 ловит клики (WebView2 не исключает невидимое из hit-test), а
                 лежит он поверх сетки главной — клик по карточке в нижней
                 части экрана проваливался в невидимую дорожку. delay на
                 показ/скрытие тот же 0.28s/0.1s, что у opacity, чтобы
                 переключение шло вместе с ней */
              visibility: playerVisible ? 'visible' : 'hidden',
              pointerEvents: playerVisible ? 'auto' : 'none',
              transform: playerVisible ? 'translateY(0)' : 'translateY(10px)',
              transition: playerVisible
                ? 'opacity 0.36s ease 0.28s, transform 0.48s cubic-bezier(0.22,1,0.36,1) 0.28s, visibility 0s linear 0.28s'
                : 'opacity 0.1s ease, transform 0.1s ease, visibility 0s linear 0.1s',
            }}>
              <ProgressBar progressRef={progressRef} audioRef={audioRef} total={track.duration || 0}
                onSeek={handleSeek} isPlaying={isPlaying} visible={playerVisible} disabled={partyLocked} positionVersion={partyState.room?.revision}
                />
            </div>
            </div>
            </div>{/* player-stage-media end: progress stays directly under the artwork */}
            </div>{/* shared artwork stage; the controls below never switch to a mock transport */}
            <div className="player-controls-layout">
            <div data-party-motion="controls" style={{width:'100%'}}>
            <div data-motion-spatial="" style={{
              width:'min(100%, clamp(260px, 34vw, 520px))', margin:'0 auto 0',
              opacity: playerVisible ? 1 : 0,
              visibility: playerVisible ? 'visible' : 'hidden',
              pointerEvents: playerVisible ? 'auto' : 'none',
              transform: playerVisible ? 'translateY(0)' : 'translateY(10px)',
              transition: playerVisible
                ? 'opacity 0.36s ease 0.28s, transform 0.48s cubic-bezier(0.22,1,0.36,1) 0.28s, visibility 0s linear 0.28s'
                : 'opacity 0.1s ease, transform 0.1s ease, visibility 0s linear 0.1s',
            }}>
            {/* ❌ был `const P = { spring:0.055, damping:0.84, clamp:10 }`,
                который шестиминутно передавался в `physics={P}` во все
                MagBtn/PlayBtn. НИ MagBtn, НИ PlayBtn этот проп не
                принимают — анимация там на whileTap/whileHover Motion.
                мёртвый объект пересоздавался на каждом рендере ради
                ничего; удалён вместе с шестью передачами. */}
            {(()=>{ const SIDE = 'clamp(40px, 5.2vw, 58px)'; return (
            <div style={{display:'flex', alignItems:'center', gap:14, justifyContent:'center', marginTop:16}}>
              {/* Баланс ряда. Слева теперь три кнопки (текст, эффекты, shuffle),
                  справа две (повтор, лайк). Без компенсации play уезжал бы
                  вправо от центра обложки на ширину кнопки, поэтому в конце
                  справа стоит невидимый спейсер того же размера, что и кнопка.
                  Постоянный слот лайка (27px + marginLeft 14) остаётся: трек
                  бывает локальным, и без слота ряд дёргался бы. */}
              <MagBtn onClick={handleToggleLyrics} active={lyricsOpen} size={SIDE}>
                <img src="../assets/textt.png" style={{width:'clamp(18px, 2.2vw, 26px)',height:'clamp(18px, 2.2vw, 26px)',filter:'brightness(0) invert(1)',opacity:lyricsOpen?1:0.38,transition:'opacity 0.2s ease'}}/>
              </MagBtn>
              {/* эффекты — рядом с текстом, потому что открывают ровно ту же
                  колонку слева (и взаимоисключающие с ним). иконка инлайном, а
                  не png из assets: те приходится выбеливать фильтром, а
                  выбранное состояние должно краситься акцентом */}
              <MagBtn onClick={handleToggleFx} active={fxOpen} size={SIDE}>
                <div style={{
                  width:'clamp(18px, 2.2vw, 26px)', height:'clamp(18px, 2.2vw, 26px)',
                  opacity: fxOpen ? 1 : 0.38, transition:'opacity 0.2s ease',
                }}>
                  <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none"
                    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <line x1="6"  y1="4" x2="6"  y2="20"/>
                    <line x1="12" y1="4" x2="12" y2="20"/>
                    <line x1="18" y1="4" x2="18" y2="20"/>
                    <line x1="2.6"  y1="15" x2="9.4"  y2="15" strokeWidth="2.4"/>
                    <line x1="8.6"  y1="8"  x2="15.4" y2="8"  strokeWidth="2.4"/>
                    <line x1="14.6" y1="13" x2="21.4" y2="13" strokeWidth="2.4"/>
                  </svg>
                </div>
              </MagBtn>
              <MagBtn onClick={()=>{ if (partyCanControl()) setShuffle(s=>!s); }} disabled={partyLocked} active={shuffle} size={SIDE}>
                <img src="../assets/shuffle.png" style={{width:'clamp(18px, 2.2vw, 26px)',height:'clamp(18px, 2.2vw, 26px)',filter:'brightness(0) invert(1)',opacity:shuffle?1:0.38,transition:'opacity 0.2s ease'}}/>
              </MagBtn>
              <MagBtn onClick={handlePrev} disabled={partyLocked} size={'clamp(46px, 6vw, 66px)'}>
                <img src="../assets/rewind.png" style={{width:'clamp(18px, 2.2vw, 26px)',height:'clamp(18px, 2.2vw, 26px)',filter:'brightness(0) invert(1)',opacity:0.38}}/>
              </MagBtn>
              <PlayBtn isPlaying={isPlaying} onToggle={togglePlayback} disabled={partyLocked}
                title={partyLocked ? partyLabels(lang).followsHost : t(isPlaying ? 'playback_pause' : 'playback_play')}
                trackKey={scPlayingTrack ? 'sc:'+scPlayingTrack.id
                        : (track ? 'loc:'+track.id : null)}/>
              <MagBtn onClick={handleNext} disabled={partyLocked} size={'clamp(46px, 6vw, 66px)'}>
                <img src="../assets/forward.png" style={{width:'clamp(18px, 2.2vw, 26px)',height:'clamp(18px, 2.2vw, 26px)',filter:'brightness(0) invert(1)',opacity:0.38}}/>
              </MagBtn>
              <MagBtn onClick={()=>{ if (partyCanControl()) setRepeat(r=>r==='off'?'all':r==='all'?'one':'off'); }} disabled={partyLocked} active={repeat!=='off'} size={SIDE}>
                <div style={{position:'relative',width:'clamp(18px, 2.2vw, 26px)',height:'clamp(18px, 2.2vw, 26px)'}}>
                  <img src="../assets/repeat.png"  style={{position:'absolute',top:0,left:0,width:'100%',height:'100%',filter:'brightness(0) invert(1)',opacity:repeat==='off'?0.38:repeat==='all'?1:0,transition:'opacity 0.2s ease'}}/>
                  <img src="../assets/repeat1.png" style={{position:'absolute',top:0,left:0,width:'100%',height:'100%',filter:'brightness(0) invert(1)',opacity:repeat==='one'?1:0,transition:'opacity 0.2s ease'}}/>
                </div>
              </MagBtn>
              {scPlayingTrack
                ? <PlayerLikeBtn liked={likedIds.has(scPlayingTrack.id)}
                    onLike={() => handleLike(scPlayingTrack)} style={{marginLeft:14}}/>
                : <div style={{width:27, marginLeft:14, flexShrink:0}}/>}
              {/* невидимый противовес третьей кнопке слева — см. комментарий
                  в начале ряда */}
              <div style={{width:SIDE, flexShrink:0}} aria-hidden="true"/>
            </div>
            ); })()}
            </div>{/* controls wrapper end */}
            </div>
            </div>{/* control alignment follows the artwork column only with the library collapsed */}
          </PartyPlayerLayout>
        </div>

        {/* volume panel. Скрывается из «Оформление → Элементы интерфейса»:
            громкость остаётся в микшере Windows, а полоса справа визуально
            самая «лишняя» из всего плеера */}
        {!uiHidden.volume && (
        <div data-motion-spatial="" style={{
          width:28, flexShrink:0, height:'100%',
          display:'flex', flexDirection:'column', alignItems:'center',
          paddingTop:110, paddingBottom:110, paddingRight:5,
          opacity: playerVisible ? 1 : 0,
          transform: playerVisible ? 'translateX(0)' : 'translateX(8px)',
          transition: playerVisible ? 'opacity 0.36s ease 0.44s, transform 0.48s cubic-bezier(0.22,1,0.36,1) 0.44s' : 'opacity 0.1s ease, transform 0.1s ease',
        }}>
          <ThinVolumeSlider volume={volume} onChange={handleVolumeCommit} onLiveChange={handleVolumeLive}/>
        </div>
        )}
          </div>
        )}

        <SettingsView settings={settings} onSettings={setSettings} visible={view==='settings'} onScanTracks={handleScanTracks} onClearFolder={handleClearFolder} onClearCoversCache={handleClearCoversCache} onClearLikesCache={handleClearLikesCache} appAccent={appAccent} winAccent={winAccent} scAuth={settings.soundcloudAuth||null} onScLogin={handleScLogin} onScLogout={handleScLogout} sec={settingsSec} setSec={setSettingsSec} discordStatus={discordStatus} crossfadeFocus={crossfadeFocus}/>
        <ListeningHistory visible={view==='history'} entries={listeningHistory} localTracks={tracks} cloudTracks={scTracks} covers={historyCovers}
          currentKey={hasTrack ? historyTrackKey(track, scPlayingTrack ? 'sc' : 'local') : null} isPlaying={isPlaying}
          loadingId={historyLoadingId || listeningHistory.find(entry => entry.source==='sc' && String(entry.track.id)===String(loadingTrackId))?.id}
          errorId={historyErrorId || listeningHistory.find(entry => entry.source==='sc' && String(entry.track.id)===String(errorTrackId))?.id}
          onPlay={handleHistoryPlay} onClear={()=>setSettings(s=>({ ...s, listeningHistory:[] }))}
          locale={lang==='en' ? 'en-US' : 'ru-RU'}
          labels={{ title:t('history_title'), subtitle:t('history_subtitle'), count:t('history_count'), clear:t('history_clear'),
            confirmClear:t('history_confirm_clear'), cancel:t('cancel'), empty:t('history_empty'), emptyHint:t('history_empty_hint'),
            local:t('history_local'), unavailable:t('history_unavailable'), today:t('history_today'), yesterday:t('history_yesterday'),
            playError:t('history_play_error'), play:t('playback_play'), untitled:t('track_untitled') }}/>
        <PlaylistsView visible={view==='playlists'} scAuth={settings.soundcloudAuth||null}
          playlists={playlists} loading={playlistsLoading} error={playlistsError} creating={creatingPlaylist}
          onOpen={handleOpenPlaylist} onEdit={pl => handleOpenPlEditor(pl, 'playlists')}
          onCreate={handleCreatePlaylist}
          onRetry={() => loadPlaylists(settings.soundcloudAuth, true)}
          onLogin={() => { setSettingsSec('account'); handleNav('settings'); }}/>
        <PlaylistEditor ref={plEditorRef} visible={view==='playlistEditor' && !!editingPlaylist}
          playlist={editingPlaylist?.playlist} scAuth={settings.soundcloudAuth||null}
          onClose={handleClosePlEditor} onUpdated={handlePlaylistUpdated} onDelete={handleDeletePlaylist}
          fallbackTracks={scTracks} onPlayTrack={tr => handleScTrackClick(tr, -1)}
          playingTrackId={scPlayingTrack?.id ?? null}
          loadingTrackId={loadingTrackId} errorTrackId={errorTrackId}/>
        <SearchView ref={searchViewRef} visible={view==='search'} scAuth={settings.soundcloudAuth||null}
          likedIds={likedIds} onLike={handleLike}
          onPlayTrack={(t, queue) => { searchQueueRef.current = queue || null; handleScTrackClick(t, -1); }}
          onSelectTrack={(t, queue) => { searchQueueRef.current = queue || null; openSearchTrack(t); }}
          onResultsLoaded={handleSearchResultsLoaded}
          onArtistClick={handleOpenArtist}
          loadingTrackId={loadingTrackId} errorTrackId={errorTrackId}
          hideDividers={HIDE_DIVIDERS}
          heroId={hero && !heroExiting ? hero.track.id : null}
          glowOff={settings.accentMode==='off' || settings.ambientGlow === false}
          onLogin={() => { setSettingsSec('account'); handleNav('settings'); }}/>
        <ArtistView artist={artistView} visible={view==='artist'} onClose={handleCloseArtist} scAuth={settings.soundcloudAuth||null} artistCacheRef={artistCacheRef}
          hideDividers={HIDE_DIVIDERS} glowOff={settings.accentMode==='off' || settings.ambientGlow === false}
          likedIds={likedIds} onLike={handleLike}
          /* очередь = список артиста. раньше второй аргумент не передавался,
             searchQueueRef оставался null, и next после трека артиста уезжал
             в лайки — в совсем другой список */
          onPlayTrack={(tr, queue) => { searchQueueRef.current = queue || null; handleScTrackClick(tr, -1); }}
          onSelectTrack={(tr, queue) => { searchQueueRef.current = queue || null; handleScTrackClick(tr, -1); setHomeVisible(false); setPlayerVisible(true); setView('player'); setNavActive('library'); }}
          onTracksAppended={handleSearchResultsLoaded}
          onLogin={() => { setSettingsSec('account'); handleNav('settings'); }}
          loadingTrackId={loadingTrackId} errorTrackId={errorTrackId}
          onFollow={handleFollow} onCheckFollow={checkFollow}/>

        <AnimatePresence>
          {toast && !toastExiting && (
            <motion.div data-motion-spatial=""
              key="toast"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 5 }}
              transition={{ type:'spring', stiffness: 420, damping: 32, mass: 0.7 }}
              style={{
                /* сверху, вплотную под тайтлбар: раньше висел снизу и накрывал
                   низ плеера. центральный блок плеера центрирован по вертикали,
                   поэтому под тайтлбаром пусто — оттуда и держим. координата от
                   --titlebar-h, не хардкод */
                position:'absolute', bottom:26, left:'50%',
                translate:'-50% 0',
                display:'flex', alignItems:'center', gap:8,
                background:'var(--pop-bg)',
                backdropFilter:'blur(20px)', WebkitBackdropFilter:'blur(20px)',
                border:'1px solid rgba(255,255,255,0.055)',
                borderRadius:11, padding:'7px 13px',
                boxShadow:'0 16px 44px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.32)',
                fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.72)',
                pointerEvents:'none', zIndex:9999,
                maxWidth:'min(440px, calc(100vw - 48px))', lineHeight:1.4,
              }}>
              {/* единственное пятно цвета — точка акцента: идентичность тоста
                  без заливки/рамки цветом. следовал за --accent, поэтому
                  переключается вместе с темой */}
              <span style={{
                width:5, height:5, borderRadius:'50%', flexShrink:0,
                background:'var(--accent)',
                boxShadow:'0 0 8px rgba(var(--accent-rgb),0.6)',
              }}/>
              <span style={{minWidth:0}}>{toast}</span>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {trackMenu && (
            <TrackContextMenu key="ctxmenu" menu={trackMenu}
              onClose={() => setTrackMenu(null)}
              onCopyLink={handleCopyTrackLink}
              onStartStation={handleStartStation}
              onDownload={handleOpenDownload}
              canAddPl={!!settings.soundcloudAuth && !trackMenu.track.path && trackMenu.track.id != null}
              playlists={playlists} playlistsLoading={playlistsLoading}
              onEnsurePlaylists={ensurePlaylists}
              plMembers={plMembers}
              onEnsureMembers={ensurePlaylistMembers}
              onToggleInPlaylist={handleToggleInPlaylist}
              onCreateWithTrack={handleCreatePlaylistWithTrack}/>
          )}
        </AnimatePresence>

        <DownloadDialog track={dlTrack} scAuth={settings.soundcloudAuth}
          dir={settings.downloadsFolder}
          onPickDir={handlePickDlDir}
          onClose={() => setDlTrack(null)}
          onSaved={handleDlSaved}/>

      </div>
    </div>
    </LangContext.Provider>
  );
}


export default App

// hmr-probe-test-1

