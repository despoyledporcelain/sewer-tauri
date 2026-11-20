import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PartyClient, PARTY_ENDPOINT, PARTY_PROTOCOL, partySnapshot, partyPosition } from '../src/party-client.js';
import { cleanPartyCode, validPartyCode, partyImageURL, sharedPartyTrack } from '../src/listening-party.js';
import { waitForPartyAudio } from '../src/party-audio.js';
import { withScArtwork, resolvePartyArtwork } from '../src/party-artwork.js';

const ref = current => ({ current });
const song = (id = 123) => ({ source: 'soundcloud', id: String(id), title: 'a song', artist: 'an artist', duration: 180,
  coverUrl: 'https://i1.sndcdn.com/artworks-test.jpg' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

class Audio extends EventTarget {
  src = '';
  currentTime = 0;
  duration = 180;
  readyState = 4;
  seeking = false;
  paused = true;
  ended = false;
  plays = 0;
  buffer = [[0, 180]];
  buffered = { length: 1, start: i => this.buffer[i][0], end: i => this.buffer[i][1] };
  emit(type) { this.dispatchEvent(new Event(type)); }
  load() { this.currentTime = 0; this.paused = true; }
  pause() { this.paused = true; }
  play() { this.plays++; if (this.playError) return Promise.reject(this.playError); this.paused = false; return this.pendingPlay || Promise.resolve(); }
}

function harness(options = {}) {
  const states = [], requests = [], sockets = [], timers = new Map(), intervals = new Map(), loads = [], seeks = [];
  let now = 100000, timerId = 0;
  class Socket {
    readyState = 0;
    sent = [];
    constructor(url, protocols) { this.url = url; this.protocols = protocols; sockets.push(this); }
    send(text) {
      const data = JSON.parse(text); this.sent.push(data); options.onSend?.(data, this);
      if (data.type === 'leave' && options.ackLeave !== false) this.disconnect(1000);
    }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(); }
    message(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
    disconnect(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  }
  const player = { track: options.track || null, audio: new Audio(), switching: false };
  if (player.track) player.audio.src = `own-stream:${player.track.id}`;
  player.audio.paused = options.paused ?? true;
  const session = { protocol: 1, code: 'ABC234', memberId: 'a'.repeat(24), token: 'b'.repeat(64), role: options.role || 'guest' };
  const client = new PartyClient({ WebSocket: Socket,
    fetch: async (url, init) => { requests.push({ url, init }); return options.fetch ? options.fetch(url, init) : { ok: true, json: async () => session }; },
    now: () => now,
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, at: now + delay }); return timerId; }, clearTimeout: id => timers.delete(id),
    setInterval: fn => { intervals.set(++timerId, fn); return timerId; }, clearInterval: id => intervals.delete(id),
    onState: state => states.push(state), getPlayer: () => player,
    pause: () => player.audio.pause(), play: () => player.audio.play(),
    seek: at => { seeks.push(at); player.audio.currentTime = at; },
    empty: () => { player.track = null; player.audio.src = ''; },
    loadTrack: async (track, args) => {
      loads.push({ track, ...args });
      if (options.loadTrack) return options.loadTrack(track, args, player);
      player.track = track; player.audio.src = `own-stream:${track.id}`; player.switching = false;
    },
  });
  const snapshot = (extra = {}) => ({ type: 'room', protocol: 1, code: session.code,
    you: { id: session.memberId, role: session.role }, members: [{ id: session.memberId, role: session.role, name: 'listener', avatarUrl: null }],
    track: song(), playback: { playing: false, position: 20, updatedAt: now, revision: 1 }, serverTime: now, ...extra });
  return { client, player, session, states, requests, sockets, loads, seeks, timers, intervals, snapshot,
    async connect(track = song()) { await client.start(session.role === 'host' ? 'create' : 'join', { code: session.code,
      user: { username: 'listener', avatarUrl: song().coverUrl, token: 'private-soundcloud' }, track }); sockets[0]?.open(); },
    advance(ms) { now += ms; },
    runTimer() { const [id, entry] = [...timers].sort((a, b) => a[1].at - b[1].at)[0]; timers.delete(id); now = Math.max(now, entry.at); entry.fn(); },
  };
}

