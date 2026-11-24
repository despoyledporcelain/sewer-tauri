import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';
import * as history from '../src/listening-history.js';
import { loadHistoryCovers } from '../src/history-covers.js';

const { HISTORY_LIMIT, ListeningRecorder, historyEntry, historyTrackKey, cleanListeningHistory,
  addListeningHistory, groupListeningHistory, historyDay } = history;
const app = readFileSync(new URL('../src/app.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const hook = readFileSync(new URL('../src/use-listening-history.js', import.meta.url), 'utf8');
const local = { id: 1, path: 'C:\\music\\song.mp3', title: 'song', artist: 'artist', duration: 100 };
const cloud = { id: 42, title: 'cloud song', artist: 'cloud artist', duration: 100,
  coverUrl: 'https://example.com/art.jpg', streamUrl: 'private-stream', resolvedUrl: 'signed-url', token: 'secret' };
const stamp = new Date(2026, 10, 19, 18, 30).getTime();

test('local history is bounded, sorted, deduplicated and defensive about corrupt or old settings', () => {
  for (const raw of [undefined, null, {}, 'bad', [null, {}, { source: 'invalid', track: cloud, playedAt: stamp }],
    [{ source: 'sc', track: cloud }], [{ source: 'local', track: local, playedAt: null }]]) {
    assert.deepEqual(cleanListeningHistory(raw), []);
  }
  const entries = Array.from({ length: HISTORY_LIMIT + 30 }, (_, i) => historyEntry(cloud, 'sc', stamp + i));
  const clean = cleanListeningHistory([entries[4], ...entries]);
  assert.equal(clean.length, HISTORY_LIMIT);
  assert.equal(clean[0].playedAt, stamp + HISTORY_LIMIT + 29);
  assert.equal(new Set(clean.map(entry => entry.id)).size, clean.length);
  assert.equal(historyEntry(cloud, 'sc', Infinity), null);
  assert.equal(historyEntry(cloud, 'sc', 0.1), null);
  assert.equal(historyEntry(cloud, 'sc', 8640000000000001), null);
  assert.equal(historyEntry({ id: '../path' }, 'sc', stamp), null);
  assert.equal(historyEntry(cloud, undefined, stamp), null);
  assert.equal(historyEntry({ ...cloud, id: '99999999999999999999' }, 'sc', stamp), null);
});

test('identity distinguishes sources and survives local re-scans and Windows path case changes', () => {
  assert.equal(historyTrackKey(local, 'local'), historyTrackKey({ ...local, id: 9, path: local.path.toUpperCase() }, 'local'));
  assert.notEqual(historyTrackKey(local, 'local'), historyTrackKey({ id: 1 }, 'sc'));
  assert.equal(historyTrackKey({ urn: 'soundcloud:tracks:42' }, 'sc'), 'sc:42');
  const entries = addListeningHistory([historyEntry(cloud, 'sc', stamp)], historyEntry(local, 'local', stamp + 100));
  assert.equal(entries[0].source, 'local');
  assert.deepEqual(JSON.parse(JSON.stringify(entries)), cleanListeningHistory(entries));
  const repeats = addListeningHistory(entries, historyEntry(local, 'local', stamp + 200));
  assert.equal(repeats.length, 3);
  assert.equal(repeats[0].key, repeats[1].key);
  assert.notEqual(repeats[0].id, repeats[1].id);
});

test('saved snapshots never contain auth, signed streams or embedded artwork', () => {
  const entry = historyEntry({ ...cloud, token: 'secret', coverUrl: 'https://example.com/art.jpg?token=secret#x' }, 'sc', stamp);
  assert.equal(entry.track.coverUrl, 'https://example.com/art.jpg');
  assert.equal(JSON.stringify(entry).includes('secret'), false);
  assert.equal('streamUrl' in entry.track, false);
  assert.equal('resolvedUrl' in entry.track, false);
  for (const coverUrl of ['data:image/png;base64,large', 'blob:memory', 'javascript:alert(1)', 'https://user:pass@example.com/art']) {
    assert.equal(historyEntry({ ...cloud, coverUrl }, 'sc', stamp).track.coverUrl, null);
  }
  const huge = historyEntry({ ...cloud, title: 'x'.repeat(10000), duration: Infinity }, 'sc', stamp);
  assert.equal(huge.track.title.length, 240);
  assert.equal(huge.track.duration, 0);
});

const cachedCover = 'http://asset.localhost/C%3A/Users/test/AppData/Roaming/sewer-tauri/sc_covers/42.jpg';

test('history preserves Tauri cached cover URLs but never accepts arbitrary insecure hosts', () => {
  for (const coverUrl of [cachedCover, cachedCover.replace('http:', 'https:'), 'asset://localhost/C%3A/covers/42.jpg']) {
    const entry = historyEntry({ ...cloud, coverUrl }, 'sc', stamp);
    assert.equal(entry.track.coverUrl, coverUrl);
    assert.equal(cleanListeningHistory(JSON.parse(JSON.stringify([entry])))[0].track.coverUrl, coverUrl);
  }
  for (const coverUrl of ['http://example.com/art.jpg', 'http://asset.localhost.evil/art.jpg',
    'http://asset.localhost:1420/art.jpg', 'asset://evil/art.jpg', 'http://user:pass@asset.localhost/art.jpg']) {
    assert.equal(historyEntry({ ...cloud, coverUrl }, 'sc', stamp).track.coverUrl, null);
  }
});

test('old coverless history is restored from the disk cache without auth or metadata requests', async () => {
  const entries = [historyEntry({ ...cloud, coverUrl: null }, 'sc', stamp), historyEntry(cloud, 'sc', stamp - 1000),
    historyEntry(local, 'local', stamp - 2000)];
  const calls = [], covers = {};
  await loadHistoryCovers(entries, { api: {
    scCheckCovers: async ids => { calls.push(ids); return { 42: cachedCover }; },
    scFetch: () => { throw new Error('must not refetch a cached cover'); },
    scCacheCover: () => { throw new Error('must not redownload a cached cover'); },
  }, onCover: (key, cover) => { covers[key] = cover; } });
  assert.deepEqual(calls, [[42]]);
  assert.deepEqual(covers, { 'sc:42': cachedCover });
});

test('missing cached images recover via track metadata and the native cover downloader', async () => {
  const calls = [], covers = {};
  const auth = { token: 'app-token', clientId: 'app-client' };
  await loadHistoryCovers([historyEntry({ ...cloud, coverUrl: cachedCover }, 'sc', stamp)], { auth, api: {
    scCheckCovers: async () => ({}),
    scFetch: async (...args) => { calls.push(args); return { data: { id: 42, artwork_url: 'https://i1.sndcdn.com/art-large.jpg' } }; },
    scCacheCover: async (...args) => { calls.push(args); return cachedCover; },
  }, onCover: (key, cover) => { covers[key] = cover; } });
  assert.deepEqual(calls, [['https://api-v2.soundcloud.com/tracks/42', auth.token, auth.clientId],
    [42, 'https://i1.sndcdn.com/art-t500x500.jpg']]);
  assert.deepEqual(covers, { 'sc:42': cachedCover });
});

test('remote snapshot covers load without login and survive downloader failures', async () => {
  const covers = {};
  await loadHistoryCovers([historyEntry(cloud, 'sc', stamp)], { api: {
    scCheckCovers: async () => { throw new Error('cache unavailable'); },
    scCacheCover: async (id, url) => { assert.equal(id, 42); assert.equal(url, cloud.coverUrl); throw new Error('offline'); },
    scFetch: () => { throw new Error('snapshot needs no authorization'); },
  }, onCover: (key, cover) => { covers[key] = cover; } });
  assert.equal(covers['sc:42'], cloud.coverUrl);
});

test('failed metadata does not block other images and foreign track IDs are rejected', async () => {
  const covers = {}, downloaded = [];
  const entries = [42, 43, 44].map(id => historyEntry({ ...cloud, id, coverUrl: null }, 'sc', stamp));
  await loadHistoryCovers(entries, { auth: { token: 'app-token' }, api: {
    scCheckCovers: async () => ({}),
    scFetch: async url => url.endsWith('/42') ? { error: 404 }
      : { data: { id: url.endsWith('/43') ? 43 : 99, artwork_url: 'https://i1.sndcdn.com/art-large.jpg' } },
    scCacheCover: async id => { downloaded.push(id); return cachedCover.replace('42.jpg', `${id}.jpg`); },
  }, onCover: (key, cover) => { covers[key] = cover; } });
  assert.deepEqual(downloaded, [43]);
  assert.deepEqual(Object.keys(covers), ['sc:43']);
});

test('cancelled history artwork loads cannot publish late results or start more requests', async () => {
  let disposed = false, resolve;
  const covers = [];
  const pending = loadHistoryCovers([historyEntry(cloud, 'sc', stamp)], { api: {
    scCheckCovers: () => new Promise(done => { resolve = done; }),
    scCacheCover: () => { throw new Error('must not start after cancellation'); },
  }, cancelled: () => disposed, onCover: (...args) => covers.push(args) });
  disposed = true; resolve({ 42: cachedCover }); await pending;
  assert.deepEqual(covers, []);
  disposed = false;
  const download = loadHistoryCovers([historyEntry(cloud, 'sc', stamp)], { api: {
    scCheckCovers: async () => ({}), scCacheCover: () => new Promise(done => { resolve = done; }),
  }, cancelled: () => disposed, onCover: (...args) => covers.push(args) });
  await new Promise(done => setImmediate(done));
  disposed = true; resolve(cachedCover); await download;
  assert.deepEqual(covers, []);
});

test('artwork hook loads only in the history tab and drops updates after cleanup', () => {
  const effects = [], loads = [], writes = [];
  const api = {};
  const context = { module: { exports: {} }, window: { electronAPI: api }, require: id => id === 'react' ? {
    useState: () => [{}, update => { writes.push(update({})); }], useEffect: effect => effects.push(effect),
  } : { loadHistoryCovers: (entries, options) => { loads.push({ entries, ...options }); } } };
  const source = readFileSync(new URL('../src/use-history-covers.js', import.meta.url), 'utf8');
  vm.runInNewContext(transformSync(source, { format: 'cjs' }).code, context);
  const render = context.module.exports.useHistoryCovers;
  const entries = [historyEntry(cloud, 'sc', stamp)];
  render({ visible: false, entries }); effects.pop()();
  render({ visible: true, entries: [] }); effects.pop()();
  assert.equal(loads.length, 0);
  render({ visible: true, entries, auth: { token: 'app-token', clientId: 'app-client' } });
  const cleanup = effects.pop()();
  assert.equal(loads[0].api, api);
  assert.equal(loads[0].auth.token, 'app-token');
  loads[0].onCover('sc:42', cachedCover);
  assert.equal(writes[0]['sc:42'], cachedCover);
  cleanup();
  assert.equal(loads[0].cancelled(), true);
  loads[0].onCover('sc:43', cachedCover);
  assert.equal(writes.length, 1);
  assert.match(app, /cloudTracks=\{scTracks\} covers=\{historyCovers\}/);
});

function recorderScene(track = cloud) {
  const recorder = new ListeningRecorder();
  const audio = { src: 'audio-source', currentTime: 0, duration: 100, playbackRate: 1,
    paused: false, seeking: false, ended: false, readyState: 4 };
  let clock = 0;
  const sample = (seconds = 0, movement = seconds * audio.playbackRate, options = {}) => {
    clock += seconds * 1000;
    audio.currentTime += movement;
    return recorder.sample({ track, source: track.path ? 'local' : 'sc', audio, playing: true,
      switching: false, clock, playedAt: stamp + clock, ...options });
  };
  return { recorder, audio, sample };
}

test('real local and SoundCloud decoder playback records one entry per playback session', () => {
  for (const track of [cloud, local]) {
    const t = recorderScene(track);
    assert.equal(t.sample(), null);
    for (let i = 0; i < 4; i++) assert.equal(t.sample(1), null);
    const entry = t.sample(1);
    assert.equal(entry.key, historyTrackKey(track));
    assert.equal(entry.playedAt, stamp + 5000);
    for (let i = 0; i < 20; i++) assert.equal(t.sample(1), null);
  }
});

test('selection, paused audio, failed loads, buffering and ended audio cannot create listens', () => {
  for (const change of [audio => { audio.paused = true; }, audio => { audio.readyState = 0; },
    audio => { audio.ended = true; }, audio => { audio.__sewRpcWaiting = true; }, audio => { audio.src = ''; }]) {
    const t = recorderScene();
    change(t.audio); t.sample();
    assert.equal(t.sample(100, 50), null);
  }
  const stalled = recorderScene();
  stalled.sample();
  for (let i = 0; i < 10; i++) assert.equal(stalled.sample(1, 0), null);
  const noTrack = recorderScene();
  assert.equal(noTrack.sample(100, 100, { track: null }), null);
  const uiPaused = recorderScene();
  uiPaused.sample(0, 0, { playing: false });
  assert.equal(uiPaused.sample(20, 20, { playing: false }), null);
});

test('seeks and pending track switches cannot count as listened time', () => {
  const t = recorderScene();
  t.sample();
  assert.equal(t.sample(0.1, 80), null);
  t.audio.seeking = true;
  assert.equal(t.sample(10, 10), null);
  t.audio.seeking = false;
  assert.equal(t.sample(1, 1, { switching: true }), null);
  assert.equal(t.sample(1), null);
  for (let i = 0; i < 4; i++) assert.equal(t.sample(1), null);
  assert.ok(t.sample(1));
});

test('pause and resume preserve one session without adding duplicates', () => {
  const t = recorderScene();
  t.sample(); t.sample(3);
  t.audio.paused = true;
  assert.equal(t.sample(), null);
  assert.equal(t.sample(100, 0), null);
  t.audio.paused = false;
  assert.equal(t.sample(), null);
  assert.ok(t.sample(2));
  t.audio.paused = true; t.sample();
  t.audio.paused = false; t.sample();
  assert.equal(t.sample(20), null);
});

test('playback speed, short tracks and repeat-one sessions are accounted for', () => {
  const fast = recorderScene();
  fast.audio.playbackRate = 2;
  fast.sample();
  assert.equal(fast.sample(4), null);
  assert.ok(fast.sample(1));
  fast.audio.currentTime = 0;
  assert.equal(fast.sample(), null);
  assert.ok(fast.sample(5));
  const short = recorderScene({ ...cloud, duration: 1 });
  short.audio.playbackRate = 2;
  short.sample();
  assert.ok(short.sample(0.25));
  short.audio.currentTime = 0;
  short.sample();
  assert.ok(short.sample(0.25));
});

test('distinct crossfade decks and source replacements never share accumulated listen time', () => {
  const t = recorderScene();
  t.sample(); t.sample(3);
  const incoming = { ...t.audio, currentTime: 8, src: 'next-source' };
  assert.equal(t.sample(3, 3, { audio: incoming, track: { ...cloud, id: 43 } }), null);
  incoming.currentTime += 5;
  assert.ok(t.sample(5, 0, { audio: incoming, track: { ...cloud, id: 43 } }));
  const source = recorderScene();
  source.sample(); source.sample(3);
  source.audio.src = 'reloaded-source';
  assert.equal(source.sample(3), null);
});

test('date groups use local calendar days, including year boundaries', () => {
  const today = historyEntry(cloud, 'sc', new Date(2026, 0, 1, 0, 10).getTime());
  const yesterday = historyEntry(local, 'local', new Date(2025, 11, 31, 23, 50).getTime());
  const groups = groupListeningHistory([today, yesterday]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].day, historyDay(today.playedAt));
  assert.equal(groups[1].entries[0], yesterday);
});

test('the local observer uses live state, ignores retired decks and cleans up every listener', () => {
  const effects = [], refs = [], samples = [];
  let cursor = 0;
  const listen = historyEntry(cloud, 'sc', stamp);
  const listeners = new Map();
  const audio = { currentTime: 0, addEventListener: (event, listener) => listeners.set(event, listener),
    removeEventListener: event => listeners.delete(event) };
  const context = { module: { exports: {} }, require: id => id === 'react' ? {
    useRef: value => refs[cursor++] ??= { current: value }, useEffect: effect => effects.push(effect),
  } : { historyTrackKey, ListeningRecorder: class {
    sample(options) { samples.push(options); return options.audio.currentTime >= 5 ? listen : null; }
  } } };
  vm.runInNewContext(transformSync(hook, { format: 'cjs' }).code, context);
  const writes = [];
  const options = { track: cloud, source: 'sc', audioRef: { current: audio }, playingRef: { current: true },
    switchingRef: { current: false }, onListen: entry => writes.push(entry) };
  context.module.exports.useListeningHistory(options);
  const cleanup = effects[0]();
  assert.equal(listeners.size, 8);
  options.playingRef.current = false;
  listeners.get('pause')();
  assert.equal(samples.at(-1).playing, false);
  options.playingRef.current = true;
  audio.currentTime = 5;
  listeners.get('timeupdate')();
  assert.deepEqual(writes, [listen]);
  options.audioRef.current = { currentTime: 10 };
  listeners.get('timeupdate')();
  assert.equal(writes.length, 1);
  cleanup();
  assert.equal(listeners.size, 0);
  assert.doesNotMatch(hook, /scFetch|fetchApi|fetchListeningHistory|soundcloudAuth|scSave/);
});

function viewHarness() {
  const state = { confirmClear: false };
  const context = { module: { exports: {} }, require: id => id === 'react' ? {
    ...React, useState: () => [state.confirmClear, value => { state.confirmClear = value; }],
    useEffect: () => {}, useMemo: fn => fn(),
  } : history };
  vm.runInNewContext(transformSync(readFileSync(new URL('../src/listening-history.jsx', import.meta.url), 'utf8'),
    { loader: 'jsx', format: 'cjs' }).code, context);
  return { render: props => context.module.exports.ListeningHistory(props), state };
}
const labels = { title: 'История', subtitle: 'Прослушанное в этом приложении', today: 'Сегодня', yesterday: 'Вчера',
  count: 'Прослушиваний: {n}', clear: 'Очистить', confirmClear: 'Удалить историю?', cancel: 'Отмена',
  empty: 'Здесь будет твоя музыка', emptyHint: 'Включи трек', untitled: 'Без названия', local: 'локально',
  unavailable: 'Файл больше не в библиотеке', playError: 'Не удалось включить трек', play: 'Воспроизвести' };
const viewProps = { visible: true, entries: [], localTracks: [], labels, locale: 'ru-RU' };
function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(child => find(child, predicate));
  if (!React.isValidElement(tree)) return [];
  return [...(predicate(tree) ? [tree] : []), ...find(tree.props.children, predicate)];
}

