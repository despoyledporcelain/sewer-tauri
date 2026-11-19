const remoteCover = value => {
  if (typeof value !== 'string' || !value.startsWith('https://')) return false;
  try { return new URL(value).hostname !== 'asset.localhost'; } catch { return false; }
};

const usableCover = value => typeof value === 'string' && (
  value.startsWith('https://') || value.startsWith('http://asset.localhost/')
  || value.startsWith('data:image/')
);

export function updateDiscordPlayback(audio, event) {
  const waiting = !!audio.__sewRpcWaiting;
  if (event === 'waiting' || event === 'emptied') audio.__sewRpcWaiting = true;
  if (event === 'playing' || event === 'pause'
    || (event === 'seeked' && audio.readyState >= 2)) audio.__sewRpcWaiting = false;
  if (event === 'timeupdate') {
    // Decoder progress is stronger evidence than a stale waiting flag.
    if (!audio.paused && !audio.ended && !audio.seeking
      && Number.isFinite(audio.__sewRpcTime) && audio.currentTime > audio.__sewRpcTime) {
      audio.__sewRpcWaiting = false;
    }
    audio.__sewRpcTime = audio.currentTime;
    return waiting !== !!audio.__sewRpcWaiting;
  }
  audio.__sewRpcTime = audio.currentTime;
  return true;
}

export function discordSnapshot({ track, originalTrack, audio, settings, playing, switching,
  progress = 0, sampledAt = Date.now() }) {
  if (!track || (!track.title && !track.artist && !track.path)) return null;
  const active = !!audio && !switching;
  const isPlaying = !!(playing && active && audio.readyState >= 2 && !audio.paused
    && !audio.ended && !audio.seeking && !audio.__sewRpcWaiting);
  if (!isPlaying && settings.discordPause === 'hide') return null;
  let coverUrl = null;
  if (settings.discordCover !== false) {
    // UI replaces SoundCloud artwork with asset.localhost. Discord cannot fetch
    // that host: retain the original CDN URL instead of needlessly uploading it.
    if (remoteCover(track.coverUrl)) coverUrl = track.coverUrl;
    else if (remoteCover(originalTrack?.coverUrl)) coverUrl = originalTrack.coverUrl;
    else if (usableCover(track.coverUrl)) coverUrl = track.coverUrl;
  }
  const duration = active && Number.isFinite(audio.duration) && audio.duration > 0
    ? audio.duration : Number(track.duration) || 0;
  const position = active && Number.isFinite(audio.currentTime) && audio.currentTime >= 0
    ? audio.currentTime : switching ? 0 : progress * duration;
  return {
    title: track.title, artist: track.artist, duration, position, progress,
    playbackRate: Number.isFinite(audio?.playbackRate) ? audio.playbackRate : 1,
    sampledAt, coverUrl, coverKey: String(track.id ?? track.path ?? ''),
    isPlaying, timestamp: settings.discordTimestamp || 'progress',
  };
}