test('default timers preserve the browser Window receiver during creation and cleanup', async () => {
  const source = readFileSync(new URL('../src/party-client.js', import.meta.url), 'utf8');
  const context = vm.createContext({ cleanPartyCode, validPartyCode, partyImageURL, sharedPartyTrack, AbortController });
  vm.runInContext(`
    globalThis.calls = [];
    globalThis.timers = new Set();
    let timerId = 0;
    function windowTimer(kind) {
      return function(value) {
        if (this !== globalThis) throw new TypeError('Illegal invocation');
        calls.push(kind);
        if (kind.startsWith('set')) { timers.add(++timerId); return timerId; }
        timers.delete(value);
      };
    }
    globalThis.setTimeout = windowTimer('setTimeout');
    globalThis.clearTimeout = windowTimer('clearTimeout');
    globalThis.setInterval = windowTimer('setInterval');
    globalThis.clearInterval = windowTimer('clearInterval');
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ protocol: 1,
      code: 'ABC234', memberId: 'a'.repeat(24), token: 'b'.repeat(64), role: 'host' }) });
    globalThis.WebSocket = class {
      readyState = 0;
      close() { this.readyState = 3; }
      send() {}
    };
    ${source.replace(/^import[^\n]*\n/, '').replace(/export /g, '')}
    globalThis.states = [];
    globalThis.client = new PartyClient({ onState: state => states.push(state),
      getPlayer: () => ({ track: null }), pause: () => {}, play: async () => {},
      seek: () => {}, loadTrack: async () => {} });
  `, context);
  await context.client.start('create');
  assert.equal(context.client.active, true);
  assert.equal(context.states.at(-1).type, 'session');
  context.client.socket.readyState = 1;
  context.client.socket.onopen();
  assert.ok(context.calls.includes('setInterval'));
  context.client.finish();
  assert.ok(context.calls.includes('clearInterval'));
  assert.equal(context.timers.size, 0);
});

test('API credentials stay private; invitations, profiles and shared tracks contain no SoundCloud secrets or streams', async () => {
  const t = harness({ role: 'host', track: song() });
  await t.connect({ ...song(), token: 'secret', streamUrl: 'signed-stream', queue: [1, 2] });
  const request = t.requests[0];
  assert.equal(request.url, PARTY_ENDPOINT + '/v1/rooms');
  const body = JSON.parse(request.init.body);
  assert.equal(body.profile.name, 'listener');
  assert.deepEqual(body.track, song());
  assert.doesNotMatch(request.init.body, /secret|signed-stream|private-soundcloud|queue/);
  assert.equal(t.sockets[0].url, PARTY_ENDPOINT.replace('https:', 'wss:') + '/v1/rooms/ABC234/socket');
  assert.deepEqual(t.sockets[0].protocols, [PARTY_PROTOCOL, `token.${t.session.token}`]);
  assert.equal(JSON.stringify(t.states).includes(t.session.token), false);
  t.client.dispose();
  assert.equal(t.timers.size + t.intervals.size, 0);
});

test('cached SoundCloud artwork stays local while creation and host publication share only the original CDN URL', async () => {
  const local = 'http://asset.localhost/C%3A%5Cprivate%5C123.jpg';
  const original = song();
  const cached = withScArtwork(withScArtwork(original, local), local + '?updated');
  assert.equal(original.coverUrl, song().coverUrl);
  assert.equal(cached.remoteCoverUrl, song().coverUrl);
  assert.deepEqual(sharedPartyTrack(cached), song());
  const t = harness({ role: 'host', track: cached });
  await t.connect(cached);
  assert.equal(JSON.parse(t.requests[0].init.body).track.coverUrl, song().coverUrl);
  t.sockets[0].message(t.snapshot());
  assert.equal(t.sockets[0].sent.find(data => data.type === 'track').track.coverUrl, song().coverUrl);
  assert.doesNotMatch(JSON.stringify(t.sockets[0].sent), /asset.localhost|private|remoteCoverUrl/);
  t.client.dispose();
});

