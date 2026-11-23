import { useEffect, useState } from 'react';

const paths = new Map();
const BAR_COUNT = 120;

export function makeSoundCloudWaveformPath(samples) {
  if (!samples?.length) return null;
  const bars = Math.min(BAR_COUNT, samples.length);
  const spacing = 576 / bars;
  const levels = Array.from({ length: bars }, (_, index) => {
    const start = Math.floor(index * samples.length / bars);
    const end = Math.floor((index + 1) * samples.length / bars);
    let energy = 0;
    for (let sample = start; sample < end; sample++) energy += samples[sample] ** 2;
    return Math.sqrt(energy / (end - start));
  });

  // Use the loud body of the track for contrast so a quiet intro or outro
  // doesn't flatten the differences between louder sections.
  const sorted = [...levels].sort((a, b) => a - b);
  const loud = sorted[Math.floor((bars - 1) * 0.95)];
  const body = sorted.filter(level => level >= loud * 0.5);
  const lower = body[Math.floor((body.length - 1) * 0.25)];
  const span = Math.max(14, loud - lower);

  return levels.map((level, index) => {
    const detail = Math.max(0, Math.min(1, 1 - (loud - level) / span));
    const x = ((index + 0.5) * spacing).toFixed(2);
    const half = 1 + level / 255 * (4.7 + 5.3 * detail);
    return `M${x} ${(12 - half).toFixed(2)}V${(12 + half).toFixed(2)}`;
  }).join('');
}

export function useSoundCloudWaveform(track, auth, visible) {
  const id = track?.id;
  const url = track?.waveformUrl;
  const token = auth?.token;
  const clientId = auth?.clientId;
  const key = url || (id == null ? null : `track:${id}`);
  const [wave, setWave] = useState(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!visible || !key || !api?.scWaveform) return;
    const cached = paths.get(key);
    if (cached) {
      setWave({ key, path: cached });
      return;
    }
    let pending = true;
    async function load() {
      let source = url;
      // Older cached tracks do not contain the waveform URL.
      if (!source && token && /^\d+$/.test(String(id)) && api.scFetch) {
        const response = await api.scFetch(`https://api-v2.soundcloud.com/tracks/${id}`, token, clientId);
        source = response?.data?.waveform_url;
      }
      if (!pending || typeof source !== 'string') return;
      const path = makeSoundCloudWaveformPath(await api.scWaveform(source));
      if (!pending || !path) return;
      paths.set(key, path);
      if (paths.size > 24) paths.delete(paths.keys().next().value);
      setWave({ key, path });
    }
    load().catch(() => {});
    return () => { pending = false; };
  }, [visible, key, id, url, token, clientId]);

  return wave?.key === key ? wave.path : paths.get(key) || null;
}
