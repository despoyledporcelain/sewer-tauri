import { DurableObject } from 'cloudflare:workers';

// Keep these exported/binding names: the deployed Cloudflare starter uses them.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_TTL = 6 * 60 * 60 * 1000;
const MAX_MEMBERS = 8;
const MAX_BODY = 4096;
const PROTOCOL = 'sewer-party.v1';
const ORIGINS = new Set(['http://tauri.localhost', 'https://tauri.localhost',
  'http://localhost:1420', 'http://127.0.0.1:1420',
  'http://localhost:5173', 'http://127.0.0.1:5173']);

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  } });
}
function failure(code, status = 400) { return json({ error: code }, status); }
function randomHex(bytes = 32) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
function roomCode() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), byte => ALPHABET[byte % ALPHABET.length]).join('');
}
async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
function cleanText(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function imageURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (url.hostname !== 'sndcdn.com' && !url.hostname.endsWith('.sndcdn.com')) return null;
    return url.href.length <= 512 ? url.href : null;
  } catch { return null; }
}
function profile(value) {
  return { name: cleanText(value?.name, 64) || 'слушатель', avatarUrl: imageURL(value?.avatarUrl) };
}
function cleanTrack(value) {
  if (value == null) return null;
  if (value.source !== 'soundcloud' || !/^[1-9][0-9]{0,19}$/.test(String(value.id))) throw new Error('invalid_track');
  if (typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration <= 0 || value.duration > 86400) {
    throw new Error('invalid_track');
  }
  // Deliberately no local paths, stream URLs, SoundCloud auth, queue or effects.
  return { source: 'soundcloud', id: String(value.id), title: cleanText(value.title, 160),
    artist: cleanText(value.artist, 160), coverUrl: imageURL(value.coverUrl), duration: value.duration };
}
async function readJSON(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error('json_required');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid_json');
  let size = 0, text = '';
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new Error('body_too_large'); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    let value;
    try { value = JSON.parse(text); } catch { throw new Error('invalid_json'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_json');
    return value;
  } finally { reader.releaseLock(); }
}
function stub(env, name) { return env.MY_DURABLE_OBJECT.get(env.MY_DURABLE_OBJECT.idFromName(name)); }
function internalRequest(action, body) {
  return new Request(`https://internal/${action}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function limit(request, env, kind) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  return stub(env, `rate:${await hash(ip)}`).fetch(internalRequest('limit', { kind }));
}
function cors(response, origin) {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  if (origin && ORIGINS.has(origin)) headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    if (origin && !ORIGINS.has(origin)) return failure('origin_not_allowed', 403);
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}), 'Vary': 'Origin',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600',
      } });
    }
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return cors(json({ ok: true, service: 'sewer-party', protocol: 1 }), origin);
    }
    if (!env.MY_DURABLE_OBJECT) return cors(failure('missing_room_binding', 503), origin);
    const join = url.pathname.match(/^\/v1\/rooms\/([A-Z2-9]{6})\/join$/);
    const socket = url.pathname.match(/^\/v1\/rooms\/([A-Z2-9]{6})\/socket$/);
    const create = request.method === 'POST' && url.pathname === '/v1/rooms';
    if (!create && !(request.method === 'POST' && join) && !(request.method === 'GET' && socket)) {
      return cors(failure('not_found', 404), origin);
    }
    if (socket && request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return cors(failure('websocket_required', 426), origin);
    }
    try {
      if (socket) {
        const protocols = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(value => value.trim());
        if (!protocols.includes(PROTOCOL) || !protocols.some(value => /^token\.[a-f0-9]{64}$/.test(value))) {
          return cors(failure('unauthorized', 401), origin);
        }
      }
      const body = socket ? null : await readJSON(request);
      const data = body ? { profile: profile(body.profile), ...(create ? { track: cleanTrack(body.track) } : {}) } : null;
      const permitted = await limit(request, env, create ? 'create' : socket ? 'socket' : 'join');
      if (permitted.status !== 200) return cors(permitted, origin);
      if (create) {
        for (let attempt = 0; attempt < 4; attempt++) {
          const code = roomCode();
          const response = await stub(env, `room:${code}`).fetch(internalRequest('create', { code, ...data }));
          if (response.status !== 409) return cors(response, origin);
        }
        return cors(failure('try_again', 503), origin);
      }
      const room = stub(env, `room:${(join || socket)[1]}`);
      return cors(await room.fetch(socket ? request : internalRequest('join', data)), origin);
    } catch (error) {
      const known = ['invalid_track', 'invalid_json', 'json_required', 'body_too_large'].includes(error.message);
      return cors(failure(known ? error.message : 'request_failed', known ? error.message === 'body_too_large' ? 413 : 400 : 503), origin);
    }
  },
};

export class MyDurableObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => { this.room = await ctx.storage.get('room') || null; });
  }
  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(() => this.handleRequest(request));
  }
  async handleRequest(request) {
    const path = new URL(request.url).pathname;
    if (path === '/limit') {
      const { kind } = await request.json();
      const max = { create: 3, join: 20, socket: 40 }[kind];
      if (!max) return failure('not_found', 404);
      const now = Date.now();
      const saved = await this.ctx.storage.get(kind);
      let bucket = { count: 0, resetAt: now + 60000 };
      // Storage returns unknown: validate it before reading the saved counter.
      if (saved && typeof saved === 'object'
        && 'count' in saved && typeof saved.count === 'number' && Number.isInteger(saved.count) && saved.count >= 0
        && 'resetAt' in saved && typeof saved.resetAt === 'number' && Number.isFinite(saved.resetAt) && saved.resetAt > now) {
        bucket = { count: saved.count, resetAt: saved.resetAt };
      }
      if (bucket.count >= max) {
        const response = failure('rate_limited', 429);
        response.headers.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
        return response;
      }
      bucket.count++;
      await this.ctx.storage.put(kind, bucket);
      await this.ctx.storage.setAlarm(now + 120000);
      return json({ ok: true });
    }
    if (this.room && this.room.expiresAt <= Date.now()) await this.closeRoom('expired');
    if (path === '/create') {
      if (this.room) return failure('code_in_use', 409);
      const body = await request.json();
      const memberId = randomHex(12), token = randomHex();
      this.room = { code: body.code, expiresAt: Date.now() + ROOM_TTL, track: cleanTrack(body.track), suggestions: [],
        playback: { playing: false, position: 0, updatedAt: Date.now(), revision: 0 },
        sessions: [{ id: memberId, tokenHash: await hash(token), role: 'host', profile: profile(body.profile), expiresAt: Date.now() + ROOM_TTL }] };
      await this.save();
      await this.ctx.storage.setAlarm(this.room.expiresAt);
      return json({ protocol: 1, code: this.room.code, memberId, token, role: 'host' }, 201);
    }
    if (!this.room) return failure('room_not_found', 404);
    if (path === '/join') {
      const body = await request.json();
      this.room.sessions = this.room.sessions.filter(session => session.expiresAt > Date.now());
      if (this.room.sessions.length >= MAX_MEMBERS) return failure('room_full', 409);
      const memberId = randomHex(12), token = randomHex();
      this.room.sessions.push({ id: memberId, tokenHash: await hash(token), role: 'guest',
        profile: profile(body.profile), expiresAt: Math.min(this.room.expiresAt, Date.now() + 60000) });
      await this.save();
      return json({ protocol: 1, code: this.room.code, memberId, token, role: 'guest' }, 201);
    }
    if (path.endsWith('/socket') && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const protocols = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(value => value.trim());
      const credential = protocols.find(value => /^token\.[a-f0-9]{64}$/.test(value));
      if (!protocols.includes(PROTOCOL) || !credential) return failure('unauthorized', 401);
      const digest = await hash(credential.slice(6));
      const session = this.room.sessions.find(value => value.tokenHash === digest && value.expiresAt > Date.now());
      if (!session) return failure('unauthorized', 401);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ id: session.id, count: 0, resetAt: 0, detached: false });
      for (const ws of this.peers()) {
        if (ws !== server && ws.deserializeAttachment().id === session.id) this.detach(ws, 4001, 'replaced');
      }
      session.expiresAt = this.room.expiresAt;
      await this.save();
      this.broadcast();
      return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': PROTOCOL } });
    }
    return failure('not_found', 404);
  }
  save() { return this.ctx.storage.put('room', this.room); }
  peers() {
    return this.ctx.getWebSockets().filter(ws => ws.readyState === 1 && !ws.deserializeAttachment()?.detached);
  }
  members() {
    const ids = new Set(this.peers().map(ws => ws.deserializeAttachment()?.id));
    return this.room.sessions.filter(session => ids.has(session.id)).map(session => ({
      id: session.id, role: session.role, name: session.profile.name, avatarUrl: session.profile.avatarUrl,
    }));
  }
  broadcast() {
    if (!this.room) return;
    const members = this.members();
    for (const ws of this.peers()) {
      const id = ws.deserializeAttachment().id;
      const session = this.room.sessions.find(value => value.id === id);
      this.send(ws, { type: 'room', protocol: 1, code: this.room.code, you: { id, role: session.role },
        members, track: this.room.track, playback: this.room.playback, suggestions: this.room.suggestions || [], serverTime: Date.now() });
    }
  }
  send(ws, value) {
    try { ws.send(JSON.stringify(value)); } catch { this.detach(ws, 1011, 'send_failed'); }
  }
  detach(ws, code, reason) {
    const attachment = ws.deserializeAttachment();
    if (attachment) ws.serializeAttachment({ ...attachment, detached: true });
    try { ws.close(code, reason); } catch { /* already disconnected */ }
  }
  webSocketMessage(ws, message) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const attachment = ws.deserializeAttachment();
      if (!this.room || attachment?.detached) return;
      if (this.room.expiresAt <= Date.now()) { await this.closeRoom('expired'); return; }
      const session = this.room.sessions.find(value => value.id === attachment?.id);
      if (!session) { this.detach(ws, 1008, 'unauthorized'); return; }
      if (typeof message !== 'string' || new TextEncoder().encode(message).byteLength > MAX_BODY) {
        this.detach(ws, 1009, 'message_too_large'); await this.disconnected(attachment.id); return;
      }
      if (attachment.resetAt <= Date.now()) { attachment.count = 0; attachment.resetAt = Date.now() + 1000; }
      if (++attachment.count > 20) { this.detach(ws, 1008, 'rate_limited'); await this.disconnected(attachment.id); return; }
      ws.serializeAttachment(attachment);
      let data;
      try { data = JSON.parse(message); } catch { this.send(ws, { type: 'error', error: 'invalid_json' }); return; }
      if (!data || typeof data !== 'object') { this.send(ws, { type: 'error', error: 'invalid_message' }); return; }
      if (data.type === 'ping') {
        this.send(ws, { type: 'pong', nonce: cleanText(data.nonce, 64), serverTime: Date.now() }); return;
      }
      if (data.type === 'leave') {
        if (session.role === 'host') { await this.closeRoom('host_left'); return; }
        this.room.sessions = this.room.sessions.filter(value => value.id !== session.id);
        this.detach(ws, 1000, 'left');
        await this.save(); this.broadcast(); return;
      }
      if (data.type === 'transfer-host') {
        if (session.role !== 'host') { this.send(ws, { type: 'error', error: 'host_only' }); return; }
        const successor = this.room.sessions.find(value => value.id === data.memberId && value.id !== session.id
          && value.role === 'guest' && this.peers().some(peer => peer.deserializeAttachment()?.id === value.id));
        if (!successor) { this.send(ws, { type: 'error', error: 'member_not_found' }); return; }
        session.role = 'guest'; successor.role = 'host'; await this.save(); this.broadcast(); return;
      }
      if (data.type === 'suggest') {
        let track;
        try { track = cleanTrack(data.track); } catch { this.send(ws, { type: 'error', error: 'invalid_track' }); return; }
        if (!track) { this.send(ws, { type: 'error', error: 'invalid_track' }); return; }
        const suggestions = this.room.suggestions || (this.room.suggestions = []);
        if (suggestions.length >= 20) { this.send(ws, { type: 'error', error: 'suggestions_full' }); return; }
        if (suggestions.some(item => item.memberId === session.id && item.track.id === track.id)) {
          this.send(ws, { type: 'error', error: 'already_suggested' }); return;
        }
        suggestions.push({ id: randomHex(8), memberId: session.id, name: session.profile.name, track });
        await this.save(); this.broadcast(); return;
      }
      if (data.type === 'suggestion-remove') {
        const suggestions = this.room.suggestions || [];
        const item = suggestions.find(value => value.id === data.id);
        if (!item) return;
        if (session.role !== 'host' && item.memberId !== session.id) { this.send(ws, { type: 'error', error: 'host_only' }); return; }
        this.room.suggestions = suggestions.filter(value => value.id !== data.id);
        await this.save(); this.broadcast(); return;
      }
      if (session.role !== 'host') { this.send(ws, { type: 'error', error: 'host_only' }); return; }
      if (data.type === 'track') {
        try { this.room.track = cleanTrack(data.track); } catch { this.send(ws, { type: 'error', error: 'invalid_track' }); return; }
        this.room.suggestions = (this.room.suggestions || []).filter(item => item.track.id !== this.room.track?.id);
        this.room.playback = { playing: false, position: 0, updatedAt: Date.now(), revision: this.room.playback.revision + 1 };
      } else if (data.type === 'playback') {
        if (!this.room.track || typeof data.playing !== 'boolean' || typeof data.position !== 'number'
          || !Number.isFinite(data.position) || data.position < 0 || data.position > this.room.track.duration) {
          this.send(ws, { type: 'error', error: 'invalid_playback' }); return;
        }
        this.room.playback = { playing: data.playing, position: data.position, updatedAt: Date.now(), revision: this.room.playback.revision + 1 };
      } else { this.send(ws, { type: 'error', error: 'invalid_message' }); return; }
      await this.save(); this.broadcast();
    });
  }
  async disconnected(id) {
    if (!this.room || this.peers().some(ws => ws.deserializeAttachment()?.id === id)) return;
    const session = this.room.sessions.find(value => value.id === id);
    if (!session) return;
    if (session.role === 'guest') {
      session.expiresAt = Math.min(session.expiresAt, this.room.expiresAt, Date.now() + 60000);
      this.room.suggestions = (this.room.suggestions || []).filter(item => item.memberId !== id);
    }
    else if (this.room.playback.playing) {
      const state = this.room.playback;
      this.room.playback = { playing: false, position: Math.min(this.room.track.duration,
        state.position + Math.max(0, Date.now() - state.updatedAt) / 1000), updatedAt: Date.now(), revision: state.revision + 1 };
    }
    await this.save(); this.broadcast();
  }
  webSocketClose(ws, code, reason) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const attachment = ws.deserializeAttachment();
      this.detach(ws, code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1000,
        cleanText(reason, 64));
      await this.disconnected(attachment?.id);
    });
  }
  webSocketError(ws) {
    return this.webSocketClose(ws, 1011, 'connection_error');
  }
  async closeRoom(reason) {
    for (const ws of this.peers()) {
      this.send(ws, { type: 'closed', reason }); this.detach(ws, 1000, reason);
    }
    this.room = null;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }
  alarm() {
    return this.ctx.blockConcurrencyWhile(async () => {
      // A retry from an older alarm must not expire a newly created room early.
      if (this.room && this.room.expiresAt > Date.now()) {
        await this.ctx.storage.setAlarm(this.room.expiresAt); return;
      }
      if (this.room) await this.closeRoom('expired');
      else { await this.ctx.storage.deleteAll(); await this.ctx.storage.deleteAlarm(); }
    });
  }
}