test('party artwork uses the listener cache, downloads only CDN URLs and falls back without failing playback', async () => {
  const local = 'http://asset.localhost/personal-cache/123.jpg';
  const requests = [];
  const api = { scCheckCovers: async ids => { requests.push(ids); return { 123: local }; },
    scCacheCover: async () => { throw new Error('must not download cached artwork'); } };
  assert.equal(await resolvePartyArtwork(song(), { api }), local);
  assert.deepEqual(requests, [[123]]);
  api.scCheckCovers = async () => ({});
  api.scCacheCover = async (id, remote) => { assert.equal(id, 123); assert.equal(remote, song().coverUrl); return local; };
  assert.equal(await resolvePartyArtwork(withScArtwork(song(), 'http://asset.localhost/host-cache.jpg'), { api }), local);
  api.scCacheCover = async () => { throw new Error('CDN unavailable'); };
  assert.equal(await resolvePartyArtwork(song(), { api }), song().coverUrl);
  assert.equal(await resolvePartyArtwork({ ...song(), coverUrl: 'http://asset.localhost/host-cache.jpg' }, { api }), null);
  let cancelled = false;
  const pending = deferred(); api.scCheckCovers = () => pending.promise;
  const resolving = resolvePartyArtwork(song(), { api, cancelled: () => cancelled });
  cancelled = true; pending.resolve({ 123: local });
  assert.equal(await resolving, null);
});

test('join validation, duplicate submissions, HTTP failures, timeout and cancellation cannot create phantom sessions', async () => {
  const pending = deferred();
  const t = harness({ fetch: () => pending.promise });
  await t.client.start('join', { code: 'ABC201' });
  assert.equal(t.requests.length, 0);
  assert.equal(t.states.at(-1).type, 'invalid-code');
  const first = t.client.start('join', { code: 'abc-234' });
  await t.client.start('join', { code: 'ABC234' });
  assert.equal(t.requests.length, 1);
  t.runTimer();
  pending.resolve({ ok: true, json: async () => t.session });
  await first;
  assert.equal(t.client.active, false);
  assert.equal(t.states.at(-1).error, 'connection_failed');
  t.client.dispose();
  const canceled = deferred(), c = harness({ fetch: () => canceled.promise });
  const start = c.client.start('join', { code: 'ABC234' });
  c.client.dispose(); canceled.resolve({ ok: true, json: async () => c.session }); await start;
  assert.equal(c.sockets.length, 0);
  const failed = harness({ fetch: async () => ({ ok: false, json: async () => ({ error: 'room_full' }) }) });
  await failed.client.start('join', { code: 'ABC234' });
  assert.equal(failed.states.at(-1).error, 'room_full');
  assert.equal(failed.client.active, false);
});

test('snapshots validate identity, protocol, members and bounded state, stripping all unknown fields', () => {
  const t = harness();
  const value = t.snapshot({ token: 'secret', track: { ...song(), streamUrl: 'secret' } });
  value.members[0].token = 'secret';
  assert.equal(JSON.stringify(partySnapshot(value, t.session)).includes('secret'), false);
  for (const bad of [{ protocol: 2 }, { code: 'XYZ234' }, { you: { id: 'foreign', role: 'host' } },
    { members: [null] }, { members: Array(9).fill(value.members[0]) }, { track: { ...song(), source: 'local' } },
    { playback: { ...value.playback, position: 181 } }, { playback: { ...value.playback, revision: -1 } }]) {
    assert.throws(() => partySnapshot({ ...value, ...bad }, t.session));
  }
  assert.equal(partyPosition(t.snapshot({ playback: { playing: true, position: 179, updatedAt: 90000, revision: 1 } }), 100000), 180);
  assert.equal(partyPosition(t.snapshot(), 200000), 20);
});

test('the host publishes actual decoder pause, buffering, seeks and position, never a shared queue or effects', async () => {
  const t = harness({ role: 'host', track: song(), paused: false });
  await t.connect(); t.player.audio.currentTime = 30;
  t.sockets[0].message(t.snapshot());
  assert.deepEqual(t.sockets[0].sent.slice(-2), [{ type: 'track', track: song() }, { type: 'playback', playing: true, position: 30 }]);
  const count = t.sockets[0].sent.length;
  for (let i = 0; i < 100; i++) t.client.sync();
  assert.equal(t.sockets[0].sent.length, count);
  t.advance(150); t.player.audio.__sewRpcWaiting = true; t.client.sync();
  assert.equal(t.sockets[0].sent.at(-1).playing, false);
  t.advance(150); t.player.audio.__sewRpcWaiting = false; t.player.audio.currentTime = 90; t.client.sync();
  assert.equal(t.sockets[0].sent.at(-1).position, 90);
  t.advance(150); t.player.audio.pause(); t.client.sync();
  assert.equal(t.sockets[0].sent.at(-1).playing, false);
  assert.doesNotMatch(JSON.stringify(t.sockets[0].sent), /queue|speed|eq|stream|token/);
  t.client.dispose();
});