test('history uses the provided PNG silhouette with theme-aware color in navigation and empty state', () => {
  const icon = readFileSync(new URL('../public/assets/history.png', import.meta.url));
  assert.equal(icon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.match(css, /\.history-icon\s*\{[^}]*background-color:currentColor;[^}]*mask:url\('\/assets\/history\.png'\) center \/ contain no-repeat;/);
  assert.match(css, /\.history-empty > \.history-icon/);
  assert.match(app, /id:"history"[^\n]*<HistoryIcon\/>/);
  const source = readFileSync(new URL('../src/listening-history.jsx', import.meta.url), 'utf8');
  assert.match(source, /className="history-icon" style=\{\{ width:size, height:size \}\} aria-hidden="true"/);
  assert.match(source, /<HistoryIcon size=\{32\}\/>/);
});

test('local history is available without an account, has an empty state and hides missing files', () => {
  const h = viewHarness();
  const empty = renderToStaticMarkup(h.render(viewProps));
  assert.ok(empty.includes(labels.empty));
  assert.equal(empty.includes('Войди'), false);
  const entries = [historyEntry({ ...local, title: '<script>no</script>' }, 'local', stamp)];
  const row = find(h.render({ ...viewProps, entries }), node => node.props.className === 'history-row')[0];
  assert.equal(row.props.disabled, true);
  const html = renderToStaticMarkup(h.render({ ...viewProps, entries }));
  assert.ok(html.includes('&lt;script&gt;no&lt;/script&gt;'));
  assert.ok(html.includes(labels.unavailable));
  const available = h.render({ ...viewProps, entries, localTracks: [{ ...local, id: 999 }] });
  assert.equal(find(available, node => node.props.className === 'history-row')[0].props.disabled, false);
  assert.equal(h.render({ ...viewProps, visible: false }), null);
});

