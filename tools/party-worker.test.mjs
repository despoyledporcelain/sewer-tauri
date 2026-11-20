import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const source = readFileSync(new URL('../workers/listening-party/index.js', import.meta.url), 'utf8');
const compiled = transformSync(source, { loader: 'js', format: 'cjs' }).code;
const track = { source: 'soundcloud', id: '123', title: 'a song', artist: 'an artist',
  coverUrl: 'https://i1.sndcdn.com/artworks-example-large.jpg', duration: 180 };

class Socket {
  readyState = 0;
  messages = [];
  serializeAttachment(value) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  send(message) { if (this.readyState !== 1) throw new Error('closed'); this.messages.push(JSON.parse(message)); }
  close(code, reason) { this.readyState = 3; this.closed = { code, reason }; }
}
class Pair {
  constructor() {
    this[0] = new Socket(); this[1] = new Socket();
    this[0].peer = this[1]; this[1].peer = this[0];
  }
}
class Context {
  sockets = [];
  pending = Promise.resolve();
  data = new Map();
  alarmAt = null;
  storage = {
    get: async key => structuredClone(this.data.get(key)),
    put: async (key, value) => this.data.set(key, structuredClone(value)),
    setAlarm: async value => { this.alarmAt = value; },
    deleteAlarm: async () => { this.alarmAt = null; },
    deleteAll: async () => this.data.clear(),
  };
  blockConcurrencyWhile(callback) {
    const result = this.pending.then(callback);
    this.pending = result.catch(() => {});
    return result;
  }
  acceptWebSocket(ws) { ws.readyState = ws.peer.readyState = 1; this.sockets.push(ws); }
  getWebSockets() { return this.sockets; }
}