test('rapid pointer seeks are coalesced below the server message limit and flush the last requested position', async () => {
  const t = harness({ role: 'host', track: song() });
  await t.connect(); t.sockets[0].message(t.snapshot());
  const before = t.sockets[0].sent.length;
  for (let i = 0; i < 100; i++) { t.player.audio.currentTime = i; t.client.sync(); }
  assert.equal(t.sockets[0].sent.length, before);
  t.runTimer();
  assert.deepEqual(t.sockets[0].sent.at(-1), { type: 'playback', playing: false, position: 99 });
  t.client.dispose();
  assert.equal(t.timers.size, 0);
});

test('guest loads with own access, stays paused at host position and never sends playback commands', async () => {
  const t = harness(); await t.connect();
  t.sockets[0].message(t.snapshot()); await flush();
  assert.equal(t.loads.length, 1);
  assert.equal(t.player.audio.currentTime, 20);
  assert.equal(t.player.audio.paused, true);
  await t.client.selectTrack(song(456));
  assert.equal(t.loads.length, 1);
  assert.equal(t.sockets[0].sent.some(data => ['playback', 'track'].includes(data.type)), false);
  t.client.dispose();
});

test('clock offset uses matched ping round trips, and guest corrects only audible drift without changing playback rate', async () => {
  const t = harness({ track: song() }); await t.connect();
  const ping = t.sockets[0].sent[0];
  t.advance(100);
  t.sockets[0].message({ type: 'pong', nonce: ping.nonce, serverTime: 105050 });
  assert.equal(t.client.offset, 5000);
  t.sockets[0].message(t.snapshot({ serverTime: 105100, playback: { playing: true, position: 20, updatedAt: 104100, revision: 2 } }));
  await flush();
  assert.equal(t.player.audio.currentTime, 21);
  assert.equal(t.player.audio.paused, false);
  const count = t.seeks.length;
  t.advance(1000); t.player.audio.currentTime = 22.1; t.client.tick();
  assert.equal(t.seeks.length, count);
  t.player.audio.currentTime = 10; t.client.tick();
  assert.equal(t.player.audio.currentTime, 22);
  t.client.dispose();
});

test('new revisions during decoding apply the latest seek and pause, not the state that began loading', async () => {
  const ready = deferred();
  const t = harness({ loadTrack: async (track, _, player) => { player.track = track; player.audio.src = 'own-stream'; await ready.promise; } });
  await t.connect();
  t.sockets[0].message(t.snapshot({ playback: { playing: true, position: 10, updatedAt: 100000, revision: 1 } }));
  t.sockets[0].message(t.snapshot({ playback: { playing: false, position: 95, updatedAt: 100000, revision: 2 } }));
  ready.resolve(); await flush();
  assert.equal(t.loads.length, 1);
  assert.equal(t.player.audio.currentTime, 95);
  assert.equal(t.player.audio.plays, 0);
  t.sockets[0].message(t.snapshot({ playback: { playing: true, position: 1, updatedAt: 100000, revision: 1 } }));
  assert.equal(t.player.audio.currentTime, 95);
  t.client.dispose();
});

test('track replacement and leave abort old loads; late results cannot seek or start playback', async () => {
  const a = deferred(), b = deferred();
  const t = harness({ loadTrack: (track, _, player) => { player.track = track; player.audio.src = `stream:${track.id}`; return track.id === '123' ? a.promise : b.promise; } });
  await t.connect(); t.sockets[0].message(t.snapshot());
  t.sockets[0].message(t.snapshot({ track: song(456), playback: { playing: true, position: 40, updatedAt: 100000, revision: 2 } }));
  assert.equal(t.loads[0].signal.aborted, true);
  a.resolve(); await flush(); assert.equal(t.player.audio.plays, 0);
  t.client.leave(); assert.equal(t.loads[1].signal.aborted, true);
  b.resolve(); await flush();
  assert.equal(t.player.audio.plays, 0);
  assert.equal(t.seeks.length, 0);
  assert.equal(t.timers.size + t.intervals.size, 0);
});