test('rows replay the selected entry and show the actual local listen time', () => {
  const h = viewHarness();
  const entry = historyEntry(cloud, 'sc', stamp);
  const entries = [entry, historyEntry(cloud, 'sc', stamp - 1000)];
  const calls = [];
  const tree = h.render({ ...viewProps, entries, currentKey: entry.key, onPlay: item => calls.push(item), isPlaying: true });
  const rows = find(tree, node => node.props.className === 'history-row');
  rows[0].props.onClick();
  assert.deepEqual(calls, [entry]);
  assert.equal(rows[0].props['data-active'], 'true');
  assert.equal(rows[1].props['data-active'], 'false');
  assert.equal(find(tree, node => node.type === 'time')[0].props.dateTime, new Date(stamp).toISOString());
  const loading = h.render({ ...viewProps, entries, loadingId: entry.id });
  assert.equal(find(loading, node => node.props.className === 'history-row')[0].props['aria-busy'], true);
});

test('history renders restored disk covers, current library artwork and late local tag covers', () => {
  const h = viewHarness();
  const entry = historyEntry({ ...cloud, coverUrl: null }, 'sc', stamp);
  const props = { ...viewProps, entries: [entry] };
  assert.equal(find(h.render(props), node => node.type === 'img').length, 0);
  const restored = h.render({ ...props, covers: { 'sc:42': cachedCover } });
  assert.equal(find(restored, node => node.type === 'img')[0].props.src, cachedCover);
  const live = h.render({ ...props, cloudTracks: [{ ...cloud, coverUrl: cachedCover }] });
  assert.equal(find(live, node => node.type === 'img')[0].props.src, cachedCover);
  const localCover = 'data:image/jpeg;base64,localcover';
  const file = h.render({ ...viewProps, entries: [historyEntry(local, 'local', stamp)],
    localTracks: [{ ...local, coverUrl: localCover }] });
  assert.equal(find(file, node => node.type === 'img')[0].props.src, localCover);
});

