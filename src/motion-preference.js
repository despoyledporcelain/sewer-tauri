export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
export function reducedMotionNow() {
  return !!globalThis.matchMedia?.(REDUCED_MOTION_QUERY)?.matches;
}
export function subscribeReducedMotion(callback, media = globalThis.matchMedia?.(REDUCED_MOTION_QUERY)) {
  if (!media) return () => {};
  if (media.addEventListener) {
    media.addEventListener('change', callback);
    return () => media.removeEventListener('change', callback);
  }
  media.addListener?.(callback);
  return () => media.removeListener?.(callback);
}

// Settle the known cover-only layers; never reset a positioning ancestor.
export function animateHeroFlight(element, clip, from, to, options, reduced = reducedMotionNow(), subscribe = subscribeReducedMotion) {
  const transform = point => `translate3d(${point.x}px, ${point.y}px, 0) scale(${point.scale})`;
  let alive = true, move, morph;
  const settle = () => {
    if (!alive) return;
    element.style.transform = transform(to);
    clip.style.borderRadius = to.br;
    move?.cancel(); morph?.cancel();
  };
  if (reduced || !element.animate || !clip.animate) settle();
  else {
    move = element.animate([{ transform: transform(from) }, { transform: transform(to) }], options);
    morph = clip.animate([{ borderRadius: from.br }, { borderRadius: to.br }], { ...options, duration: options.duration * 0.55 });
  }
  const unsubscribe = subscribe(event => { if (event.matches) settle(); });
  return () => { alive = false; unsubscribe(); move?.cancel(); morph?.cancel(); };
}

export function heroMayReveal(ready, elapsed, limit) {
  return ready || elapsed >= limit;
}
