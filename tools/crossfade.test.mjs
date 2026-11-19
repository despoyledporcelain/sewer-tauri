/* Pure envelope checks and the actual App transport, with fake audio elements.
 * No browser, WebView, network or audible playback: node --test tools/crossfade.test.mjs */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as crossfade from '../src/crossfade.js';
import { Shuffle } from '../src/shuffle.js';

const { crossfadeSettings, cleanCrossfadeSettings, crossfadeGains, crossfadeDuration,
  crossfadeIntroPosition, CrossfadeEnvelope, rotateDecks, mediaDuration, waitForDeck } = crossfade;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const flush = () => new Promise(resolve => setImmediate(resolve));

test('saved settings are bounded and old crossfade settings migrate without enabling it', () => {
  assert.deepEqual(crossfadeSettings(), { seconds: 0, curve: 'power', smart: true, intro: 0 });
  const settings = { crossfade: '5', unrelated: 7 };
  assert.equal(cleanCrossfadeSettings(settings), settings);
  assert.equal(settings.crossfade, 5);
  assert.equal(settings.unrelated, 7);
  assert.deepEqual(crossfadeSettings({ crossfade: 900, crossfadeCurve: 'unknown', crossfadeIntro: -4 }),
    { seconds: 12, curve: 'power', smart: true, intro: 0 });
  assert.equal(crossfadeSettings({ crossfade: NaN }).seconds, 0);
});

test('all curves are bounded, monotonic and have exact silent/full endpoints', () => {
  for (const curve of crossfade.CROSSFADE_CURVES) {
    assert.deepEqual(crossfadeGains(-1, curve), { out: 1, in: 0 });
    assert.deepEqual(crossfadeGains(2, curve), { out: 0, in: 1 });
    let previous = crossfadeGains(0, curve);
    for (let i = 1; i <= 100; i++) {
      const gain = crossfadeGains(i / 100, curve);
      assert.ok(gain.out <= previous.out && gain.in >= previous.in);
      assert.ok(gain.in >= 0 && gain.in <= 1 && gain.out >= 0 && gain.out <= 1);
      if (curve !== 'linear') near(gain.in ** 2 + gain.out ** 2, 1);
      else near(gain.in + gain.out, 1);
      previous = gain;
    }
  }
  assert.ok(crossfadeGains(0.1, 'smooth').in < crossfadeGains(0.1, 'power').in);
});

test('buffering, paused position and repeated volume reads do not advance a fade', () => {
  const envelope = new CrossfadeEnvelope({ seconds: 5, curve: 'power', position: 3 });
  envelope.sample(4);
  near(envelope.progress, 0.2);
  for (let i = 0; i < 100; i++) envelope.sample(4);
  near(envelope.progress, 0.2);
  envelope.sample(8);
  assert.equal(envelope.done, true);
  assert.deepEqual(envelope.gains(), { out: 0, in: 1 });
});

test('duration and envelope account for playback rate, including changes mid-transition', () => {
  const envelope = new CrossfadeEnvelope({ seconds: 4, curve: 'linear' });
  envelope.sample(2, 2); // 1 audible second
  envelope.sample(3, 0.5); // 2 audible seconds
  near(envelope.progress, 0.75);
  envelope.sample(3.5, 0.5);
  assert.equal(envelope.done, true);
  const config = crossfadeSettings({ crossfade: 12 });
  assert.equal(crossfadeDuration(config, 8, 100, 2), 1);
  assert.equal(crossfadeDuration({ ...config, smart: false }, 8, 100, 2), 12);
});

test('smart length preserves short tracks and intro skipping cannot swallow a track', () => {
  const config = crossfadeSettings({ crossfade: 12, crossfadeIntro: 10 });
  assert.equal(crossfadeIntroPosition(config.intro, 4), 1);
  assert.equal(crossfadeDuration(config, 100, 4), 0.75);
  assert.equal(crossfadeDuration(config, 100, 100), 12);
  assert.equal(mediaDuration({ duration: Infinity }, { duration: 123 }), 123);
  assert.equal(mediaDuration({ duration: 123.45 }, { duration: 100 }), 123.45);
});