test('clearing local history requires inline confirmation and can be cancelled', () => {
  const h = viewHarness();
  const calls = [];
  const props = { ...viewProps, entries: [historyEntry(cloud, 'sc', stamp)], onClear: () => calls.push('clear') };
  const byLabel = label => find(h.render(props), node => node.type === 'button' && node.props.children === label)[0];
  byLabel(labels.clear).props.onClick();
  assert.equal(calls.length, 0);
  assert.equal(h.state.confirmClear, true);
  byLabel(labels.cancel).props.onClick();
  assert.equal(h.state.confirmClear, false);
  byLabel(labels.clear).props.onClick();
  byLabel(labels.clear).props.onClick();
  assert.deepEqual(calls, ['clear']);
  assert.equal(h.state.confirmClear, false);
});

function replayHarness(overrides = {}) {
  const start = app.indexOf('  const handleHistoryPlay = async entry =>');
  const end = app.indexOf('  async function handleScTrackClick(', start);
  assert.ok(start > 0 && end > start);
  const state = { settings: { sourceMode: 'sc', untouched: true }, played: [], toasts: [] };
  const ref = current => ({ current });
  const context = { historyTrackKey, track: cloud, scPlayingTrack: cloud, tracks: [local], trackRef: ref(cloud),
    partyCanSelect: () => true,
    historyRequestRef: ref(0), scReqRef: ref(0), scAuthRef: ref({ token: 'auth', clientId: 'client', userId: 1 }),
    scCacheMapRef: ref(new Map()), scTracksRef: ref([]), xfadeRef: ref(null), xfadePrimeRef: ref(null),
    trackSwitchingRef: ref(false), stationQueueRef: ref(['old station']), playlistQueueRef: ref(['old playlist']),
    searchQueueRef: ref(null), progressRef: ref(0.5),
    setSettings: update => { state.settings = update(state.settings); },
    setHistoryErrorId: id => { state.error = id; }, setHistoryLoadingId: id => { state.loading = id; },
    setLoadingTrackId: () => {}, setIsPlaying: playing => { state.playing = playing; },
    setPendingPlayerTrack: track => { state.pendingTrack = track; },
    setScPlayingTrack: track => { state.scTrack = track; }, setTrackIdx: idx => { state.idx = idx; },
    setStationActive: station => { state.station = station; }, setPlaylistActive: playlist => { state.playlist = playlist; },
    abortCrossfade: () => { state.aborted = true; }, showToast: message => state.toasts.push(message), t: key => key,
    mapScTrack: raw => ({ ...raw, streamUrl: 'fresh-api-stream' }),
    handleScTrackClick: async track => { state.played.push(track); },
    window: { electronAPI: { scFetch: async () => ({ data: { id: 43, title: 'fresh song' } }) } }, ...overrides };
  vm.runInNewContext(`${app.slice(start, end)}\nglobalThis.replay = handleHistoryPlay;`, context);
  return { ...context, state };
}

