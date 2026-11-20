// Timer generations also reject callbacks already queued when cancellation runs.
export function createTimerOwner(clock = globalThis) {
  let generation = 0;
  const timers = new Set();
  const cancel = () => {
    generation++;
    for (const timer of timers) clock.clearTimeout(timer);
    timers.clear();
  };
  return {
    cancel,
    schedule(callback, delay) {
      const version = generation;
      const timer = clock.setTimeout(() => {
        timers.delete(timer);
        if (version === generation) callback();
      }, delay);
      timers.add(timer);
      return timer;
    },
  };
}

export function createNavigationOwner(commit, clock) {
  const timers = createTimerOwner(clock);
  return {
    cancel: timers.cancel,
    commit(destination) { timers.cancel(); commit(destination); },
    settings(delay) {
      timers.cancel();
      timers.schedule(() => commit('settings'), delay);
    },
  };
}

export function createToastOwner(message, exiting, clock) {
  const timers = createTimerOwner(clock);
  return {
    cancel: timers.cancel,
    show(value) {
      timers.cancel();
      message(value);
      exiting(false);
      timers.schedule(() => {
        exiting(true);
        timers.schedule(() => { message(null); exiting(false); }, 240);
      }, 2200);
    },
  };
}

export const FEEDBACK_EASE = 'cubic-bezier(0.23,1,0.32,1)';

// Ownership is local to a purely visual layer, never the transport button.
export function createFeedbackMotion(element, readStyle = el => el.ownerDocument.defaultView.getComputedStyle(el)) {
  let active = null;
  const cancel = () => {
    const previous = active;
    active = null;
    previous?.cancel();
  };
  const play = (frames, duration) => {
    if (!element?.animate) return;
    const animation = element.animate(frames, { duration, easing: FEEDBACK_EASE });
    active = animation;
    animation.onfinish = animation.oncancel = () => {
      if (active !== animation) return;
      active = null;
      // No fill/commitStyles: the underlying geometry is restored automatically.
      animation.cancel();
    };
  };
  return {
    cancel,
    pulse(reduced = false) {
      const from = active ? readStyle(element).transform : 'scale(1)';
      cancel();
      if (reduced) return; // Cover crossfade already acknowledges the new track.
      play([{ transform: from === 'none' ? 'scale(1)' : from },
        { transform: 'scale(0.97)', offset: 0.5 }, { transform: 'scale(1)' }], 160);
    },
    acknowledge(duration, reduced = false) {
      const from = active ? readStyle(element).opacity : 0.45;
      cancel();
      if (reduced) return;
      play([{ opacity: from }, { opacity: 1 }], duration);
    },
  };
}

export function isFineHover(event, media = globalThis.matchMedia) {
  return event?.pointerType === 'mouse' && !!media?.('(hover: hover) and (pointer: fine)')?.matches;
}

export function isSuccessTransition(previous, current) {
  return previous === 'saving' && current === 'saved';
}