test('two decks remain distinct through repeated role swaps', () => {
  let pair = { current: {}, standby: {} };
  const first = pair.current;
  for (let i = 0; i < 10; i++) {
    pair = rotateDecks(pair.current, pair.standby);
    assert.notEqual(pair.current, pair.standby);
  }
  assert.equal(pair.current, first);
  assert.throws(() => rotateDecks(first, first));
});

class FakeAudio extends EventTarget {
  constructor() {
    super();
    this.currentTime = 0;
    this.duration = 100;
    this.playbackRate = 1;
    this.volume = 0;
    this.paused = true;
    this.ended = false;
    this.seeking = false;
    this.readyState = 4;
    this.buffer = [[0, 100]];
    this.buffered = {
      get length() { return this.owner.buffer.length; },
      owner: this,
      start: i => this.buffer[i][0], end: i => this.buffer[i][1],
    };
    this.playCalls = 0;
  }
  emit(type) { this.dispatchEvent(new Event(type)); }
  load() { this.currentTime = 0; this.ended = false; }
  play() {
    this.playCalls++;
    if (this.playError) return Promise.reject(this.playError);
    this.paused = false;
    this.ended = false;
    return this.pendingPlay || Promise.resolve();
  }
  pause() { this.paused = true; }
}

test('readiness waits for decoded buffer at the requested intro, not just metadata', async () => {
  const audio = new FakeAudio();
  audio.readyState = 1;
  audio.buffer = [[0, 2]];
  let ready = false;
  const pending = waitForDeck(audio, { position: 8, bufferSeconds: 3 }).then(() => { ready = true; });
  assert.equal(audio.currentTime, 8);
  audio.readyState = 3;
  audio.emit('canplay');
  await flush();
  assert.equal(ready, false);
  audio.buffer = [[8, 9]];
  audio.emit('progress');
  await flush();
  assert.equal(ready, false);
  audio.buffer = [[8, 12]];
  audio.emit('progress');
  await pending;
  assert.equal(ready, true);
});

