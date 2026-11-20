# 007 — keep small exits responsive

- Status: DONE (implemented and reviewed; manual feel-check pending)
- Commit: 00512b8
- Severity: LOW
- Category: easing
- Estimated scope: src/app.jsx, regression assertions

## Problem
C:/seWer-tauri/src/app.jsx:4060 root menu exit uses duration .14 ease [0.4,0,1,1]; submenu at 4142 uses .12 easeIn; download dialog at 4407 and unsaved modal at 9030 use .13 easeIn; player popovers at 14750/14813 use .14 easeIn. perceived sluggishness is NOT measured, but these are local opportunities for consistent responsive exit.

## Target
keep exact geometry/durations, use ease [0.22,1,0.36,1] (existing MENU_VARIANTS at 3039). preserve deliberate play/pause crossfade at 3702–3704 unchanged: that is a documented separate choreography, not a generic popup exit. no normal hero timing change.

## Repo conventions to follow
module-scope MENU_VARIANTS and Item variants avoid replay on data updates. submenu is a sibling in portal; no backdrop blur. do not replace this structure.

## Steps
1. change only listed generic menu/dialog/popover exit curves to the existing strong ease-out.
2. add a compact assertion guarding intended exits and preserving original variant lifetime/transform origins.

## Boundaries
no entrances/staggers/blur overhaul, no library upgrade or global curve rewrite. no measured performance claims.

## Verification
node --test tools/*.test.mjs; npm run build. user feel-check: dismiss menu/dialog repeatedly, including Escape; exit should leave promptly without new waiting or geometry changes.
