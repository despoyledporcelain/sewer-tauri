# 001 — cancel stale settings navigation

- Status: DONE (implemented and reviewed; manual feel-check pending)
- Commit: 00512b8
- Severity: HIGH
- Category: interruptibility
- Estimated scope: src/app.jsx, one regression test

## Problem
`C:/seWer-tauri/src/app.jsx:14320` currently schedules an unowned navigation:
```jsx
setTimeout(() => setView('settings'), view === 'home' ? 240 : 300);
```
settings followed by search leaves view=settings and navActive=search. navigation elsewhere also uses direct setView calls.

## Target
latest navigation wins; preserve normal 240ms home and 300ms player delays. cancel pending navigation when another navigation begins (including same-destination clicks), when another route commits, and on unmount. stale callback cannot commit after cancellation.

## Repo conventions to follow
refs and cleanup already own asynchronous work; use a small independently testable timer owner if needed. original view state is `const [view, setView] = useState('home')` at 10411. no dependency installation.

## Steps
1. add tracked cancellation/version protection around delayed settings navigation. cover direct route changes, not only search.
2. keep view/navActive, unsaved-playlist guard, visibility choreography and callbacks intact.
3. add fake-clock regressions: settings→search/history/player, repeated settings, cancellation on unmount, stale callbacks, and ordinary delay.

## Boundaries
do not change audio, queue, RPC, hero durations, or rewrite routing. no application launch or commits. if excerpt differs at initial base, report drift.

## Verification
executor: node --test tools/*.test.mjs and npm run build. all existing tests must pass. user feel-check: rapid route clicks must keep the final destination, unchanged ordinary fades.
