import { useSyncExternalStore } from 'react';
import { reducedMotionNow, subscribeReducedMotion } from './motion-preference.js';

// Motion 11's hook snapshots the preference at mount. Subscribe explicitly so
// CSS, WAAPI, GSAP and existing FLIP owners also react to OS changes.
export function useReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, reducedMotionNow, () => false);
}
