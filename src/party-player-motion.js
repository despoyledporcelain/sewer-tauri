export const PARTY_PLAYER_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const cleanups = new WeakMap();

// Capture the rendered frame before React switches the grid. This also captures
// an interrupted flight, so a quick second click reverses without a jump.
export function snapshotPartyPlayer(root) {
  const motionElements = [...root.querySelectorAll('[data-party-motion]')]
    .filter(element => element.getAttribute('data-party-motion') !== 'art');
  const elements = new Map(motionElements.map(element => [element, {
    rect: element.getBoundingClientRect(),
  }]));
  const sidebar = root.querySelector('.party-sidebar');
  const rect = sidebar?.getBoundingClientRect();
  const opacity = sidebar && root.ownerDocument?.defaultView?.getComputedStyle(sidebar).opacity;
  const artwork = root.ownerDocument?.querySelector('[data-party-shared-art]');
  const artworkRect = artwork?.getBoundingClientRect();
  return { elements, artwork, artworkRect, sidebar: rect?.width && rect?.height ? {
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

// Measure the slot without transforms, then move the real artwork over it.
export function animatePartyPlayer(snapshot, root, { open, instant, reduced, layoutOnly = false }, animations) {
  cancelPartyPlayerMotion(animations);
  const sharedArt = root.ownerDocument?.querySelector('[data-party-shared-art]');
  const artSlot = root.querySelector('#player-album-art');
  const artRect = artSlot?.getBoundingClientRect();
  if (sharedArt && artRect?.width && artRect.height) {
    Object.assign(sharedArt.style, {
      left: `${artRect.left}px`, top: `${artRect.top}px`,
      width: `${artRect.width}px`, height: `${artRect.height}px`,
    });
  }
  const libraryPanel = root.ownerDocument?.querySelector('[data-player-library-panel]');
  const libraryMoving = libraryPanel?.getAnimations?.().some(animation =>
    animation.transitionProperty === 'width' &&
    (animation.pending || animation.playState === 'running'));
  // The artwork observer already follows the changing slot during a width transition.
  if (!snapshot || instant || reduced || libraryMoving) return;

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
  const oldArt = snapshot.artworkRect;
  if (sharedArt && sharedArt === snapshot.artwork && oldArt?.width && oldArt.height && artRect?.width && artRect.height) {
    const dx = oldArt.left - artRect.left;
    const dy = oldArt.top - artRect.top;
    const scale = oldArt.width / artRect.width;
    if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5 || Math.abs(scale - 1) >= 0.001) {
      play(sharedArt, [
        { translate: `${dx}px ${dy}px`, scale: String(scale) },
        { translate: '0px 0px', scale: '1' },
      ], { duration: open ? 280 : 240, fill:'backwards' });
    }
  }
  for (const [element, rect] of after) {
    const { rect: old } = snapshot.elements.get(element);
    if (!rect.width || !rect.height || !old.width || !old.height) continue;
    const dx = old.left + old.width / 2 - rect.left - rect.width / 2;
    const dy = old.top - rect.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    play(element, [
      { transform: `translate(${dx}px, ${dy}px)` },
      { transform: 'translate(0, 0)' },
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
