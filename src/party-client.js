import { cleanPartyCode, validPartyCode, partyImageURL, sharedPartyTrack } from './listening-party.js';

export const PARTY_ENDPOINT = 'https://sewer-party.dysphorialkxd.workers.dev';
export const PARTY_PROTOCOL = 'sewer-party.v1';
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function partySnapshot(value, session) {
  if (!value || value.protocol !== 1 || value.code !== session.code || value.you?.id !== session.memberId
    || !['host', 'guest'].includes(value.you.role) || !Array.isArray(value.members) || value.members.length > 8
    || !finite(value.serverTime) || !value.playback || typeof value.playback.playing !== 'boolean'
    || !finite(value.playback.position) || value.playback.position < 0 || !finite(value.playback.updatedAt)
    || !Number.isSafeInteger(value.playback.revision) || value.playback.revision < 0) throw new Error('protocol_error');
  const track = value.track == null ? null : sharedPartyTrack(value.track);
  if (value.track != null && (!track || value.track.source !== 'soundcloud')
    || value.playback.position > (track?.duration || 0) || !track && value.playback.playing) throw new Error('protocol_error');
  const ids = new Set();
  const members = value.members.map(member => {
    if (typeof member.id !== 'string' || member.id.length > 64 || ids.has(member.id)
      || !['host', 'guest'].includes(member.role) || typeof member.name !== 'string') throw new Error('protocol_error');
    ids.add(member.id);
    return { id: member.id, role: member.role, name: member.name.slice(0, 64), avatarUrl: partyImageURL(member.avatarUrl) };
  });
  const suggestions = value.suggestions ?? [];
  if (!Array.isArray(suggestions) || suggestions.length > 20) throw new Error('protocol_error');
  const cleanSuggestions = suggestions.map(item => {
    const track = sharedPartyTrack(item?.track);
    if (typeof item?.id !== 'string' || item.id.length > 64 || typeof item.memberId !== 'string'
      || item.memberId.length > 64 || typeof item.name !== 'string' || !track) throw new Error('protocol_error');
    return { id: item.id, memberId: item.memberId, name: item.name.slice(0, 64), track };
  });
  return { type: 'room', protocol: 1, code: session.code, you: { id: session.memberId, role: value.you.role },
    members, track, suggestions: cleanSuggestions, playback: { playing: value.playback.playing, position: value.playback.position,
      updatedAt: value.playback.updatedAt, revision: value.playback.revision }, serverTime: value.serverTime };
}

export function partyPosition(snapshot, serverNow) {
  if (!snapshot?.track) return 0;
  const state = snapshot.playback;
  return Math.min(snapshot.track.duration, Math.max(0, state.position
    + (state.playing ? Math.max(0, serverNow - state.updatedAt) / 1000 : 0)));
}

// Owned by App, never by the visible room layout. Toggling the room is purely visual.
export class PartyClient {
  constructor({ fetch: fetcher = globalThis.fetch.bind(globalThis), WebSocket: Socket = globalThis.WebSocket,
    // WebView's timer methods require Window as their receiver, not PartyClient.
    now = () => Date.now(), setTimeout: later = globalThis.setTimeout.bind(globalThis), clearTimeout: cancel = globalThis.clearTimeout.bind(globalThis),
    setInterval: every = globalThis.setInterval.bind(globalThis), clearInterval: stop = globalThis.clearInterval.bind(globalThis),
    onState, getPlayer, loadTrack, pause, play, seek, empty = () => {}, onActive = () => {} }) {
    Object.assign(this, { fetcher, Socket, now, later, cancel, every, stop, onState, getPlayer, loadTrack, pause, play, seek, empty, onActive });
    this.generation = 0;
    this.session = null;
    this.status = 'idle';
    this.snapshot = null;
    this.offset = 0;
    this.bestRTT = Infinity;
    this.load = null;
    this.lastPublished = null;
    this.disposed = false;
  }
  get active() { return !!this.session; }
  get role() { return this.session?.role; }

