export const PARTY_PLAYER_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const cleanups = new WeakMap();

// Capture the rendered frame before React switches the grid. This also captures
// an interrupted flight, so a quick second click reverses without a jump.
export function snapshotPartyPlayer(root) {
  const elements = new Map([...root.querySelectorAll('[data-party-motion]')].map(element => [element, {
    rect: element.getBoundingClientRect(), kind: element.getAttribute('data-party-motion'),
  }]));
  const sidebar = root.querySelector('.party-sidebar');
  const rect = sidebar?.getBoundingClientRect();
  const opacity = sidebar && root.ownerDocument?.defaultView?.getComputedStyle(sidebar).opacity;
  return { elements, sidebar: rect?.width && rect?.height ? {
    element: sidebar, rect, opacity: opacity == null ? 1 : Number(opacity),
  } : null };
}

export function cancelPartyPlayerMotion(animations) {
  for (const animation of [...animations]) {
    animation.cancel();
    // WAAPI queues the cancel event. Restore pinned room geometry now, before
    // measuring the next grid, not when that old event eventually arrives.
    cleanups.get(animation)?.();
  }
  animations.clear();
}

// FLIP only the cover and its neighbours, never the player engine or individual
// buttons. Layout happens once; every animated frame uses transform/opacity.
export function animatePartyPlayer(snapshot, root, { open, instant, reduced, layoutOnly = false }, animations) {
  cancelPartyPlayerMotion(animations);
  if (!snapshot || instant || reduced) return;

  const play = (element, frames, options, cleanup = () => {}) => {
    if (!element.animate) { cleanup(); return; }
    const animation = element.animate(frames, { easing: PARTY_PLAYER_EASE, ...options });
    animations.add(animation);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      animations.delete(animation);
      cleanups.delete(animation);
      cleanup();
    };
    cleanups.set(animation, release);
    animation.onfinish = animation.oncancel = release;
  };

  // Read all final boxes together before starting compositor animations.
  const after = new Map([...snapshot.elements.keys()].filter(element => root.contains(element))
    .map(element => [element, element.getBoundingClientRect()]));
  for (const [element, rect] of after) {
    const { rect: old, kind } = snapshot.elements.get(element);
    if (!rect.width || !rect.height || !old.width || !old.height) continue;
    const scale = kind === 'art';
    const dx = scale ? old.left - rect.left : old.left + old.width / 2 - rect.left - rect.width / 2;
    const dy = old.top - rect.top;
    const sx = scale ? old.width / rect.width : 1;
    const sy = scale ? old.height / rect.height : 1;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.001 && Math.abs(sy - 1) < 0.001) continue;
    play(element, [
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
      { transform: 'translate(0, 0) scale(1, 1)' },
    ], { duration: open ? 280 : 240 });
  }

  if (layoutOnly) return; // Library alignment must not restart the room's fade.
  const sidebar = root.querySelector('.party-sidebar');
  if (!sidebar?.animate) return;
  if (open && !sidebar.hidden) {
    const rect = sidebar.getBoundingClientRect();
    const previous = snapshot.sidebar;
    const dx = previous ? previous.rect.left - rect.left : -8;
    const dy = previous ? previous.rect.top - rect.top : 0;
    play(sidebar, [
      { opacity: previous?.opacity ?? 0, transform: `translate(${dx}px, ${dy}px)` },
      { opacity: 1, transform: 'translate(0, 0)' },
    ], { duration: 200, delay: previous ? 0 : 40, fill: 'backwards' });
  } else if (snapshot.sidebar && sidebar.hidden) {
    // Retain only the outgoing visual in its old spot. hidden/aria-hidden/inert
    // already remove the closed room from interaction and accessibility.
    const { rect, opacity } = snapshot.sidebar;
    const parent = sidebar.parentElement.getBoundingClientRect();
    const pinned = { display: 'flex', position: 'absolute', left: `${rect.left - parent.left}px`,
      top: `${rect.top - parent.top}px`, width: `${rect.width}px`, height: `${rect.height}px` };
    const previous = Object.fromEntries(Object.keys(pinned).map(key => [key, sidebar.style[key]]));
    Object.assign(sidebar.style, pinned);
    play(sidebar, [
      { opacity, transform: 'translate(0, 0)' },
      { opacity: 0, transform: 'translate(-8px, 0)' },
    ], { duration: 160 }, () => Object.assign(sidebar.style, previous));
  }
}
