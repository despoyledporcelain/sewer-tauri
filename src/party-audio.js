// Unlike crossfade intro skipping, room seeks can target the entire track.
export function waitForPartyAudio(audio, { signal, position, duration, timeout = 15000 }) {
  return new Promise((resolve, reject) => {
    let sought = false, settled = false, timer;
    const events = ['loadedmetadata', 'durationchange', 'canplay', 'progress', 'seeked'];
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const event of events) audio.removeEventListener(event, check);
      audio.removeEventListener('error', failed);
      signal?.removeEventListener('abort', aborted);
      error ? reject(error) : resolve();
    };
    const failed = () => finish(new Error('track_unavailable'));
    const aborted = () => finish(new Error('cancelled'));
    const check = () => {
      if (settled) return;
      if (signal?.aborted) { aborted(); return; }
      if (audio.readyState < 1) return;
      if (!sought) {
        const at = Math.max(0, Math.min(Math.max(0, duration - 0.05), position()));
        try { if (Math.abs(audio.currentTime - at) > 0.05) audio.currentTime = at; } catch { return; }
        sought = true;
      }
      if (audio.readyState < 2 || audio.seeking) return;
      if (audio.readyState >= 4) { finish(); return; }
      for (let i = 0; i < (audio.buffered?.length || 0); i++) {
        if (audio.buffered.start(i) <= audio.currentTime && audio.buffered.end(i) >= audio.currentTime + Math.min(0.2, duration - audio.currentTime)) {
          finish(); return;
        }
      }
    };
    for (const event of events) audio.addEventListener(event, check);
    audio.addEventListener('error', failed);
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(failed, timeout);
    check();
  });
}
