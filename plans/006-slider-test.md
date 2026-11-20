# 006 — restore slider regression coverage

- Status: DONE (all four behavioral tests restored)
- Commit: 00512b8
- Severity: MEDIUM
- Category: verification
- Estimated scope: tools/slider.test.mjs

## Problem
C:/seWer-tauri/tools/slider.test.mjs:27–29 currently extracts useRail using an obsolete comment:
```js
const begin = app.indexOf('function useRail(');
const end = app.indexOf('/* вертикальный фейдер', begin);
assert.ok(begin >= 0 && end > begin);
```
comment is absent; file aborts before all four tests. diagnostic replacing boundary in memory with function EqFader passes all four.

## Target
extract only useRail using `app.indexOf('function EqFader(', begin)` or a more robust bounded helper extraction; retain validation and every behavioral assertion. no changes to slider implementation merely to satisfy the test.

## Repo conventions to follow
existing tests use node:test and VM harness, no browser required.

## Steps
1. replace stale boundary with actual component marker and assert isolated function ends correctly.
2. retain continuous drag, frame-batching, last-value commit, keyboard accumulation and reset tests.

## Boundaries
never delete/skip assertions. no source choreography changes, app launch or dependencies.

## Verification
node --test tools/slider.test.mjs must pass all four tests normally, not only in-memory diagnostics; node --test tools/*.test.mjs must pass.
