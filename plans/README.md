# motion polish

base commit: 00512b8. implementation authorized by the user. execute in an isolated worktree, review before integration; no application launch, installs, commits, broad resets or deletion of user work.

| plan | severity | status |
| --- | --- | --- |
| 001 navigation timer | high | DONE |
| 002 toast timer | medium | DONE |
| 003 track pulse | medium | DONE |
| 004 reduced motion | medium | DONE |
| 005 local feedback | low | DONE |
| 006 slider test | medium | DONE |
| 007 responsive exits | low | DONE |

order: 006, 001, 002, 003, 004, 005, 007. 003 and 005 share reduced handling with 004; review them together. reuse installed dependencies through a worktree-local node_modules junction if needed; do not download dependencies.

mechanical verification: full existing npm test plus focused new motion tests and npm run build in the isolated worktree. test script must include new regression files. visual and listening verification is performed by the user, never open the application during automated work.

preserve: hero 430ms/140ms and ready handoff in normal mode; disclosures/party FLIP reversibility; lyrics inner/outer transform separation; slider capture/throttling; virtual rows; actual audio/decks; cover-driven theme; mini-player-track quiet hover; stationary selection fills and no layoutId.

## implementation verification

reviewed and transferred 22 source/test files from motion-polish to the main project with matching SHA-256 hashes. no commits, dependency installs or application launches by the agents.

worktree checks: `npm test` passed 212/212 with no failures/skips; `npm run build` succeeded (existing large-chunk warning); `git diff --check` passed. review additionally repaired current-cover failure ownership, coverless-to-image readiness and pre-paint hero exit resets, with regression tests for stale responses and repeated renders.

after transfer, the same three commands also passed in `C:/seWer-tauri`: 212/212 tests, successful frontend build and clean diff whitespace. the Vite build still warns about chunks over 500 kB; native packaging and measured visual performance were not tested.

manual visual/listening checks remain user-owned: repeated track changes; copy/save success and error; pointer/keyboard play-all; fast settings/search navigation; live OS reduced-motion changes during hero, disclosures and room flights; correct progress/slider positions. automated mocks do not establish perceived smoothness or FPS.