test('local replay selects files by path, works offline and cancels pending SoundCloud playback', async () => {
  const t = replayHarness({ scAuthRef: { current: null }, xfadeRef: { current: {} },
    window: { electronAPI: { scFetch: () => { throw new Error('must not request the network'); } } } });
  await t.replay(historyEntry({ ...local, id: 987 }, 'local', stamp));
  assert.equal(t.state.idx, 0);
  assert.equal(t.state.scTrack, null);
  assert.equal(t.state.pendingTrack, null);
  assert.equal(t.state.settings.sourceMode, 'local');
  assert.equal(t.state.settings.untouched, true);
  assert.equal(t.state.playing, true);
  assert.equal(t.state.aborted, true);
  assert.equal(t.scReqRef.current, 1);
  assert.equal(t.stationQueueRef.current, null);
  const missing = replayHarness({ tracks: [] });
  await missing.replay(historyEntry(local, 'local', stamp));
  assert.equal(missing.state.playing, undefined);
  assert.deepEqual(missing.state.toasts, ['history_unavailable']);
  const current = replayHarness({ track: local, scPlayingTrack: null, trackSwitchingRef: { current: true } });
  await current.replay(historyEntry(local, 'local', stamp));
  assert.equal(current.state.playing, true);
  assert.equal(current.scReqRef.current, 1);
  assert.equal(current.trackSwitchingRef.current, false);
});

