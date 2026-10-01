import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react'
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


/* десктоп-поведение вместо сайт-поведения:
   Tab не гоняет фокус по вкладкам/кнопкам (рамка-«бегунка» больше не появляется) */
window.addEventListener('keydown', e => { if (e.key === 'Tab') e.preventDefault(); });

/* ── accent presets ──────────────────────────────────────────────────────── */
const ACCENT_PRESETS = {
  default:  { r: 178, g: 178, b: 178 },
  lavender: { r: 155, g: 125, b: 255 },
  mint:     { r: 130, g: 220, b: 195 },
  rose:     { r: 255, g: 145, b: 175 },
  amber:    { r: 255, g: 178, b: 100 },
};

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
async function fetchLyrics(track, order) {
  const artist = cleanTrackName(splitArtists(track.artist || '')[0]?.name || '');
  /* СЫРОЕ название, НЕ чищеное: разбор «Артист — Название» делает
     trackQueries, и если почистить заранее, тире уже исчезнет и ветка
     разбора не сработает. Из-за этого весь разворот был мёртвым кодом:
     «Королевский XVII — Charles de Gaulle» превращался в «Королевский XVII»
     (то же самое, что и артист), и поиск шёл «Королевский XVII
     Королевский XVII» → 0 хитов. */
  const rawTitle = String(track.title || '').trim();
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
  const inflight = order.map((id, i) => {
    const p = Promise.resolve().then(() => one(id));
    p.then(v => { box[i] = { ok: true, v }; },
           e => { box[i] = { ok: false, e }; });
    return p;
  });

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
      if (s.v && s.v.lines.length) return { status: 'ready', ...s.v, source: id, tried };
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
      return { status: 'ready', ...s.v, source: order[i], tried };
  }
  /* если все ответили ошибкой, а не «нет трека» — это не miss */
  const allError = tried.length > 0 && tried.every(x => x.result === 'error');
  return { status: allError ? 'error' : 'empty', tried };
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
  const startTop = el.scrollTop;
  const delta    = targetTop - startTop;
  if (Math.abs(delta) < 1) return;   /* субпиксель — анимировать нечего */
  const t0 = performance.now();
  const ease = x => x < 0.5 ? 2*x*x : 1 - Math.pow(-2*x + 2, 2)/2;
  const tick = now => {
    const p = Math.min((now - t0) / duration, 1);
    el.scrollTop = startTop + delta * ease(p);
    if (p < 1) _smoothScrolls.set(el, requestAnimationFrame(tick));
    else _smoothScrolls.delete(el);
  };
  _smoothScrolls.set(el, requestAnimationFrame(tick));
}
function stopSmoothScroll(el) {
  const h = _smoothScrolls.get(el);
  if (h) { cancelAnimationFrame(h); _smoothScrolls.delete(el); }
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
    nav_local:'Локальная библиотека', nav_settings:'Настройки',
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
    card_audio:'Аудио',
    autoplay:'Автовоспроизведение', autoplay_sub:'Следующий трек запускается автоматически',
    default_repeat:'Повтор по умолчанию',
    crossfade:'Кроссфейд', crossfade_sub:'Плавное перекрытие треков',
    card_interface:'Интерфейс',
    hide_dividers:'Отключить разделители', hide_dividers_sub:'Убирает линии между пунктами настроек и треками',
    discord_rpc:'Discord Rich Presence', discord_rpc_sub:'Показывать текущий трек в Discord',
    card_discord:'Discord',
    discord_timestamp:'Таймстамп',
    discord_ts_progress:'Прогресс', discord_ts_elapsed:'Прошло', discord_ts_none:'Нет',
    discord_on_pause:'При паузе',
    discord_pause_show:'Показывать', discord_pause_hide:'Скрывать',
    discord_cover:'Обложка трека', discord_cover_sub:'Показывать art в присутствии',
    discord_st_off:'Discord не запущен или RPC выключен',
    discord_st_connecting:'Подключение к Discord…',
    discord_st_connected:'Discord подключён',
    discord_st_lost:'Соединение с Discord потеряно, переподключаемся…',
    card_account:'Аккаунт', card_language:'Язык интерфейса', language_label:'Язык', language_sub:'Язык элементов управления',
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
    opening_browser:'открываем браузер...', login_browser:'войти через браузер',
    search_ph:'поиск',
    artists:'Исполнители', followers:'подписчиков', tracks_label:'Треки',
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
    back:'назад',
    subscribe:'Подписаться', subscribed:'Вы подписаны',
    follow_err:'не удалось подписаться', unfollow_err:'не удалось отписаться',
    copy_link:'Скопировать ссылку', link_copied:'Ссылка скопирована', copy_link_err:'не удалось скопировать ссылку',
    start_station:'Запустить станцию', station_for:'Станция по треку', station_label:'Станция', station_exit:'выйти', station_err:'не удалось запустить станцию',
    add_to_pl:'Добавить в плейлист', add_pl_new:'новый плейлист', added_to:'добавлено в',
    removed_from:'удалено из', pl_rm_err:'не удалось удалить трек',
    dl_save:'Скачать', dl_folder:'Папка', dl_change:'изменить', dl_name:'Имя файла',
    dl_no_dir:'папка не выбрана', dl_no_auth:'нужен вход в SoundCloud',
    dl_no_stream:'у трека нет прямого mp3 (только hls) — нужен ffmpeg',
    dl_resolve:'не удалось получить ссылку на файл',
    dl_not_audio:'сервер вернул не аудио — файл не записан',
    dl_resolving:'получаем ссылку…',
    dl_err:'не удалось скачать', dl_wait:'скачивание…', dl_ok:'скачано',
    dl_no_tags:'скачано, но без тегов и обложки',
    pl_in:'убрать из плейлиста', pl_out:'добавить в плейлист', pl_in_loading:'проверяем…',
    pl_add_err:'не удалось добавить трек', pl_list_err:'не удалось загрузить плейлисты',
    ed_title_ph:'Название плейлиста', ed_art_pick:'Выбрать обложку', ed_art_err:'не удалось загрузить обложку',
    accent_title:'Акцент и свечение', accent_sub:'Свечения и цвет активных элементов интерфейса',
    accent_default:'По умолчанию', accent_lavender:'Лавандовый', accent_mint:'Мятный', accent_rose:'Розовый', accent_amber:'Янтарный', accent_cover:'От обложки',
    accent_cover_sub:'Динамически меняется под обложку трека',
    accent_seg_off:'Выкл', accent_seg_color:'Цвет',
    accent_off_title:'Свечения выключены', accent_off_sub:'Фоновые свечения скрыты, акцент — статичный серый',
    art_glow:'Мягкое свечение за обложкой', art_glow_sub:'Цветное пятно вокруг обложки в плеере. Меньше нагрузки на видеокарту, чем настоящее размытие',
    sec_lyrics:'Текст песен',
    sec_discord:'Discord',
    shuffle_all:'Случайно', shuffle_empty:'Нечего перемешивать',
    lyrics_sources:'Источники текста', lyrics_sources_sub:'Сверху вниз — в этом порядке ищется текст песни',
    lyrics_off:'Выключенные', lyrics_synced:'синхронный',
    lyrics_up:'Выше по списку', lyrics_down:'Ниже по списку',
    lyrics_back:'вернуться к трекам',
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
    nav_local:'Local library', nav_settings:'Settings',
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
    card_audio:'Audio',
    autoplay:'Autoplay', autoplay_sub:'Next track plays automatically',
    default_repeat:'Default repeat',
    crossfade:'Crossfade', crossfade_sub:'Smooth overlap between tracks',
    card_interface:'Interface',
    hide_dividers:'Hide dividers', hide_dividers_sub:'Removes lines between settings items and tracks',
    discord_rpc:'Discord Rich Presence', discord_rpc_sub:'Show current track in Discord',
    card_discord:'Discord',
    discord_timestamp:'Timestamp',
    discord_ts_progress:'Progress', discord_ts_elapsed:'Elapsed', discord_ts_none:'None',
    discord_on_pause:'On pause',
    discord_pause_show:'Show', discord_pause_hide:'Hide',
    discord_cover:'Track artwork', discord_cover_sub:'Show art in presence',
    discord_st_off:'Discord is not running or RPC is off',
    discord_st_connecting:'Connecting to Discord…',
    discord_st_connected:'Discord connected',
    discord_st_lost:'Lost connection to Discord, reconnecting…',
    card_account:'Account', card_language:'Interface language', language_label:'Language', language_sub:'Language of UI elements',
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
    opening_browser:'opening browser...', login_browser:'log in via browser',
    search_ph:'search',
    artists:'Artists', followers:'followers', tracks_label:'Tracks',
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
    back:'back',
    subscribe:'Follow', subscribed:'Following',
    follow_err:'could not follow', unfollow_err:'could not unfollow',
    copy_link:'Copy link', link_copied:'Link copied', copy_link_err:'could not copy link',
    start_station:'Start station', station_for:'Station for', station_label:'Station', station_exit:'exit', station_err:'could not start station',
    add_to_pl:'Add to playlist', add_pl_new:'new playlist', added_to:'added to',
    removed_from:'removed from', pl_rm_err:'could not remove the track',
    dl_save:'Download', dl_folder:'Folder', dl_change:'change', dl_name:'File name',
    dl_no_dir:'no folder selected', dl_no_auth:'SoundCloud login required',
    dl_no_stream:'no direct mp3 for this track (hls only) — needs ffmpeg',
    dl_resolve:'could not get a file url',
    dl_not_audio:'server returned non-audio — nothing was written',
    dl_resolving:'getting the file url…',
    dl_err:'download failed', dl_wait:'downloading…', dl_ok:'downloaded',
    dl_no_tags:'downloaded, but without tags and cover',
    pl_in:'remove from playlist', pl_out:'add to playlist', pl_in_loading:'checking…',
    pl_add_err:'could not add the track', pl_list_err:'could not load playlists',
    ed_title_ph:'Playlist name', ed_art_pick:'Choose cover', ed_art_err:'cover upload failed',
    accent_title:'Accent & glow', accent_sub:'Glow effects and the color of active interface elements',
    accent_default:'Default', accent_lavender:'Lavender', accent_mint:'Mint', accent_rose:'Rose', accent_amber:'Amber', accent_cover:'From cover',
    accent_cover_sub:'Dynamically follows the current track artwork',
    accent_seg_off:'Off', accent_seg_color:'Color',
    accent_off_title:'Glow disabled', accent_off_sub:'Background glows hidden, accent is flat gray',
    art_glow:'Soft glow behind artwork', art_glow_sub:'Colored halo around the cover in the player. Cheaper for the GPU than a real blur',
    sec_lyrics:'Lyrics',
    sec_discord:'Discord',
    shuffle_all:'Shuffle', shuffle_empty:'Nothing to shuffle',
    lyrics_sources:'Lyrics sources', lyrics_sources_sub:'Top to bottom — lyrics are searched in this order',
    lyrics_off:'Turned off', lyrics_synced:'synced',
    lyrics_up:'Move up', lyrics_down:'Move down',
    lyrics_back:'back to tracks',
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

function buildScShuffle(list, currentId) {
  const ids = list.map(t => t.id);
  const rest = currentId != null ? ids.filter(id => id !== currentId) : ids.slice();
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return currentId != null ? [currentId, ...rest] : rest;
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
  const [hov, setHov] = useState(false);
  const [popKey, setPopKey] = useState(0);
  const click = () => { if (!liked) setPopKey(k => k + 1); onLike(); };
  return (
    <div
      onClick={click}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        flexShrink:0, cursor:'pointer', padding:4, lineHeight:0,
        opacity: liked ? (hov ? 1 : 0.85) : (hov ? 0.6 : 0.25),
        transition:'opacity 0.18s ease',
        ...extraStyle,
      }}
    >
      <div style={{position:'relative', display:'flex', transform: hov ? 'scale(1.16)' : 'scale(1)', transition:'transform 0.15s ease'}}>
        {/* кольцо-вспышка: расходится и гаснет при каждом лайке */}
        {popKey > 0 && (
          <motion.div key={'ring' + popKey}
            initial={{ scale: 0.55, opacity: 0.55 }}
            animate={{ scale: 1.8, opacity: 0 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
            style={{position:'absolute', inset:-8, borderRadius:'50%',
              border:'1.5px solid var(--accent)', pointerEvents:'none'}}/>
        )}
        {/* сердце: пружинный поп с лёгким поворотом, replay по key */}
        <motion.div key={'pop' + popKey}
          initial={{ scale: 1, rotate: 0 }}
          animate={popKey > 0
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

/* ── Progress Bar ────────────────────────────────────────────────────────── */
function ProgressBar({ progressRef, audioRef, total, onSeek, isPlaying, visible }) {
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
    const onMove = (e) => { if (dragging.current) onSeek(getVal(e)); };
    const onUp   = () => { if (dragging.current) { dragging.current = false; setActive(false); } };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [onSeek]);

  const timeStyle = {
    fontSize: 'var(--fs-xs)', fontVariantNumeric: 'tabular-nums',
    color: hover || active ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.28)',
    letterSpacing: '0.02em',
    userSelect: 'none', flexShrink: 0,
    transition: 'color 0.2s ease',
  };
  const thick = hover || active;
  const TRACK_H = thick ? 14 : 10;
  const THUMB_SZ = active ? 16 : (hover ? 14 : 0);
  return (
    <div style={{width:'100%', display:'flex', alignItems:'center', gap:11}}>
      <span ref={elapsedSpanRef} style={timeStyle}>{fmt(Math.floor(progressRef.current * (total||0)))}</span>
      {/* clickable hit-zone with vertical padding */}
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => { setHover(false); setTip(s => ({...s, show:false})); }}
        onMouseMove={e => {
          const rect = trackRef.current?.getBoundingClientRect();
          if (!rect) return;
          const wrapRect = e.currentTarget.getBoundingClientRect();
          const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          setTip({ x: e.clientX - wrapRect.left, t: Math.floor(p * (total || 0)), show: true });
        }}
        onMouseDown={e => { dragging.current = true; setActive(true); onSeek(getVal(e)); kick(); }}
        style={{
          flex:1, minWidth:0, position:'relative',
          padding: '10px 0', cursor:'pointer',
          display:'flex', alignItems:'center',
        }}
      >
        {/* time tooltip on hover */}
        {tip.show && (
          <div style={{
            position:'absolute',
            left: tip.x, top: -4,
            translate: '-50% -100%',
            background:'rgba(20,20,26,0.96)',
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
          <div ref={trackRef}
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
          <div ref={glowRef} style={{
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
          <div ref={thumbRef} style={{
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
    <motion.div variants={itemVars} onClick={disabled ? null : () => { onClick?.(); onClose(); }}
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
      <motion.svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#0a0a0c"
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
      if (!dragging.current && Math.abs(diff) < 0.001) {
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
        retryRef.current = 0;
        onLoaded(url);
      };
      if (im.decode) im.decode().then(ready).catch(ready); else ready();
    };
    im.onerror = () => {
      if (dead) return;
      if (retryRef.current < 2) {
        retryRef.current++;
        setTimeout(() => {
          if (dead) return;
          const sep = url.includes('?') ? '&' : '?';
          im.src = url + sep + '_r=' + Date.now();
        }, 500 * retryRef.current);
      } else {
        onFailed(url);
      }
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
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    if (isTop) {
      cv.style.opacity = ready ? '1' : '0';
      cv.style.transform = ready ? 'none' : 'scale(1.035)';
      return;
    }
    if (!topReady) return;
    cv.style.opacity = '0';
    cv.style.transform = 'scale(0.985)';
  }, [isTop, ready, topReady]);

  return (
    <canvas ref={canvasRef}
      style={{position:'absolute',inset:0,width:'100%',height:'100%',display:'block',
        opacity: instant ? 1 : 0, transform:'none',
        /* ⚠️ instant — на экране hero-клона кроссфейд НЕ нужен и вреден.
           клон поверх уже показывает новую обложку; если дать нижним слоям дорисовки,
           в момент снятия клона сверху будет полупрозрачная новая,
           а снизу — старая. */
        transition: instant ? 'none' : 'opacity 0.38s ease-out, transform 0.5s cubic-bezier(0.2,0.8,0.2,1)',
        willChange:'transform, opacity',
        pointerEvents:'none'}}/>
  );
}

function AlbumArt({ track, instant, onReady }) {
  const url = track?.coverUrl || null;
  const [layers, setLayers] = useState(() => (url ? [{ url }] : []));
  const pruneTimer = useRef(null);
  const topUrl = layers.length ? layers[layers.length - 1].url : null;
  /* верхний слой отрисован — сообщаем, чтобы hero-клон снимался только когда
     под ним уже лежит НОВАЯ обложка, а не предыдущая */
  const topReady = layers.length ? !!layers[layers.length - 1].ready : true;
  useEffect(() => { if (topReady) onReady?.(); }, [topReady, onReady]);
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
      const found = prev.find(l => l.url === url);
      if (found) return [...prev.filter(l => l.url !== url), found];
      return [...prev, { url }];
    });
  }, [url, topUrl]);

  /* верхний слой проявился → срезаем нижние после кроссфейда */
  useEffect(() => {
    if (layers.length < 2) return;
    const top = layers[layers.length - 1];
    if (!top.ready) return;
    if (pruneTimer.current) clearTimeout(pruneTimer.current);
    pruneTimer.current = setTimeout(() => {
      pruneTimer.current = null;
      setLayers(prev => {
        if (prev.length < 2) return prev;
        const t = prev[prev.length - 1];
        return t.ready ? [t] : prev;
      });
    }, 800);
  }, [layers]);

  useEffect(() => () => { if (pruneTimer.current) clearTimeout(pruneTimer.current); }, []);

  const markLoaded = u => setLayers(prev => {
    const i = prev.findIndex(l => l.url === u);
    if (i < 0 || prev[i].ready) return prev;
    const next = prev.slice();
    next[i] = { url: u, ready: true };
    return next;
  });
  const dropLayer = u => setLayers(prev => prev.filter(l => l.url !== u));

  return (
    <div style={{
      position:'relative', width:'100%', aspectRatio:'1', borderRadius:16, overflow:'hidden',
      background:'#111116',
      display:'flex', alignItems:'center', justifyContent:'center',
    }}>
      {/* placeholder underneath — always rendered */}
      <img src="../assets/note.png" style={{width:32,height:32,filter:'brightness(0) invert(1)',opacity:0.13}}/>
      {layers.map((l, i) => (
        <CoverLayer key={l.url} url={l.url} onLoaded={markLoaded} onFailed={dropLayer} instant={instant}
          isTop={i === layers.length - 1} ready={!!l.ready} topReady={topReady}/>
      ))}    </div>
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
  return (
    <div style={{
      position:'absolute', inset:'-50%', borderRadius:'50%',
      /* ⚠️ хвост после 60% намеренно сжат. У скруглённой обложки за дугой
         каждого угла остаётся просвет, и в него видно glow. Углы квадрата
         лежат на 0.707 радиуса градиента, а середины рёбер — на 0.5, так
         что дальнюю зону можно гасить независимо от ореола у самой
         обложки: 0.26 на 50% (ореол) оставлено как было, а на 70% вместо
         ~0.135 теперь ~0.068. без этого в просветах углов на секунду
         вспыхивало цветное пятно — glow-то как раз в этот момент гас. */
      background: 'radial-gradient(circle closest-side at center, rgba(var(--accent-rgb),0.42) 0%, rgba(var(--accent-rgb),0.36) 25%, rgba(var(--accent-rgb),0.26) 50%, rgba(var(--accent-rgb),0.14) 62%, rgba(var(--accent-rgb),0.06) 72%, rgba(var(--accent-rgb),0.024) 82%, rgba(var(--accent-rgb),0.008) 91%, rgba(var(--accent-rgb),0.002) 97%, rgba(var(--accent-rgb),0) 100%)',
      opacity: visible ? 1 : 0, transition:'opacity 0.6s ease',
      willChange:'opacity', transform:'translateZ(0)',
      pointerEvents:'none', zIndex:0,
    }}/>
  );
}

/* ── MagBtn ──────────────────────────────────────────────────────────────── */
function MagBtn({ onClick, active, children, size=52 }) {
  return (
    <motion.button onClick={onClick}
      whileHover={{ scale: 1.1 }}
      whileTap={{ scale: 0.82 }}
      transition={{ type:'spring', stiffness: 600, damping: 22, mass: 0.4 }}
      style={{
        width:size, height:size, borderRadius:'50%', border:'none', background:'none',
        color: active ? 'var(--accent)' : 'rgba(255,255,255,0.38)',
        display:'flex', alignItems:'center', justifyContent:'center',
        cursor:'pointer', flexShrink:0,
        transition:'color 0.2s ease',
      }}>
      {children}
    </motion.button>
  );
}

/* ── PlayBtn ─────────────────────────────────────────────────────────────── */
function PlayBtn({ isPlaying, onToggle, trackKey = null }) {
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
  const [trackPulse, setTrackPulse] = useState(0);
  const wasPlaying = useRef(false);
  useEffect(() => {
    if (isPlaying && !wasPlaying.current) setPlayPulse(k => k + 1);
    wasPlaying.current = isPlaying;
  }, [isPlaying]);
  const lastTrack = useRef(trackKey);
  useEffect(() => {
    if (lastTrack.current === trackKey) return;
    lastTrack.current = trackKey;
    if (trackKey != null) setTrackPulse(k => k + 1);
  }, [trackKey]);

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
    transform: visible ? 'scale(1)' : 'scale(0.78)',
    transition: visible
      ? 'opacity 0.22s ease-out, transform 0.34s cubic-bezier(0.2,0.9,0.2,1)'
      : 'opacity 0.12s ease-in, transform 0.12s ease-in',
    pointerEvents:'none',
  });
  return (
    <motion.button onClick={onToggle}
      whileHover={{ scale: 1.04 }}
      whileTap={{ scale: 0.93 }}
      animate={trackPulse > 0 ? { scale: [1, 0.9, 1] } : {}}
      transition={{ type:'spring', stiffness: 380, damping: 26, mass: 0.6 }}
      style={{
        width:BTN, height:BTN, borderRadius:'50%', border:'none',
        background: isPlaying ? 'rgba(178,178,178,0.1)' : 'rgba(255,255,255,0.06)',
        color:'var(--text)',
        display:'flex', alignItems:'center', justifyContent:'center',
        cursor:'pointer', flexShrink:0, position:'relative',
        transition:'background 0.3s ease',
      }}>
      {isPlaying && playPulse > 0 && (
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
  /* качать имеет смысл только у SC-трека с progressive-transcoding:
     локальный файл уже на диске, hls-only требует ffmpeg */
  const canDownload = !!menu.track.streamUrl;
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
    <motion.div ref={ref}
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
      exit={{ opacity: 0, scale: 0.96, y: -2, transition: { duration: 0.14, ease: [0.4, 0, 1, 1] } }}
      style={{
        position:'fixed', left: pos.x, top: pos.y,
        transformOrigin: 'top left',
        minWidth: 208,
        background:'rgba(24,24,24,0.97)',
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
        <motion.div variants={itemVars}
          onClick={() => setPlOpen(v => !v)}
          style={itemStyle} {...itemHover}>
          <span style={{display:'flex', alignItems:'center', justifyContent:'center', width:14, opacity:0.7}}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18V5l12-2v13"/>
              <circle cx="6" cy="18.5" r="3"/><circle cx="18" cy="16.5" r="3"/>
            </svg>
          </span>
          <span>{t('add_to_pl')}</span>
          <motion.span animate={{ rotate: plOpen ? 90 : 0 }} transition={{ duration: 0.18, ease:'easeOut' }}
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
            exit={{ opacity: 0, x: subPos ? (subPos.dir > 0 ? -4 : 4) : -4, transition: { duration: 0.12, ease: 'easeIn' } }}
            transition={{ type:'spring', stiffness: 560, damping: 36, mass: 0.5 }}
            style={{
              position:'fixed', left: subPos?.x ?? -9999, top: subPos?.y ?? -9999,
              width: SUB_W,
              background:'rgba(24,24,24,0.97)',
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
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState(null);   /* { got, total } */
  const [err, setErr] = useState(null);
  const idRef = useRef(null);

  const meta = useMemo(
    () => cleanTrackMeta(track?.title, track?.artist, track?.artistReal, track?.uploaderUsername),
    [track?.id, track?.title, track?.artist, track?.artistReal]
  );

  useEffect(() => {
    if (!track) return;
    setName(fileNameFor(meta.artist, meta.title) + '.mp3');
    setProg(null); setErr(null); setBusy(false);
  }, [track?.id]);

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
     чем свежее — тем лучше */
  const resolveStream = async (auth) => {
    const res = await window.electronAPI.scFetch(track.streamUrl, auth.token, auth.clientId);
    const url = res?.data?.url;
    if (typeof url === 'string' && url.startsWith('http')) return url;
    return null;
  };

  const start = async () => {
    /* dir — проп из прошлого рендера: после await он не обновится, поэтому
       выбор папки кладём в локальную переменную, иначе нативный диалог
       выскочил бы дважды подряд */
    let target = dir;
    if (!target) { target = await onPickDir?.(); if (!target) return }
    if (!scAuth?.token) { setErr(t('dl_no_auth')); return }
    if (!track?.streamUrl) { setErr(t('dl_no_stream')); return }
    setBusy(true); setErr(null); setProg(null);
    idRef.current = track.id;
    try {
      const audioUrl = await resolveStream(scAuth);
      if (!audioUrl) { setBusy(false); setErr(t('dl_resolve')); return }
      setProg({ got: 0, total: 0 });
      const res = await window.electronAPI.scDownloadTrack({
        id: track.id,
        title: meta.title,
        artist: meta.artist,
        comment: meta.comment,
        coverUrl: track.coverUrl,
        streamUrl: audioUrl,
        baseName: name.replace(/\.mp3$/i, ''),
        dir: target,
        token: scAuth.token,
      });
      setBusy(false);
      if (res?.error) { setErr(t(DL_ERR[res.error] || 'dl_err')); return }
      setProg(null);
      onSaved?.(res);
    } catch (e) {
      setBusy(false);
      setErr(t('dl_err'));
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
          <motion.div
            initial={{ scale: 0.97, y: 10, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.98, y: 6, opacity: 0, transition: { duration: 0.13, ease: 'easeIn' } }}
            transition={{ type: 'spring', stiffness: 420, damping: 32, mass: 0.7 }}
            style={{ width: 384, background: 'rgba(24,24,24,0.97)',
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
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--fs-md)', fontWeight: 600, color: 'rgba(255,255,255,0.88)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta.title}</div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'rgba(255,255,255,0.4)', marginTop: 2,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta.artist}</div>
                {meta.comment && (
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'rgba(255,255,255,0.26)', marginTop: 2,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta.comment}</div>
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
              <input value={name} onChange={e => setName(e.target.value)} disabled={busy}
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
              <div style={{ marginTop: 12, fontSize: 'var(--fs-xs)', color: 'rgba(255,110,95,0.9)' }}>{err}</div>
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

function VirtualTrackList({ items, activeId, loadingId, errorId, onClickItem, onContextMenuItem, scrollToActive, scrollTargetId }) {
  const ROW_H = 50;
  const BUFFER = 5;
  const FADE = 18;
  const ref = useRef(null);
  const scrollRafRef = useRef(null);
  const [range, setRange] = useState({ start: 0, end: 30 });
  const [edges, setEdges] = useState({ top: false, bottom: false });

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
    const topEdge = scrollTop > 4;
    const botEdge = scrollTop + viewportH < el.scrollHeight - 4;
    setEdges(prev => (prev.top === topEdge && prev.bottom === botEdge) ? prev : { top: topEdge, bottom: botEdge });
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
  const edgeFade = {
    position:'absolute', left:0, right:0, height: FADE,
    pointerEvents:'none', zIndex:2,
    transition:'opacity 0.2s ease',
  };
  const fadeTop = { ...edgeFade, top:0,    background:'linear-gradient(to bottom, var(--bg), transparent)', opacity: edges.top ? 1 : 0 };
  const fadeBot = { ...edgeFade, bottom:0, background:'linear-gradient(to top,    var(--bg), transparent)', opacity: edges.bottom ? 1 : 0 };

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
    <div ref={ref} className="scroll-thin" style={{
      flex:1, minHeight:0, overflowY:'auto', padding:'2px 6px 10px', position:'relative',
    }}>
      {activeIdx >= 0 && (
        <div style={{
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
      <div style={{position:'relative', zIndex:1, height: totalHeight}}>
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
    <div style={fadeTop}/>
    <div style={fadeBot}/>
    </div>
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
   `renderer/index.md`. */
function LyricsPanel({ open, inPlayer, state, activeLine, onSeek, onRetry, onBack, onRefresh, sources }) {
  const t = useLang();
  const bodyRef  = useRef(null);
  const lineRefs = useRef([]);
  const userScrollRef = useRef(0);
  const autoUntilRef  = useRef(0);
  const wasOpenRef    = useRef(false);
  /* края храним в ref + чиним через счётчик: меняются они на каждом
     скролле, а ререндер ради двух булевых значений не нужен — маска
     применяется стилем, а состояние нужно только чтобы перерисовалось */
  const [edgesTick, setEdgesTick] = useState(0);
  const edgesRef = useRef({ top: false, bottom: false });
  const forceEdges = useCallback(() => setEdgesTick(v => v + 1), []);
  lineRefs.current = [];

  /* порядок — из массива настроек, не из реестра (см. LyricsSettings) */
  const _on = cleanLyricsSources(sources);
  const enabled = _on.map(id => LYRICS_SOURCES.find(s => s.id === id)).filter(Boolean);
  const lines   = state?.status === 'ready' ? state.lines : null;
  /* `synced` в панели больше не читается: подпись «без таймкодов» убрана.
     само поле `state.synced` по-прежнему нужно — по нему App гоняет rAF
     подсветки (см. эффект активной строки) */

  /* Градиенты по краям контента — ОТДЕЛЬНЫМИ слоями поверх скроллера, а не
     mask'ом на нём: маска заставляет chromium перерастрировать содержимое
     в замаскированный слой на каждом кадре скролла, а transition по
     mask-image запускал вторую интерполяцию градиента в момент, когда
     список уже едет (то же, что в VirtualTrackList) */
  const EDGE_FADE = 20;
  const edges = edgesRef.current;
  const edgeFade = {
    position:'absolute', left:0, right:0, height: EDGE_FADE,
    pointerEvents:'none', zIndex:2,
    transition:'opacity 0.2s ease',
  };
  const fadeTop = { ...edgeFade, top:0,    background:'linear-gradient(to bottom, var(--bg), transparent)', opacity: edges.top ? 1 : 0 };
  const fadeBot = { ...edgeFade, bottom:0, background:'linear-gradient(to top,    var(--bg), transparent)', opacity: edges.bottom ? 1 : 0 };

  const scrollToActive = useCallback((smooth) => {
    const el   = bodyRef.current;
    const line = lineRefs.current[activeLine];
    if (!el || !line) return;
    const top = Math.max(0, line.offsetTop - el.clientHeight / 2 + line.offsetHeight / 2);
    autoUntilRef.current = Date.now() + (smooth ? 700 : 120);
    if (smooth) smoothScroll(el, top, 480);
    else el.scrollTop = top;
  }, [activeLine]);

  /* новый трек — новый текст: сбрасываем скролл в начало, иначе открытие
     с середины прошлого трека выглядело бы как случайность */
  useEffect(() => {
    if (state?.status !== 'loading') return;
    if (bodyRef.current) { bodyRef.current.scrollTop = 0; forceEdges() }
  }, [state, forceEdges]);

  /* края пересчитываются не только на скролле: контент мог смениться,
     панель открылась, окноresize */
  useEffect(() => {
    if (!open) return;
    const el = bodyRef.current;
    if (!el) return;
    const sync = () => {
      const top = el.scrollTop > 4;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 4;
      if (top !== edgesRef.current.top || bottom !== edgesRef.current.bottom) {
        edgesRef.current = { top, bottom };
        forceEdges();
      }
    };
    sync();
    const unbind = bindScrollInterrupt(el);   /* колесо прерывает ведение */
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => { unbind(); ro.disconnect() };
  }, [open, state, forceEdges]);

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
    /* границы контента: по ним рисуем градиенты у краёв панели, вместо
       постоянно висящей полосы. обе считаются напрямую из DOM — состояние
       ради двух булевых значений перекладывать не нужно */
    const el = bodyRef.current;
    if (el) {
      const top = el.scrollTop > 4;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 4;
      if (top !== edgesRef.current.top || bottom !== edgesRef.current.bottom) {
        edgesRef.current = { top, bottom };
        forceEdges();
      }
    }
    if (Date.now() < autoUntilRef.current) return;  /* это наша автопрокрутка */
    userScrollRef.current = Date.now();
  }, []);

  /* Один стиль на чип источника и на кнопку возврата — по просьбе выключалка
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
  };

  return (
    <div style={{
      position:'absolute', inset:0, display:'flex', flexDirection:'column',
      opacity: open ? 1 : 0,
      /* inPlayer — тот же трюк, что у слоя списка: `pointer-events:none` на
         скрытом слое плеера не гасит потомка, который сам ставит auto. Панель
         закрыта, но на главной всё равно оставалась целью для кликов в
         левом краю. */
      pointerEvents: inPlayer && open ? 'auto' : 'none',
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
          return (
            <span key={s.id} title={dead ? entry.why : undefined} style={{
              ...CHIP,
              color: used ? 'rgba(255,255,255,0.6)' : CHIP.color,
              background: used ? 'rgba(var(--accent-rgb),0.1)' : CHIP.background,
              border: used ? '1px solid rgba(var(--accent-rgb),0.28)' : CHIP.border,
            }}>
              {dead && <span style={{width:4, height:4, borderRadius:'50%', background:'rgba(255,80,60,0.7)', flexShrink:0}}/>}
              {busy && <span style={{
                width:7, height:7, borderRadius:'50%', flexShrink:0,
                border:'1px solid rgba(255,255,255,0.28)',
                borderTopColor:'rgba(255,255,255,0.7)',
                animation:'spin 0.7s linear infinite',
              }}/>}
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
        <div onClick={onBack} title={t('lyrics_back')} style={{
          ...CHIP, flexShrink:0, cursor:'pointer',
          justifyContent:'center', color:'rgba(255,255,255,0.3)',
          transition:'background 0.15s, color 0.15s',
        }}
          onMouseEnter={e => { e.currentTarget.style.background='rgba(255,255,255,0.08)'; e.currentTarget.style.color='rgba(255,255,255,0.75)'; }}
          onMouseLeave={e => { e.currentTarget.style.background=CHIP.background; e.currentTarget.style.color='rgba(255,255,255,0.3)'; }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round">
            <path d="M8 6h13M8 12h13M8 18h13"/>
            <circle cx="3.6" cy="6" r="1" fill="currentColor" stroke="none"/>
            <circle cx="3.6" cy="12" r="1" fill="currentColor" stroke="none"/>
            <circle cx="3.6" cy="18" r="1" fill="currentColor" stroke="none"/>
          </svg>
        </div>
      </div>

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
        {lines && lines.map((l, i) => l.section ? null : (
          <div key={i} ref={el => { if (el) lineRefs.current[i] = el; }}
            onClick={() => l.t != null && onSeek(l.t)}
            title={l.t != null ? t('lyrics_tap_line') : undefined}
            style={{
              fontSize:'var(--fs-md)', lineHeight:1.5,
              color: i === activeLine ? 'var(--accent)' : 'rgba(255,255,255,0.34)',
              fontWeight: i === activeLine ? 600 : 500,
              transform: i === activeLine ? 'translateX(2px)' : 'translateX(0)',
              cursor: l.t != null ? 'pointer' : 'default',
              padding:'3px 0', borderRadius:5,
              transition:'color 0.28s ease, font-weight 0.28s ease, transform 0.28s ease',
            }}>{l.text}</div>
        ))}

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
      {/* градиенты по краям — индикация «есть что прокрутить» */}
      <div style={fadeTop}/>
      <div style={fadeBot}/>
      </div>
    </div>
  );
}

/* ── HomeCard ────────────────────────────────────────────────────────────── */
const HomeCard = React.memo(function HomeCard({ track, onSelect, artRef, artHidden, isLiked, onLike }) {
  const handleClick = useCallback(() => onSelect(track), [onSelect, track]);
  const [popKey, setPopKey] = useState(0);
  return (
    <motion.div className="home-card" onClick={handleClick}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      whileHover={{ scale: 1.03 }}
      exit={{ opacity: 0, scale: 0.88 }}
      transition={{ type:'spring', stiffness: 380, damping: 32, mass: 0.6 }}
      style={{
        borderRadius:16, cursor:'pointer',
      }}>
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
    </motion.div>
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
      <AnimatePresence initial={false}>
        {list.map(t => (
          <HomeCard key={t.id} track={t}
            artRef={getArtRef(t.id)}
            onSelect={onSelect}
            artHidden={(reverseId != null && t.id === reverseId) || (heroId != null && t.id === heroId)}
            isLiked={likedIds ? likedIds.has(t.id) : false}
            onLike={onLike}/>
        ))}
      </AnimatePresence>
    </div>
  );
});

/* ── Hero clone ──────────────────────────────────────────────────────────── */
const HERO_DUR_MS  = 430;
const HERO_FADE_MS = 140;
/* ⚠️ было `expo.inOut` — и это была ровно та резкость, на которую жаловались.
   expo.inOut держит пол пути в середине: между 25% и 75% времени проходит
   ~97% дистанции. обложка будто стоит на месте, потом р��зко пролетает
   экран, потом снова стоит — «хлёсткий» перелёт.
   power3.inOut в той же середине проходит ~87%, и он симметричен, поэтому
   разгон и торможение читаются плавно. `sine.inOut` мягче ещё, но на
   длинной дистанции обложка начинает «плыть» — если покажется вяло,
   двигать сюда, а не трогать остальное. */
const HERO_EASE    = 'power3.inOut';
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

  // run the timeline BEFORE first paint so there is no flash in the target rect
  useLayoutEffect(() => {
    const el = cloneRef.current;
    if (!el) return;
    /* ⚠️ transform и border-radius РАЗВЕДЕНЫ по времени, и это ради плавности.
       border-radius — некомпозитное свойство: пока он меняется, Chromium
       обязан перерисовать слой клона, а внутри него ещё и ресемплировать
       обложку под новую кривую. на элементе ~500×500 это перерисовка
       картинки каждый кадр все 430мс полёта. transform же чисто
       композиционный, и стоит дорого только пока меняется радиус.
       Поэтому морф держим BR_MORTH (55% полёта), а остаток — чистый
       композиционный transform. посадка к 55% уже в 16px, так что к
       моменту приземления углы ровные и щелчка нет.
       Значения радиуса округляются до целых пикселей: 16→53px набирает
       ~37 различных значений, и на каждом смене — перерисовка. */
    const BR_MORPH = 0.55;
    const rNums = s => s.split(/\s+/).map(parseFloat);
    const tl = gsap.timeline();
    const from = reverse
      ? { x: 0, y: 0, scale: 1, br: BR4 }
      : { x: dx, y: dy, scale: sc, br: BR_END };
    const to = reverse
      ? { x: dx, y: dy, scale: sc, br: BR_END }
      : { x: 0, y: 0, scale: 1, br: BR4 };
    /* transform — на всю длительность, только он
       композитный и его можно отдать GPU целиком */
    tl.fromTo(el, { x: from.x, y: from.y, scale: from.scale },
      { x: to.x, y: to.y, scale: to.scale, ease: HERO_EASE, duration: DUR, force3D: true }, 0);
    /* радиус — отдельным твином на BR_MORTH длительности, пишем сами,
       чтобы округлять до целых и не перерисовывать на дробных */
    const A = rNums(from.br), B = rNums(to.br);
    const brS = { p: 0 };
    tl.fromTo(brS, { p: 0 }, {
      p: 1, ease: HERO_EASE, duration: DUR * BR_MORPH,
      onUpdate: () => {
        const k = brS.p;
        el.style.borderRadius = (A[0]+(B[0]-A[0])*k).toFixed(0) + 'px '
          + (A[1]+(B[1]-A[1])*k).toFixed(0) + 'px '
          + (A[2]+(B[2]-A[2])*k).toFixed(0) + 'px '
          + (A[3]+(B[3]-A[3])*k).toFixed(0) + 'px';
      },
      onComplete: () => { el.style.borderRadius = to.br; },
    }, 0);
    /* ❌ раньше здесь параллельно анимировался `clip-path: inset(0 round …)`
       на <img> — «в такт радиусу родителя». это было ИЗБЫЧНО: у контейнера
       `overflow:hidden` и анимируемый `borderRadius` с тем же радиусом, то
       есть картинка и так обрезается скруглением родителя. вторая
       растеризация той же кривой (плюс на масштабированной картинке)
       стоила кадра на каждом шаге, а дропы кадров читаются как
       дёргасть — то есть добавляли ровно ту «резкость», которую
       убирали. теперь скругление ведёт только родитель. */
    return () => tl.kill();
  }, []);

  useEffect(() => {
    if (!exiting || !cloneRef.current) return;
    const tween = gsap.to(cloneRef.current, {
      opacity: 0,
      duration: HERO_FADE_MS / 1000,
      ease: 'power2.out',
      force3D: true,
    });
    return () => tween.kill();
  }, [exiting]);

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
      borderRadius: reverse ? BR4 : BR_END,
      overflow:'hidden',
      background:'#111116',
      willChange:'transform, opacity',
      backfaceVisibility:'hidden',
      contain:'layout style paint',
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
    </div>,
    document.body
  );
}

/* ── TopBar ──────────────────────────────────────────────────────────────── */
/* навигация в тайтлбаре: слева аватар→настройки→source-тумблер, по центру
   (абсолютно на окно) сегмент Плейлисты|Треки|Плеер|Поиск с горизонтальным
   пиллом, справа collapse библиотеки (только в плеере). рендерится порталами в
   #topbar-slot и #titlebar (тайтлбар — статический html вне react-root) */
function TopBar({ navActive, onNav, libCollapsed, onToggleLib, inPlayer, scAuth, sourceMode, onToggleSource }) {
  const t = useLang();
  const navImg = (src, s=17) => <img src={src} style={{width:s, height:s, filter:'brightness(0) invert(1)', display:'block'}}/>;
  const NAV = [
    { id:"playlists", label:t('nav_playlists'), icon: navImg('../assets/playlists.png') },
    { id:"home",    label:t('nav_tracks'),  icon: navImg('../assets/tracks.png')  },
    { id:"library", label:t('nav_player'),  icon: navImg('../assets/player.png', 19), size:38 },
    { id:"search",  label:t('nav_search'),  icon: navImg('../assets/search.png')  },
  ];
  const folderIcon = navImg('../assets/local.png');

  const navRefs = useRef({});
  const navWrapRef = useRef(null);
  const [pillRect, setPillRect] = useState({ left: 0, width: 34, visible: false });
  /* вкладка «Плеер» стоит ровно по центру окна: сегмент смещается так,
     чтобы центр library-кнопки попал на 50% ширины (слева 2 вкладки, справа 1) */
  const [navShift, setNavShift] = useState(0);

  useLayoutEffect(() => {
    const el = navRefs.current[navActive];
    if (!el || (navActive !== 'playlists' && navActive !== 'home' && navActive !== 'search' && navActive !== 'library')) {
      setPillRect(p => ({ ...p, visible: false }));
      return;
    }
    setPillRect({ left: el.offsetLeft, width: el.offsetWidth, visible: true });
  }, [navActive]);

  useLayoutEffect(() => {
    const measure = () => {
      const wrap = navWrapRef.current, el = navRefs.current['library'];
      if (!wrap || !el) return;
      setNavShift(wrap.offsetWidth / 2 - (el.offsetLeft + el.offsetWidth / 2));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const NoDrag = { WebkitAppRegion:'no-drag' };
  const slot = document.getElementById('topbar-slot');
  const bar  = document.getElementById('titlebar');
  if (!slot || !bar) return null;

  /* центрированный сегмент — абсолют внутри #titlebar; «Плеер» ровно по центру окна */
  const nav = (
    <div ref={navWrapRef} style={{position:'absolute', left:'50%', top:'50%', translate:'-50% -50%',
      transform:`translateX(${navShift}px)`,
      display:'flex', alignItems:'center', gap:4, WebkitAppRegion:'no-drag'}}>
      <div style={{
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
          {/* левый кластер: настройки → source-тумблер */}
          <div style={{display:'flex', alignItems:'center', gap:2, paddingLeft:10}}>
            <div style={{WebkitAppRegion:'no-drag'}}>
              <NavIcon label={t('nav_settings')} active={navActive==='settings'} onClick={()=>onNav('settings')} size={32}
                icon={<img src="../assets/settings.png" style={{width:17,height:17,filter:'brightness(0) invert(1)',display:'block'}}/>}/>
            </div>
            <div style={{WebkitAppRegion:'no-drag', opacity: scAuth ? 1 : 0, pointerEvents: scAuth ? 'auto' : 'none', transition:'opacity 0.2s ease'}}>
              <NavIcon label={t('nav_local')} active={sourceMode==='local'} onClick={onToggleSource} size={32} icon={folderIcon}/>
            </div>
          </div>

          {/* правая зона: collapse библиотеки (только в плеере) */}
          <div style={{flex:1, display:'flex', alignItems:'center', justifyContent:'flex-end', paddingRight:6,
            opacity: inPlayer ? 1 : 0, pointerEvents: inPlayer ? 'auto' : 'none', transition:'opacity 0.2s ease'}}>
            <div style={{WebkitAppRegion:'no-drag', width:30, height:30, borderRadius:9, cursor:'pointer',
              display:'flex', alignItems:'center', justifyContent:'center',
              color:'rgba(255,255,255,0.35)', transition:'color 0.18s ease'}}
              onClick={onToggleLib}
              onMouseEnter={e=>e.currentTarget.style.color='rgba(255,255,255,0.7)'}
              onMouseLeave={e=>e.currentTarget.style.color='rgba(255,255,255,0.35)'}>
              <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
                style={{transition:'transform 0.26s cubic-bezier(0.4,0,0.2,1)', transform: libCollapsed ? 'rotate(180deg)' : 'rotate(0deg)'}}>
                <polyline points="15 18 9 12 15 6"/>
              </svg>
            </div>
          </div>
        </div>, slot)}
      {createPortal(nav, bar)}
    </>
  );
}

/* ── CrossfadeSlider ─────────────────────────────────────────────────────── */
function CrossfadeSlider({ value, onChange }) {
  const t = useLang();
  const trackRef    = useRef(null);
  const onChangeRef = useRef(onChange);
  const valueRef    = useRef(value);
  onChangeRef.current = onChange;
  valueRef.current    = value;

  const calcVal = (clientX) => {
    const rect = trackRef.current.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * 12);
  };

  useEffect(() => {
    const el = trackRef.current;
    const onWheel = e => {
      e.preventDefault();
      onChangeRef.current(Math.max(0, Math.min(12, valueRef.current + (e.deltaY > 0 ? -1 : 1))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const pct = ((value || 0) / 12) * 100;

  return (
    <div style={{display:'flex', alignItems:'center', gap:12}}>
      <div ref={trackRef}
        style={{width:150, height:24, display:'flex', alignItems:'center', cursor:'ew-resize', userSelect:'none', touchAction:'none'}}
        onPointerDown={e => {
          e.currentTarget.setPointerCapture(e.pointerId);
          onChangeRef.current(calcVal(e.clientX));
        }}
        onPointerMove={e => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
          onChangeRef.current(calcVal(e.clientX));
        }}
        onPointerUp={e => {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}>
        <div style={{width:'100%', height:6, borderRadius:3, background:'rgba(255,255,255,0.07)', position:'relative', overflow:'hidden'}}>
          <div style={{
            position:'absolute', left:0, top:0, height:'100%',
            width:`${pct}%`, borderRadius:3,
            background:'#c8c8c8',
            boxShadow: pct > 0 ? '0 0 8px rgba(178,178,178,0.45)' : 'none',
          }}/>
        </div>
      </div>
      <span style={{fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.32)', minWidth:28, textAlign:'right'}}>
        {value === 0 ? t('off') : `${value} ${t('sec')}`}
      </span>
    </div>
  );
}

/* ── ClearCacheCard ───────────────────────────────────────────────────────── */
function ClearCacheCard({ Card, Row, onClearCoversCache, onClearLikesCache }) {
  const t = useLang();
  const [confirmCovers, setConfirmCovers] = useState(false);
  const [confirmLikes,  setConfirmLikes]  = useState(false);
  const btn = (label, onClick) => (
    <div onClick={onClick} style={{fontSize: 'var(--fs-sm)', color:'rgba(255,80,80,0.8)', cursor:'pointer', background:'rgba(255,80,80,0.08)', borderRadius:7, padding:'5px 14px'}}>
      {label}
    </div>
  );
  const cancel = (fn) => (
    <div onClick={fn} style={{fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.45)', cursor:'pointer', background:'rgba(255,255,255,0.055)', borderRadius:7, padding:'5px 14px'}}>
      {t('cancel')}
    </div>
  );
  return (
    <Card title={t('cache')}>
      <Row label={t('covers_cache')} sub={t('covers_cache_sub')}>
        {confirmCovers ? (
          <div style={{display:'flex', gap:8, flexShrink:0}}>
            {cancel(()=>setConfirmCovers(false))}
            {btn(t('del'), ()=>{ onClearCoversCache(); setConfirmCovers(false); })}
          </div>
        ) : (
          <div onClick={()=>setConfirmCovers(true)} style={{fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.45)', cursor:'pointer', background:'rgba(255,255,255,0.055)', borderRadius:7, padding:'5px 14px'}}>{t('clear')}</div>
        )}
      </Row>
      <Row label={t('likes_cache')} sub={t('likes_cache_sub')} last>
        {confirmLikes ? (
          <div style={{display:'flex', gap:8, flexShrink:0}}>
            {cancel(()=>setConfirmLikes(false))}
            {btn(t('del'), ()=>{ onClearLikesCache(); setConfirmLikes(false); })}
          </div>
        ) : (
          <div onClick={()=>setConfirmLikes(true)} style={{fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.45)', cursor:'pointer', background:'rgba(255,255,255,0.055)', borderRadius:7, padding:'5px 14px'}}>{t('clear')}</div>
        )}
      </Row>
    </Card>
  );
}

/* ── LyricsSettings ───────────────────────────────────────────────────────── */
/* пара «стрелки приоритета» у строки источника. на краях списка стрелка
   гаснет и не кликается. на модульном уровне — вложенный компонент
   пересоздавался бы на каждом рендере (см. TrackContextMenu) */
function SourceArrows({ i, count, onMove, upTitle, downTitle }) {
  return (
    <div style={{display:'flex', flexDirection:'column', gap:1, flexShrink:0}}>
      {[-1, 1].map(dir => {
        const edge = i + dir < 0 || i + dir >= count;
        return (
          <div key={dir} onClick={() => { if (!edge) onMove(i, dir); }}
            title={dir < 0 ? upTitle : downTitle}
            style={{
              width:18, height:12, borderRadius:4,
              display:'flex', alignItems:'center', justifyContent:'center',
              cursor: edge ? 'default' : 'pointer',
              color: edge ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.24)',
              transition:'color 0.15s, background 0.15s',
            }}
            onMouseEnter={e => { if (!edge) e.currentTarget.style.color = 'rgba(255,255,255,0.72)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = edge ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.24)'; }}>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"
              style={{transform: dir < 0 ? 'none' : 'rotate(180deg)'}}>
              <path d="m6 15 6-6 6 6"/>
            </svg>
          </div>
        );
      })}
    </div>
  );
}

function LyricsSettings({ settings, onSettings, Card, Toggle }) {
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
  const div = settings.hideDividers ? 'none' : '1px solid rgba(255,255,255,0.045)';

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
    <Card title={t('lyrics_sources')}>
      <div style={{
        padding:'13px 20px 11px',
        fontSize:'var(--fs-xs)', color:'rgba(255,255,255,0.28)', lineHeight:1.45,
      }}>{t('lyrics_sources_sub')}</div>

      {enabled.map((s, i) => (
        <div key={s.id} style={{
          display:'flex', alignItems:'center', gap:11, padding:'10px 16px 10px 12px',
          borderBottom: (disabled.length || i === enabled.length - 1) ? div : 'none',
        }}>
          <SourceArrows i={i} count={enabled.length} onMove={move}
            upTitle={t('lyrics_up')} downTitle={t('lyrics_down')}/>
          <div style={{flex:1, minWidth:0, display:'flex', alignItems:'center', gap:8}}>
            <span style={{fontSize:'var(--fs-md)', color:'rgba(255,255,255,0.75)'}}>{s.label}</span>
            {s.synced && (
              <span style={{
                fontSize:'var(--fs-eyebrow)', letterSpacing:'0.06em', textTransform:'uppercase',
                color:'rgba(255,255,255,0.26)', padding:'2px 6px', borderRadius:5,
                background:'rgba(255,255,255,0.05)', flexShrink:0,
              }}>{t('lyrics_synced')}</span>
            )}
          </div>
          <Toggle value onChange={() => toggle(s.id)}/>
        </div>
      ))}

      {enabled.length === 0 && (
        <div style={{
          padding:'2px 20px 14px', fontSize:'var(--fs-xs)',
          color:'rgba(255,255,255,0.22)', lineHeight:1.45,
        }}>{t('lyrics_all_off')}</div>
      )}

      {disabled.length > 0 && (
        <>
          <div style={{
            padding:'12px 20px 4px',
            fontSize:'var(--fs-eyebrow)', letterSpacing:'0.09em', textTransform:'uppercase',
            color:'rgba(255,255,255,0.2)',
          }}>{t('lyrics_off')}</div>
          {disabled.map((s, i) => (
            <div key={s.id} style={{
              display:'flex', alignItems:'center', gap:11, padding:'10px 20px',
              borderBottom: i === disabled.length - 1 ? 'none' : div,
            }}>
              {/* место под стрелки, чтобы названия выключенных не съезжали влево */}
              <div style={{width:18, flexShrink:0}}/>
              <span style={{flex:1, minWidth:0, fontSize:'var(--fs-md)', color:'rgba(255,255,255,0.3)'}}>
                {s.label}
              </span>
              <Toggle value={false} onChange={() => toggle(s.id)}/>
            </div>
          ))}
        </>
      )}
    </Card>
  );
}

/* ── SettingsView ─────────────────────────────────────────────────────────── */
function SettingsView({ settings, onSettings, visible, onScanTracks, onClearFolder, onClearCoversCache, onClearLikesCache, appAccent, scAuth, onScLogin, onScLogout, sec, setSec, discordStatus }) {
  const t = useLang();
  const [scLoading, setScLoading] = useState(false);
  const [scError, setScError] = useState(null);
  const scLogin = async () => {
    setScLoading(true); setScError(null);
    try {
      const creds = await window.electronAPI.scLogin();
      if (!creds) { setScLoading(false); return; }
      const res = await window.electronAPI.scFetch('https://api-v2.soundcloud.com/me', creds.token, creds.clientId);
      if (res.data) onScLogin({ ...creds, userId: res.data.id, username: res.data.username, avatarUrl: res.data.avatar_url || null });
      else setScError(t('profile_error'));
    } catch { setScError(t('conn_error')); }
    setScLoading(false);
  };
  const set = (k, v) => onSettings({ ...settings, [k]: v });
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

  /* k — ключ в settings. либо вместо него явные value/onChange:
     тумблер поверх не-булевой настройки (порядок источников текста) */
  const Toggle = ({ k, value, onChange }) => {
    const on = value !== undefined ? !!value : !!settings[k];
    return (
      <div style={{
        width:38, height:22, borderRadius:11, cursor:'pointer', flexShrink:0,
        background: on ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.1)',
        position:'relative', transition:'background 0.22s ease',
      }} onClick={() => onChange !== undefined ? onChange(!on) : set(k, !on)}>
        <div style={{
          position:'absolute', top:4, width:14, height:14, borderRadius:'50%',
          background:'#fff', boxShadow:'0 1px 4px rgba(0,0,0,0.4)',
          left: on ? 20 : 4,
          transition:'left 0.22s cubic-bezier(0.4,0,0.2,1)',
        }}/>
      </div>
    );
  };

  const Row = ({ label, sub, children, last }) => (
    <div style={{
      display:'flex', alignItems:'center', justifyContent:'space-between',
      padding:'13px 20px',
      borderBottom: (last || !!settings.hideDividers) ? 'none' : '1px solid rgba(255,255,255,0.045)',
    }}>
      <div>
        <div style={{fontSize: 'var(--fs-md)', color:'rgba(255,255,255,0.75)'}}>{label}</div>
        {sub && <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.28)', marginTop:2}}>{sub}</div>}
      </div>
      {children}
    </div>
  );

  const Card = ({ title, children }) => (
    <div style={{marginBottom:18}}>
      {title && <div style={{
        fontSize: 'var(--fs-xs)', letterSpacing:'0.09em', textTransform:'uppercase',
        color:'rgba(255,255,255,0.25)', marginBottom:8, paddingLeft:4,
      }}>{title}</div>}
      <div style={{
        background:'rgba(255,255,255,0.034)',
        borderRadius:13, overflow:'hidden',
      }}>{children}</div>
    </div>
  );

  const SECS = [
    { id:'account',  label:t('card_account'),
      icon:<SoundCloudIcon size={14} fill="rgba(255,255,255,0.5)"/> },
    { id:'playback', label:t('sec_playback'),
      icon:<img src="../assets/vosproizvedenie.png" style={{width:15,height:15,filter:'brightness(0) invert(1)',display:'block'}}/> },
    { id:'lyrics',   label:t('sec_lyrics'),
      icon:<img src="../assets/textt.png" style={{width:15,height:15,filter:'brightness(0) invert(1)',display:'block'}}/> },
    { id:'discord',  label:t('sec_discord'),
      icon:<DiscordIcon size={15} fill="rgba(255,255,255,0.5)"/> },
    { id:'appearance', label:t('sec_appearance'),
      icon:<img src="../assets/theme.png" style={{width:15,height:15,filter:'brightness(0) invert(1)',display:'block'}}/> },
    { id:'system',   label:t('sec_system'),
      icon:<img src="../assets/system.png" style={{width:15,height:15,filter:'brightness(0) invert(1)',display:'block'}}/> },
    { id:'about',    label:t('sec_about'),
      icon:<img src="../assets/about.png" style={{width:15,height:15,filter:'brightness(0) invert(1)',display:'block'}}/> },
  ];

  const content = {
    account: (
      <Card title={t('card_account')}>
        {scAuth ? (
          <div style={{display:'flex', alignItems:'center', gap:14, padding:'16px'}}>
            <div style={{
              width:46, height:46, borderRadius:14, flexShrink:0, overflow:'hidden',
              background:'rgba(178,178,178,0.06)',
              display:'flex', alignItems:'center', justifyContent:'center',
              color:'var(--accent)',
            }}>
              {scAuth.avatarUrl
                ? <img src={scAuth.avatarUrl} style={{width:'100%',height:'100%',objectFit:'cover'}}/>
                : <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
              }
            </div>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontSize: 'var(--fs-lg)', fontWeight:600, letterSpacing:'-0.015em', color:'rgba(255,255,255,0.85)',
                whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{scAuth.username || t('unknown')}</div>
              <div style={{fontSize: 'var(--fs-eyebrow)', color:'rgba(255,255,255,0.26)', letterSpacing:'0.08em', textTransform:'uppercase', marginTop:3}}>soundcloud</div>
            </div>
            <button onClick={onScLogout} style={{
              background:'rgba(255,255,255,0.04)', border:'none',
              borderRadius:9, padding:'7px 16px', flexShrink:0,
              fontSize: 'var(--fs-sm)', fontWeight:500, color:'rgba(255,255,255,0.5)',
              cursor:'pointer', fontFamily:'inherit',
              transition:'background 0.15s, color 0.15s',
            }}
              onMouseEnter={e=>{ e.currentTarget.style.background='rgba(255,255,255,0.07)'; e.currentTarget.style.color='rgba(255,255,255,0.75)'; }}
              onMouseLeave={e=>{ e.currentTarget.style.background='rgba(255,255,255,0.04)'; e.currentTarget.style.color='rgba(255,255,255,0.5)'; }}
            >{t('logout')}</button>
          </div>
        ) : (
          <div style={{padding:'16px'}}>
            <div style={{display:'flex', alignItems:'center', gap:14, marginBottom:14}}>
              <div style={{
                width:46, height:46, borderRadius:14, flexShrink:0,
                background:'rgba(255,85,0,0.07)',
                display:'flex', alignItems:'center', justifyContent:'center',
              }}>
                <SoundCloudIcon size={24} fill="rgba(255,100,20,0.65)"/>
              </div>
              <div style={{flex:1, minWidth:0}}>
                <div style={{fontSize: 'var(--fs-md)', fontWeight:600, letterSpacing:'-0.015em', color:'rgba(255,255,255,0.6)', marginBottom:4}}>{t('sc_not_connected')}</div>
                <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.26)', lineHeight:1.55}}>{t('sc_hint').split('\n').map((l,i)=><span key={i}>{l}{i===0&&<br/>}</span>)}</div>
              </div>
            </div>
            {scError && <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,80,60,0.7)', marginBottom:10}}>{scError}</div>}
            <button onClick={scLogin} disabled={scLoading} style={{
              background: scLoading ? 'rgba(255,85,0,0.06)' : 'rgba(255,85,0,0.1)',
              border:'none', borderRadius:10, padding:'9px 22px',
              fontSize: 'var(--fs-sm)', fontWeight:500,
              color: scLoading ? 'rgba(255,130,60,0.4)' : 'rgba(255,130,60,0.85)',
              cursor: scLoading ? 'default' : 'pointer', fontFamily:'inherit',
              transition:'background 0.15s, color 0.15s',
            }}
              onMouseEnter={e=>{ if(!scLoading) e.currentTarget.style.background='rgba(255,85,0,0.17)'; }}
              onMouseLeave={e=>{ e.currentTarget.style.background=scLoading?'rgba(255,85,0,0.06)':'rgba(255,85,0,0.1)'; }}
            >{scLoading ? t('opening_browser') : t('login_browser')}</button>
          </div>
        )}
      </Card>
    ),
    playback: (
      <Card title={t('card_audio')}>
        <Row label={t('crossfade')} sub={t('crossfade_sub')} last>
          <CrossfadeSlider value={settings.crossfade} onChange={v=>set('crossfade', v)}/>
        </Row>
      </Card>
    ),
    lyrics: (
      <LyricsSettings settings={settings} onSettings={onSettings} Card={Card} Toggle={Toggle}/>
    ),
    appearance: (<>
      <Card title={t('accent_title')}>
        <div style={{padding:'14px 16px 16px'}}>
          <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.32)', marginBottom:14, lineHeight:1.4}}>
            {t('accent_sub')}
          </div>
          {(() => {
            const mode = settings.accentMode || 'color';
            const preset = ACCENT_PRESETS[settings.accentPreset] ? settings.accentPreset : 'default';
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
                {/* сегмент Выкл | Цвет | От обложки — пилл плавно ездит между опциями */}
                <LayoutGroup>
                  <div style={{display:'flex', gap:3, padding:3, borderRadius:11, background:'rgba(255,255,255,0.035)'}}>
                    {SEGS.map(([id, label, icon]) => {
                      const active = mode === id;
                      return (
                        <div key={id}
                          /* клик по УЖЕ активной вкладке — полный no-op. раньше
                             onSettings звал с новым объектом, палитра и
                             сохранение перезапускались впустую */
                          onClick={() => { if (active) return; onSettings(s => ({ ...s, accentMode: id })); }}
                          style={{position:'relative', flex:1, display:'flex', alignItems:'center', justifyContent:'center',
                            padding:'8px 0', borderRadius:9, cursor:'pointer', userSelect:'none',
                            color: active ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.38)',
                            transition:'color 0.18s ease'}}>
                          {active && (
                            <motion.div layoutId="accentSegPill"
                              transition={{ type:'spring', stiffness:420, damping:34, mass:0.7 }}
                              style={{position:'absolute', inset:0, borderRadius:9, background:'rgba(255,255,255,0.07)'}}/>
                          )}
                          <span style={{position:'relative', display:'flex', alignItems:'center', gap:6, fontSize: 'var(--fs-xs)',
                            fontWeight: active ? 600 : 500}}>{icon}{label}</span>
                        </div>
                      );
                    })}
                  </div>
                </LayoutGroup>
                {/* контекстный блок под выбранным режимом */}
                <div key={mode} style={{marginTop:16, animation:'fadeInUp 0.22s ease'}}>
                  {mode === 'color' && (
                    <div style={{display:'flex', flexWrap:'wrap', gap:10}}>
                      {[
                        ['default',  t('accent_default')],
                        ['lavender', t('accent_lavender')],
                        ['mint',     t('accent_mint')],
                        ['rose',     t('accent_rose')],
                        ['amber',    t('accent_amber')],
                      ].map(([key, label]) => {
                        const c = ACCENT_PRESETS[key];
                        const active = preset === key;
                        return (
                          <div key={key}
                            /* тот же принцип: повторный клик по выбранному
                               образцу не перезапускает палитру и запись */
                            onClick={() => { if (active) return; onSettings(s => ({ ...s, accentMode:'color', accentPreset:key })); }}
                            style={{
                              display:'flex', flexDirection:'column', alignItems:'center', gap:6,
                              cursor:'pointer', padding:'8px 6px', borderRadius:10,
                              flex:'1 0 70px',
                              background: active ? 'rgba(255,255,255,0.06)' : 'transparent',
                              transition:'background 0.18s',
                            }}
                            onMouseEnter={e => { if (!active) e.currentTarget.style.background='rgba(255,255,255,0.035)'; }}
                            onMouseLeave={e => { if (!active) e.currentTarget.style.background='transparent'; }}
                          >
                            <div style={{
                              width:32, height:32, borderRadius:'50%',
                              background:`rgb(${c.r},${c.g},${c.b})`,
                              boxShadow: active
                                ? `0 0 0 2px #07070a, 0 0 0 4px rgba(${c.r},${c.g},${c.b},0.9), 0 0 18px rgba(${c.r},${c.g},${c.b},0.55)`
                                : `0 2px 8px rgba(${c.r},${c.g},${c.b},0.25)`,
                              transition:'box-shadow 0.22s',
                            }}/>
                            <div style={{
                              fontSize: 'var(--fs-xs)', fontWeight: active ? 600 : 500,
                              color: active ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.45)',
                              transition:'color 0.18s',
                            }}>{label}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {mode === 'cover' && (
                    <div onClick={() => onSettings(s => ({ ...s, accentMode:'cover' }))}
                      style={{
                        position:'relative',
                        display:'flex', alignItems:'center', gap:14,
                        padding:'12px 14px', borderRadius:12, cursor:'pointer',
                        background:'rgba(255,255,255,0.05)',
                        border:'1px solid transparent',
                        transition:'background 0.2s',
                        overflow:'hidden',
                      }}
                    >
                      {/* rainbow border ring */}
                      <div style={{
                        position:'absolute', inset:0, borderRadius:12,
                        padding:1.5,
                        background:'conic-gradient(from 0deg, #ff8fb1, #ffb164, #ffeb6b, #82dcc3, #9b7dff, #ff8fb1)',
                        WebkitMask:'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
                        WebkitMaskComposite:'xor', maskComposite:'exclude',
                        pointerEvents:'none',
                      }}/>
                      <div style={{
                        width:38, height:38, borderRadius:'50%',
                        background:'conic-gradient(from 0deg, #ff8fb1, #ffb164, #ffeb6b, #82dcc3, #9b7dff, #ff8fb1)',
                        boxShadow:`0 0 22px rgba(${appAccent.r},${appAccent.g},${appAccent.b},0.55)`,
                        flexShrink:0,
                        display:'flex', alignItems:'center', justifyContent:'center',
                        transition:'box-shadow 0.4s',
                      }}>
                        {/* palette icon */}
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(7,7,10,0.85)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 0-4-4h-2a2 2 0 0 1-2-2v-2a4 4 0 0 0-2-2z"/>
                          <circle cx="6.5" cy="11.5" r="1"/><circle cx="9.5" cy="7.5" r="1"/><circle cx="14.5" cy="7.5" r="1"/><circle cx="17.5" cy="11.5" r="1"/>
                        </svg>
                      </div>
                      <div style={{flex:1, minWidth:0}}>
                        <div style={{fontSize: 'var(--fs-md)', fontWeight:600, color:'rgba(255,255,255,0.95)', letterSpacing:'-0.005em'}}>
                          {t('accent_cover')}
                        </div>
                        <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.38)', marginTop:2}}>
                          {t('accent_cover_sub')}
                        </div>
                      </div>
                      {/* live swatch preview */}
                      <div style={{
                        width:14, height:14, borderRadius:'50%',
                        background:`rgb(${appAccent.r},${appAccent.g},${appAccent.b})`,
                        boxShadow:`0 0 12px rgba(${appAccent.r},${appAccent.g},${appAccent.b},0.7)`,
                        transition:'background 0.4s, box-shadow 0.4s',
                        flexShrink:0,
                      }}/>
                    </div>
                  )}
                  {mode === 'off' && (
                    <div style={{
                      display:'flex', alignItems:'center', gap:14,
                      padding:'12px 14px', borderRadius:12,
                      background:'rgba(255,255,255,0.025)', border:'1px solid rgba(255,255,255,0.04)',
                    }}>
                      <div style={{
                        width:38, height:38, borderRadius:'50%', background:'rgba(255,255,255,0.05)',
                        display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0,
                        color:'rgba(255,255,255,0.35)',
                      }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 3v9"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>
                        </svg>
                      </div>
                      <div style={{flex:1, minWidth:0}}>
                        <div style={{fontSize: 'var(--fs-md)', fontWeight:600, color:'rgba(255,255,255,0.6)', letterSpacing:'-0.005em'}}>
                          {t('accent_off_title')}
                        </div>
                        <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.3)', marginTop:2, lineHeight:1.5}}>
                          {t('accent_off_sub')}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </>
            );
          })()}

          {/* тумблер пятна за обложкой — в этой же карточке, а не в «Интерфейсе» */}
          <div style={{
            display:'flex', alignItems:'center', justifyContent:'space-between', gap:12,
            marginTop:16, paddingTop:14,
            /* инлайн, а не через константу `div`: она объявлена в
               LyricsSettings, в SettingsView её нет (ReferenceError) */
            borderTop: settings.hideDividers ? 'none' : '1px solid rgba(255,255,255,0.045)',
            opacity: settings.accentMode === 'off' ? 0.4 : 1,
            transition:'opacity 0.2s ease',
          }}>
            <div style={{minWidth:0}}>
              <div style={{fontSize: 'var(--fs-md)', color:'rgba(255,255,255,0.75)'}}>
                {t('art_glow')}
              </div>
              <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.28)', marginTop:2, lineHeight:1.45}}>
                {t('art_glow_sub')}
              </div>
            </div>
            <Toggle k="ambientGlow"/>
          </div>
        </div>
      </Card>
      <Card title={t('card_interface')}>
        <Row label={t('hide_dividers')} sub={t('hide_dividers_sub')} last><Toggle k="hideDividers"/></Row>
      </Card>
    </>),
    /* секция discord вынесена из оформления: это интеграция, а не вид */
    discord: (<>
      <Card title={t('card_discord')}>
        <Row label={t('discord_rpc')} sub={t('discord_rpc_sub')} last={!settings.discordRpc}>
          <Toggle k="discordRpc"/>
        </Row>
        <div style={{
          maxHeight: settings.discordRpc ? 400 : 0,
          opacity: settings.discordRpc ? 1 : 0,
          overflow: 'hidden',
          transition: 'max-height 0.38s cubic-bezier(0.4,0,0.2,1), opacity 0.25s ease',
        }}>
          <div style={{
            margin:'0 14px 14px',
            background:'rgba(255,255,255,0.028)',
            borderRadius:10,
            overflow:'hidden',
          }}>
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
                  display:'flex', alignItems:'center', gap:8,
                  padding:'10px 14px',
                  borderBottom: settings.hideDividers ? 'none' : '1px solid rgba(255,255,255,0.04)',
                }}>
                  <div style={{
                    width:6, height:6, borderRadius:'50%', background:map.c, flexShrink:0,
                    boxShadow: live ? `0 0 0 3px rgba(74,222,128,0.14)` : 'none',
                  }}/>
                  <div style={{fontSize:'var(--fs-xs)', color: live ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.3)'}}>{map.t}</div>
                </div>
              );
            })()}
            {/* таймстамп */}
            <div style={{
              display:'flex', alignItems:'center', justifyContent:'space-between',
              padding:'11px 14px',
              borderBottom: settings.hideDividers ? 'none' : '1px solid rgba(255,255,255,0.04)',
            }}>
              <div style={{fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.5)'}}>{t('discord_timestamp')}</div>
              <div style={{display:'flex', gap:4, flexShrink:0}}>
                {[
                  {v:'progress', l:t('discord_ts_progress')},
                  {v:'elapsed',  l:t('discord_ts_elapsed')},
                  {v:'none',     l:t('discord_ts_none')},
                ].map(({v,l}) => {
                  const active = (settings.discordTimestamp||'progress') === v;
                  return (
                    <div key={v} onClick={()=>{ if (active) return; set('discordTimestamp',v); }} style={{
                      fontSize: 'var(--fs-xs)', fontWeight:500, letterSpacing:'0.03em',
                      padding:'4px 11px', borderRadius:7, cursor:'pointer', userSelect:'none',
                      background: active ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.04)',
                      color: active ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.3)',
                      border: active ? '1px solid rgba(255,255,255,0.14)' : '1px solid transparent',
                      transition:'background 0.15s, color 0.15s, border-color 0.15s',
                    }}
                      onMouseEnter={e=>{ if(!active) e.currentTarget.style.background='rgba(255,255,255,0.07)'; }}
                      onMouseLeave={e=>{ if(!active) e.currentTarget.style.background='rgba(255,255,255,0.04)'; }}
                    >{l}</div>
                  );
                })}
              </div>
            </div>
            {/* при паузе */}
            <div style={{
              display:'flex', alignItems:'center', justifyContent:'space-between',
              padding:'11px 14px',
              borderBottom: settings.hideDividers ? 'none' : '1px solid rgba(255,255,255,0.04)',
            }}>
              <div style={{fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.5)'}}>{t('discord_on_pause')}</div>
              <div style={{display:'flex', gap:4, flexShrink:0}}>
                {[
                  {v:'show', l:t('discord_pause_show')},
                  {v:'hide', l:t('discord_pause_hide')},
                ].map(({v,l}) => {
                  const active = (settings.discordPause||'show') === v;
                  return (
                    <div key={v} onClick={()=>{ if (active) return; set('discordPause',v); }} style={{
                      fontSize: 'var(--fs-xs)', fontWeight:500, letterSpacing:'0.03em',
                      padding:'4px 11px', borderRadius:7, cursor:'pointer', userSelect:'none',
                      background: active ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.04)',
                      color: active ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.3)',
                      border: active ? '1px solid rgba(255,255,255,0.14)' : '1px solid transparent',
                      transition:'background 0.15s, color 0.15s, border-color 0.15s',
                    }}
                      onMouseEnter={e=>{ if(!active) e.currentTarget.style.background='rgba(255,255,255,0.07)'; }}
                      onMouseLeave={e=>{ if(!active) e.currentTarget.style.background='rgba(255,255,255,0.04)'; }}
                    >{l}</div>
                  );
                })}
              </div>
            </div>
            {/* обложка */}
            <div style={{
              display:'flex', alignItems:'center', justifyContent:'space-between',
              padding:'11px 14px',
            }}>
              <div>
                <div style={{fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.5)'}}>{t('discord_cover')}</div>
                <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.22)', marginTop:2}}>{t('discord_cover_sub')}</div>
              </div>
              <Toggle k="discordCover"/>
            </div>
          </div>
        </div>
      </Card>
    </>),
    system: (<>
      <Card title={t('card_language')}>
        <Row label={t('language_label')} sub={t('language_sub')} last>
          <div style={{display:'flex', gap:6, flexShrink:0}}>
            {['RU','EN'].map(lang => {
              const active = (settings.language || 'RU') === lang;
              return (
                <div key={lang} onClick={() => set('language', lang)} style={{
                  fontSize: 'var(--fs-sm)', fontWeight:500, letterSpacing:'0.04em',
                  padding:'5px 18px', borderRadius:8, cursor:'pointer',
                  userSelect:'none',
                  background: active ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)',
                  color: active ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.3)',
                  border: active ? '1px solid rgba(255,255,255,0.15)' : '1px solid transparent',
                  transition:'background 0.15s, color 0.15s, border-color 0.15s',
                }}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; }}
                  onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                >{lang}</div>
              );
            })}
          </div>
        </Row>
      </Card>
      <ClearCacheCard Card={Card} Row={Row} onClearCoversCache={onClearCoversCache} onClearLikesCache={onClearLikesCache}/>
      <Card title={t('card_startup')}>
        <Row label={t('start_windows')}><Toggle k="startWithWindows"/></Row>
        <Row label={t('minimize_tray')} last><Toggle k="minimizeToTray"/></Row>
      </Card>
      <Card title={t('card_local')}>
        <Row label={t('music_folder')}
          sub={settings.musicFolder
            ? settings.musicFolder.length > 42
              ? '...' + settings.musicFolder.slice(-42)
              : settings.musicFolder
            : t('no_folder')}>
          <div style={{display:'flex', gap:8, flexShrink:0}}>
            {settings.musicFolder && (
              <div
                onClick={() => onClearFolder()}
                style={{
                  fontSize: 'var(--fs-sm)', color:'rgba(255,80,80,0.7)', cursor:'pointer',
                  background:'rgba(255,80,80,0.07)',
                  borderRadius:7, padding:'5px 14px',
                  transition:'background 0.15s',
                }}
              >{t('remove')}</div>
            )}
            <div
              onClick={async () => {
                const folder = await window.electronAPI.selectMusicFolder();
                if (folder) { set('musicFolder', folder); onScanTracks(folder); }
              }}
              style={{
                fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.5)', cursor:'pointer',
                background:'rgba(255,255,255,0.055)',
                borderRadius:7, padding:'5px 14px',
                transition:'background 0.15s',
              }}
            >{t('choose')}</div>
          </div>
        </Row>
        <Row label={t('min_dur')} sub={t('min_dur_sub')} last>
          <div style={{display:'flex', alignItems:'center', gap:8, flexShrink:0}}>
            <div onClick={()=>set('minDuration', Math.max(0,(settings.minDuration??30)-5))}
              style={{width:28,height:28,borderRadius:8,background:'rgba(255,255,255,0.055)',
                display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',
                fontSize: 'var(--fs-lg)',color:'rgba(255,255,255,0.5)',userSelect:'none',transition:'background 0.15s'}}
              onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.09)'}
              onMouseLeave={e=>e.currentTarget.style.background='rgba(255,255,255,0.055)'}>−</div>
            <span style={{fontSize: 'var(--fs-md)',color:'rgba(255,255,255,0.75)',minWidth:42,textAlign:'center'}}>
              {settings.minDuration??30} {t('secs')}
            </span>
            <div onClick={()=>set('minDuration', (settings.minDuration??30)+5)}
              style={{width:28,height:28,borderRadius:8,background:'rgba(255,255,255,0.055)',
                display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',
                fontSize: 'var(--fs-lg)',color:'rgba(255,255,255,0.5)',userSelect:'none',transition:'background 0.15s'}}
              onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.09)'}
              onMouseLeave={e=>e.currentTarget.style.background='rgba(255,255,255,0.055)'}>+</div>
          </div>
        </Row>
      </Card>
    </>),
    about: (
      <Card>
        <Row label={t('version')}><span style={{fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.3)'}}>0.4.0-alpha</span></Row>
        <Row label={t('repository')}><span style={{fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.3)'}}>despoyledporcelain/seWer</span></Row>
        <Row label={t('stack')} last><span style={{fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.3)'}}>Electron · React · HTML</span></Row>
      </Card>
    ),
  };

  return (
    <div style={{
      position:'absolute', inset:0, display:'flex',
      opacity: visible ? 1 : 0, transform: visible ? 'none' : 'translateY(8px)',
      transition:'opacity 0.28s ease, transform 0.28s ease',
      pointerEvents: visible ? 'auto' : 'none',
    }}>
      {/* левая навигация */}
      <div style={{
        width:214, flexShrink:0, height:'100%',
        padding:'36px 14px 24px',
        display:'flex', flexDirection:'column',
        background:'transparent',
      }}>
        <div style={{
          fontSize: 'var(--fs-xl)', fontWeight:600, letterSpacing:'-0.025em',
          color:'rgba(255,255,255,0.85)', marginBottom:26, paddingLeft:10,
        }}>{t('settings_title')}</div>
        <div style={{display:'flex', flexDirection:'column', gap:2, position:'relative'}}>
          <div style={{
            position:'absolute', left:0, right:0, borderRadius:9, pointerEvents:'none',
            background:'rgba(255,255,255,0.07)',
            top: pill.top, height: pill.height,
            transition:'top 0.24s cubic-bezier(0.45,0,0.55,1), height 0.24s cubic-bezier(0.45,0,0.55,1)',
          }}/>
          {SECS.map(s => (
            <div key={s.id} ref={el => secRefs.current[s.id] = el} style={{
              display:'flex', alignItems:'center', gap:10,
              padding:'9px 12px', borderRadius:9, cursor:'pointer',
              background:'transparent',
              color: sec===s.id ? 'rgba(255,255,255,0.82)' : 'rgba(255,255,255,0.38)',
              transition:'color 0.18s',
              position:'relative', zIndex:1,
            }} onClick={()=>setSec(s.id)}>
              {s.icon}
              <span style={{fontSize: 'var(--fs-md)', fontWeight: sec===s.id ? 500 : 400}}>{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* правый контент */}
      <div style={{flex:1, overflowY:'auto', padding:'36px 40px'}}>
        <div style={{
          fontSize: 'var(--fs-xs)', fontWeight:500, color:'rgba(255,255,255,0.22)',
          letterSpacing:'0.08em', textTransform:'uppercase', marginBottom:22,
        }}>{SECS.find(s=>s.id===sec)?.label}</div>
        <div style={{maxWidth:480}}>
          {content[sec]}
        </div>
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
    <div style={{display:'flex', alignItems:'center', gap:12, padding:'7px 0',
      borderBottom:'1px solid rgba(255,255,255,0.032)'}}>
      <div className="skel" style={{width:44, height:44, borderRadius:8, flexShrink:0, '--skel-delay':skelDelay(i)}}/>
      <div style={{flex:1, minWidth:0, display:'flex', flexDirection:'column', gap:6}}>
        <div className="skel" style={{height:11, borderRadius:4, width:skelW(i, 46, 30), '--skel-delay':skelDelay(i + 3)}}/>
        <div className="skel" style={{height:9,  borderRadius:4, width:skelW(i, 24, 22), '--skel-delay':skelDelay(i + 7)}}/>
      </div>
      <div className="skel" style={{width:30, height:9, borderRadius:4}}/>
      <div className="skel" style={{width:62, height:26, borderRadius:999, flexShrink:0, '--skel-delay':skelDelay(i + 5)}}/>
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

function ArtistCardsSkeleton() {
  return (
    <div style={{display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:10}}>
      {[0,1,2,3].map(i => (
        <div key={i} style={{display:'flex', alignItems:'center', gap:14,
          background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.02)',
          borderRadius:14, padding:'12px 16px', minWidth:0}}>
          <div className="skel" style={{width:42, height:42, borderRadius:'50%', flexShrink:0, '--skel-delay':skelDelay(i + 2)}}/>
          <div style={{flex:1, minWidth:0, display:'flex', flexDirection:'column', gap:6}}>
            <div className="skel" style={{height:10, borderRadius:4, width:skelW(i, 52, 26)}}/>
            <div className="skel" style={{height:8,  borderRadius:4, width:'38%', '--skel-delay':skelDelay(i + 6)}}/>
          </div>
        </div>
      ))}
    </div>
  );
}

function SearchSkeleton() {
  return (
    <div>
      <div className="skel" style={{height:10, width:58, borderRadius:4, marginBottom:10}}/>
      <div style={{marginBottom:22}}><ArtistCardsSkeleton/></div>
      <div className="skel" style={{height:10, width:52, borderRadius:4, marginBottom:8}}/>
      {[0,1,2,3,4].map(i => <TrackRowSkeleton key={i} i={i}/>)}
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

function SearchTrackRow({ track, isLiked, onLike, onClick, onCoverClick, isLoading, isError, hideDividers }) {
  const t = useLang();
  const [hov, setHov] = useState(false);
  const [popKey, setPopKey] = useState(0);
  const lc = fmtCount(track.likesCount);
  const pc = fmtCount(track.playCount);
  return (
    <motion.div onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)}
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: isError ? 0.55 : 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0, marginTop: 0, marginBottom: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 34, mass: 0.6 }}
      style={{
        display:'flex', alignItems:'center', gap:12, padding:'7px 0',
        borderBottom: hideDividers ? 'none' : '1px solid rgba(255,255,255,0.032)',
        overflow:'hidden',
      }}>
      {/* cover */}
      <div onClick={e=>{e.stopPropagation(); if(!isLoading) onCoverClick();}} style={{
        width:44, height:44, borderRadius:8, flexShrink:0,
        background:'#111116', overflow:'hidden', position:'relative',
        cursor: isLoading ? 'default' : 'pointer',
      }}>
        {track.coverUrl && <img src={track.coverUrl} loading="lazy" decoding="async" style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover',clipPath:'inset(0 round 8px)',display:'block'}}
          onError={e=>{e.currentTarget.style.display='none'}}/>}
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
      {/* title + artist */}
      <div style={{flex:1, minWidth:0, cursor:'pointer'}} onClick={onClick}>
        <div style={{fontSize: 'var(--fs-md)', color:'rgba(255,255,255,0.86)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{track.title}</div>
        <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.3)', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{formatArtistDisplay(track.artist)}</div>
      </div>
      {/* stats — plays + duration */}
      <div style={{display:'flex', alignItems:'center', gap:14, flexShrink:0}}>
        {/* plays */}
        {pc && <div style={{display:'flex', alignItems:'center', gap:5, color:'rgba(255,255,255,0.32)'}}>
          <img src="../assets/vosproizvedenie.png" width="10" height="10" style={{display:'block', filter:'brightness(0) invert(1)', opacity:0.5}}/>
          <span style={{fontSize: 'var(--fs-xs)', fontVariantNumeric:'tabular-nums'}}>{pc}</span>
        </div>}
        {/* duration / unavailable */}
        {isError
          ? <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,80,80,0.7)', minWidth:36, textAlign:'right'}}>{t('unavailable')}</div>
          : <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.32)', minWidth:30, textAlign:'right', fontVariantNumeric:'tabular-nums'}}>{fmt(track.duration)}</div>
        }
      </div>
      {/* like — pill at the very end */}
      {onLike && <div onClick={e=>{e.stopPropagation(); if (!isLiked) setPopKey(k=>k+1); onLike();}}
        style={{
          marginLeft:12, flexShrink:0,
          display:'flex', alignItems:'center', justifyContent:'center', gap:5,
          minWidth: lc ? 62 : 32,
          padding:'5px 11px',
          borderRadius: 999,
          background: isLiked ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.035)',
          border: isLiked ? '1px solid rgba(255,255,255,0.10)' : '1px solid rgba(255,255,255,0.05)',
          color: isLiked ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.42)',
          cursor:'pointer',
          transition:'background 0.15s, border-color 0.15s, color 0.15s',
        }}
        onMouseEnter={e=>{
          e.currentTarget.style.background = isLiked ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.07)';
          e.currentTarget.style.color = isLiked ? '#fff' : 'rgba(255,255,255,0.7)';
        }}
        onMouseLeave={e=>{
          e.currentTarget.style.background = isLiked ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.035)';
          e.currentTarget.style.color = isLiked ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.42)';
        }}
      >
        <LikeHeart key={popKey} liked={isLiked} size={11}
          className={popKey ? 'like-pop like-glow' : undefined}/>
        {lc && <span style={{fontSize: 'var(--fs-xs)', fontVariantNumeric:'tabular-nums'}}>{lc}</span>}
      </div>}
    </motion.div>
  );
}

/* ── SearchView ──────────────────────────────────────────────────────────── */
/* ── PlaylistCard ─────────────────────────────────────────────────────────── */
/* карточка плейлиста — скелет как у HomeCard: полоска-заголовок (владелец /
   название) + квадратная обложка + hover-оверлей с play. ✎ — только на своих
   плейлистах (SC не даёт редактировать чужие), трек-каунт — бейдж на обложке */
function PlaylistCard({ playlist, onOpen, onEdit }) {
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
    <motion.div className="home-card"
      onClick={() => onOpen(playlist)}
      initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }}
      whileHover={{ scale: 1.03 }}
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
      position:'absolute', inset:0,
      opacity: visible ? 1 : 0,
      pointerEvents: visible ? 'auto' : 'none',
      transition:'opacity 0.14s ease',
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
      `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&limit=20`,
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
      position:'absolute', inset:0, zIndex:60,
      background:'var(--bg)',
      opacity: visible ? 1 : 0,
      pointerEvents: visible ? 'auto' : 'none',
      transition:'opacity 0.18s ease',
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
              <motion.div onClick={saveNow}
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
                {STATUS.text}
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
                        {active && <motion.div layoutId="plEdTabPill"
                          transition={{ type:'spring', stiffness:420, damping:34, mass:0.7 }}
                          style={{position:'absolute', inset:0, borderRadius:8, background:'rgba(255,255,255,0.07)'}}/>}
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
              exit={{scale:0.98, y:6, opacity:0, transition:{duration:0.13, ease:'easeIn'}}}
              transition={{type:'spring', stiffness:420, damping:32, mass:0.7}}
              style={{width:272,
                background:'rgba(24,24,24,0.97)',
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

const SearchView = React.forwardRef(function SearchView({ visible, scAuth, likedIds, onLike, onPlayTrack, onSelectTrack, onResultsLoaded, onArtistClick, loadingTrackId, errorTrackId, hideDividers }, ref) {
  const T = useLang();
  const inputRef = useRef(null);
  const [query,   setQuery]   = useState('');
  const [results, setResults] = useState([]);
  const [users,   setUsers]   = useState([]);
  const [loading, setLoading] = useState(false);
  const [offset,  setOffset]  = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const debounceRef  = useRef(null);
  const queryRef     = useRef('');
  const loadingRef   = useRef(false);
  const hasMoreRef   = useRef(false);
  const offsetRef    = useRef(0);
  hasMoreRef.current = hasMore;
  offsetRef.current  = offset;
  React.useImperativeHandle(ref, () => ({
    focus: () => { inputRef.current?.focus(); inputRef.current?.select(); },
    loadMore: () => {
      if (!hasMoreRef.current || loadingRef.current) return;
      doSearch(queryRef.current, offsetRef.current);
    },
  }));

  const hasResults = results.length > 0 || users.length > 0;

  const doSearch = async (q, off = 0) => {
    if (!q.trim() || !scAuth) return;
    loadingRef.current = true;
    setLoading(true);
    const [tracksRes, usersRes] = await Promise.all([
      window.electronAPI.scFetch(
        `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&limit=20&offset=${off}`,
        scAuth.token, scAuth.clientId
      ),
      off === 0
        ? window.electronAPI.scFetch(
            `https://api-v2.soundcloud.com/search/users?q=${encodeURIComponent(q)}&limit=4`,
            scAuth.token, scAuth.clientId
          )
        : Promise.resolve(null),
    ]);
    if (queryRef.current !== q) return;
    const newTracks = (tracksRes.data?.collection || []).map(t => mapScTrack(t, T('no_title')));
    if (off === 0) {
      setResults(newTracks);
      setUsers((usersRes?.data?.collection || []).map(u => ({
        id: u.id, username: u.username,
        avatarUrl: u.avatar_url,
        followersCount: u.followers_count,
        bannerUrl: u.visuals?.visuals?.[0]?.visual_url || null,
      })));
    } else {
      setResults(prev => [...prev, ...newTracks]);
      if (newTracks.length > 0) onResultsLoaded?.(newTracks);
    }
    setHasMore(!!tracksRes.data?.next_href);
    setOffset(off + 20);
    loadingRef.current = false;
    setLoading(false);
  };

  const handleInput = e => {
    const q = e.target.value;
    setQuery(q);
    queryRef.current = q;
    clearTimeout(debounceRef.current);
    if (!q.trim()) { setResults([]); setUsers([]); setOffset(0); return; }
    debounceRef.current = setTimeout(() => doSearch(q, 0), 380);
  };

  const handleScroll = e => {
    if (!hasMore || loadingRef.current) return;
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) doSearch(query, offset);
  };

  return (
    <div style={{
      position:'absolute', inset:0,
      opacity: visible ? 1 : 0,
      pointerEvents: visible ? 'auto' : 'none',
      transition:'opacity 0.14s ease',
    }}>
      {/* searchbar */}
      <div style={{
        position:'absolute', left:0, right:0,
        top: hasResults ? '8%' : '36%',
        transition:'top 0.42s cubic-bezier(0.22,1,0.36,1)',
        padding:'0 52px', zIndex:2,
      }}>
        <div style={{
          position:'relative',
          background:'rgba(255,255,255,0.05)',
          borderRadius:18,
        }}>
          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"
            viewBox="0 0 24 24" style={{position:'absolute', left:22, top:'50%', translate:'0 -50%', pointerEvents:'none', color:'rgba(255,255,255,0.3)'}}>
            <circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35" strokeLinecap="round"/>
          </svg>
          <input
            ref={inputRef}
            value={query} onChange={handleInput}
            placeholder={T('search_hinted')}
            style={{
              width:'100%', background:'transparent', border:'none', outline:'none',
              padding:'15px 54px',
              color:'#ededf4', fontSize: 'var(--fs-xl)', fontFamily:'inherit', textAlign:'center',
            }}
          />
          {loading && <div style={{position:'absolute', right:22, top:'50%', translate:'0 -50%', width:16, height:16, borderRadius:'50%', border:'2px solid rgba(255,255,255,0.15)', borderTopColor:'rgba(255,255,255,0.5)', animation:'spin 0.7s linear infinite'}}/>}
        </div>
      </div>

      {/* skeleton первой загрузки — до первых результатов */}
      {!hasResults && loading && (
        <div style={{position:'absolute', left:52, right:52, top:'calc(36% + 84px)'}}>
          <SearchSkeleton/>
        </div>
      )}

      {/* пустой результат */}
      {!hasResults && !loading && query.trim() && (
        <div style={{position:'absolute', left:0, right:0, top:'calc(36% + 96px)', textAlign:'center'}}>
          <svg width="26" height="26" fill="none" stroke="rgba(255,255,255,0.13)" strokeWidth="1.7" viewBox="0 0 24 24" style={{marginBottom:12}}>
            <circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35" strokeLinecap="round"/>
          </svg>
          <div style={{fontSize: 'var(--fs-md)', color:'rgba(255,255,255,0.3)'}}>{T('not_found')}</div>
        </div>
      )}

      {/* results */}
      {hasResults && (
        <div onScroll={handleScroll}
          className="scroll-thin"
          style={{
            position:'absolute', left:0, right:10,
            top:'calc(8% + 76px)', bottom:0,
            overflowY:'auto', padding:'16px 52px 32px',
            /* ❌ был `willChange:'transform'`, хотя transform у этого
               элемента НИКОГДА не меняется — он просто скроллится.
               подсказка браузеру «готовь слой под transform» тут
               бессмысленна: держала лишний слой на всю область
               результатов поиска на всё время её жизни. */
          }}>
          {users.length > 0 && (
            <div style={{marginBottom:22}}>
              <div style={{fontSize: 'var(--fs-xs)',letterSpacing:'0.09em',textTransform:'uppercase',color:'rgba(255,255,255,0.22)',marginBottom:10}}>{T('artists')}</div>
              <div style={{display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:10}}>
                {users.slice(0, 4).map(u => (
                  <div key={u.id}
                    onClick={() => onArtistClick?.(u)}
                    style={{
                    display:'flex', alignItems:'center', gap:14,
                    background:'rgba(255,255,255,0.04)',
                    border:'1px solid rgba(255,255,255,0.03)',
                    borderRadius:14, padding:'12px 16px',
                    cursor:'pointer', transition:'background 0.15s, border-color 0.15s',
                    minWidth:0,
                  }}
                    onMouseEnter={e => { e.currentTarget.style.background='rgba(255,255,255,0.075)'; e.currentTarget.style.borderColor='rgba(255,255,255,0.06)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background='rgba(255,255,255,0.04)'; e.currentTarget.style.borderColor='rgba(255,255,255,0.03)'; }}
                  >
                    {u.avatarUrl
                      ? <img src={u.avatarUrl} loading="lazy" decoding="async" style={{width:42,height:42,borderRadius:'50%',objectFit:'cover',flexShrink:0}}/>
                      : <div style={{width:42,height:42,borderRadius:'50%',background:'#111116',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                          <svg width="20" height="20" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="1.6" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
                        </div>
                    }
                    <div style={{minWidth:0, flex:1}}>
                      <div style={{fontSize: 'var(--fs-md)', fontWeight:600, color:'rgba(255,255,255,0.9)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', letterSpacing:'-0.005em'}}>{u.username}</div>
                      {u.followersCount > 0 && <div style={{fontSize: 'var(--fs-xs)', color:'rgba(255,255,255,0.36)', marginTop:3, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{u.followersCount.toLocaleString()} {T('followers')}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {results.length > 0 && (
            <div>
              <div style={{fontSize: 'var(--fs-xs)',letterSpacing:'0.09em',textTransform:'uppercase',color:'rgba(255,255,255,0.22)',marginBottom:8}}>{T('tracks_label')}</div>
              <AnimatePresence initial={false}>
                {results.map(t => (
                  <SearchTrackRow key={t.id} track={t}
                    isLiked={likedIds.has(t.id)}
                    onLike={() => onLike(t)}
                    onClick={() => onSelectTrack(t, results)}
                    onCoverClick={() => onPlayTrack(t, results)}
                    isLoading={loadingTrackId === t.id}
                    isError={errorTrackId === t.id}
                    hideDividers={hideDividers}/>
                ))}
              </AnimatePresence>
              {loading && <div style={{textAlign:'center',color:'rgba(255,255,255,0.2)',padding:'16px 0',fontSize: 'var(--fs-sm)'}}>{T('loading')}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/* ── ArtistView ──────────────────────────────────────────────────────────── */
function ArtistView({ artist, visible, onClose, scAuth, likedIds, onLike, onPlayTrack, onSelectTrack, loadingTrackId, errorTrackId, artistCacheRef, onFollow, onCheckFollow, hideDividers }) {
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
            `https://api-v2.soundcloud.com/search/users?q=${encodeURIComponent(artist.username)}&limit=1`,
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
    } catch {}
    loadingMoreRef.current = false;
    setLoadingMore(false);
  };

  const profile = fetched ? { ...artist, ...fetched } : artist;
  const avatarUrl = profile?.avatarUrl || null;
  const bannerUrl = profile?.bannerUrl || null;

  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
      opacity: visible ? 1 : 0,
      pointerEvents: visible ? 'auto' : 'none',
      transition: 'opacity 0.18s ease',
    }}>
      {/* hero — asymmetric layout: avatar left, info right */}
      <div style={{
        position: 'relative', flexShrink: 0, overflow: 'hidden',
        display: 'flex', alignItems: 'flex-end', gap: 24,
        padding: '60px 40px 26px 40px',
      }}>
        {/* blur background — prefer banner, fallback to avatar */}
        {(bannerUrl || avatarUrl) && (
          <img src={bannerUrl || avatarUrl} style={{
            position: 'absolute', inset: '-40px',
            width: 'calc(100% + 80px)', height: 'calc(100% + 80px)',
            objectFit: 'cover',
            filter: 'blur(56px) saturate(1.3) brightness(0.5)',
            transform: 'scale(1.06)',
          }}/>
        )}
        {/* gradient overlay */}
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(to bottom, rgba(7,7,10,0.36) 0%, rgba(7,7,10,0.55) 55%, #07070a 100%)',
        }}/>

        {/* back button — circular with blur backdrop */}
        <div onClick={onClose} title={t('back')} style={{
          position: 'absolute', top: 14, left: 14, zIndex: 10,
          width: 32, height: 32, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer',
          background: 'rgba(0,0,0,0.42)',
          backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
          border: '1px solid rgba(255,255,255,0.09)',
          color: 'rgba(255,255,255,0.72)',
          transition: 'background 0.15s, color 0.15s, transform 0.15s',
        }}
          onMouseEnter={e => { e.currentTarget.style.background='rgba(0,0,0,0.62)'; }}
          onMouseLeave={e => { e.currentTarget.style.background='rgba(0,0,0,0.42)'; }}
          onMouseDown={e => e.currentTarget.style.transform='scale(0.92)'}
          onMouseUp={e => e.currentTarget.style.transform='scale(1)'}
        >
          {/* ассет чёрный на прозрачном 100x100 → инвертим в белый, как
              note.png/edit.png. у <img> нет currentColor, поэтому ховер-яркость
              делаем через opacity на самой картинке. objectFit:contain —
              иначе наконечник срежет по краям */}
          <img src="../assets/back.png" alt="" draggable="false"
            style={{width:14, height:14, objectFit:'contain', opacity:0.72,
              filter:'brightness(0) invert(1)', transition:'opacity 0.15s'}}
            onMouseEnter={e => e.currentTarget.style.opacity='0.95'}
            onMouseLeave={e => e.currentTarget.style.opacity='0.72'}/>
        </div>

        {/* avatar — left */}
        <div style={{
          position: 'relative', zIndex: 2,
          width: 148, height: 148, borderRadius: 16,
          overflow: 'hidden', flexShrink: 0,
          background: '#111116',
          boxShadow: '0 18px 48px rgba(0,0,0,0.7)',
          border: '1px solid rgba(255,255,255,0.07)',
        }}>
          {avatarUrl
            ? <img src={avatarUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>
            : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="52" height="52" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="1.4" viewBox="0 0 24 24">
                  <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                </svg>
              </div>
          }
        </div>

        {/* info column — right */}
        <div style={{
          position: 'relative', zIndex: 2, flex: 1, minWidth: 0,
          display: 'flex', flexDirection: 'column',
          paddingBottom: 6,
        }}>
          <div style={{
            fontSize: 'var(--fs-xs)', letterSpacing: '0.13em', textTransform: 'uppercase',
            color: 'rgba(255,255,255,0.42)', marginBottom: 6, fontWeight: 600,
          }}>
            {t('artist_label') || 'Артист'}
          </div>
          <div style={{
            fontSize: 'clamp(26px, 3.4vw, 38px)', fontWeight: 700,
            letterSpacing: '-0.028em', lineHeight: 1.12,
            overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
            textShadow: '0 2px 14px rgba(0,0,0,0.55)',
          }}>
            {profile?.username || artist?.username || '—'}
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 14,
            marginTop: 10,
          }}>
            {(profile?.followersCount > 0) && (
              <div style={{ fontSize: 'var(--fs-sm)', color: 'rgba(255,255,255,0.5)', letterSpacing: '0.01em' }}>
                {profile.followersCount.toLocaleString()} {t('followers')}
              </div>
            )}
            {profileId && scAuth && isFollowing !== null && (
              <button
                disabled={followBusy}
                onClick={handleSubscribeClick}
                onMouseEnter={e => {
                  if (followBusy) return;
                  e.currentTarget.style.background = isFollowing ? 'rgba(255,80,80,0.10)' : 'rgba(255,255,255,0.20)';
                  e.currentTarget.style.color = isFollowing ? 'rgba(255,140,140,0.95)' : '#fff';
                  e.currentTarget.style.borderColor = isFollowing ? 'rgba(255,120,120,0.32)' : 'transparent';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = isFollowing ? 'transparent' : 'rgba(255,255,255,0.12)';
                  e.currentTarget.style.color = isFollowing ? 'rgba(255,255,255,0.78)' : 'rgba(255,255,255,0.94)';
                  e.currentTarget.style.borderColor = isFollowing ? 'rgba(255,255,255,0.22)' : 'transparent';
                }}
                style={{
                  padding: '6px 18px',
                  fontSize: 'var(--fs-sm)', fontWeight: 600, letterSpacing: '0.02em',
                  background: isFollowing ? 'transparent' : 'rgba(255,255,255,0.12)',
                  border: isFollowing ? '1px solid rgba(255,255,255,0.22)' : '1px solid transparent',
                  color: isFollowing ? 'rgba(255,255,255,0.78)' : 'rgba(255,255,255,0.94)',
                  borderRadius: 999,
                  cursor: followBusy ? 'default' : 'pointer',
                  fontFamily: 'inherit',
                  opacity: followBusy ? 0.6 : 1,
                  transition: 'background 0.15s, color 0.15s, border-color 0.15s, opacity 0.15s',
                }}
              >{isFollowing ? t('subscribed') : t('subscribe')}</button>
            )}
          </div>
        </div>
      </div>

      {/* tabs */}
      <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'center', padding: '10px 0 12px' }}>
        <LayoutGroup id="artistTabs">
          <div style={{ display: 'flex', gap: 2 }}>
            {TABS.map(tb => (
              <button key={tb.id}
                onClick={() => setTab(tb.id)}
                style={{
                  position: 'relative', zIndex: 1,
                  background: 'none', border: 'none',
                  padding: '7px 18px',
                  fontSize: 'var(--fs-sm)', fontWeight: 600,
                  color: tab === tb.id ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.36)',
                  cursor: 'pointer', fontFamily: 'inherit',
                  transition: 'color 0.18s ease',
                  letterSpacing: '0.015em',
                  borderRadius: 999,
                }}
                onMouseEnter={e => { if (tab !== tb.id) e.currentTarget.style.color = 'rgba(255,255,255,0.6)'; }}
                onMouseLeave={e => { if (tab !== tb.id) e.currentTarget.style.color = 'rgba(255,255,255,0.36)'; }}
              >
                {tab === tb.id && (
                  <motion.div layoutId="artistTabPill"
                    style={{
                      position: 'absolute', inset: 0,
                      background: 'rgba(255,255,255,0.10)',
                      border: '1px solid rgba(255,255,255,0.06)',
                      borderRadius: 999, zIndex: -1,
                    }}
                    transition={{ type: 'spring', stiffness: 420, damping: 34, mass: 0.7 }}/>
                )}
                {tb.label}
              </button>
            ))}
          </div>
        </LayoutGroup>
      </div>

      {/* content */}
      <div ref={scrollContainerRef} className="scroll-thin" style={{ flex: 1, overflowY: 'auto', padding: '8px 32px 32px' }}
        onScroll={e => {
          const el = e.currentTarget;
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 180) loadMore();
        }}>
        {tracksLoading ? (
          <div>{[0,1,2,3,4,5].map(i => <TrackRowSkeleton key={i} i={i}/>)}</div>
        ) : tracksError ? (
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:12, padding:'48px 0' }}>
            <div style={{ fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.3)' }}>{tracksError}</div>
            <button onClick={() => { delete tabCacheRef.current[tab]; setFetchKey(k => k + 1); }}
              style={{ background:'rgba(255,255,255,0.06)', border:'none', borderRadius:8, padding:'6px 16px',
                fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.55)', cursor:'pointer', fontFamily:'inherit' }}>
              {t('retry') || 'Повторить'}
            </button>
          </div>
        ) : artistTracks.length === 0 ? (
          <div style={{ textAlign:'center', padding:'48px 0', fontSize: 'var(--fs-sm)', color:'rgba(255,255,255,0.15)' }}>{t('not_found')}</div>
        ) : (
          <AnimatePresence initial={false}>
            {artistTracks.map(tr => (
              <SearchTrackRow key={tr.id} track={tr}
                isLiked={likedIds?.has(tr.id) || false}
                onLike={onLike ? () => onLike(tr) : null}
                onClick={() => onSelectTrack?.(tr)}
                onCoverClick={() => onPlayTrack?.(tr)}
                isLoading={loadingTrackId === tr.id}
                isError={errorTrackId === tr.id}
                hideDividers={hideDividers}/>
            ))}
          </AnimatePresence>
        )}
        {loadingMore && (
          <div style={{ display:'flex', justifyContent:'center', padding:'16px 0' }}>
            <div style={{ width:20, height:20, border:'2px solid rgba(255,255,255,0.07)', borderTopColor:'rgba(255,255,255,0.22)', borderRadius:'50%', animation:'spin 1s linear infinite' }}/>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── App ─────────────────────────────────────────────────────────────────── */
function App() {
  const [view,          setView]          = useState('home');
  const [tracks,        setTracks]        = useState([]);
  const [trackIdx,      setTrackIdx]      = useState(0);
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
  /* текст песни: перекрывает библиотеку в колонке слева */
  const [lyricsOpen,   setLyricsOpen]   = useState(false);
  const [lyrics,       setLyrics]       = useState(null);   /* { status, lines, synced, source } */
  const [lyricsActive, setLyricsActive] = useState(-1);
  const [lyricsNonce,  setLyricsNonce]  = useState(0);      /* ретрай: тот же эффект заново */
  const lyricsReqRef = useRef(0);
  const [settings,      setSettings]      = useState({
    autoplay:false, crossfade:0, defaultRepeat:false,
    startWithWindows:false, minimizeToTray:false, musicFolder:'', downloadsFolder:'',
    customTitles: {}, scTitles: {}, minDuration: 30, soundcloudAuth: null,
    sourceMode: 'local', discordRpc: true,
    discordTimestamp: 'progress', discordPause: 'show', discordCover: true,
    accentMode: 'color', accentPreset: 'default',
    ambientGlow: true,   /* пятно за обложкой в плеере; false = не рисуем вовсе */
    lyricsSources: LYRICS_SOURCE_IDS.slice(),  /* включённые источники, сверху вниз */
    volume: 0.7,   /* gain 0..1 (не позиция ползунка) — переживает перезапуск */
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
  const scShuffleOrderRef = useRef([]);
  const scShuffleIdxRef   = useRef(-1);
/* «не пересобирать порядок» для эффекта [shuffle]: см. handleShuffleStart */
const shuffleKeepRef    = useRef(false);
  const scPlayingTrackRef = useRef(null);
  const volumeRef         = useRef(0.7);
  const settingsRef       = useRef({});
  const crossfadeRafRef   = useRef(null);
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
  settingsRef.current  = settings;
  const track = scPlayingTrack || tracks[trackIdx] || tracks[0] || { id:0, title:'', artist:'', duration:0, color:'#333' };

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
      return ACCENT_PRESETS[settings.accentPreset] || ACCENT_PRESETS.default;
    }
    return ACCENT_PRESETS.default;
  }, [settings.accentMode, settings.accentPreset, accentRGB]);

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
       --accent-rgb, и два из них перерисовывают крупные поверхности:
       #accent-top во всю окно и AmbientGlow (2× обложки). плюс _accentSubs
       дёргает перерисовку canvas-слайдера громкости с shadowBlur.
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

  // titlebar accent glow + верхняя акцентная подсветка — only in player view.
  // привязано к playerVisible, а не к view: при уходе в настройки setView
  // отложен на 300мс — свечение гасло бы с запозданием, в отличие от
  // поиска/библиотеки, где view меняется сразу
  useEffect(() => {
    const inPlayer = view === 'player' && playerVisible;
    document.body.classList.toggle('in-player', inPlayer);
    const tb = document.getElementById('titlebar');
    if (!tb) return;
    if (inPlayer && settings.accentMode !== 'off') {
      tb.style.background = 'linear-gradient(90deg, var(--bg) 0%, rgba(var(--accent-rgb),0.09) 50%, var(--bg) 100%)';
    } else {
      tb.style.background = '';
    }
  }, [view, playerVisible, settings.accentMode]);

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
            /* список источников текста: выкидываем мусор и дубли, отсутствие
               поля (старый файл настроек) → все источники по умолчанию */
            m.lyricsSources = cleanLyricsSources(m.lyricsSources);
            /* те же ворота для rpc: без них мусорное значение из старого файла
               настроек уезжало в main как есть (см. cleanDiscordSettings) */
            cleanDiscordSettings(m);
            /* булев гейт по образцу cleanDiscordSettings: мусор из старого
               файла настроек не должен превращать тумблер в «включено» */
            m.ambientGlow = m.ambientGlow !== false;
            m.scTitles = cleanScTitles(m.scTitles);
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

  /* сохраняем настройки при изменении */
  useEffect(() => {
    try { window.electronAPI.saveSettings(settings); } catch {}
  }, [settings]);

  useEffect(() => {
    try { window.electronAPI.setLoginItem?.(settings.startWithWindows); } catch {}
  }, [settings.startWithWindows]);

  /* инициализация Audio */
  useEffect(() => {
    const audio = new Audio();
    audio.volume = volume;
    audioRef.current = audio;

    const onTime  = () => {
      if (!audio.duration) return;
      progressRef.current = audio.currentTime / audio.duration;
      discordProgressRef.current = progressRef.current;
      // crossfade fade-out: плавно убираем громкость в конце трека
      const cf = settingsRef.current?.crossfade || 0;
      if (cf > 0) {
        const remaining = audio.duration - audio.currentTime;
        if (remaining <= cf && remaining > 0) {
          audio.volume = Math.max(0, volumeRef.current * (remaining / cf));
        } else if (remaining > cf && audio.volume !== volumeRef.current) {
          audio.volume = volumeRef.current; // восстанавливаем если seek после fade
        }
      }
    };
    const onEnded = () => handleNextRef.current?.();
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended',      onEnded);

    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('ended',      onEnded);
      audio.pause();
      audio.src = '';
      destroyHls();
      cancelAnimationFrame(crossfadeRafRef.current);
    };
  }, []);

  /* смена трека — обновляем src */
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track) return;
    if (scPlayingTrack) return; // SC-трек управляется через handleScTrackClick
    destroyHls(); // если был HLS — уничтожить при переключении на локальный трек
    if (track.path) {
      audio.src = fileSrc(track.path);
      audio.load();
      audio.addEventListener('loadedmetadata', () => {
        const dur = Math.floor(audio.duration);
        if (dur) setTracks(prev => prev.map((t, i) => i === trackIdx ? { ...t, duration: dur } : t));
      }, { once: true });
      if (isPlayingRef.current) {
        startFadeIn(audio);
        audio.play().catch(() => setIsPlaying(false));
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
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.play().catch(() => setIsPlaying(false));
    } else {
      cancelAnimationFrame(crossfadeRafRef.current);
      if (!trackSwitchingRef.current) audio.volume = volumeRef.current;
      audio.pause();
    }
  }, [isPlaying]);

  /* громкость */
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  /* live-применение громкости при драге слайдера — без ререндера App.
     state коммитится один раз на mouseup */
  const handleVolumeLive = useCallback((v) => {
    if (audioRef.current) audioRef.current.volume = v;
    volumeRef.current = v;
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
    api.onMediaPlayPause(() => setIsPlaying(p => !p));
    api.onMediaNext(() => handleNextRef.current?.());
    api.onMediaPrev(() => handlePrevRef.current?.());
  }, []);

  /* Снятие hero-клона — по готовности новой обложки, а не по слепому
     таймеру. Таймер остаётся как страховка (ART_READY_WAIT_MS), потому что
     обложка может не загрузиться вообще (retry исчерпан, onFailed). */
  const ART_READY_WAIT_MS = 900;
  useEffect(() => {
    if (!hero || !heroExiting) return;
    let raf = 0;
    const t0 = performance.now();
    const wait = () => {
      if (!artReadyRef.current && performance.now() - t0 < ART_READY_WAIT_MS) {
        raf = requestAnimationFrame(wait); return;
      }
      setHero(null); setHeroExiting(false);
    };
    raf = requestAnimationFrame(wait);
    return () => cancelAnimationFrame(raf);
  }, [hero, heroExiting]);

  /* анимация обложки при входе в плеер не из home */
  /* 🚨 готовность НОВОЙ обложки в AlbumArt. hero-клон снимается по таймеру
     на 510мс, а AlbumArt к этому моменту под клоном ещё рисует ПРЕДЫДУЩУЮ
     обложку (новый слой = загрузка + decode + draw в canvas). снятие клона
     показывало её на кадр — «вспышка старой обложки» после прилёта.
     Теперь клон ждёт готовности, но не дольше ART_READY_WAIT_MS, иначе
     при неудачной загрузке обложки клон зависнет навсегда. */
  const artReadyRef = useRef(true);
  useEffect(() => { artReadyRef.current = false; }, [track?.id, track?.coverUrl]);
  const handleArtReady = useCallback(() => { artReadyRef.current = true; }, []);

  const artEntranceTweenRef = useRef(null);
  useEffect(() => {
    if (view === 'player' && !hero && artEntranceRef.current) {
      artEntranceTweenRef.current?.kill();
      artEntranceTweenRef.current = gsap.fromTo(artEntranceRef.current,
        { opacity: 0, y: 14 },
        { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out' }
      );
    }
  }, [view]);

  /* gsap — анимация info блока при входе/выходе из плеера */
  useEffect(() => {
    const el = playerInfoRef.current;
    if (!el) return;
    if (playerVisible) {
      gsap.fromTo(el,
        { opacity: 0, y: 14 },
        { opacity: 1, y: 0, duration: 0.42, ease: 'sine.out', delay: 0.08, clearProps: 'y' }
      );
    } else {
      gsap.to(el, { opacity: 0, duration: 0.1 });
    }
  }, [playerVisible]);

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

  /* единственная точка сборки присутствия. раньше таких было две (эффект
     ниже + копия внутри handleSeek) — они делили ОДИН discordTimerRef,
     поэтому взаимно отменяли дебаунс друг друга и расходились в мелочах
     (в seek-копии при !discordRpc был `return` вместо discordClear, а
     isPlaying брался из ref, здесь — из state) */
  const pushDiscord = useCallback((delay) => {
    clearTimeout(discordTimerRef.current);
    discordTimerRef.current = setTimeout(() => {
      const s = settingsRef.current;
      if (!s.discordRpc || !track) return;   /* выключенным rpc'ом рулит main */
      if (!isPlayingRef.current && s.discordPause === 'hide') { window.electronAPI?.discordClear?.(); return; }
      let coverUrl = null;
      if (s.discordCover !== false) {
        const direct = track.coverUrl || '';
        /* sc-обложки — обычные https-ссылки, их discord берёт сам.
           локальные приходят data-url'ом (getCoverArt) — их надо сначала
           загрузить в дискорд, этим занимается main по coverKey */
        if (direct.startsWith('https://') || direct.startsWith('data:image')) coverUrl = direct;
        if (!coverUrl && scPlayingTrack) {
          const cached = scCacheMapRef.current.get(track.id);
          if (cached?.coverUrl?.startsWith('https://')) coverUrl = cached.coverUrl;
        }
      }
      window.electronAPI?.discordUpdate?.({
        title:     track.title,
        artist:    track.artist,
        duration:  track.duration,
        progress:  discordProgressRef.current,
        coverUrl,
        coverKey:  track.id,
        isPlaying: isPlayingRef.current,
        timestamp: s.discordTimestamp || 'progress',
      });
    }, delay);
  }, [track, scPlayingTrack]);

  /* deps по полям трека, а не по track?.id: coverUrl у локальных приезжает
     асинхронно (loadCovers), duration уточняется в loadedmetadata. при
     deps по id эффект не перезапускался, и дискорд весь трек показывал
     не ту длительность и без обложки — он сам activity не перерисовывает.
     pushDiscord в списке обязателен: он пересобирается на каждый новый объект
     трека, и без него переименование (commitEdit) меняло title в state, но
     эффект держал старое замыкание — присутствие оставалось с прежним названием */
  useEffect(() => { pushDiscord(800); },
    [pushDiscord, track?.id, track?.coverUrl, track?.duration, isPlaying, scPlayingTrack,
     settings.discordRpc, settings.discordTimestamp, settings.discordPause, settings.discordCover]);

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
    set('play',          () => { setIsPlaying(true); });
    set('pause',         () => { setIsPlaying(false); });
    set('previoustrack', () => { handlePrevRef.current?.(); });
    set('nexttrack',     () => { handleNextRef.current?.(); });
    set('stop',          () => { setIsPlaying(false); });
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
          playbackRate: 1,
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
          playbackRate: 1,
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
  useEffect(() => { window.electronAPI?.discordSetEnabled?.(rpcWanted === true); }, [rpcWanted]);

  useEffect(() => {
    const off = window.electronAPI?.onDiscordStatus?.(setDiscordStatus);
    return () => { off?.(); };
  }, []);

  useEffect(() => () => window.electronAPI?.discordClear?.(), []);

  useEffect(() => {
    if (!shuffle) {
      scShuffleOrderRef.current = [];
      scShuffleIdxRef.current = -1;
      shuffleKeepRef.current = false;
      return;
    }
    /* handleShuffleStart уже положил готовый порядок со случайным первым
       треком. эффект [shuffle] в этот момент как раз срабатывает (false→true)
       и пересобрал бы порядок от ТЕКУЩЕГО трека, выбросив выбор. флаг
       ставится только когда переключение реально будет — если shuffle уже
       включён, setShuffle(true) это no-op, эффект не запустится, и висящий
       флаг сломал бы следующий ручной переключатель */
    if (shuffleKeepRef.current) { shuffleKeepRef.current = false; return; }
    const cur = scPlayingTrackRef.current;
    if (cur) {
      const list = activeQueueList();
      scShuffleOrderRef.current = buildScShuffle(list, cur.id);
      scShuffleIdxRef.current = 0;
    }
  }, [shuffle]);

  /* список, из которого реально играет next/prev — тот же приоритет, что и
     везде: станция > плейлист > очередь поиска > лайки. нужен кнопке
     «случайно» в плеере, чтобы она перемешивала ИМЕННО то, что играет.
     режим берём из settingsRef, а не из замыкания: эффект [shuffle] не
     перезапускается на смене режима и держал бы старый */
  function activeQueueList() {
    const s = settingsRef.current;
    const sc = (s?.soundcloudAuth && s?.sourceMode === 'sc') ? 'sc' : 'local';
    if (sc === 'sc') {
      return stationQueueRef.current || playlistQueueRef.current || searchQueueRef.current
        || (searchRef.current ? filteredScRef.current : scTracksRef.current);
    }
    return searchRef.current ? filteredRef.current : tracks;
  }

  /* переключатель режима, а не «перемешать ещё раз». второй клик ВЫКЛЮЧАЕТ
     shuffle: порядок сбрасывает эффект [shuffle], и дальше next идёт в обычном
     порядке. включение — как handleShuffleStart: случайный трек + переход в
     плеер. список приходит с места нажатия, потому что он у всех трёх кнопок
     разный (лайки / активная очередь / треки плейлиста) */
  function handleShuffleToggle(list) {
    if (shuffle) { setShuffle(false); return; }
    handleShuffleStart(list);
  }

  /* «случайно»: перемешать переданный список, включить первый случайный трек
     и уйти в плеер. список приходит снаружи — по нажатию не угадать, что
     имеется в виду: с главного экрана это лайки, в плеере — активная очередь,
     в чипе плейлиста — треки плейлиста */
  function handleShuffleStart(list) {
    const pool = (list || []).filter(Boolean);
    if (!pool.length) { showToast(t('shuffle_empty')); return; }
    if (!shuffle) shuffleKeepRef.current = true;
    setShuffle(true);
    const s = settingsRef.current;
    const sc = (s?.soundcloudAuth && s?.sourceMode === 'sc') ? 'sc' : 'local';
    if (sc === 'sc') {
      const order = buildScShuffle(pool, null);
      scShuffleOrderRef.current = order;
      scShuffleIdxRef.current = 0;
      const first = pool.find(tr => tr.id === order[0]) || pool[0];
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
    if (repeat === 'one') {
      const audio = audioRef.current;
      if (audio) { audio.currentTime = 0; audio.play().catch(() => {}); }
      progressRef.current = 0; return;
    }
    if (scPlayingTrack) {
      const list = stationQueueRef.current || playlistQueueRef.current || searchQueueRef.current || (searchRef.current ? filteredScRef.current : scTracksRef.current);
      if (shuffle) {
        const remaining = scShuffleOrderRef.current.length - 1 - scShuffleIdxRef.current;
        if (searchQueueRef.current && remaining <= 3) searchViewRef.current?.loadMore();
        scShuffleIdxRef.current++;
        if (scShuffleIdxRef.current >= scShuffleOrderRef.current.length) {
          if (repeat === 'all') {
            scShuffleOrderRef.current = buildScShuffle(list, null);
            scShuffleIdxRef.current = 0;
          } else { setIsPlaying(false); return; }
        }
        const nextTrack = list.find(t => t.id === scShuffleOrderRef.current[scShuffleIdxRef.current]);
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
    if (progressRef.current > 0.05) {
      progressRef.current = 0;
      if (audioRef.current) audioRef.current.currentTime = 0;
      return;
    }
    if (scPlayingTrack) {
      const list = stationQueueRef.current || playlistQueueRef.current || searchQueueRef.current || (searchRef.current ? filteredScRef.current : scTracksRef.current);
      if (shuffle && scShuffleOrderRef.current.length > 0) {
        const pi = scShuffleIdxRef.current - 1;
        if (pi >= 0) {
          scShuffleIdxRef.current = pi;
          const prevTrack = list.find(t => t.id === scShuffleOrderRef.current[pi]);
          if (prevTrack) handleScTrackClick(prevTrack, scTracksRef.current.indexOf(prevTrack), true, 0, -1);
        }
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
    setTrackIdx(tracks.indexOf(list[(curIdx - 1 + list.length) % list.length]));
    progressRef.current = 0;
  }
  handlePrevRef.current = handlePrev;

  const handleSeek = useCallback((v) => {
    progressRef.current = v;
    discordProgressRef.current = v;
    cancelAnimationFrame(crossfadeRafRef.current); // отменяем fade если был
    const audio = audioRef.current;
    if (audio?.duration) {
      audio.currentTime = v * audio.duration;
      audio.volume = volumeRef.current; // восстанавливаем громкость после seek
    }
    /* pushDiscord сам гасит прошлый таймер. раньше здесь стоял отдельный
       clearTimeout того же ref — из-за него seek отменял дебаунс эффекта,
       и задержка обновления присутствия становилась случайной */
    pushDiscord(400);
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
        setTrackIdx(0);
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
    setTrackIdx(0);
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
        if (res.error) { setScError(`${STRINGS[langRef.current]?.api_err ?? 'api error'}: ${res.error}`); break; }
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
      const withCache = all.map(t => cached[t.id] ? { ...t, coverUrl: cached[t.id] } : t);
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
      setScTracks(prev => prev.map(t => snap[t.id] ? { ...t, coverUrl: snap[t.id] } : t));
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
        if (res.error) { setScError(`${STRINGS[langRef.current]?.api_err ?? 'api error'}: ${res.error}`); break; }
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
        const newestWithCovers = newest.map(t => cachedCovers[t.id] ? { ...t, coverUrl: cachedCovers[t.id] } : t);
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
        cache.map(t => cachedCovers[t.id] ? { ...t, coverUrl: cachedCovers[t.id] } : t));
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
  const handleScLogout = useCallback(() => {
    scCacheRef.current = [];
    scCacheMapRef.current = new Map();
    try { window.electronAPI.scSaveLikesCache([]); } catch {}
    setSettings(s => ({ ...s, soundcloudAuth: null, sourceMode: 'local' }));
  }, []);
  const handleToggleSource = useCallback(() => setSettings(s => ({ ...s, sourceMode: s.sourceMode === 'sc' ? 'local' : 'sc' })), []);
  const sourceMode = (settings.soundcloudAuth && settings.sourceMode === 'sc') ? 'sc' : 'local';

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

  const toastTimerRef = useRef(null);
  function handleSearchResultsLoaded(newTracks) {
    if (!searchQueueRef.current) return;
    searchQueueRef.current = [...searchQueueRef.current, ...newTracks];
    if (scShuffleOrderRef.current.length > 0) {
      const shuffledNew = buildScShuffle(newTracks, null);
      scShuffleOrderRef.current = [...scShuffleOrderRef.current, ...shuffledNew];
    }
  }

  function showToast(msg) {
    setToast(msg);
    setToastExiting(false);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      setToastExiting(true);
      setTimeout(() => { setToast(null); setToastExiting(false); }, 240);
    }, 2200);
  }

  function startFadeIn(audio) {
    cancelAnimationFrame(crossfadeRafRef.current);
    const cf = settingsRef.current?.crossfade || 0;
    if (cf <= 0) { audio.volume = volumeRef.current; return; }
    audio.volume = 0;
    const target = volumeRef.current;
    const startMs = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - startMs) / (cf * 1000));
      audio.volume = target * t;
      if (t < 1) crossfadeRafRef.current = requestAnimationFrame(tick);
    };
    crossfadeRafRef.current = requestAnimationFrame(tick);
  }

  function destroyHls() {
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
  }

  async function handleScTrackClick(scTrack, idx, autoSkip = false, skipCount = 0, direction = 1) {
    /* Токен запроса. handleScTrackClick делает await'ы (streamUrl, потом HLS),
       и без guard'а два быстрых клика давали гонку: первый запрос резолвился
       вторым и перебивал setScPlayingTrack — включался не тот трек, на который
       кликнули. Сейчас устаревший запрос просто выходит. */
    const req = ++scReqRef.current;
    const stale = () => req !== scReqRef.current;
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
    if (!auth) { setLoadingTrackId(null); setIsPlaying(false); return; }

    if (!autoSkip && shuffle) {
      const list = stationQueueRef.current || playlistQueueRef.current || searchQueueRef.current || (searchRef.current ? filteredScRef.current : scTracksRef.current);
      scShuffleOrderRef.current = buildScShuffle(list, scTrack.id);
      scShuffleIdxRef.current = 0;
    }

    const markError = () => {
      clearTimeout(errorTimerRef.current);
      setErrorTrackId(scTrack.id);
      errorTimerRef.current = setTimeout(() => setErrorTrackId(null), 2200);
    };

    const skipInDirection = () => {
      const list = stationQueueRef.current || playlistQueueRef.current || searchQueueRef.current || (searchRef.current ? filteredScRef.current : scTracksRef.current);
      if (shuffle) {
        const order = scShuffleOrderRef.current;
        const ni = scShuffleIdxRef.current + direction;
        if (skipCount < order.length && ni >= 0 && ni < order.length) {
          scShuffleIdxRef.current = ni;
          const nextTrack = list.find(t => t.id === order[ni]);
          if (nextTrack) { handleScTrackClick(nextTrack, scTracksRef.current.indexOf(nextTrack), true, skipCount + 1, direction); return; }
        }
        if (repeat === 'all' && direction > 0 && skipCount < order.length) {
          const newOrder = buildScShuffle(list, null);
          scShuffleOrderRef.current = newOrder;
          scShuffleIdxRef.current = 0;
          const nextTrack = list.find(t => t.id === newOrder[0]);
          if (nextTrack) handleScTrackClick(nextTrack, scTracksRef.current.indexOf(nextTrack), true, skipCount + 1, direction);
          else setIsPlaying(false);
        } else { setIsPlaying(false); }
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

    let resolvedUrl = null;
    let isHls = false;

    if (scTrack.streamUrl) {
      const res = await window.electronAPI.scFetch(scTrack.streamUrl, auth.token, auth.clientId);
      if (stale()) return;
      if (res.data?.url) resolvedUrl = res.data.url;
    }
    if (!resolvedUrl && scTrack.hlsUrl) {
      const res = await window.electronAPI.scFetch(scTrack.hlsUrl, auth.token, auth.clientId);
      if (stale()) return;
      if (res.data?.url) { resolvedUrl = res.data.url; isHls = true; }
    }
    /* успел протухнуть, пока грузили: не снимаем индикатор загрузки и не
       трогаем markError — этим занимается тот запрос, который актуален */
    if (stale()) return;

    if (!resolvedUrl) {
      trackSwitchingRef.current = false;
      setLoadingTrackId(null);
      setIsPlaying(false);
      markError();
      if (autoSkip) { skipInDirection(); }
      return;
    }

    const resolved = { ...scTrack, resolvedUrl };
    setScPlayingTrack(resolved);

    const audio = audioRef.current;
    if (!audio) { setLoadingTrackId(null); return; }

    const cf = settingsRef.current?.crossfade || 0;
    audio.volume = cf > 0 ? 0 : volumeRef.current;
    audio.addEventListener('playing', () => {
      trackSwitchingRef.current = false;
      startFadeIn(audio);
    }, { once: true });

    if (isHls && typeof Hls !== 'undefined' && Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.loadSource(resolvedUrl);
      hls.attachMedia(audio);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        audio.play().then(() => setLoadingTrackId(null)).catch(() => { setLoadingTrackId(null); setIsPlaying(false); });
        setIsPlaying(true);
      });
      hls.on(Hls.Events.LEVEL_LOADED, (_, data) => {
        const dur = Math.floor(data.details.totalduration || 0);
        if (dur) setScPlayingTrack(prev => prev ? { ...prev, duration: dur } : prev);
      });
    } else {
      audio.src = resolvedUrl;
      audio.load();
      audio.addEventListener('loadedmetadata', () => {
        const dur = Math.floor(audio.duration);
        if (dur) setScPlayingTrack(prev => prev ? { ...prev, duration: dur } : prev);
      }, { once: true });
      audio.play().then(() => setLoadingTrackId(null)).catch(() => { setLoadingTrackId(null); setIsPlaying(false); });
      setIsPlaying(true);
    }
  }

  async function selectTrack(t) {
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
      setTimeout(() => setHeroExiting(true), HERO_DUR_MS - 80);
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
        startFadeIn(audio);
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
    try {
      const res = await window.electronAPI.scFetch(
        `https://api-v2.soundcloud.com/stations/soundcloud:track-stations:${track.id}/tracks?limit=50`,
        auth.token, auth.clientId
      );
      const items = res?.data?.collection || [];
      if (items.length === 0) { showToast(t('station_err')); return; }
      const mapped = items.map(it => mapScTrack(it, STRINGS[langRef.current]?.no_title ?? 'Без названия'));
      stationQueueRef.current = mapped;
      playlistQueueRef.current = null;
      searchQueueRef.current = null;
      setPlaylistActive(null);
      setStationActive({ origTrack: track, tracks: mapped });
      setHomeVisible(false);
      setPlayerVisible(true);
      setView('player');
      setNavActive('library');
      // play the first track from station
      handleScTrackClick(mapped[0], -1);
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

  const searchLower = useMemo(() => search.toLowerCase(), [search]);
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
    /* текст живёт в колонке библиотеки — если она свёрнута, показать негде */
    if (next) setLibCollapsed(false);
  };

  /* панель уезжает вместе с плеером, а не остаётся висеть на чужом экране */
  useEffect(() => { if (!playerVisible) setLyricsOpen(false); }, [playerVisible]);

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
    if (!order.length) { setLyrics({ status: 'empty', tried: [] }); return; }
    setLyrics({ status: 'loading', tried: [] });
    fetchLyrics(track, order).then(r => {
      if (req !== lyricsReqRef.current) return;
      setLyrics(r);
    }).catch(e => {
      if (req !== lyricsReqRef.current) return;
      console.warn('[lyrics] fetch failed', e);
      setLyrics({ status: 'error', tried: [], why: String(e?.message || e) });
    });
  }, [lyricsOpen, track.id, track.title, lyricsNonce]);

  /* Перечитать текст. Тот же `lyricsNonce`, что у кнопки «попробовать
     снова»: побочный эффект ровно тот же — эффект выше видит новое значение
     и запускает поиск заново, с чистого состояния. отдельный рефреш со
     своей логикой не нужен. */
  const handleLyricsRefresh = useCallback(() => setLyricsNonce(n => n + 1), []);

  /* активная строка. rAF нужен только чтобы догонять play/pause/seek, но
     setState с bailout'ом не даёт ререндерить App каждый кадр: значение
     меняется на строку пару раз за трек, не 60 раз в секунду */
  useEffect(() => {
    if (!lyricsOpen || lyrics?.status !== 'ready' || !lyrics.synced) {
      if (lyricsActive !== -1) setLyricsActive(-1);
      return;
    }
    let raf = 0;
    const tick = () => {
      const dur = track.duration || 0;
      if (dur > 0) {
        const t = progressRef.current * dur;
        const ls = lyrics.lines;
        let idx = -1;
        for (let i = 0; i < ls.length; i++) {
          if (ls[i].t == null) continue;            /* метка секции — не строка */
          if (ls[i].t <= t) idx = i; else break;
        }
        setLyricsActive(prev => (prev === idx ? prev : idx));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [lyricsOpen, lyrics, track.id]);

  const handleLyricsSeek = useCallback((t) => {
    const dur = track.duration || 0;
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
  const plEditorRef = useRef(null);
  const handleNav = async (id) => {
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
          setTimeout(() => setReverseHeroExiting(true), HERO_DUR_MS - 80);
          setTimeout(() => { setReverseHero(null); setReverseHeroExiting(false); }, HERO_DUR_MS - 80 + HERO_FADE_MS + 20);
        }
        setPlayerVisible(false);
        setHomeVisible(true);
        setView('home');
      } else if (view === 'settings' || view === 'search' || view === 'artist' || view === 'playlists' || view === 'playlistEditor') {
        setHomeVisible(true);
        setView('home');
      } else if (view === 'home') {
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
    } else if (id === 'settings') {
      if (view === 'player') setPlayerVisible(false);
      if (view === 'home') setHomeVisible(false);
      setTimeout(() => setView('settings'), view === 'home' ? 240 : 300);
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
        setTimeout(() => setHeroExiting(true), HERO_DUR_MS - 80);
      }
      setHomeVisible(false);
      setPlayerVisible(true);
      setView('player');
    } else if (view === 'settings') {
      setPlayerVisible(true);
      setView('player');
    } else if (view === 'search') {
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
      setLibScrollTargetId(track.id);
      setLibScrollTrigger(v => v + 1);
    }
  };
  handleNavRef.current = handleNav;

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
    <div style={{display:'flex', width:'100%', height:'100%', overflow:'hidden'}}>
      {hero && hero.targetRect && <HeroClone hero={hero} exiting={heroExiting}/>}
      {reverseHero && reverseHero.targetRect && <HeroClone hero={reverseHero} exiting={reverseHeroExiting} reverse={true}/>}
      <TopBar navActive={navActive} onNav={handleNav}
        libCollapsed={libCollapsed} onToggleLib={()=>setLibCollapsed(v=>!v)}
        inPlayer={view==='player'} scAuth={settings.soundcloudAuth||null}
        sourceMode={sourceMode} onToggleSource={handleToggleSource}/>

      <div style={{position:'relative', flex:1, height:'100%', overflow:'hidden'}}>

        {(
          <div ref={homeScrollRef} className="scroll-thin scroll-home" style={{
            position:'absolute', top:0, left:0, right:10, bottom:0,
            overflowY:'auto', padding:'18px 4px 32px 36px',
            opacity: homeVisible ? 1 : 0,
            transition: 'opacity 0.18s ease',
            pointerEvents: homeVisible ? 'auto' : 'none',
          }}>
            {!showWelcome && <div style={{
              display:'flex', alignItems:'center', gap:14, marginBottom:22,
            }}>
              {/* порядок: подпись слева, поиск по центру, действие справа */}
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
              {sourceMode !== 'sc' && (
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
            position:'absolute', inset:0, display:'flex',
            opacity: playerVisible ? 1 : 0,
            transition:'opacity 0.1s ease',
            pointerEvents: playerVisible ? 'auto' : 'none',
          }}>
        {/* library panel */}
        <div style={{
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
          <div style={{
            position:'absolute', inset:0, display:'flex', flexDirection:'column',
            opacity: lyricsOpen ? 0 : 1,
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
            pointerEvents: playerVisible && !lyricsOpen ? 'auto' : 'none',
            transform: lyricsOpen ? 'translateX(-14px)' : 'translateX(0)',
            transition: lyricsOpen
              ? 'opacity 0.16s ease, transform 0.16s ease'
              : 'opacity 0.3s ease 0.08s, transform 0.44s cubic-bezier(0.22,1,0.36,1) 0.08s',
          }}>
          <AnimatePresence initial={false} mode="wait">
          {stationActive ? (
            <motion.div key="station-chip"
              initial={{ opacity: 0, y: -10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98, transition: { duration: 0.14, ease: 'easeIn' } }}
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
                  <img src={stationActive.origTrack.coverUrl} style={{
                    width:26, height:26, borderRadius:7, objectFit:'cover',
                    flexShrink:0, display:'block'}}/>
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
              exit={{ opacity: 0, y: -8, scale: 0.98, transition: { duration: 0.14, ease: 'easeIn' } }}
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
                  <img src={playlistActive.playlist.coverUrl} style={{
                    width:26, height:26, borderRadius:7, objectFit:'cover',
                    flexShrink:0, display:'block'}}/>
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
              <ShuffleBtn variant="icon" field h={38} on={shuffle} onClick={() => handleShuffleToggle(activeQueueList())}/>
              </div>
            </motion.div>
          )}
          </AnimatePresence>
          <VirtualTrackList
            items={stationActive ? stationActive.tracks : playlistActive ? playlistActive.tracks : activeList}
            activeId={stationActive || playlistActive ? (scPlayingTrack ? scPlayingTrack.id : null) : activeListPlayingId}
            loadingId={loadingTrackId}
            errorId={errorTrackId}
            onClickItem={libClickStable}
            scrollToActive={libScrollTrigger}
            scrollTargetId={libScrollTargetId}
            onContextMenuItem={libCtxStable}
          />
          </div>
          <LyricsPanel open={lyricsOpen} inPlayer={playerVisible} state={lyrics} activeLine={lyricsActive}
            onSeek={handleLyricsSeek} onRetry={handleLyricsRefresh}
            onRefresh={handleLyricsRefresh}
            sources={settings.lyricsSources} onBack={() => setLyricsOpen(false)}/>
          </div>
        </div>

        {/* drag handle — positioned relative to flex parent, sits on library's right edge */}
        {/* center player */}
        <div style={{
          flex:1, minWidth:0, height:'100%',
          display:'flex', alignItems:'center', justifyContent:'center',
        }}>
          <div style={{
            width:'calc(100% - 48px)',
            maxWidth:'clamp(380px, 55vw, 900px)', minWidth:220,
            display:'flex', flexDirection:'column',
            alignItems:'center', gap:0,
          }}>
            <div style={{width:'100%', display:'flex', flexDirection:'column', alignItems:'center'}}>
            <div ref={playerInfoRef} style={{width:'100%', display:'flex', flexDirection:'column', alignItems:'center', opacity:0}}>
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
            </div>{/* playerInfoRef end */}
              {/* album art with ambient glow */}
              <div style={{
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
            </div>
            <div style={{
              width:'min(100%, clamp(260px, 34vw, 520px))', margin:'0 auto 0',
              opacity: playerVisible ? 1 : 0,
              transform: playerVisible ? 'translateY(0)' : 'translateY(10px)',
              transition: playerVisible ? 'opacity 0.36s ease 0.28s, transform 0.48s cubic-bezier(0.22,1,0.36,1) 0.28s' : 'opacity 0.1s ease, transform 0.1s ease',
            }}>
              <ProgressBar progressRef={progressRef} audioRef={audioRef} total={track.duration || 0}
                onSeek={handleSeek} isPlaying={isPlaying} visible={playerVisible}
                />
            {/* ❌ был `const P = { spring:0.055, damping:0.84, clamp:10 }`,
                который шестиминутно передавался в `physics={P}` во все
                MagBtn/PlayBtn. НИ MagBtn, НИ PlayBtn этот проп не
                принимают — анимация там на whileTap/whileHover Motion.
                мёртвый объект пересоздавался на каждом рендере ради
                ничего; удалён вместе с шестью передачами. */}
            {(()=>{ const SIDE = 'clamp(40px, 5.2vw, 58px)'; return (
            <div style={{display:'flex', alignItems:'center', gap:14, justifyContent:'center', marginTop:16}}>
              {/* Левый балансирующий спейсер 27px УБРАН. Он уравнивал play с
                  кнопкой лайка, когда слева было только shuffle+prev. Слева
                  теперь ещё и кнопка текста, и спейсер сдвигал play на 29px.
                  Справа вместо этого постоянный слот шириной лайка (27px +
                  marginLeft 14): сам лайк, когда он есть, и невидимый спейсер,
                  когда трек локальный. Ряд сбалансирован в обоих случаях,
                  лайк никуда не уезжает. Слева спейсер не нужен вовсе —
                  flex gap уже даёт отступ от края. */}
              <MagBtn onClick={handleToggleLyrics} active={lyricsOpen} size={SIDE}>
                <img src="../assets/textt.png" style={{width:'clamp(18px, 2.2vw, 26px)',height:'clamp(18px, 2.2vw, 26px)',filter:'brightness(0) invert(1)',opacity:lyricsOpen?1:0.38,transition:'opacity 0.2s ease'}}/>
              </MagBtn>
              <MagBtn onClick={()=>setShuffle(s=>!s)} active={shuffle} size={SIDE}>
                <img src="../assets/shuffle.png" style={{width:'clamp(18px, 2.2vw, 26px)',height:'clamp(18px, 2.2vw, 26px)',filter:'brightness(0) invert(1)',opacity:shuffle?1:0.38,transition:'opacity 0.2s ease'}}/>
              </MagBtn>
              <MagBtn onClick={handlePrev} size={'clamp(46px, 6vw, 66px)'}>
                <img src="../assets/rewind.png" style={{width:'clamp(18px, 2.2vw, 26px)',height:'clamp(18px, 2.2vw, 26px)',filter:'brightness(0) invert(1)',opacity:0.38}}/>
              </MagBtn>
              <PlayBtn isPlaying={isPlaying} onToggle={()=>setIsPlaying(p=>!p)}
                trackKey={scPlayingTrack ? 'sc:'+scPlayingTrack.id
                        : (track ? 'loc:'+track.id : null)}/>
              <MagBtn onClick={handleNext} size={'clamp(46px, 6vw, 66px)'}>
                <img src="../assets/forward.png" style={{width:'clamp(18px, 2.2vw, 26px)',height:'clamp(18px, 2.2vw, 26px)',filter:'brightness(0) invert(1)',opacity:0.38}}/>
              </MagBtn>
              <MagBtn onClick={()=>setRepeat(r=>r==='off'?'all':r==='all'?'one':'off')} active={repeat!=='off'} size={SIDE}>
                <div style={{position:'relative',width:'clamp(18px, 2.2vw, 26px)',height:'clamp(18px, 2.2vw, 26px)'}}>
                  <img src="../assets/repeat.png"  style={{position:'absolute',top:0,left:0,width:'100%',height:'100%',filter:'brightness(0) invert(1)',opacity:repeat==='off'?0.38:repeat==='all'?1:0,transition:'opacity 0.2s ease'}}/>
                  <img src="../assets/repeat1.png" style={{position:'absolute',top:0,left:0,width:'100%',height:'100%',filter:'brightness(0) invert(1)',opacity:repeat==='one'?1:0,transition:'opacity 0.2s ease'}}/>
                </div>
              </MagBtn>
              {scPlayingTrack
                ? <PlayerLikeBtn liked={likedIds.has(scPlayingTrack.id)}
                    onLike={() => handleLike(scPlayingTrack)} style={{marginLeft:14}}/>
                : <div style={{width:27, marginLeft:14, flexShrink:0}}/>}
            </div>
            ); })()}
            </div>{/* controls+progress wrapper end */}
          </div>
        </div>

        {/* volume panel */}
        <div style={{
          width:28, flexShrink:0, height:'100%',
          display:'flex', flexDirection:'column', alignItems:'center',
          paddingTop:110, paddingBottom:110, paddingRight:5,
          opacity: playerVisible ? 1 : 0,
          transform: playerVisible ? 'translateX(0)' : 'translateX(8px)',
          transition: playerVisible ? 'opacity 0.36s ease 0.44s, transform 0.48s cubic-bezier(0.22,1,0.36,1) 0.44s' : 'opacity 0.1s ease, transform 0.1s ease',
        }}>
          <ThinVolumeSlider volume={volume} onChange={handleVolumeCommit} onLiveChange={handleVolumeLive}/>
        </div>
          </div>
        )}

        <SettingsView settings={settings} onSettings={setSettings} visible={view==='settings'} onScanTracks={handleScanTracks} onClearFolder={handleClearFolder} onClearCoversCache={handleClearCoversCache} onClearLikesCache={handleClearLikesCache} appAccent={appAccent} scAuth={settings.soundcloudAuth||null} onScLogin={handleScLogin} onScLogout={handleScLogout} sec={settingsSec} setSec={setSettingsSec} discordStatus={discordStatus}/>
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
          onSelectTrack={(t, queue) => { searchQueueRef.current = queue || null; handleScTrackClick(t, -1); setHomeVisible(false); setPlayerVisible(true); setView('player'); setNavActive('library'); }}
          onResultsLoaded={handleSearchResultsLoaded}
          onArtistClick={handleOpenArtist}
          loadingTrackId={loadingTrackId} errorTrackId={errorTrackId}
          hideDividers={settings.hideDividers}/>
        <ArtistView artist={artistView} visible={view==='artist'} onClose={handleCloseArtist} scAuth={settings.soundcloudAuth||null} artistCacheRef={artistCacheRef}
          hideDividers={settings.hideDividers}
          likedIds={likedIds} onLike={handleLike}
          onPlayTrack={t => handleScTrackClick(t, -1)}
          onSelectTrack={t => { handleScTrackClick(t, -1); setHomeVisible(false); setPlayerVisible(true); setView('player'); setNavActive('library'); }}
          loadingTrackId={loadingTrackId} errorTrackId={errorTrackId}
          onFollow={handleFollow} onCheckFollow={checkFollow}/>

        <AnimatePresence>
          {toast && !toastExiting && (
            <motion.div
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
                background:'rgba(24,24,24,0.97)',
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