  async start(kind, { code = '', user, track = null } = {}) {
    if (this.disposed || this.active || this.request) return;
    code = cleanPartyCode(code);
    if (kind === 'join' && !validPartyCode(code)) { this.onState({ type: 'invalid-code' }); return; }
    const generation = ++this.generation;
    const controller = new AbortController();
    this.request = controller;
    this.status = 'connecting';
    this.onState({ type: 'request' });
    const timer = this.later(() => controller.abort(), 12000);
    try {
      const response = await this.fetcher(PARTY_ENDPOINT + (kind === 'create' ? '/v1/rooms' : `/v1/rooms/${code}/join`), {
        method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: { name: String(user?.username || '').slice(0, 64), avatarUrl: partyImageURL(user?.avatarUrl) },
          ...(kind === 'create' ? { track: sharedPartyTrack(track) } : {}) }),
      });
      const data = await response.json();
      if (generation !== this.generation || this.disposed) return;
      if (controller.signal.aborted) throw new Error('connection_failed');
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'connection_failed');
      if (data.protocol !== 1 || !validPartyCode(data.code) || kind === 'join' && data.code !== code
        || !/^[a-f0-9]{64}$/.test(data.token) || !/^[a-f0-9]{24}$/.test(data.memberId)
        || data.role !== (kind === 'create' ? 'host' : 'guest')) throw new Error('protocol_error');
      this.session = { code: data.code, token: data.token, memberId: data.memberId, role: data.role };
      this.onActive(data.role);
      this.onState({ type: 'session', code: data.code, memberId: data.memberId, role: data.role });
      this.connect();
    } catch (error) {
      if (generation !== this.generation || this.disposed) return;
      const code = controller.signal.aborted ? 'connection_failed' : error.message;
      if (this.active) this.finish(code);
      else { this.status = 'idle'; this.onState({ type: 'failed', error: code }); }
    } finally {
      this.cancel(timer);
      if (this.request === controller) this.request = null;
    }
  }

  connect() {
    if (!this.active || this.disposed) return;
    const generation = this.generation;
    const current = () => (!this.disposed || this.status === 'leaving')
      && generation === this.generation && this.socket === socket;
    let socket;
    try {
      socket = new this.Socket(PARTY_ENDPOINT.replace('https:', 'wss:') + `/v1/rooms/${this.session.code}/socket`,
        [PARTY_PROTOCOL, `token.${this.session.token}`]);
    } catch { this.finish('connection_failed'); return; }
    this.socket = socket;
    const timeout = this.later(() => {
      if (current()) this.disconnected(socket);
    }, 10000);
    this.connectTimeout = timeout;
    socket.onopen = () => {
      if (!current()) return;
      this.lastMessage = this.now();
      this.pings = new Map();
      this.lastPing = 0;
      this.lastPublished = null;
      this.tickTimer ??= this.every(() => this.tick(), 1000);
      this.ping();
      // Keep the timeout until the server sends its first authenticated room snapshot.
    };
    socket.onmessage = event => {
      if (!current()) return;
      let data;
      try {
        if (typeof event.data !== 'string' || event.data.length > 16384) throw new Error('protocol_error');
        data = JSON.parse(event.data);
        this.lastMessage = this.now();
        if (data?.type === 'room') {
          if (this.status === 'leaving') return;
          const snapshot = partySnapshot(data, this.session);
          this.session.role = snapshot.you.role;
          if (this.snapshot && snapshot.playback.revision < this.snapshot.playback.revision) return;
          if (this.bestRTT === Infinity) this.offset = snapshot.serverTime - this.now();
          // Hosts own selection: a delayed acknowledgement must not cancel
          // a newer local load or clear an error reported after selection.
          if (this.role === 'guest' && snapshot.track?.id !== this.snapshot?.track?.id) {
            this.cancelLoad();
            this.followError = '';
            this.onState({ type: 'playback-error', error: '' });
          }
          this.snapshot = snapshot;
          this.status = 'connected';
          this.reconnectAt = null;
          this.attempt = 0;
          this.cancel(timeout);
          this.onState({ ...snapshot, type: 'snapshot' });
          this.sync();
        } else if (data?.type === 'pong') {
          const sent = this.pings?.get(data.nonce);
          if (sent != null && finite(data.serverTime)) {
            const rtt = this.now() - sent;
            if (rtt >= 0 && rtt < this.bestRTT) {
              this.bestRTT = rtt;
              this.offset = data.serverTime - (sent + this.now()) / 2;
            }
            this.pings.delete(data.nonce);
          }
        } else if (data?.type === 'closed') {
          if (this.status === 'leaving') this.finish('', { keepHostPlaying: true });
          else this.finish(['host_left', 'expired'].includes(data.reason) ? data.reason : 'connection_failed');
        }
        else if (data?.type === 'error') this.onState({ type: 'playback-error', error: data.error || 'connection_failed' });
        else throw new Error('protocol_error');
      } catch { this.finish('protocol_error'); }
    };
    socket.onerror = () => {
      if (!current()) return;
      if (this.status === 'leaving') this.finish('leave_unconfirmed', { keepHostPlaying: true });
      else this.disconnected(socket);
    };
    socket.onclose = event => {
      if (!current()) return;
      if (this.status === 'leaving') this.finish(event.code === 1000 ? '' : 'leave_unconfirmed', { keepHostPlaying: true });
      else if (event.code === 4001) this.finish('replaced');
      else this.disconnected(socket);
    };
  }

  disconnected(socket) {
    if (socket !== this.socket || !this.active) return;
    this.retireSocket();
    this.cancelLoad();
    this.pause();
    this.status = 'reconnecting';
    this.onState({ type: 'connection', value: 'reconnecting' });
    this.reconnectAt ??= this.now();
    if (this.now() - this.reconnectAt >= 45000) { this.finish('connection_failed'); return; }
    const delay = Math.min(8000, 500 * 2 ** (this.attempt || 0));
    this.attempt = (this.attempt || 0) + 1;
    this.reconnectTimer = this.later(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }
  retireSocket() {
    this.cancel(this.connectTimeout);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try { socket.close(1000, 'disconnect'); } catch { /* handshake may still be pending */ }
    }
  }
  send(value) {
    if (this.socket?.readyState !== 1) return false;
    try { this.socket.send(JSON.stringify(value)); return true; }
    catch {
      if (this.status === 'leaving') this.finish('leave_unconfirmed', { keepHostPlaying: true });
      else this.disconnected(this.socket);
      return false;
    }
  }
  ping() {
    const nonce = String(this.now()) + ':' + String(this.pingNumber = (this.pingNumber || 0) + 1);
    this.pings?.set(nonce, this.now());
    this.lastPing = this.now();
    this.send({ type: 'ping', nonce });
  }
  tick() {
    if (this.status === 'leaving' || !this.active || this.socket?.readyState !== 1) return;
    if (this.now() - this.lastMessage > 30000) { this.disconnected(this.socket); return; }
    if (this.now() - this.lastPing >= 10000) this.ping();
    this.sync();
  }
  sync() {
    if (this.status !== 'connected' || !this.active) return;
    if (this.role === 'host') this.publish();
    else this.follow();
  }
  publish() {
    const { track, audio, switching } = this.getPlayer();
    if (switching || this.load) return;
    const shared = sharedPartyTrack(track);
    if (!shared || !audio) return;
    const key = JSON.stringify(shared);
    const playing = !audio.paused && !audio.ended && !audio.seeking && !audio.__sewRpcWaiting && audio.readyState >= 2;
    const position = Math.min(shared.duration, Math.max(0, Number(audio.currentTime) || 0));
    const last = this.lastPublished;
    const trackChanged = !last || last.key !== key;
    if (!trackChanged) {
      const predicted = last.position + (last.playing ? (this.now() - last.at) / 1000 : 0);
      if (playing === last.playing && Math.abs(position - predicted) < 0.35
        && (!playing || this.now() - last.at < 2000)) return;
      // Pointer seeks and decoder events can arrive far faster than the server's
      // message budget. Flush the latest position, not every intermediate one.
      const elapsed = this.now() - last.at;
      if (elapsed < 150) {
        this.publishTimer ??= this.later(() => { this.publishTimer = null; this.sync(); }, 150 - elapsed);
        return;
      }
    }
    // Set before send: a test/server may answer synchronously with our own snapshot.
    this.lastPublished = { key, playing, position, at: this.now() };
    if (trackChanged && !this.send({ type: 'track', track: shared })) return;
    this.send({ type: 'playback', playing, position });
  }

  async selectTrack(track) {
    if (this.role !== 'host' || this.status !== 'connected') return;
    const shared = sharedPartyTrack(track);
    if (!shared) { this.onState({ type: 'playback-error', error: 'soundcloud_only' }); return; }
    this.cancelLoad();
    const load = this.beginLoad(shared.id);
    const generation = this.generation;
    this.load = load;
    this.pause();
    this.followError = '';
    this.onState({ type: 'playback-error', error: '' });
    this.lastPublished = { key: JSON.stringify(shared), playing: false, position: 0, at: this.now() };
    if (!this.send({ type: 'track', track: shared })) { this.cancelLoad(); return; }
    const current = () => this.load === load && generation === this.generation
      && !load.controller.signal.aborted && this.status === 'connected';
    try {
      await this.loadTrack(shared, { signal: load.controller.signal, position: () => 0 });
      if (!current()) return;
      await this.play({ signal: load.controller.signal });
      if (!current()) return;
      this.cancel(load.timer);
      this.load = null;
      this.publish();
    } catch (error) {
      if (!current()) return;
      this.cancel(load.timer);
      this.load = null;
      this.failPlayback(error.message === 'login_required' ? 'login_required' : 'track_unavailable');
    }
  }

  transferHost(memberId) { return this.role === 'host' && this.send({ type: 'transfer-host', memberId }); }
  suggestTrack(track) {
    if (!this.active || this.status !== 'connected') return false;
    const shared = sharedPartyTrack(track);
    if (!shared) { this.onState({ type: 'playback-error', error: 'soundcloud_only' }); return false; }
    return this.send({ type: 'suggest', track: shared });
  }
  removeSuggestion(id) { return this.send({ type: 'suggestion-remove', id }); }

  follow() {
    if (!this.snapshot || this.followError) return;
    const shared = this.snapshot.track;
    if (!shared) {
      this.cancelLoad(); this.pause();
      if (!this.emptyApplied) { this.emptyApplied = true; this.empty(); }
      return;
    }
    this.emptyApplied = false;
    const player = this.getPlayer();
    if (this.load) return; // New revisions for this track are applied after decoding.
    if (this.needsLoad || String(player.track?.id) !== shared.id || player.track?.path || !player.audio?.src || player.switching) {
      const controller = new AbortController();
      const generation = this.generation;
      const load = this.beginLoad(shared.id, controller);
      this.load = load;
      this.pause();
      this.loadTrack(shared, { signal: controller.signal, position: () => this.target() }).then(() => {
        if (this.load !== load || generation !== this.generation || controller.signal.aborted) return;
        this.cancel(load.timer);
        this.load = null;
        this.needsLoad = false;
        this.applyPlayback(true);
      }).catch(error => {
        if (this.load !== load || generation !== this.generation || controller.signal.aborted) return;
        this.cancel(load.timer);
        this.load = null;
        this.failPlayback(error.message === 'login_required' ? 'login_required' : 'track_unavailable');
      });
      return;
    }
    this.applyPlayback(false);
  }
  target() { return partyPosition(this.snapshot, this.now() + this.offset); }
  applyPlayback(force) {
    if (this.followError || this.role !== 'guest' || this.status !== 'connected' || !this.snapshot?.track) return;
    const audio = this.getPlayer().audio;
    if (!audio) return;
    const target = this.target();
    const playing = this.snapshot.playback.playing && target < this.snapshot.track.duration;
    const difference = Math.abs((Number(audio.currentTime) || 0) - target);
    if (force || difference > (playing ? 0.65 : 0.05)) {
      try { this.seek(target); } catch { this.failPlayback('track_unavailable'); return; }
    }
    if (!playing) { this.pause(); return; }
    if (!audio.paused || this.playPending) return;
    const generation = this.generation, snapshotId = this.snapshot.track.id, source = audio.src;
    const pending = this.play();
    this.playPending = pending;
    Promise.resolve(pending).then(() => {
      if (this.getPlayer().audio === audio && audio.src === source && (generation !== this.generation || this.status !== 'connected'
        || this.snapshot?.track?.id !== snapshotId || !this.snapshot?.playback.playing)) this.pause();
    }).catch(() => {
      if (generation === this.generation && this.snapshot?.track?.id === snapshotId && this.status === 'connected') this.failPlayback('playback_blocked');
    }).finally(() => { if (this.playPending === pending) this.playPending = null; });
  }
  failPlayback(error) {
    this.cancelLoad();
    this.followError = error;
    if (error === 'track_unavailable' || error === 'login_required') this.needsLoad = true;
    this.pause();
    this.onState({ type: 'playback-error', error });
  }
  retry() {
    this.followError = '';
    this.onState({ type: 'playback-error', error: '' });
    if (this.role === 'host' && this.snapshot?.track) { this.selectTrack(this.snapshot.track); return; }
    this.sync();
  }
  beginLoad(id, controller = new AbortController()) {
    const load = { controller, id };
    load.timer = this.later(() => {
      if (this.load !== load) return;
      this.cancelLoad();
      this.failPlayback('track_unavailable');
    }, 25000);
    return load;
  }
  cancelLoad() {
    if (this.load) { this.cancel(this.load.timer); this.load.controller.abort(); this.needsLoad = true; }
    this.load = null;
  }
  finish(reason = '', { keepHostPlaying = false } = {}) {
    const role = this.role;
    ++this.generation;
    this.request?.abort();
    this.request = null;
    this.cancelLoad();
    this.cancel(this.reconnectTimer);
    this.reconnectTimer = null;
    this.cancel(this.publishTimer);
    this.publishTimer = null;
    this.cancel(this.leaveTimer);
    this.leaveTimer = null;
    this.stop(this.tickTimer);
    this.tickTimer = null;
    this.retireSocket();
    if (role && !(keepHostPlaying && role === 'host')) this.pause();
    this.session = this.snapshot = this.lastPublished = null;
    this.status = 'idle';
    this.followError = '';
    this.playPending = null;
    this.emptyApplied = false;
    this.needsLoad = false;
    this.offset = 0; this.bestRTT = Infinity;
    this.reconnectAt = null; this.attempt = 0;
    if (!this.disposed) this.onState({ type: 'closed', reason });
  }
  leave() {
    if (this.status === 'leaving') return;
    if (!this.active || this.socket?.readyState !== 1) { this.finish('', { keepHostPlaying: true }); return; }
    this.cancelLoad();
    this.status = 'leaving';
    if (this.role === 'guest') this.pause();
    if (!this.disposed) this.onState({ type: 'connection', value: 'leaving' });
    // Closing immediately after send can discard the final frame in WebView /
    // intermediaries. Keep the transport alive for the server's close ack.
    this.leaveTimer = this.later(() => this.finish('leave_unconfirmed', { keepHostPlaying: true }), 2500);
    this.send({ type: 'leave' });
  }
  dispose() { this.disposed = true; this.leave(); }
}