test('failed tracks and blocked autoplay wait for retry, without infinite polling or replaying a broken source', async () => {
  let attempt = 0;
  const t = harness({ loadTrack: async (track, _, player) => { attempt++; player.track = track; player.audio.src = 'broken-source';
    if (attempt === 1) throw new Error('unavailable'); } });
  await t.connect(); t.sockets[0].message(t.snapshot()); await flush();
  for (let i = 0; i < 5; i++) t.client.tick();
  assert.equal(attempt, 1);
  assert.equal(t.states.at(-1).error, 'track_unavailable');
  t.client.retry(); await flush(); assert.equal(attempt, 2);
  t.player.audio.playError = new Error('NotAllowedError');
  t.sockets[0].message(t.snapshot({ playback: { playing: true, position: 20, updatedAt: 100000, revision: 3 } }));
  await flush(); assert.equal(t.states.at(-1).error, 'playback_blocked');
  t.player.audio.playError = null; t.client.retry(); await flush();
  assert.equal(t.player.audio.paused, false); assert.equal(attempt, 2);
  t.client.dispose();
});

test('a hung native metadata request times out, aborts and stays quiet after a late success', async () => {
  const ready = deferred();
  const t = harness({ loadTrack: () => ready.promise });
  await t.connect(); t.sockets[0].message(t.snapshot());
  t.runTimer();
  assert.equal(t.loads[0].signal.aborted, true);
  assert.equal(t.states.at(-1).error, 'track_unavailable');
  ready.resolve(); await flush(); assert.equal(t.player.audio.plays, 0);
  t.client.dispose();
});

test('fatal decoder errors cancel readiness immediately and cannot restart after a late buffer result', async () => {
  const ready = deferred(), t = harness({ loadTrack: () => ready.promise });
  await t.connect(); t.sockets[0].message(t.snapshot({ playback: { playing: true, position: 10, updatedAt: 100000, revision: 1 } }));
  t.client.failPlayback('track_unavailable');
  assert.equal(t.loads[0].signal.aborted, true);
  ready.resolve(); await flush();
  assert.equal(t.player.audio.plays, 0);
  assert.equal(t.states.at(-1).error, 'track_unavailable');
  t.client.dispose();
});

test('a pending autoplay cannot resume a guest after the host pauses or the guest leaves', async () => {
  for (const action of ['pause', 'leave']) {
    const t = harness({ track: song() }), played = deferred();
    await t.connect(); t.player.audio.pendingPlay = played.promise;
    t.sockets[0].message(t.snapshot({ playback: { playing: true, position: 10, updatedAt: 100000, revision: 1 } }));
    if (action === 'pause') t.sockets[0].message(t.snapshot());
    else t.client.leave();
    t.player.audio.paused = false; played.resolve(); await flush();
    assert.equal(t.player.audio.paused, true);
    t.client.dispose();
  }
});

test('a delayed host track acknowledgement cannot erase a fresh playback error', async () => {
  const t = harness({ role: 'host', track: song(), loadTrack: async () => { throw new Error('denied'); } });
  await t.connect(); t.sockets[0].message(t.snapshot());
  await t.client.selectTrack(song(456));
  t.sockets[0].message(t.snapshot({ track: song(456), playback: { playing: false, position: 0, updatedAt: 100000, revision: 2 } }));
  assert.equal(t.client.followError, 'track_unavailable');
  assert.equal(t.states.filter(state => state.type === 'playback-error').at(-1).error, 'track_unavailable');
  t.client.dispose();
});

test('host selection keeps its own acknowledged load, cancels rapid replacements and publishes only after real play', async () => {
  const first = deferred(), second = deferred();
  const t = harness({ role: 'host', track: song(), loadTrack: (track, _, player) => {
    player.track = track; player.audio.src = `own:${track.id}`; return track.id === '456' ? first.promise : second.promise;
  } });
  await t.connect(); t.sockets[0].message(t.snapshot());
  const a = t.client.selectTrack(song(456));
  assert.equal(t.loads[0].signal.aborted, false);
  const b = t.client.selectTrack(song(789)); assert.equal(t.loads[0].signal.aborted, true);
  t.sockets[0].message(t.snapshot({ track: song(456), playback: { playing: false, position: 0, updatedAt: 100000, revision: 2 } }));
  assert.equal(t.loads[1].signal.aborted, false);
  t.sockets[0].message(t.snapshot({ track: song(789), playback: { playing: false, position: 0, updatedAt: 100000, revision: 3 } }));
  assert.equal(t.loads[1].signal.aborted, false);
  first.resolve(); await a; assert.equal(t.player.audio.plays, 0);
  second.resolve(); await b;
  assert.equal(t.player.audio.plays, 1);
  t.runTimer();
  assert.equal(t.sockets[0].sent.at(-1).playing, true);
  assert.equal(t.sockets[0].sent.filter(data => data.type === 'track' && data.track.id === '789').length, 1);
  t.client.dispose();
});

