import { useEffect, useRef } from 'react';
import { historyTrackKey, ListeningRecorder } from './listening-history.js';

export function useListeningHistory(options) {
  const latest = useRef(options);
  latest.current = options;
  const key = historyTrackKey(options.track, options.source);
  const currentAudio = options.audioRef.current;
  useEffect(() => {
    const audio = latest.current.audioRef.current;
    if (!audio || !key) return;
    const recorder = new ListeningRecorder();
    const sample = () => {
      const current = latest.current;
      // An outgoing or standby crossfade deck must never publish a listen.
      if (current.audioRef.current !== audio) return;
      const entry = recorder.sample({ track: current.track, source: current.source, audio,
        playing: current.playingRef.current, switching: current.switchingRef.current });
      if (entry) current.onListen(entry);
    };
    const events = ['timeupdate', 'pause', 'playing', 'seeking', 'seeked', 'waiting', 'emptied', 'ended'];
    for (const event of events) audio.addEventListener(event, sample);
    sample();
    return () => { for (const event of events) audio.removeEventListener(event, sample); };
  }, [key, currentAudio]);
}
