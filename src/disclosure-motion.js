export const DISCLOSURE_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

// Read before React changes the layout. Only the branches around disclosures
// participate, not every slider, icon and text node in the settings page.
export function snapshotDisclosures(root) {
  const elements = new Set();
  for (const disclosure of root.querySelectorAll('[data-disclosure]')) {
    if (disclosure.parentElement.closest('[data-disclosure][data-open="false"]')) continue;
    for (let branch = disclosure; branch && branch !== root; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) elements.add(sibling);
    }
  }
  return new Map([...elements].map(element => [element, {
    rect: element.getBoundingClientRect(),
    open: element.getAttribute('data-open'),
    background: element.hasAttribute('data-disclosure-surface')
      ? element.querySelector(':scope > [data-disclosure-background]')?.getBoundingClientRect() : null,
  }]));
}

// FLIP: layout changes once; the visual movement uses transform only. Reading
// the current rendered positions before cancelling also makes rapid reversals
// continue from the visible frame rather than restart from an old endpoint.
export function animateDisclosureLayout(before, root, reduced, animations) {
  for (const animation of animations) animation.cancel();
  animations.clear();
  if (!before || reduced) return;
  const after = new Map();
  for (const element of before.keys()) {
    if (root.contains(element)) after.set(element, element.getBoundingClientRect());
  }
  const opening = [...after.keys()].some(element =>
    before.get(element).open === 'false' && element.getAttribute('data-open') === 'true');
  const options = { duration: opening ? 240 : 180, easing: DISCLOSURE_EASE };
  const play = (element, frames) => {
    if (!element.animate) return;
    const animation = element.animate(frames, options);
    animations.add(animation);
    animation.onfinish = animation.oncancel = () => animations.delete(animation);
  };
  for (const [element, rect] of after) {
    const old = before.get(element).rect;
    let dx = old.left - rect.left, dy = old.top - rect.top;
    // Nested branches inherit their ancestor's translation; subtract it to
    // avoid moving a row twice when its entire card moves too.
    for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) {
      if (!after.has(parent)) continue;
      const previous = before.get(parent).rect, current = after.get(parent);
      dx -= previous.left - current.left;
      dy -= previous.top - current.top;
      break;
    }
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      play(element, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }]);
    }
    const backgroundHeight = before.get(element).background?.height || old.height;
    if (element.hasAttribute('data-disclosure-surface') && backgroundHeight && rect.height
      && Math.abs(backgroundHeight - rect.height) > 0.5) {
      const background = element.querySelector(':scope > [data-disclosure-background]');
      if (background) play(background, [
        { transform: `scaleY(${backgroundHeight / rect.height})` }, { transform: 'scaleY(1)' },
      ]);
    }
  }
}