test('disconnect pauses immediately, reconnects the same private session, ignores retired sockets and never resumes a host by itself', async () => {
  const t = harness({ role: 'host', track: song(), paused: false }); await t.connect();
  const old = t.sockets[0]; old.message(t.snapshot());
  const late = old.onmessage;
  old.disconnect(); assert.equal(t.player.audio.paused, true); assert.equal(t.client.status, 'reconnecting');
  t.runTimer(); const socket = t.sockets[1]; socket.open(); socket.message(t.snapshot());
  assert.deepEqual(socket.protocols, old.protocols);
  assert.equal(t.requests.length, 1);
  assert.equal(t.player.audio.paused, true);
  late({ data: JSON.stringify({ type: 'closed', reason: 'host_left' }) });
  assert.equal(t.client.active, true);
  t.client.dispose();
});

test('quiet or unauthenticated sockets are bounded; replaced, closed and corrupt rooms stop cleanly', async () => {
  const t = harness(); await t.connect(); t.runTimer();
  assert.equal(t.client.status, 'reconnecting'); t.client.dispose();
  const quiet = harness({ track: song() }); await quiet.connect(); quiet.sockets[0].message(quiet.snapshot());
  quiet.advance(31000); quiet.client.tick(); assert.equal(quiet.client.status, 'reconnecting'); quiet.client.dispose();
  for (const event of ['closed', 'replaced', 'corrupt']) {
    const c = harness(); await c.connect();
    if (event === 'closed') c.sockets[0].message({ type: 'closed', reason: 'host_left' });
    else if (event === 'replaced') c.sockets[0].disconnect(4001);
    else c.sockets[0].message({ type: 'room', protocol: 2 });
    assert.equal(c.client.active, false);
    assert.equal(c.timers.size + c.intervals.size, 0);
  }
});

test('empty rooms clear the previous decoder once; leaving a host preserves normal playback while a guest stays paused', async () => {
  const t = harness({ track: song() }); await t.connect();
  t.sockets[0].message(t.snapshot({ track: null, playback: { playing: false, position: 0, updatedAt: 100000, revision: 1 } }));
  assert.equal(t.player.track, null); assert.equal(t.player.audio.src, '');
  t.client.leave(); assert.equal(t.player.audio.paused, true);
  const h = harness({ role: 'host', track: song(), paused: false }); await h.connect();
  h.client.leave(); assert.equal(h.player.audio.paused, false);
});

test('explicit leave keeps the socket open until the server ack; timeout and disposal still release every timer', async () => {
  const t = harness({ role: 'host', track: song(), paused: false, ackLeave: false });
  await t.connect(); t.sockets[0].message(t.snapshot());
  t.client.leave();
  assert.equal(t.client.status, 'leaving');
  assert.equal(t.sockets[0].readyState, 1);
  t.sockets[0].message(t.snapshot({ playback: { playing: false, position: 0, updatedAt: 100000, revision: 3 } }));
  assert.equal(t.client.status, 'leaving');
  t.sockets[0].message({ type: 'closed', reason: 'host_left' });
  assert.equal(t.client.active, false); assert.equal(t.player.audio.paused, false);
  assert.equal(t.timers.size + t.intervals.size, 0);
  for (const disposed of [false, true]) {
    const c = harness({ role: 'host', track: song(), ackLeave: false });
    await c.connect(); c.sockets[0].message(c.snapshot());
    if (disposed) c.client.dispose(); else c.client.leave();
    c.runTimer();
    assert.equal(c.client.active, false);
    if (!disposed) assert.equal(c.states.at(-1).reason, 'leave_unconfirmed');
    assert.equal(c.timers.size + c.intervals.size, 0);
  }
});

