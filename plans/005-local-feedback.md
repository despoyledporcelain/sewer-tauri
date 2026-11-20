# 005 — add four quiet local acknowledgments

- Status: DONE (implemented and reviewed; manual feel-check pending)
- Commit: 00512b8
- Severity: LOW
- Category: missed opportunities
- Estimated scope: src/app.jsx, src/listening-party.jsx, scoped CSS, tests

## Problem
room-copy icon at C:/seWer-tauri/src/listening-party.jsx:148–152 swaps instantly; saved status at app.jsx:8757–8766 is static; artist play-all at 10196–10214 has no press response; Discord dot at 7661–7664 changes immediately.

## Target
1. room copy: icon-only success opacity acknowledgment, 160ms cubic-bezier(0.23,1,0.32,1); fixed 14px slot; label/status immediate and truthful. pointer and keyboard confirmation text must not be delayed. no room/sidebar motion.
2. manually saved playlist: one-time success text opacity acknowledgment, 180ms cubic-bezier(0.23,1,0.32,1), only genuine successful transition to saved (not initial mount/status error). stable status slot where appropriate. no header/list/reorder movement.
3. artist play-all: pointer-only press scale(0.97), 120ms cubic-bezier(0.23,1,0.32,1), instant onClick transport. add real disabled semantics when canPlay=false. keyboard produces no new spatial motion; reduced mode keeps color feedback only. preserve current hover colors and icon.
4. Discord dot: background-color/box-shadow transition 160ms ease; text immediate; no looping pulse. local dot only.

## Repo conventions to follow
use shared --ease-out cubic-bezier(0.23,1,0.32,1) for these new effects (existing literals at app.jsx:3651 match); do not rewrite other intentionally different curves. CSS for press/color, transition/WAAPI for cancellable success feedback. no new animation library.

## Steps
1. implement each isolated seam, never parent transforms. opacity entrance may use @starting-style with safe fallback; repeated fast success feedback must clean up/retarget, not accumulate timers.
2. ship reduced preference and pointer/keyboard handling with it. existing accessible names and live status remain immediate.
3. tests: failed clipboard does not celebrate; real save only; error is not success; disabled play-all cannot invoke callback; keyboard no scale; no parent/layout animation or list stagger; Discord changes no playback settings.

## Boundaries
no new hover on mini-player-track; no page/list entrances or extra graphs; no button icon redesign; no changing RPC connection logic, save transport, clipboard logic or audio.

## Verification
node --test tools/*.test.mjs; npm run build. user feel-check: room copy denied/successful, save success/failure, rapidly repeat success, press and keyboard play-all, reconnect Discord. acknowledgment must be quiet and never block actions.