test('cloud replay alone fetches fresh stream metadata, handles login and exits unrelated queues', async () => {
  const entry = historyEntry({ ...cloud, id: 43 }, 'sc', stamp);
  const t = replayHarness();
  await t.replay(entry);
  assert.equal(t.state.played[0].id, 43);
  assert.equal(t.stationQueueRef.current, null);
  assert.equal(t.playlistQueueRef.current, null);
  assert.equal(t.searchQueueRef.current[0].id, 43);
  const loggedOut = replayHarness({ scAuthRef: { current: null } });
  await loggedOut.replay(entry);
  assert.deepEqual(loggedOut.state.toasts, ['history_login']);
  const failed = replayHarness({ window: { electronAPI: { scFetch: async () => { throw new Error('offline'); } } } });
  await failed.replay(entry);
  assert.equal(failed.state.error, entry.id);
  assert.equal(failed.state.played.length, 0);
  const current = replayHarness();
  await current.replay(historyEntry(cloud, 'sc', stamp));
  assert.equal(current.state.playing, true);
  assert.equal(current.state.played.length, 0);
});

test('late cloud replay cannot override a local selection, different account or newer request', async () => {
  for (const change of [t => t.scReqRef.current++, t => { t.scAuthRef.current = null; },
    t => { t.trackRef.current = local; }, t => t.historyRequestRef.current++]) {
    let resolve;
    const t = replayHarness({ window: { electronAPI: { scFetch: () => new Promise(done => { resolve = done; }) } } });
    const pending = t.replay(historyEntry({ ...cloud, id: 43 }, 'sc', stamp));
    change(t); resolve({ data: { id: 43 } }); await pending;
    assert.equal(t.state.played.length, 0);
    assert.equal(t.state.error, null);
  }
});