test('room readiness seeks across the full track and waits for decoded data at that position, not just metadata', async () => {
  const audio = new Audio(); audio.readyState = 1; audio.buffer = [[0, 3]];
  let done = false;
  const pending = waitForPartyAudio(audio, { position: () => 120, duration: 180 }).then(() => { done = true; });
  assert.equal(audio.currentTime, 120);
  audio.readyState = 3; audio.emit('canplay'); await flush(); assert.equal(done, false);
  audio.buffer = [[120, 123]]; audio.emit('progress'); await pending;
  const controller = new AbortController(); audio.readyState = 0;
  const aborted = waitForPartyAudio(audio, { signal: controller.signal, position: () => 0, duration: 180 });
  controller.abort(); await assert.rejects(aborted, /cancelled/);
  await assert.rejects(waitForPartyAudio(audio, { signal: controller.signal, position: () => 0, duration: 180 }), /cancelled/);
  const error = waitForPartyAudio(audio, { position: () => 0, duration: 180 }); audio.emit('error'); await assert.rejects(error, /unavailable/);
  await assert.rejects(waitForPartyAudio(audio, { position: () => 0, duration: 180, timeout: 1 }), /unavailable/);
});

const app = readFileSync(new URL('../src/app.jsx', import.meta.url), 'utf8');
function loaderHarness({ scFetch, resolveScUrl, loadHls, scCheckCovers, scCacheCover } = {}) {
  const audio = new Audio(), states = {}, calls = [];
  const context = { scAuthRef: ref({ token: 'own-auth', clientId: 'own-client', userId: 1 }), scReqRef: ref(0),
    partyClientRef: ref({ active: true }), xfadeRef: ref(null), xfadePrimeRef: ref(null),
    trackSwitchingRef: ref(false), scPlayingTrackRef: ref(null), trackRef: ref(null), audioRef: ref(audio),
    scTracksRef: ref([]), scCacheMapRef: ref(new Map()), hlsRef: ref(null), HOT_STORE: {},
    progressRef: ref(0), discordProgressRef: ref(0),
    pausePartyPlayback: () => audio.pause(), destroyHls: () => { context.hlsRef.current?.destroy(); context.hlsRef.current = null; },
    setLoadingTrackId: id => { states.loading = id; }, setScPlayingTrack: track => { states.track = track; },
    setScPlayingIdx: () => {}, setMiniProgress: () => {}, restorePlaybackVolume: () => {}, t: key => key,
    mapScTrack: raw => ({ ...raw, streamUrl: 'own-stream-api' }), waitForPartyAudio, withScArtwork, resolvePartyArtwork,
    resolveScUrl: resolveScUrl || (async () => ({ url: 'https://own-access.soundcloud.com/audio', isHls: false })),
    loadHls: loadHls || (() => { throw new Error('not HLS'); }),
    window: { electronAPI: { scCheckCovers, scCacheCover,
      scFetch: async (...args) => { calls.push(args); return scFetch ? scFetch(...args) : { data: { id: 123 } }; } } },
  };
  const start = app.indexOf('  async function loadPartySoundCloudTrack('), end = app.indexOf('  partyCallbacksRef.current =', start);
  vm.runInNewContext(`${app.slice(start, end)}\nglobalThis.load = loadPartySoundCloudTrack;`, context);
  return { context, audio, states, calls, load: context.load };
}

test('the real room loader fetches with personal auth, displays shared metadata and decodes without self-starting', async () => {
  const t = loaderHarness(), controller = new AbortController();
  await t.load(song(), { signal: controller.signal, position: () => 115 });
  assert.deepEqual(t.calls[0], ['https://api-v2.soundcloud.com/tracks/123', 'own-auth', 'own-client']);
  assert.equal(t.states.track.title, song().title);
  assert.equal(t.audio.currentTime, 115); assert.equal(t.audio.plays, 0);
  assert.equal(t.context.trackSwitchingRef.current, false);
});

test('missing shared artwork cannot overwrite fresh SoundCloud artwork and the guest resolves their own local cache', async () => {
  const local = 'http://asset.localhost/guest-cache/123.jpg';
  const t = loaderHarness({ scFetch: async () => ({ data: { id: 123, coverUrl: song().coverUrl } }),
    scCheckCovers: async () => ({ 123: local }) });
  await t.load({ ...song(), coverUrl: null }, { signal: new AbortController().signal, position: () => 10 });
  await flush();
  assert.equal(t.states.track.coverUrl, local);
  assert.equal(t.states.track.remoteCoverUrl, song().coverUrl);
  assert.equal(t.audio.currentTime, 10);
});

