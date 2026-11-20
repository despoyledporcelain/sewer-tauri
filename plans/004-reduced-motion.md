# 004 — complete spatial-motion preference handling

- Status: DONE (implemented and reviewed; manual feel-check pending)
- Commit: 00512b8
- Severity: MEDIUM
- Category: accessibility
- Estimated scope: src/app.jsx, src/main.jsx, scoped CSS, motion helpers/tests

## Problem
global MotionConfig is absent (`C:/seWer-tauri/src/main.jsx:7` renders `<App />`). uncovered CSS/WAAPI/GSAP transforms remain in hero, lyrics, transport, settings and app entrances. mini active selector at styles.css:303 outranks reduced rule at 333–335. MagBtn guard only affects magnetic movement, not tap/halo. FxPanel removes transition but retains hover transform.

## Target
normal motion geometry/durations remain unchanged except fixes explicitly covered by plans 003/005. when prefers-reduced-motion changes, spatial/decorative motion cancels or settles immediately, while useful opacity/color feedback and actual position values remain. use MotionConfig reducedMotion="user" for Motion animations plus explicit local useReducedMotion/CSS for non-Motion movement. DO NOT blindly set transform:none on all nodes: many transforms position controls, progress and centered popovers.

## Repo conventions to follow
src/disclosure.jsx and src/party-player-layout.jsx already handle reduced preferences and keyboard instant toggles; preserve these. useSmoothPosition at app.jsx:5314–5321 returns unsmoothed target. scoped selectors and !important are acceptable only for known spatial feedback layers, never positioning ancestors.

## Steps
1. add default Motion preference handling without changing normal mode.
2. cover HeroClone WAAPI (5792–5799), app art entrance GSAP (11454–11467), CSS page translations, lyric wave/highlight, list auto-scroll (smoothScroll at 1301), like/PlayBtn/MagBtn/cover transitions and menus/modals.
3. ensure hero preference path never exposes the old artwork: preserve decode/onReady handoff and lifetime bound; skip the travel, not readiness correctness. active flights must settle/cancel safely when preference changes.
4. cover settings switch thumb movement (6533–6534,7364–7365), selection/theme transforms, navigation indicator, search-field geometry transitions and CSS hover/press feedback (mini/EQ/fx/cards/swatches). preserve final offsets, scaleX progress and slider fractions; reduced mode means no temporal movement, not wrong geometry.
5. gate spatial hover by actual hover/fine-pointer capability (including imperative pointerType where relevant); keep current hover visual in normal fine-pointer mode. reduced motion uses color/opacity/static loading cues, not a blanket removal of all feedback.
6. add focused tests for preference updates/cancellation, reduced pressed mini specificity, switch/slider positions, hero-ready handoff, and normal-mode invariance. do not replace existing disclosures/party FLIP.

## Boundaries
no audio/queue/theme persistence changes, no animations added to virtual rows, no shared layoutId, no transform on fixed-picker ancestors, no new dependencies or app launch. do not refactor working choreography for token uniformity. task must work in Russian and English.

## Verification
node --test tools/*.test.mjs; npm run build. user feel-check: toggle OS preference before and during hero/disclosure/party motion; old artwork must not flash, sliders/progress must still show actual values, and semantic feedback must remain. keyboard navigation remains instant where already defined. actual frame rate/visual feel remain user verification, not a claim from mocks.
