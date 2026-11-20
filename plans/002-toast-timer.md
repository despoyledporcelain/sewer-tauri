# 002 — preserve newer notifications

- Status: DONE (implemented and reviewed; manual feel-check pending)
- Commit: 00512b8
- Severity: MEDIUM
- Category: interruptibility
- Estimated scope: src/app.jsx, one regression test

## Problem
`C:/seWer-tauri/src/app.jsx:12669–12676` clears only the lifetime timer:
```jsx
setToast(msg);
setToastExiting(false);
clearTimeout(toastTimerRef.current);
toastTimerRef.current = setTimeout(() => {
  setToastExiting(true);
  setTimeout(() => { setToast(null); setToastExiting(false); }, 240);
}, 2200);
```
new toast during the old 240ms exit is deleted by the old callback.

## Target
own both lifetime and exit cleanup; cancellation/version protects replacement and unmount. retain 2200ms display, 240ms cleanup, normal spring and position. no obsolete cleanup may alter new toast or exiting state.

## Repo conventions to follow
use the same cancellable timer-owner convention as plan 001 where sensible. toast key and AnimatePresence ownership stay stable.

## Steps
1. replace nested untracked timeout with cancellable ownership.
2. cancel on new message and unmount; protect queued obsolete callbacks.
3. add fake-clock tests for replacement before expiry, during exit (2300ms), rapid repeated replacements and unmount.

## Boundaries
no toast library, stacking redesign, audio changes, application launch or commits. no transform on toast ancestors.

## Verification
node --test tools/*.test.mjs; user feel-check: new toast survives old exit; appearance and dismissal remain familiar; reduced-motion variant is covered by plan 004.
