export const HISTORY_LIMIT = 200;
export const HISTORY_LISTEN_SECONDS = 5;

const text = (value, limit = 240) => typeof value === 'string' ? value.trim().slice(0, limit) : '';

function trackId(track) {
  const value = String(track?.id ?? '').match(/^[1-9]\d*$/)?.[0]
    || String(track?.urn ?? '').match(/^soundcloud:tracks:([1-9]\d*)$/)?.[1];
  return value && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

export function historyTrackKey(track, source = track?.path ? 'local' : 'sc') {
  if (source === 'local') {
    const path = text(track?.path, 4096);
    return path ? `local:${path.toLowerCase()}` : null;
  }
  const id = source === 'sc' ? trackId(track) : null;
  return id ? `sc:${id}` : null;
}

export function historyArtwork(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) return null;
    const url = new URL(value);
    const asset = url.hostname === 'asset.localhost' && !url.port
      && (url.protocol === 'http:' || url.protocol === 'https:');
    const nativeAsset = url.protocol === 'asset:' && url.hostname === 'localhost' && !url.port;
    if ((url.protocol !== 'https:' && !asset && !nativeAsset) || url.username || url.password) return null;
    url.search = url.hash = '';
    return url.href;
  } catch { return null; }
}

export function historyEntry(track, source, playedAt = Date.now()) {
  if (source !== 'local' && source !== 'sc') return null;
  const key = historyTrackKey(track, source);
  if (!key || !Number.isFinite(playedAt) || playedAt <= 0 || playedAt > 8640000000000000) return null;
  playedAt = Math.floor(playedAt);
  if (!playedAt) return null;
  // Only small metadata snapshots go into settings: no auth, signed streams,
  // blob/data artwork or playback state. Local covers come from the library.
  const snapshot = {
    id: source === 'sc' ? trackId(track) : text(String(track.id ?? ''), 120),
    title: text(track.title), artist: text(track.artist),
    duration: Number.isFinite(Number(track.duration)) ? Math.min(86400, Math.max(0, Number(track.duration))) : 0,
    coverUrl: historyArtwork(track.coverUrl),
    ...(source === 'local' ? { path: text(track.path, 4096) } : {}),
  };
  return { id: `${playedAt}:${key}`, key, source, playedAt, track: snapshot };
}

export function cleanListeningHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw.slice(0, HISTORY_LIMIT * 4)
    .map(entry => entry && Number.isFinite(entry.playedAt) ? historyEntry(entry.track, entry.source, entry.playedAt) : null)
    .filter(entry => {
      if (!entry || seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .sort((a, b) => b.playedAt - a.playedAt)
    .slice(0, HISTORY_LIMIT);
}

export function addListeningHistory(raw, entry) {
  return cleanListeningHistory([entry, ...(Array.isArray(raw) ? raw : [])]);
}

export function historyDay(timestamp) {
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function groupListeningHistory(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const day = historyDay(entry.playedAt);
    if (!groups.has(day)) groups.set(day, { day, timestamp: entry.playedAt, entries: [] });
    groups.get(day).entries.push(entry);
  }
  return [...groups.values()];
}

/* Decoder movement is proof of playback. Selection, pause, loading, buffering
   and seeking cannot create a listen. The observer never controls the audio. */
export class ListeningRecorder {
  previous = null;

  sample({ track, source, audio, playing, switching, clock = performance.now(), playedAt = Date.now() }) {
    const key = historyTrackKey(track, source);
    const position = Number(audio?.currentTime);
    if (!key || !audio || !Number.isFinite(position) || !Number.isFinite(clock)) {
      this.previous = null;
      return null;
    }
    const src = audio.src || audio.currentSrc || '';
    const speed = Number(audio.playbackRate);
    const rate = Number.isFinite(speed) && speed > 0 ? speed : 1;
    const advancing = !!src && !!playing && !switching && !audio.paused && !audio.ended
      && !audio.seeking && audio.readyState >= 2 && !audio.__sewRpcWaiting;
    const previous = this.previous;
    const changed = !previous || previous.key !== key || previous.audio !== audio || previous.src !== src;
    const restarted = previous?.recorded && position < 1 && position < previous.position - 0.05;
    const state = changed || restarted ? { key, audio, src, seconds: 0, recorded: false } : previous;
    if (!changed && !restarted && advancing && previous.advancing) {
      const wall = Math.max(0, (clock - previous.clock) / 1000);
      const media = position - previous.position;
      // Discontinuous jumps are seeks, even without a seeking event.
      if (media > 0 && media <= (wall + 0.3) * rate + 0.5) state.seconds += Math.min(media / rate, wall);
    }
    Object.assign(state, { position, clock, advancing });
    this.previous = state;
    const duration = Number(track.duration) || Number(audio.duration) || 0;
    const threshold = duration > 0 ? Math.min(HISTORY_LISTEN_SECONDS, duration / rate / 2) : HISTORY_LISTEN_SECONDS;
    if (state.recorded || state.seconds < threshold) return null;
    const entry = historyEntry(track, source, playedAt);
    if (entry) state.recorded = true;
    return entry;
  }
}