test('readiness handles cancellation, decoder errors, short tracks and timeouts', async () => {
  const audio = new FakeAudio();
  audio.readyState = 0;
  const controller = new AbortController();
  const pending = waitForDeck(audio, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(waitForDeck(audio, { signal: controller.signal }), /cancelled/);
  const error = waitForDeck(audio);
  audio.emit('error');
  await assert.rejects(error, /decoded/);
  await assert.rejects(waitForDeck(audio, { timeout: 1 }), /timeout/);
  audio.readyState = 4;
  audio.duration = 4;
  await waitForDeck(audio, { position: 10 });
  assert.equal(audio.currentTime, 1);
});

// Execute the real non-JSX transport functions from App, not a copied model.
const app = readFileSync(new URL('../src/app.jsx', import.meta.url), 'utf8');
const start = app.indexOf('  const XFADE_PRIME_LEAD =');
const end = app.indexOf('  xfadeTickRef.current = xfadeTick;', start);
assert.ok(start >= 0 && end > start, 'App transport test anchors must exist');
const source = app.slice(start, end);
const ref = current => ({ current });
const trackList = (local = true) => Array.from({ length: 4 }, (_, i) => ({ id: i + 1,
  title: `song ${i + 1}`, duration: 100, ...(local ? { path: `${i + 1}.mp3` } : { streamUrl: `stream:${i + 1}` }) }));

function transport({ local = true, tracks = trackList(local), settings = {}, standby = null, scFetch } = {}) {
  const current = new FakeAudio();
  current.src = tracks[0].path || tracks[0].streamUrl;
  current.currentTime = 95;
  current.paused = false;
  const frames = new Map();
  let frameId = 0;
  const context = {
    ...crossfade, Audio: FakeAudio, AbortController, Promise, setTimeout, clearTimeout,
    performance, HOT_STORE: { audio: current },
    settingsRef: ref({ crossfade: 5, ...settings }), isPlayingRef: ref(true),
    volumeRef: ref(0.8), trackRef: ref(tracks[0]), scPlayingTrackRef: ref(local ? null : tracks[0]),
    scTracksRef: ref(local ? [] : tracks), localTracksRef: ref(local ? tracks : []),
    filteredRef: ref(tracks), filteredScRef: ref(tracks), searchRef: ref(''),
    stationQueueRef: ref(null), playlistQueueRef: ref(null), searchQueueRef: ref(null),
    shuffleOnRef: ref(false), repeatRef: ref('off'), scAuthRef: ref({ token: 'token' }),
    audioRef: ref(current), deckBRef: ref(standby), deckBHlsRef: ref(null), hlsRef: ref(null),
    xfadeRef: ref(null), xfadePrimeRef: ref(null), outgoingRef: ref(null),
    xfadeRafRef: ref(0), crossfadeRafRef: ref(0), xfadeTickRef: ref(null),
    trackSwitchingRef: ref(false), progressRef: ref(0.95), discordProgressRef: ref(0.95),
    searchViewRef: ref(null), state: { trackIndex: 0, nextCalls: 0, rpc: [] },
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
    afxAttach: () => {}, afxResume: () => { context.state.resumes = (context.state.resumes || 0) + 1; },
    fileSrc: path => `file:${path}`,
    bindDeck: (audio, onTime, onEnded) => { audio.onTime = onTime; audio.onEnded = onEnded; },
    window: { electronAPI: { scFetch: scFetch || (async url => ({ data: { url: `cdn:${url}` } })) } },
  };
  context.shuffleStateRef = ref(new Shuffle({ repeat: () => context.repeatRef.current }));
  context.handleNextRef = ref(() => { context.state.nextCalls++; });
  context.discordPushRef = ref(() => { context.state.rpc.push({ track: context.trackRef.current.id,
    position: context.audioRef.current.currentTime }); });
  context.setTrackIdx = i => { context.state.trackIndex = i; };
  context.setScPlayingTrack = track => { context.state.scTrack = track; };
  context.setScPlayingIdx = i => { context.state.scIndex = i; };
  context.setMiniProgress = v => { context.state.progress = v; };
  context.setIsPlaying = v => { context.isPlayingRef.current = v; };
  vm.runInNewContext(`${source}\nglobalThis.engine = { xfadeTick, startCrossfade,
    primeNextPlayback, peekNextPlayback, primeStillValid, abortCrossfade, finishCrossfade,
    handleDeckEnded, handleDeckTime, restorePlaybackVolume, handleDeckPlayback };`, context);
  context.xfadeTickRef.current = context.engine.xfadeTick;
  return Object.assign(context, {
    tracks, frames,
    async tick() { context.engine.xfadeTick(); await flush(); },
    advance(seconds) {
      for (const audio of [context.audioRef.current, context.outgoingRef.current?.audio]) {
        if (!audio || audio.paused) continue;
        audio.currentTime = Math.min(audio.duration, audio.currentTime + seconds * audio.playbackRate);
        audio.ended = audio.currentTime >= audio.duration;
      }
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback();
      context.engine.xfadeTick();
    },
  });
}

test('three consecutive local transitions rotate both decks and keep the next track audible', async () => {
  const t = transport();
  const firstDeck = t.audioRef.current;
  for (let i = 1; i <= 3; i++) {
    t.audioRef.current.currentTime = 95;
    await t.tick();
    assert.equal(t.trackRef.current.id, i + 1);
    assert.equal(t.state.trackIndex, i);
    assert.notEqual(t.audioRef.current, t.deckBRef.current);
    assert.equal(t.HOT_STORE.audio, t.audioRef.current);
    assert.equal(t.HOT_STORE.deckB, t.deckBRef.current);
    t.advance(2);
    assert.ok(t.audioRef.current.volume > 0);
    assert.ok(t.outgoingRef.current.audio.volume > 0);
    t.advance(3);
    assert.equal(t.xfadeRef.current, null);
    assert.equal(t.audioRef.current.volume, 0.8);
    assert.equal(t.deckBRef.current.paused, true);
    assert.equal(t.deckBRef.current.volume, 0);
    assert.equal(t.state.nextCalls, 0);
  }
  assert.notEqual(t.audioRef.current, firstDeck);
});

test('ordinary playback restores volume synchronously without waiting for a UI frame or interaction', () => {
  const t = transport();
  t.audioRef.current.volume = 0;
  t.engine.restorePlaybackVolume(t.audioRef.current);
  assert.equal(t.audioRef.current.volume, 0.8);
  assert.equal(t.state.resumes, 1);
  assert.equal(t.frames.size, 0, 'startup must never depend on requestAnimationFrame');
  const standby = new FakeAudio();
  t.engine.restorePlaybackVolume(standby);
  assert.equal(standby.volume, 0, 'standby must remain silent');
  t.volumeRef.current = 0;
  t.engine.restorePlaybackVolume(t.audioRef.current);
  assert.equal(t.audioRef.current.volume, 0, 'user mute must remain respected');
});

test('playing restores stale volume but never overrides an active crossfade envelope', async () => {
  const t = transport();
  t.audioRef.current.volume = 0;
  t.engine.handleDeckPlayback(t.audioRef.current)({ type: 'playing' });
  assert.equal(t.audioRef.current.volume, 0.8);
  await t.tick();
  t.advance(1);
  const incoming = t.audioRef.current.volume;
  const outgoing = t.outgoingRef.current.audio.volume;
  t.engine.handleDeckPlayback(t.audioRef.current)({ type: 'playing' });
  near(t.audioRef.current.volume, incoming);
  near(t.outgoingRef.current.audio.volume, outgoing);
  t.engine.abortCrossfade();
});

test('a playing event wakes the audio graph even when RPC waiting state has not changed', () => {
  const begin = app.indexOf('function bindDeck(');
  const finish = app.indexOf('/* Звук правится', begin);
  assert.ok(begin >= 0 && finish > begin);
  let resumes = 0, playing = 0;
  const context = { updateDiscordPlayback: () => false, afxResume: () => { resumes++; } };
  vm.runInNewContext(`${app.slice(begin, finish)}\nglobalThis.bind = bindDeck;`, context);
  const audio = new FakeAudio();
  context.bind(audio, () => {}, () => {}, event => { if (event.type === 'playing') playing++; });
  audio.emit('playing');
  assert.equal(resumes, 1);
  assert.equal(playing, 1);
});

test('curve morph keeps exact endpoints and supports smooth interruption at the visible geometry', () => {
  const power = crossfade.crossfadeCurvePoints('power');
  const linear = crossfade.crossfadeCurvePoints('linear');
  const smooth = crossfade.crossfadeCurvePoints('smooth');
  const halfway = crossfade.mixCurvePoints(power, linear, 0.5);
  for (const channel of ['out', 'in']) {
    assert.equal(halfway[channel].length, 49);
    assert.deepEqual(halfway[channel][0], power[channel][0]);
    assert.deepEqual(halfway[channel].at(-1), power[channel].at(-1));
    for (let i = 0; i < 49; i++) {
      near(halfway[channel][i].y, (power[channel][i].y + linear[channel][i].y) / 2);
      assert.ok(Number.isFinite(halfway[channel][i].x));
    }
  }
  assert.deepEqual(crossfade.mixCurvePoints(halfway, smooth, 0), halfway);
  assert.deepEqual(crossfade.mixCurvePoints(halfway, smooth, 1), smooth);
  assert.equal(power.out.at(-1).y - power.out[0].y, 104, 'preview uses the larger vertical range');
});

test('SoundCloud resolves once and RPC immediately describes the incoming intro position', async () => {
  let requests = 0;
  const t = transport({ local: false, settings: { crossfadeIntro: 3 }, scFetch: async url => {
    requests++;
    return { data: { url: `cdn:${url}` } };
  } });
  await t.tick();
  assert.equal(requests, 1);
  assert.equal(t.trackRef.current.id, 2);
  assert.equal(t.state.scTrack.id, 2);
  assert.equal(t.audioRef.current.currentTime, 3);
  assert.deepEqual(t.state.rpc[0], { track: 2, position: 3 });
  t.advance(5);
  assert.equal(t.xfadeRef.current, null);
  assert.equal(requests, 1);
});

test('failed play does not advance queue, mute the outgoing track or publish a new RPC track', async () => {
  const standby = new FakeAudio();
  standby.playError = new Error('autoplay denied');
  const t = transport({ standby });
  await t.tick();
  assert.equal(t.trackRef.current.id, 1);
  assert.equal(t.xfadeRef.current, null);
  assert.equal(t.audioRef.current.volume, 0.8);
  assert.equal(t.xfadePrimeRef.current.failed, true);
  assert.equal(t.state.rpc.length, 0);
  for (let i = 0; i < 5; i++) await t.tick();
  assert.equal(standby.playCalls, 1, 'no retry storm every 150ms');
});

test('cancelling a pending play cannot commit the old next track', async () => {
  const standby = new FakeAudio();
  let resolve;
  standby.pendingPlay = new Promise(done => { resolve = done; });
  const t = transport({ standby });
  await t.tick();
  assert.equal(t.xfadePrimeRef.current.starting, true);
  t.engine.abortCrossfade();
  resolve();
  await flush();
  assert.equal(t.trackRef.current.id, 1);
  assert.equal(t.xfadeRef.current, null);
  assert.equal(t.xfadePrimeRef.current, null);
  assert.equal(standby.paused, true);
  assert.equal(t.audioRef.current.volume, 0.8);
});

test('cancellation during overlap keeps the new queue position and silences the outgoing deck', async () => {
  const t = transport();
  await t.tick();
  t.advance(2);
  const incoming = t.audioRef.current;
  const outgoing = t.outgoingRef.current.audio;
  t.engine.abortCrossfade();
  t.engine.abortCrossfade();
  t.engine.finishCrossfade();
  assert.equal(t.trackRef.current.id, 2);
  assert.equal(t.audioRef.current, incoming);
  assert.equal(t.audioRef.current.volume, 0.8);
  assert.equal(outgoing.paused, true);
  assert.equal(outgoing.volume, 0);
  assert.equal(t.frames.size, 0);
});

test('standby events cannot advance queue or overwrite progress; outgoing ended only finishes the mix', async () => {
  const t = transport();
  await t.tick();
  const outgoing = t.outgoingRef.current.audio;
  const progress = t.progressRef.current;
  outgoing.currentTime = 99;
  t.engine.handleDeckTime(outgoing)();
  assert.equal(t.progressRef.current, progress);
  t.engine.handleDeckEnded(outgoing)();
  assert.equal(t.xfadeRef.current, null);
  assert.equal(t.state.nextCalls, 0);
  t.engine.handleDeckEnded(outgoing)();
  assert.equal(t.state.nextCalls, 0);
});

test('repeat-one, last track and disabled crossfade do not prime an unwanted next track', async () => {
  for (const kind of ['one', 'last', 'off']) {
    const t = transport({ settings: kind === 'off' ? { crossfade: 0 } : {} });
    if (kind === 'one') t.repeatRef.current = 'one';
    if (kind === 'last') t.trackRef.current = t.tracks.at(-1);
    await t.tick();
    assert.equal(t.xfadePrimeRef.current, null);
    assert.equal(t.xfadeRef.current, null);
  }
});

test('queue changes while buffered invalidate the reserved next track', async () => {
  const t = transport();
  t.audioRef.current.currentTime = 85;
  await t.tick();
  assert.equal(t.xfadePrimeRef.current.ready, true);
  t.localTracksRef.current = [t.tracks[0], t.tracks[2]];
  t.audioRef.current.currentTime = 96;
  await t.tick();
  assert.equal(t.xfadePrimeRef.current, null);
  assert.equal(t.trackRef.current.id, 1);
  await t.tick();
  assert.equal(t.trackRef.current.id, 3);
});

test('shuffle repeat-all reserves a single wrap step and commits it only after play succeeds', async () => {
  const t = transport({ local: false });
  t.shuffleOnRef.current = true;
  t.repeatRef.current = 'all';
  const eng = t.shuffleStateRef.current;
  eng.start(t.tracks, t.tracks[0].id);
  eng.pos = eng.order.length - 1;
  eng.curId = eng.order.at(-1);
  const originalPeek = eng.peek.bind(eng);
  let wraps = 0;
  eng.peek = direction => {
    if (direction !== 1 || eng.pos !== eng.order.length - 1) return originalPeek(direction);
    const others = eng.order.filter(id => id !== eng.curId);
    const id = others[wraps++ % others.length];
    return { id, index: 0, order: [id, ...eng.order.filter(other => other !== id)] };
  };
  t.trackRef.current = t.scPlayingTrackRef.current = eng.track(eng.curId);
  t.audioRef.current.currentTime = 85;
  await t.tick();
  assert.ok(t.xfadePrimeRef.current);
  const prime = t.xfadePrimeRef.current;
  const nextId = prime.next.track.id;
  for (let i = 0; i < 20; i++) {
    await t.tick();
    assert.equal(t.xfadePrimeRef.current, prime);
    assert.equal(eng.pos, eng.order.length - 1);
  }
  assert.equal(wraps, 1, 'a random wrap must not be drawn again for validation');
  t.audioRef.current.currentTime = 96;
  await t.tick();
  assert.equal(t.trackRef.current.id, nextId);
  assert.equal(eng.pos, 0);
  assert.equal(eng.curId, nextId);
  t.engine.abortCrossfade();
  assert.equal(eng.curId, nextId, 'cancellation after commit must not rewind shuffle');
});

test('the actual transport freezes on stalled audio and live volume scales both curves', async () => {
  const t = transport();
  await t.tick();
  t.advance(1);
  const xf = t.xfadeRef.current;
  const progress = xf.envelope.progress;
  for (let i = 0; i < 30; i++) await t.tick();
  assert.equal(xf.envelope.progress, progress);
  t.volumeRef.current = 0.4;
  await t.tick();
  const gains = crossfadeGains(progress);
  near(xf.from.volume, gains.out * 0.4);
  near(xf.to.volume, gains.in * 0.4);
  t.engine.abortCrossfade();
});

test('queue changes during asynchronous play prevent commit and leave current playback intact', async () => {
  const standby = new FakeAudio();
  let resolve;
  standby.pendingPlay = new Promise(done => { resolve = done; });
  const t = transport({ standby });
  await t.tick();
  t.localTracksRef.current = [t.tracks[0], t.tracks[2]];
  resolve();
  await flush();
  assert.equal(t.trackRef.current.id, 1);
  assert.equal(t.xfadeRef.current, null);
  assert.equal(t.audioRef.current.volume, 0.8);
  assert.equal(standby.paused, true);
  t.engine.abortCrossfade();
});

test('slow or failed SoundCloud resolution never fades the old track toward silence', async () => {
  let resolve;
  let requests = 0;
  const pending = new Promise(done => { resolve = done; });
  const t = transport({ local: false, scFetch: () => { requests++; return pending; } });
  t.audioRef.current.volume = 0.8;
  await t.tick();
  t.audioRef.current.currentTime = 99;
  for (let i = 0; i < 5; i++) await t.tick();
  assert.equal(t.audioRef.current.volume, 0.8);
  assert.equal(t.trackRef.current.id, 1);
  assert.equal(requests, 1);
  resolve({ error: 'expired link' });
  await flush();
  assert.equal(t.xfadePrimeRef.current.failed, true);
  t.engine.abortCrossfade();
});

test('HLS ownership follows the current deck and cancellation destroys only the standby/outgoing stream', async () => {
  class FakeHls {
    static Events = { ERROR: 'error' };
    static isSupported() { return true; }
    constructor(config) { this.config = config; this.destroyed = false; }
    on() {}
    loadSource(url) { this.url = url; }
    attachMedia(audio) { this.audio = audio; }
    destroy() { this.destroyed = true; }
  }
  const tracks = trackList(false).map(({ streamUrl, ...track }) => ({ ...track, hlsUrl: streamUrl }));
  const t = transport({ local: false, tracks, settings: { crossfadeIntro: 2 } });
  t.loadHls = async () => FakeHls;
  const old = new FakeHls({});
  t.hlsRef.current = old;
  await t.tick();
  const incoming = t.hlsRef.current;
  assert.ok(incoming instanceof FakeHls);
  assert.notEqual(incoming, old);
  assert.equal(t.deckBHlsRef.current, null);
  assert.equal(t.outgoingRef.current.hls, old);
  assert.equal(incoming.config.startPosition, 2);
  t.engine.abortCrossfade();
  assert.equal(old.destroyed, true);
  assert.equal(incoming.destroyed, false);
  assert.equal(t.hlsRef.current, incoming);
  t.audioRef.current.currentTime = 85;
  await t.tick();
  const standby = t.deckBHlsRef.current;
  assert.ok(standby instanceof FakeHls);
  t.engine.abortCrossfade();
  assert.equal(standby.destroyed, true);
  assert.equal(incoming.destroyed, false);
});
