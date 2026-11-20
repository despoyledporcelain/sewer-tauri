export const CROSSFADE_MAX = 12;
export const CROSSFADE_CURVES = ['power', 'smooth', 'linear'];
export const CROSSFADE_PRESETS = [
  { id: 'cut', seconds: 0.5, curve: 'linear', smart: true, intro: 0 },
  { id: 'short', seconds: 2, curve: 'smooth', smart: true, intro: 0 },
  { id: 'radio', seconds: 3, curve: 'linear', smart: true, intro: 1 },
  { id: 'flow', seconds: 5, curve: 'power', smart: true, intro: 0 },
  { id: 'mix', seconds: 8, curve: 'smooth', smart: true, intro: 0 },
  { id: 'dj', seconds: 12, curve: 'power', smart: true, intro: 2 },
];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function crossfadeSettings(settings = {}) {
  return {
    seconds: clamp(number(settings.crossfade, 0), 0, CROSSFADE_MAX),
    curve: CROSSFADE_CURVES.includes(settings.crossfadeCurve) ? settings.crossfadeCurve : 'power',
    smart: settings.crossfadeSmart !== false,
    intro: clamp(number(settings.crossfadeIntro, 0), 0, 10),
  };
}

export function cleanCrossfadeSettings(settings) {
  const config = crossfadeSettings(settings);
  Object.assign(settings, { crossfade: config.seconds, crossfadeCurve: config.curve,
    crossfadeSmart: config.smart, crossfadeIntro: config.intro });
  return settings;
}

export function crossfadeGains(progress, curve = 'power') {
  let t = clamp(number(progress, 0), 0, 1);
  if (t === 0) return { out: 1, in: 0 };
  if (t === 1) return { out: 0, in: 1 };
  if (curve === 'linear') return { out: 1 - t, in: t };
  if (curve === 'smooth') t = t * t * (3 - 2 * t);
  return { out: Math.cos(t * Math.PI / 2), in: Math.sin(t * Math.PI / 2) };
}

// Preview and its electrical overlay share the same sampled geometry.
export function crossfadeCurvePoints(curve) {
  const points = { out: [], in: [] };
  for (let i = 0; i <= 48; i++) {
    const gains = crossfadeGains(i / 48, curve);
    for (const channel of ['out', 'in']) points[channel].push({
      x: 12 + i / 48 * 296, y: 14 + (1 - gains[channel]) * 104,
    });
  }
  return points;
}

export function mixCurvePoints(from, to, progress) {
  const t = clamp(number(progress, 0), 0, 1);
  return Object.fromEntries(['out', 'in'].map(channel => [channel, to[channel].map((point, i) => ({
    x: point.x, y: from[channel][i].y + (point.y - from[channel][i].y) * t,
  }))]));
}

export function crossfadeDuration(config, outgoing, incoming, rate = 1) {
  rate = clamp(number(rate, 1) || 1, 0.1, 8);
  let seconds = config.seconds;
  if (config.smart) {
    const durations = [outgoing, incoming - crossfadeIntroPosition(config.intro, incoming)]
      .filter(value => Number.isFinite(value) && value > 0);
    // At most one quarter of a short track; times are audible, not media seconds.
    for (const duration of durations) seconds = Math.min(seconds, duration / rate / 4);
  }
  return Math.max(0, seconds);
}

export function crossfadeIntroPosition(seconds, duration) {
  const requested = clamp(number(seconds, 0), 0, 10);
  // Never skip most of a short track, even if the saved intro is longer than it.
  return Number.isFinite(duration) && duration > 0 ? Math.min(requested, duration / 4) : requested;
}

export function mediaDuration(audio, track) {
  return Number.isFinite(audio?.duration) && audio.duration > 0
    ? audio.duration : Math.max(0, number(track?.duration, 0));
}

export function rotateDecks(current, standby) {
  if (!current || !standby || current === standby) throw new Error('crossfade requires two different decks');
  return { current: standby, standby: current };
}

// Progress follows decoded audio, not rAF time. Background throttling, pauses
// and buffering cannot complete a transition while the incoming track is silent.
export class CrossfadeEnvelope {
  constructor({ seconds, curve, position = 0 }) {
    this.seconds = Math.max(0, number(seconds, 0));
    this.curve = curve;
    this.position = position;
    this.elapsed = 0;
    this.progress = this.seconds > 0 ? 0 : 1;
  }

  sample(position, rate = 1) {
    if (Number.isFinite(position)) {
      const delta = Math.max(0, position - this.position);
      this.elapsed += delta / clamp(number(rate, 1) || 1, 0.1, 8);
      this.position = position;
    }
    this.progress = this.seconds > 0 ? clamp(this.elapsed / this.seconds, 0, 1) : 1;
    return this.gains();
  }

  gains() { return crossfadeGains(this.progress, this.curve); }
  get done() { return this.progress >= 1; }
}

export function waitForDeck(audio, { position = 0, duration: fallbackDuration = 0,
  bufferSeconds = 1, signal, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let seeked = false;
    let settled = false;
    let timer;
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
    const failed = () => finish(new Error('next track could not be decoded'));
    const aborted = () => finish(new Error('crossfade cancelled'));
    const check = () => {
      if (settled) return;
      if (signal?.aborted) { aborted(); return; }
      if (audio.readyState < 1) return;
      if (!seeked) {
        const duration = mediaDuration(audio, { duration: fallbackDuration });
        const start = crossfadeIntroPosition(position, duration);
        try { if (Math.abs(audio.currentTime - start) > 0.05) audio.currentTime = start; }
        catch { return; }
        seeked = true;
      }
      if (audio.readyState < 2 || audio.seeking) return;
      // A progressive file with HAVE_ENOUGH_DATA can play through. For MSE,
      // require a real buffer at the seek target, not merely a loaded manifest.
      if (audio.readyState >= 4) { finish(); return; }
      const duration = mediaDuration(audio, { duration: fallbackDuration });
      const required = duration > 0 ? Math.min(bufferSeconds, duration - audio.currentTime) : bufferSeconds;
      for (let i = 0; i < (audio.buffered?.length || 0); i++) {
        const at = audio.currentTime;
        if (audio.buffered.start(i) <= at && audio.buffered.end(i) - at >= required - 0.01) { finish(); return; }
      }
    };
    for (const event of events) audio.addEventListener(event, check);
    audio.addEventListener('error', failed);
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => finish(new Error('next track buffering timeout')), timeout);
    check();
  });
}
