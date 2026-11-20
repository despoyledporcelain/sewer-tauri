import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createNavigationOwner, createToastOwner } from '../src/motion-lifecycle.js';
import { fakeClock } from './motion-harness.mjs';

for (const delay of [240, 300]) test(`settings preserves its ordinary ${delay}ms delay`, () => {
  const clock = fakeClock(), routes = [], nav = createNavigationOwner(value => routes.push(value), clock);
  nav.settings(delay); clock.advance(delay - 1); assert.deepEqual(routes, []);
  clock.advance(1); assert.deepEqual(routes, ['settings']); assert.equal(clock.timers.size, 0);
});

for (const destination of ['search', 'history', 'player', 'home', 'artist', 'playlistEditor', 'playlists']) {
  test(`settings cannot replace a newer direct ${destination} commit, even from a queued callback`, () => {
    const clock = fakeClock(), routes = [], nav = createNavigationOwner(value => routes.push(value), clock);
    nav.settings(240); const stale = clock.queued.at(-1);
    clock.advance(100); nav.commit(destination); stale(); clock.advance(1000);
    assert.deepEqual(routes, [destination]); assert.equal(clock.timers.size, 0);
  });
}

test('same-destination navigation supersedes the first timer and unmount rejects queued work', () => {
  const clock = fakeClock(), routes = [], nav = createNavigationOwner(value => routes.push(value), clock);
  nav.settings(240); const stale = clock.queued.at(-1);
  clock.advance(100); nav.settings(240); stale(); clock.advance(239);
  assert.deepEqual(routes, []); clock.advance(1); assert.deepEqual(routes, ['settings']);
  nav.settings(300); nav.cancel(); clock.queued.at(-1)(); clock.advance(1000);
  assert.deepEqual(routes, ['settings']); assert.equal(clock.timers.size, 0);
});

const app = readFileSync(new URL('../src/app.jsx', import.meta.url), 'utf8');
test('real navigation cancels at entry, retains the unsaved guard and restores same-route visibility', async () => {
  const begin = app.indexOf('  const handleNav = async (id) => {');
  const end = app.indexOf('  handleNavRef.current = handleNav;', begin);
  assert.ok(begin > 0 && end > begin);
  const clock = fakeClock();
  const state = { view: 'home', nav: 'home', home: true, player: false };
  const context = {
    view: 'home', reduced: false, editingPlaylist: null, track: { id: 1 },
    homeScrollRef: { current: null }, plEditorRef: { current: null },
    setNavActive: value => { state.nav = value; },
    setHomeVisible: value => { state.home = value; }, setPlayerVisible: value => { state.player = value; },
    setLibScrollTargetId: () => {}, setLibScrollTrigger: () => {},
    navigationRef: { current: createNavigationOwner(value => { state.view = value; }, clock) },
  };
  context.setView = context.navigationRef.current.commit;
  vm.runInNewContext(`${app.slice(begin, end)}\nglobalThis.nav = handleNav;`, context);
  await context.nav('settings'); assert.equal(state.home, false);
  await context.nav('home'); clock.advance(1000);
  assert.equal(state.view, 'home'); assert.equal(state.nav, 'home'); assert.equal(state.home, true);
  await context.nav('settings'); await context.nav('search'); clock.advance(1000);
  assert.equal(state.view, 'search'); assert.equal(state.nav, 'search');
  context.view = 'player'; await context.nav('settings'); await context.nav('library'); clock.advance(1000);
  assert.equal(state.player, true); assert.equal(state.nav, 'library');
  context.view = 'playlistEditor'; context.editingPlaylist = {};
  let guard = 0; context.plEditorRef.current = { requestClose: () => guard++ };
  await context.nav('search'); assert.equal(guard, 1); assert.equal(state.nav, 'library');
  assert.match(app, /const setView = useCallback\(destination => navigationRef\.current\.commit\(destination\), \[\]\)/);
  assert.match(app, /useEffect\(\(\) => \(\) => navigationRef\.current\.cancel\(\), \[\]\)/);
});

function toastHarness() {
  const clock = fakeClock(), updates = [], state = { message: null, exiting: false };
  const toast = createToastOwner(value => { state.message = value; updates.push(['message', value]); },
    value => { state.exiting = value; updates.push(['exiting', value]); }, clock);
  return { clock, updates, state, toast };
}
test('toast keeps 2200ms display and 240ms cleanup', () => {
  const t = toastHarness(); t.toast.show('first'); t.clock.advance(2199);
  assert.equal(t.state.exiting, false); t.clock.advance(1); assert.equal(t.state.exiting, true);
  t.clock.advance(239); assert.equal(t.state.message, 'first'); t.clock.advance(1);
  assert.deepEqual(t.state, { message: null, exiting: false });
});
for (const at of [1000, 2300]) test(`replacement at ${at}ms survives obsolete lifetime and exit callbacks`, () => {
  const t = toastHarness(); t.toast.show('old'); t.clock.advance(at);
  const obsolete = [...t.clock.queued]; t.toast.show('new');
  const updates = t.updates.length;
  for (const callback of obsolete) callback();
  assert.equal(t.updates.length, updates); t.clock.advance(2199);
  assert.deepEqual(t.state, { message: 'new', exiting: false });
  t.clock.advance(241); assert.deepEqual(t.state, { message: null, exiting: false });
});
test('rapid toast replacement and unmount release both timer stages', () => {
  const t = toastHarness();
  for (let i = 0; i < 20; i++) { t.toast.show(String(i)); t.clock.advance(10); }
  assert.equal(t.clock.timers.size, 1); t.clock.advance(2200); assert.equal(t.clock.timers.size, 1);
  t.toast.cancel(); const count = t.updates.length;
  for (const callback of t.clock.queued) callback();
  assert.equal(t.updates.length, count); assert.equal(t.clock.timers.size, 0);
  assert.match(app, /toastOwnerRef\.current = createToastOwner\(setToast, setToastExiting\)/);
  assert.match(app, /useEffect\(\(\) => \(\) => toastOwnerRef\.current\.cancel\(\), \[\]\)/);
});
