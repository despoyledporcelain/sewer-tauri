import { historyArtwork, historyTrackKey } from './listening-history.js';

function remoteArtwork(value) {
  const cover = historyArtwork(value);
  if (!cover) return null;
  const url = new URL(cover);
  return url.protocol === 'https:' && url.hostname !== 'asset.localhost' ? cover : null;
}

// This only resolves artwork for local history records. It never requests the
// account's listening history or stores authorization in a metadata snapshot.
export async function loadHistoryCovers(entries, { api, auth, onCover, cancelled = () => false }) {
  if (!api || cancelled()) return;
  const tracks = new Map();
  for (const entry of entries) {
    if (entry.source !== 'sc') continue;
    const key = historyTrackKey(entry.track, 'sc');
    if (key && (!tracks.has(key) || !tracks.get(key).coverUrl)) {
      tracks.set(key, { key, id: Number(key.slice(3)), coverUrl: entry.track.coverUrl });
    }
  }
  if (!tracks.size) return;
  let cached = {};
  try { cached = await api.scCheckCovers?.([...tracks.values()].map(track => track.id)) || {}; } catch {}
  if (cancelled()) return;
  const pending = [];
  for (const track of tracks.values()) {
    const cover = historyArtwork(cached[track.id]);
    if (cover) onCover(track.key, cover);
    else pending.push(track);
  }
  let next = 0;
  async function worker() {
    while (!cancelled() && next < pending.length) {
      const track = pending[next++];
      try {
        let remote = remoteArtwork(track.coverUrl);
        // A local asset is not a download URL. If an old snapshot lost its
        // cover, fetch only this track's metadata using the current app login.
        if (!remote) {
          if (!auth?.token || !api.scFetch) continue;
          const result = await api.scFetch(`https://api-v2.soundcloud.com/tracks/${track.id}`, auth.token, auth.clientId);
          if (cancelled()) return;
          if (result?.error || String(result?.data?.id) !== String(track.id)) continue;
          remote = remoteArtwork(result.data.artwork_url?.replace('-large', '-t500x500'));
        }
        if (!remote || cancelled()) continue;
        let cover = null;
        try { cover = historyArtwork(await api.scCacheCover?.(track.id, remote)); } catch {}
        if (!cancelled()) onCover(track.key, cover || remote);
      } catch {} // A missing/deleted track must not block the other covers.
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
}