test('history uses persisted settings, no remote history API, and preserves centered navigation', () => {
  assert.match(app, /id:"search"[^\n]+\n\s*\{ id:"history"/);
  const nav = app.slice(app.indexOf('  const handleNav = async'), app.indexOf('  handleNavRef.current = handleNav;'));
  assert.match(nav, /id === 'history'[\s\S]*?setView\('history'\)/);
  assert.match(nav, /view === 'search' \|\| view === 'history'/);
  assert.match(app, /m\.listeningHistory = cleanListeningHistory\(m\.listeningHistory\)/);
  assert.match(app, /listeningHistory: addListeningHistory\(s\.listeningHistory, entry\)/);
  assert.match(app, /onClear=\{\(\)=>setSettings\(s=>\(\{ \.\.\.s, listeningHistory:\[\] \}\)\)\}/);
  assert.match(css, /prefers-reduced-motion:reduce[\s\S]*?\.history-playing i, \.history-spinner \{ animation:none; \}/);
  for (const key of ['nav_history', 'history_title', 'history_today', 'history_yesterday', 'history_empty', 'history_clear', 'history_unavailable']) {
    assert.equal((app.match(new RegExp(`\\b${key}:`, 'g')) || []).length, 2);
  }
  assert.doesNotMatch(app + hook + readFileSync(new URL('../src/listening-history.js', import.meta.url), 'utf8'),
    /play-history\/|recently-played\/|accountHistory|historyPageUrl|fetchListeningHistory/);
  assert.doesNotThrow(() => transformSync(app, { loader: 'jsx' }));
});