function server() {
  const clock = { now: 1800000000000 };
  const objects = new Map();
  let MyDurableObject;
  const env = { MY_DURABLE_OBJECT: {
    idFromName: name => name,
    get(name) {
      if (!objects.has(name)) {
        const ctx = new Context();
        objects.set(name, { ctx, object: new MyDurableObject(ctx, env) });
      }
      return { fetch: request => objects.get(name).object.fetch(request) };
    },
  } };
  const sandbox = { module: { exports: {} }, require: name => {
    assert.equal(name, 'cloudflare:workers');
    return { DurableObject: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } };
  }, crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, Headers, Request, URL,
  Date: class extends Date { static now() { return clock.now; } }, WebSocketPair: Pair,
  Response: class extends Response {
    constructor(body, options) {
      if (options?.status === 101) return { status: 101, webSocket: options.webSocket, headers: new Headers(options.headers) };
      super(body, options);
    }
  } };
  vm.runInNewContext(compiled, sandbox);
  MyDurableObject = sandbox.module.exports.MyDurableObject;
  const api = sandbox.module.exports.default;
  const request = (path, body, headers = {}, method = body === undefined ? 'GET' : 'POST') => api.fetch(new Request(
    `https://sewer-party.dysphorialkxd.workers.dev${path}`, { method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
  const create = async body => {
    const response = await request('/v1/rooms', body || { profile: { name: 'host' }, track });
    assert.equal(response.status, 201);
    return response.json();
  };
  const join = async (code, body = { profile: { name: 'guest' } }) => {
    const response = await request(`/v1/rooms/${code}/join`, body);
    assert.equal(response.status, 201);
    return response.json();
  };
  const connect = async session => {
    const response = await request(`/v1/rooms/${session.code}/socket`, undefined, {
      Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `sewer-party.v1, token.${session.token}`,
      Origin: 'http://tauri.localhost',
    });
    assert.equal(response.status, 101);
    assert.equal(response.headers.get('Sec-WebSocket-Protocol'), 'sewer-party.v1');
    return response.webSocket.peer;
  };
  const room = session => objects.get(`room:${session.code}`);
  const message = (session, ws, value) => room(session).object.webSocketMessage(ws, typeof value === 'string' ? value : JSON.stringify(value));
  return { request, api, env, create, join, connect, message, room, objects, clock, MyDurableObject };
}

test('the deployment keeps the starter class/binding and exposes a no-store health endpoint', async () => {
  const s = server();
  const response = await s.request('/health');
  assert.deepEqual(await response.json(), { ok: true, service: 'sewer-party', protocol: 1 });
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(s.objects.size, 0);
  assert.match(source, /export class MyDurableObject extends DurableObject/);
  assert.match(source, /env\.MY_DURABLE_OBJECT/);
  assert.doesNotMatch(source, /console\.|setInterval\(|\.accept\(/);
});

test('create/join mint distinct credentials, cannot promote a guest and never store or broadcast stream/auth data', async () => {
  const s = server();
  const host = await s.create({ profile: { name: 'host', token: 'soundcloud-secret' },
    track: { ...track, resolvedUrl: 'signed-stream', path: 'C:\\private.mp3', token: 'another-secret' } });
  const guest = await s.join(host.code, { role: 'host', token: host.token, profile: { name: 'guest' } });
  assert.match(host.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.match(host.token, /^[a-f0-9]{64}$/);
  assert.notEqual(host.token, guest.token);
  assert.equal(host.role, 'host'); assert.equal(guest.role, 'guest');
  const a = await s.connect(host), b = await s.connect(guest);
  assert.equal(a.messages.at(-1).members.length, 2);
  assert.equal(b.messages.at(-1).you.role, 'guest');
  for (const text of [JSON.stringify(a.messages), JSON.stringify(b.messages), JSON.stringify([...s.room(host).ctx.data])]) {
    for (const secret of [host.token, guest.token, 'soundcloud-secret', 'signed-stream', 'private.mp3', 'another-secret']) {
      assert.equal(text.includes(secret), false);
    }
  }
});

test('host track/playback changes reach both clients with authoritative timestamps and increasing revisions', async () => {
  const s = server(), host = await s.create();
  const guest = await s.join(host.code), a = await s.connect(host), b = await s.connect(guest);
  await s.message(host, a, { type: 'playback', playing: true, position: 15, speed: 2, eq: [10] });
  assert.equal(b.messages.at(-1).playback.playing, true);
  assert.equal(b.messages.at(-1).playback.position, 15);
  assert.equal(b.messages.at(-1).playback.updatedAt, s.clock.now);
  assert.equal(b.messages.at(-1).playback.revision, 1);
  assert.equal('speed' in b.messages.at(-1).playback, false);
  await s.message(host, a, { type: 'track', track: { ...track, id: '456' } });
  assert.equal(b.messages.at(-1).track.id, '456');
  assert.equal(b.messages.at(-1).playback.playing, false);
  assert.equal(b.messages.at(-1).playback.position, 0);
  assert.equal(b.messages.at(-1).playback.revision, 2);
});

test('guest controls and malformed/local tracks or out-of-range positions cannot change shared state', async () => {
  const s = server(), host = await s.create(), guest = await s.join(host.code);
  const a = await s.connect(host), b = await s.connect(guest);
  const original = JSON.stringify(s.room(host).object.room.playback);
  for (const command of [{ type: 'playback', playing: true, position: 2 }, { type: 'track', track: null }]) {
    await s.message(host, b, command);
    assert.equal(b.messages.at(-1).error, 'host_only');
  }
  for (const command of [
    { type: 'track', track: { ...track, source: 'local', path: 'C:\\private.mp3' } },
    { type: 'playback', playing: true, position: -1 },
    { type: 'playback', playing: true, position: 181 },
    { type: 'playback', playing: 'true', position: 1 },
    { type: 'playback', playing: true, position: null },
    { type: 'speed', speed: 2 },
  ]) {
    await s.message(host, a, command);
    assert.equal(a.messages.at(-1).type, 'error');
  }
  assert.equal(JSON.stringify(s.room(host).object.room.playback), original);
  assert.equal(s.room(host).object.room.track.id, '123');
});

test('unknown rooms, missing upgrade, invalid token and untrusted origins fail before joining', async () => {
  const s = server(), host = await s.create();
  assert.equal((await s.request('/v1/rooms/ABC234/join', {})).status, 404);
  assert.equal((await s.request(`/v1/rooms/${host.code}/socket`)).status, 426);
  assert.equal((await s.request(`/v1/rooms/${host.code}/socket`, undefined, { Upgrade: 'websocket' })).status, 401);
  const impostor = { ...host, token: 'a'.repeat(64) };
  const response = await s.request(`/v1/rooms/${host.code}/socket`, undefined, {
    Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `sewer-party.v1, token.${impostor.token}`,
  });
  assert.equal(response.status, 401);
  assert.equal(s.room(host).ctx.sockets.length, 0);
  assert.equal((await s.request('/v1/rooms', { track }, { Origin: 'https://evil.example' })).status, 403);
});

test('CORS allows only app/development origins, JSON body size/type/structure is bounded', async () => {
  const s = server();
  const preflight = await s.request('/v1/rooms', undefined, { Origin: 'http://tauri.localhost' }, 'OPTIONS');
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'http://tauri.localhost');
  assert.notEqual(preflight.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await s.request('/v1/rooms', { track }, { 'Content-Type': 'text/plain' })).status, 400);
  assert.equal((await s.request('/v1/rooms', { padding: 'a'.repeat(5000) })).status, 413);
  assert.equal((await s.request('/v1/rooms', [])).status, 400);
  const response = await s.api.fetch(new Request('https://sewer-party.dysphorialkxd.workers.dev/v1/rooms', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken',
  }), s.env);
  assert.equal(response.status, 400); assert.equal((await response.json()).error, 'invalid_json');
});

test('room limits and IP limits survive hibernation rather than relying on in-memory timers', async () => {
  const s = server(), host = await s.create();
  for (let i = 0; i < 7; i++) await s.join(host.code);
  assert.equal((await s.request(`/v1/rooms/${host.code}/join`, {})).status, 409);
  const entry = s.room(host);
  entry.object = new s.MyDurableObject(entry.ctx, s.env);
  assert.equal((await entry.object.fetch(new Request('https://internal/join', { method: 'POST',
    body: '{}', headers: { 'Content-Type': 'application/json' } }))).status, 409);
  await s.create(); await s.create();
  const denied = await s.request('/v1/rooms', { track });
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get('Retry-After'), '60');
  s.clock.now += 61000;
  await s.create();
});

test('unknown or corrupt stored rate counters reset safely while valid counters still enforce the limit', async () => {
  const s = server();
  await s.create();
  const entry = [...s.objects.entries()].find(([name]) => name.startsWith('rate:'))[1];
  for (const saved of [null, 123, 'broken', [], {}, { count: '1', resetAt: s.clock.now + 60000 },
    { count: 1, resetAt: 'later' }, { count: -1, resetAt: s.clock.now + 60000 },
    { count: 0.5, resetAt: s.clock.now + 60000 }, { count: 1, resetAt: Infinity },
    { count: 3, resetAt: s.clock.now }]) {
    await entry.ctx.storage.put('create', saved);
    await s.create();
    assert.deepEqual(await entry.ctx.storage.get('create'), { count: 1, resetAt: s.clock.now + 60000 });
  }
  await entry.ctx.storage.put('create', { count: 2, resetAt: s.clock.now + 30000 });
  await s.create();
  const response = await s.request('/v1/rooms', { track });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '30');
});

