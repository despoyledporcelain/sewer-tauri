# 003 — make the existing track-change pulse work

- Status: DONE (implemented and reviewed; manual feel-check pending)
- Commit: 00512b8
- Severity: MEDIUM
- Category: interruptibility
- Estimated scope: src/app.jsx, a small motion helper and tests if needed

## Problem
`C:/seWer-tauri/src/app.jsx:3687` increments trackPulse, but `3711–3712` uses:
```jsx
animate={trackPulse > 0 ? { scale: [1, 0.9, 1] } : {}}
transition={{ type:'spring', stiffness: 380, damping: 26, mass: 0.6 }}
```
installed framer-motion 11.18.2 spring uses only endpoints (1→1); equal arrays do not restart on later track changes.

## Target
an actual repeatable, subtle feedback pulse on track identity changes, not initial mount. use an isolated visual layer so press and track feedback do not fight over one transform. permitted target: scale 1→0.97→1 over 160ms, cubic-bezier(0.23,1,0.32,1), with at most two phases. use WAAPI or a tested explicit motion sequence, not spring over three numeric keyframes. rapid changes restart from visible geometry and cancel old work; remove inline transform on finish/cancel. reduced motion uses a short opacity-only acknowledgment or no additional pulse when existing cover feedback suffices.

## Repo conventions to follow
preserve PlayBtn crossfade images, play-ring keys and actual shared transport handler. WAAPI ownership/cleanup exemplars: src/party-player-motion.js:18–47. prefer transform strings on this installed Motion version.

## Steps
1. remove the broken counter/animate target implementation.
2. isolate pulse from press state, preserve focus/button semantics and disabled handling.
3. add tests for initial mount, successive tracks, rapid cancellation, reduced preference, unmount and no interference with shared playback callbacks.

## Boundaries
never key/remount the actual transport button, audio element or player to restart animation. no new dependencies, app launch or commits. do not alter normal play/pause choreography or magnetic spring values.

## Verification
node --test tools/*.test.mjs; npm run build. user feel-check: several next/previous presses, track changes without pointer pressing play, and switching during a press; each settled pulse must be visible but quiet. inspect at slow speed and with reduced motion.
