import { useLayoutEffect, useRef } from 'react';
import { useReducedMotion } from './use-motion-preference.js';
import { createFeedbackMotion, isSuccessTransition } from './motion-lifecycle.js';

// Observe state after the DOM update; never delay semantic text or the action.
export function useSuccessFeedback(status, duration) {
  const ref = useRef(null);
  const previous = useRef(status);
  const owner = useRef(null);
  const element = useRef(null);
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    return () => owner.current?.cancel();
  }, []);
  useLayoutEffect(() => {
    if (element.current !== ref.current || !owner.current) {
      owner.current?.cancel();
      element.current = ref.current;
      owner.current = createFeedbackMotion(ref.current);
    }
    if (isSuccessTransition(previous.current, status)) owner.current.acknowledge(duration, reduced);
    else if (reduced || status !== 'saved') owner.current.cancel();
    previous.current = status;
  }, [status, duration, reduced]);
  return ref;
}