test('resuming after hibernation restores state and websocket identities, not tokens in attachments', async () => {
  const s = server(), host = await s.create(), a = await s.connect(host);
  await s.message(host, a, { type: 'playback', playing: true, position: 40 });
  const entry = s.room(host);
  entry.object = new s.MyDurableObject(entry.ctx, s.env);
  await s.message(host, a, { type: 'ping', nonce: 'clock-1' });
  assert.equal(a.messages.at(-1).type, 'pong');
  assert.equal(a.messages.at(-1).nonce, 'clock-1');
  assert.equal(entry.object.room.playback.position, 40);
  assert.equal(JSON.stringify(a.deserializeAttachment()).includes(host.token), false);
});

test('replacement connections do not pause the room when the obsolete socket close arrives later', async () => {
  const s = server(), host = await s.create(), a = await s.connect(host);
  await s.message(host, a, { type: 'playback', playing: true, position: 40 });
  const b = await s.connect(host);
  assert.equal(a.closed.code, 4001);
  await s.room(host).object.webSocketClose(a, 4001, 'replaced');
  assert.equal(s.room(host).object.room.playback.playing, true);
  assert.equal(b.messages.at(-1).members.length, 1);
});

test('host disconnection pauses at the elapsed position; reconnecting does not automatically resume', async () => {
  const s = server(), host = await s.create(), guest = await s.join(host.code);
  const a = await s.connect(host), b = await s.connect(guest);
  await s.message(host, a, { type: 'playback', playing: true, position: 175 });
  s.clock.now += 10000;
  await s.room(host).object.webSocketClose(a, 1006, 'network');
  assert.equal(b.messages.at(-1).playback.playing, false);
  assert.equal(b.messages.at(-1).playback.position, 180);
  assert.equal(b.messages.at(-1).members.length, 1);
  const resumed = await s.connect(host);
  assert.equal(resumed.messages.at(-1).playback.playing, false);
});

