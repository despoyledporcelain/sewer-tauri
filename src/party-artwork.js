import { partyImageURL } from './listening-party.js';

// Keep the CDN URL when the library replaces display artwork with a local asset.
// Only the public CDN URL can be shared; each listener has a separate cache.
export function withScArtwork(track, coverUrl) {
  return { ...track, remoteCoverUrl: partyImageURL(track.remoteCoverUrl) || partyImageURL(track.coverUrl), coverUrl };
}

export async function resolvePartyArtwork(track, { api, cancelled = () => false }) {
  if (!api || cancelled()) return null;
  const id = Number(track.id);
  const remote = partyImageURL(track.remoteCoverUrl) || partyImageURL(track.coverUrl);
  try {
    const cached = await api.scCheckCovers?.([id]);
    if (cancelled()) return null;
    if (cached?.[id]) return cached[id];
  } catch {}
  if (!remote || cancelled()) return null;
  try {
    const local = await api.scCacheCover?.(id, remote);
    if (cancelled()) return null;
    return local || remote;
  } catch { return cancelled() ? null : remote; }
}