test('a host keeps the existing cover; artwork IO cannot block audio or replace a newer track after a late result', async () => {
  const pending = deferred();
  const local = 'http://asset.localhost/host-cache/123.jpg';
  const t = loaderHarness({ scCheckCovers: () => pending.promise });
  t.context.scTracksRef.current = [withScArtwork(song(), local)];
  await t.load(song(), { signal: new AbortController().signal, position: () => 12 });
  assert.equal(t.states.track.coverUrl, local);
  assert.equal(t.states.loading, null);
  assert.equal(t.audio.currentTime, 12);
  t.context.scReqRef.current++;
  t.context.scPlayingTrackRef.current = t.states.track = { ...song(456), coverUrl: 'new-cover' };
  pending.resolve({ 123: 'old-late-cover' }); await flush();
  assert.equal(t.states.track.coverUrl, 'new-cover');
});

test('the real HLS loader starts buffering at the room seek without autoplay and reports fatal errors only for its own stream', async () => {
  const instances = [], errors = [];
  class Hls {
    static Events = { ERROR: 'error' };
    static isSupported() { return true; }
    callbacks = new Map();
    constructor(options) { this.options = options; instances.push(this); }
    on(event, fn) { this.callbacks.set(event, fn); }
    loadSource(url) { this.url = url; }
    attachMedia(audio) { audio.src = 'blob:own-hls'; }
    destroy() { this.destroyed = true; }
  }
  const t = loaderHarness({ resolveScUrl: async () => ({ url: 'https://own-access/hls', isHls: true }), loadHls: async () => Hls });
  t.context.partyClientRef.current.failPlayback = error => errors.push(error);
  const controller = new AbortController();
  await t.load(song(), { signal: controller.signal, position: () => 80 });
  assert.equal(instances[0].options.startPosition, 80);
  assert.equal(t.audio.currentTime, 80); assert.equal(t.audio.plays, 0);
  instances[0].callbacks.get('error')(null, { fatal: true });
  assert.deepEqual(errors, ['track_unavailable']);
  t.context.hlsRef.current = null;
  instances[0].callbacks.get('error')(null, { fatal: true });
  assert.equal(errors.length, 1);
});

test('the real loader drops late metadata after abort, different account or newer request and cannot clear a newer stream', async () => {
  for (const kind of ['abort', 'account', 'newer']) {
    const pending = deferred(), t = loaderHarness({ scFetch: () => pending.promise }), controller = new AbortController();
    const loading = t.load(song(), { signal: controller.signal, position: () => 10 });
    if (kind === 'abort') controller.abort();
    if (kind === 'account') t.context.scAuthRef.current = { token: 'other-auth', userId: 2 };
    if (kind === 'newer') { t.context.scReqRef.current++; t.audio.src = 'newer-stream'; }
    pending.resolve({ data: { id: 123 } }); await assert.rejects(loading, /cancelled/);
    assert.equal(t.audio.plays, 0);
    assert.equal(t.audio.src, kind === 'newer' ? 'newer-stream' : '');
  }
});

test('room control guards protect direct selection, media keys and local files; production CSP allows only the deployed party socket', () => {
  const start = app.indexOf('  function partyCanControl()'), end = app.indexOf('  function pausePartyPlayback()', start);
  const context = { partyClientRef: ref(null), scPlayingTrackRef: ref(song()), trackRef: ref(song()),
    langRef: ref('ru'), partyLabels: () => ({ error_host_only: 'host-only', error_soundcloud_only: 'sc-only' }),
    showToast: () => {}, setIsPlaying: () => {} };
  vm.runInNewContext(`${app.slice(start, end)}\nglobalThis.controls = { partyCanControl, partyCanSelect };`, context);
  assert.equal(context.controls.partyCanControl(), true);
  context.partyClientRef.current = { active: true, role: 'guest', status: 'connected' };
  assert.equal(context.controls.partyCanControl(), false); assert.equal(context.controls.partyCanSelect(false), false);
  context.partyClientRef.current.role = 'host';
  assert.equal(context.controls.partyCanSelect(false), true); assert.equal(context.controls.partyCanSelect(true), false);
  context.partyClientRef.current.status = 'reconnecting'; assert.equal(context.controls.partyCanControl(), false);
  const csp = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url))).app.security.csp;
  assert.ok(csp.includes('wss://sewer-party.dysphorialkxd.workers.dev'));
  assert.equal(csp.includes('wss: '), false);
  assert.match(app, /speed = partyActive \? 1/); assert.match(app, /pitch = partyActive \? 0/);
  assert.match(app, /onTogglePlayback=\{togglePlayback\}/);
});