test('oversized and flooded sockets are detached, pause an offending host and do not stay in membership', async () => {
  for (const flood of [false, true]) {
    const s = server(), host = await s.create(), a = await s.connect(host);
    await s.message(host, a, { type: 'playback', playing: true, position: 10 });
    if (flood) for (let i = 0; i < 20; i++) await s.message(host, a, { type: 'ping' });
    else await s.message(host, a, 'a'.repeat(5000));
    assert.equal(a.readyState, 3);
    assert.equal(s.room(host).object.room.playback.playing, false);
    assert.equal(s.room(host).object.members().length, 0);
  }
});

test('guest leave revokes its credential; host leave closes everyone and clears persisted state', async () => {
  const s = server(), host = await s.create(), guest = await s.join(host.code);
  const a = await s.connect(host), b = await s.connect(guest);
  await s.message(host, b, { type: 'leave' });
  assert.equal(s.room(host).object.room.sessions.length, 1);
  const denied = await s.request(`/v1/rooms/${host.code}/socket`, undefined, {
    Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `sewer-party.v1, token.${guest.token}`,
  });
  assert.equal(denied.status, 401);
  const nextGuest = await s.join(host.code), c = await s.connect(nextGuest);
  await s.message(host, a, { type: 'leave' });
  assert.equal(c.messages.at(-1).type, 'closed');
  assert.equal(c.closed.reason, 'host_left');
  assert.equal(s.room(host).ctx.data.size, 0);
  assert.equal(s.room(host).ctx.alarmAt, null);
});

test('room alarms expire connected rooms and the next fetch also enforces expiry if the alarm is late', async () => {
  for (const alarm of [false, true]) {
    const s = server(), host = await s.create(), a = await s.connect(host);
    s.clock.now += 6 * 60 * 60 * 1000 + 1;
    if (alarm) await s.room(host).object.alarm();
    else assert.equal((await s.request(`/v1/rooms/${host.code}/join`, {})).status, 404);
    assert.equal(a.messages.at(-1).type, 'closed');
    assert.equal(a.messages.at(-1).reason, 'expired');
    assert.equal(s.room(host).ctx.data.size, 0);
  }
});

test('an early or retried alarm cannot expire a live room before its own deadline', async () => {
  const s = server(), host = await s.create(), a = await s.connect(host);
  const deadline = s.room(host).object.room.expiresAt;
  await s.room(host).object.alarm();
  assert.equal(s.room(host).object.room.expiresAt, deadline);
  assert.equal(s.room(host).ctx.alarmAt, deadline);
  assert.equal(a.readyState, 1);
});

test('a delayed close event cannot revive an expired guest credential', async () => {
  const s = server(), host = await s.create(), guest = await s.join(host.code);
  await s.connect(host);
  const b = await s.connect(guest);
  await s.message(host, b, 'a'.repeat(5000));
  s.clock.now += 61000;
  await s.room(host).object.webSocketClose(b, 1009, 'message_too_large');
  const response = await s.request(`/v1/rooms/${host.code}/socket`, undefined, {
    Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `sewer-party.v1, token.${guest.token}`,
  });
  assert.equal(response.status, 401);
});
