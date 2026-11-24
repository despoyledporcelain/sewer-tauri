import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { reducedMotionNow, subscribeReducedMotion, animateHeroFlight, heroMayReveal } from '../src/motion-preference.js';
import { isFineHover } from '../src/motion-lifecycle.js';
import { sliderFraction } from '../src/slider.js';
import { makeSoundCloudWaveformPath } from '../src/use-soundcloud-waveform.js';
import { hookHarness, animationElement, fakeClock, findNode } from './motion-harness.mjs';

const app = readFileSync(new URL('../src/app.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const preference = readFileSync(new URL('../src/use-motion-preference.js', import.meta.url), 'utf8');

test('preference subscriptions react live and release modern/legacy listeners, unsupported media is safe', () => {
  const listeners = new Set(), values = [];
  const media = { matches: false, addEventListener: (name, fn) => { assert.equal(name, 'change'); listeners.add(fn); },
    removeEventListener: (name, fn) => listeners.delete(fn) };
  const unsubscribe = subscribeReducedMotion(event => values.push(event.matches), media);
  media.matches = true; for (const fn of listeners) fn(media);
  media.matches = false; for (const fn of listeners) fn(media);
  assert.deepEqual(values, [true, false]); unsubscribe(); assert.equal(listeners.size, 0);
  const legacy = { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) };
  subscribeReducedMotion(() => {}, legacy)(); assert.equal(listeners.size, 0);
  assert.doesNotThrow(() => subscribeReducedMotion(() => {}, null)());
  assert.doesNotThrow(() => subscribeReducedMotion(() => {}, {})());
  assert.match(preference, /useSyncExternalStore\(subscribeReducedMotion, reducedMotionNow, \(\) => false\)/);
  assert.equal(reducedMotionNow(), false);
});

test('imperative hover requires a real fine mouse and transport hover uses gated CSS', () => {
  const fine = () => ({ matches: true }), coarse = () => ({ matches: false });
  assert.equal(isFineHover({ pointerType: 'mouse' }, fine), true);
  assert.equal(isFineHover({ pointerType: 'mouse' }, coarse), false);
  assert.equal(isFineHover({ pointerType: 'touch' }, fine), false);
  assert.equal(isFineHover({ pointerType: 'pen' }, fine), false);
  assert.equal(isFineHover({}, fine), false);
  const transport = app.slice(app.indexOf('function TransportButton('), app.indexOf('function PlayBtn('));
  assert.doesNotMatch(transport, /onPointerMove|useSpring/);
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\) \{\s*\.player-transport-button:where\(:enabled:hover\)/);
  assert.match(css, /\.player-transport-button\[data-reduced-motion="true"\] \.player-transport-icon \{\s*transform:none/);
});

test('the actual preference hook observes live snapshots and releases its subscription', () => {
  const listeners = new Set(), media = { matches: false,
    addEventListener: (name, fn) => listeners.add(fn), removeEventListener: (name, fn) => listeners.delete(fn) };
  const api = { reducedMotionNow: () => media.matches, subscribeReducedMotion: fn => subscribeReducedMotion(fn, media) };
  const harness = hookHarness(preference, { './motion-preference.js': api });
  let updates = 0;
  harness.react.useSyncExternalStore = (subscribe, snapshot, server) => {
    assert.equal(server(), false);
    harness.react.useEffect(() => subscribe(() => updates++), [subscribe]);
    return snapshot();
  };
  assert.equal(harness.render(harness.exports.useReducedMotion), false);
  media.matches = true; for (const fn of listeners) fn(media);
  assert.equal(harness.render(harness.exports.useReducedMotion), true);
  media.matches = false; for (const fn of listeners) fn(media);
  assert.equal(harness.render(harness.exports.useReducedMotion), false);
  assert.equal(updates, 2); assert.equal(listeners.size, 1);
  harness.unmount(); assert.equal(listeners.size, 0);
});

const from = { x: -260, y: 80, scale: 0.35, br: '8px' };
const to = { x: 0, y: 0, scale: 1, br: '16px' };
const options = { duration: 430, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', fill: 'forwards' };
test('normal hero retains exact 430ms travel, separate 55% morph and original final geometry', () => {
  const el = animationElement(), clip = animationElement();
  const cleanup = animateHeroFlight(el, clip, from, to, options, false, () => () => {});
  assert.deepEqual(el.calls[0].options, options);
  assert.deepEqual(el.calls[0].frames, [{ transform: 'translate3d(-260px, 80px, 0) scale(0.35)' }, { transform: 'translate3d(0px, 0px, 0) scale(1)' }]);
  assert.equal(clip.calls[0].options.duration, 236.50000000000003);
  assert.deepEqual(el.style, {}); cleanup(); assert.equal(el.calls[0].cancelled, true); assert.equal(clip.calls[0].cancelled, true);
});
test('reduced hero skips travel, preference changes settle an active flight and cannot replay it', () => {
  const el = animationElement(), clip = animationElement();
  let listener, removed = false;
  const cleanup = animateHeroFlight(el, clip, from, to, options, false, fn => { listener = fn; return () => { removed = true; }; });
  listener({ matches: true }); assert.equal(el.calls[0].cancelled, true); assert.equal(clip.calls[0].cancelled, true);
  assert.equal(el.style.transform, 'translate3d(0px, 0px, 0) scale(1)'); assert.equal(clip.style.borderRadius, '16px');
  listener({ matches: false }); assert.equal(el.calls.length, 1); cleanup(); assert.equal(removed, true);
  const still = animationElement(), round = animationElement();
  animateHeroFlight(still, round, from, to, options, true, () => () => {});
  assert.equal(still.calls.length, 0); assert.equal(round.calls.length, 0); assert.equal(still.style.transform, el.style.transform);
  const reverse = animationElement(), reverseClip = animationElement();
  animateHeroFlight(reverse, reverseClip, to, from, options, true, () => () => {});
  assert.equal(reverse.style.transform, 'translate3d(-260px, 80px, 0) scale(0.35)');
  assert.doesNotThrow(() => animateHeroFlight({ style: {} }, { style: {} }, from, to, options, false, () => () => {})());
});

test('actual HeroClone retargets replaced heroes, and retired preference callbacks cannot mutate the new flight', () => {
  const begin = app.indexOf('function HeroClone('), end = app.indexOf('/* ── TopBar', begin);
  assert.ok(begin > 0 && end > begin);
  const listeners = [];
  const harness = hookHarness(`${app.slice(begin, end)}\nexport { HeroClone };`, {}, {
    HERO_DUR_MS: 430, HERO_FADE_MS: 140, HERO_EASE: options.easing,
    createPortal: node => node, document: { body: {} }, CoverTint: 'tint',
    animateHeroFlight: (el, clip, from, to, opts) => animateHeroFlight(el, clip, from, to, opts, false,
      fn => { listeners.push(fn); return () => {}; }),
  });
  const hero = { targetRect: { left: 200, top: 100, size: 400 }, startRect: { left: 10, top: 10, width: 100, height: 100 }, track: {} };
  const props = { hero, exiting: false };
  let tree = harness.render(harness.exports.HeroClone, props); const element = tree.ref.current;
  const first = element.calls[0]; assert.equal(first.options.duration, 430);
  props.hero = { ...hero, startRect: { ...hero.startRect, left: 50 } };
  tree = harness.render(harness.exports.HeroClone, props);
  assert.equal(first.cancelled, true); assert.equal(element.calls.length, 2);
  assert.notEqual(element.calls[0].frames[0].transform, element.calls[1].frames[0].transform);
  listeners[0]({ matches: true }); assert.deepEqual(element.style, {}); assert.equal(element.calls[1].cancelled, false);
  listeners[1]({ matches: true }); assert.equal(element.calls[1].cancelled, true);
  assert.equal(element.style.transform, 'translate3d(0px, 0px, 0) scale(1)');
  harness.unmount();
});

function handoffHarness(reduced) {
  const begin = app.indexOf('  // Normal handoff keeps 430ms');
  const end = app.indexOf('  const artEntranceTweenRef', begin);
  assert.ok(begin > 0 && end > begin);
  const clock = fakeClock(), changes = [], ready = { current: false }, listeners = new Set();
  const harness = hookHarness(`export function Setup() { ${app.slice(begin, end)} }`, {}, {
    hero: {}, reduced, HERO_DUR_MS: 430, ART_READY_WAIT_MS: 900, artReadyRef: ready, heroMayReveal,
    reducedMotionNow: () => reduced, subscribeReducedMotion: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    setHeroExiting: value => changes.push(value), performance: { now: () => clock.now },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    requestAnimationFrame: fn => clock.setTimeout(() => fn(clock.now), 16), cancelAnimationFrame: clock.clearTimeout,
  });
  harness.render(harness.exports.Setup);
  return { harness, clock, changes, ready, listeners, preference(value) {
    reduced = value;
    for (const fn of [...listeners]) fn({ matches: value });
  } };
}
test('actual reduced hero handoff waits for decode/draw rather than exposing the previous artwork', () => {
  const t = handoffHarness(true); t.clock.advance(480); assert.deepEqual(t.changes, [false]);
  t.ready.current = true; t.clock.advance(16); assert.deepEqual(t.changes, [false, true]);
  t.harness.unmount(); assert.equal(t.clock.timers.size, 0);
  assert.match(app, /const faded = elapsed >= HERO_FADE_MS \+ 20/);
  assert.match(app, /!artReadyRef\.current && elapsed < ART_READY_WAIT_MS/);
  assert.match(app, /const HERO_FADE_MS\s*= 140/);
});
test('hero readiness is bounded; normal travel is unchanged and switching preference cancels the old timer', () => {
  const reduced = handoffHarness(true); reduced.clock.advance(896); assert.deepEqual(reduced.changes, [false]);
  reduced.clock.advance(16); assert.deepEqual(reduced.changes, [false, true]); reduced.harness.unmount();
  const normal = handoffHarness(false); normal.clock.advance(429); assert.deepEqual(normal.changes, [false]);
  normal.clock.advance(1); assert.deepEqual(normal.changes, [false, true]); normal.harness.unmount();
  const changing = handoffHarness(false); changing.clock.advance(100);
  changing.preference(true); changing.harness.render(changing.harness.exports.Setup);
  changing.clock.advance(400); assert.deepEqual(changing.changes, [false]);
  changing.ready.current = true; changing.clock.advance(16); assert.deepEqual(changing.changes, [false, true]);
  changing.preference(false); changing.harness.render(changing.harness.exports.Setup);
  changing.preference(true); changing.clock.advance(1000);
  assert.deepEqual(changing.changes, [false, true], 'preference updates never restart a fade already in progress');
  changing.harness.unmount(); assert.equal(changing.clock.timers.size, 0);
  assert.equal(changing.listeners.size, 0);
});

test('forward hero cleanup rejects already-queued timers and frames after unmount', () => {
  for (const reduced of [false, true]) {
    const t = handoffHarness(reduced);
    const stale = [...t.clock.queued], preference = [...t.listeners];
    t.harness.unmount(); t.ready.current = true;
    for (const callback of stale) callback();
    for (const callback of preference) callback({ matches: true });
    t.clock.advance(2000);
    assert.deepEqual(t.changes, [false]); assert.equal(t.clock.timers.size, 0);
  }
});

test('hero removal retains the fade/readiness bound and a retired frame cannot clear a replacement hero', () => {
  const normalized = app.replace(/\r\n/g, '\n');
  const start = normalized.indexOf('  useEffect(() => {\n    if (!hero || !heroExiting) return;');
  const stop = normalized.indexOf('  /* gsap грузится лениво', start);
  assert.ok(start > 0 && stop > start);
  const setup = ready => {
    const clock = fakeClock(), changes = [];
    const harness = hookHarness(`export function Setup() { ${normalized.slice(start, stop)} }`, {}, {
      hero: {}, heroExiting: true, artReadyRef: { current: ready }, HERO_FADE_MS: 140, ART_READY_WAIT_MS: 900,
      performance: { now: () => clock.now },
      requestAnimationFrame: fn => clock.setTimeout(fn, 16), cancelAnimationFrame: clock.clearTimeout,
      setHero: value => changes.push(['hero', value]), setHeroExiting: value => changes.push(['exit', value]),
    });
    harness.render(harness.exports.Setup); return { clock, changes, harness };
  };
  const ready = setup(true); ready.clock.advance(159); assert.deepEqual(ready.changes, []);
  ready.clock.advance(1); assert.deepEqual(ready.changes, [['hero', null], ['exit', false]]); ready.harness.unmount();
  const waiting = setup(false); waiting.clock.advance(896); assert.deepEqual(waiting.changes, []);
  waiting.clock.advance(16); assert.equal(waiting.changes.length, 2); waiting.harness.unmount();
  const replacement = setup(true), stale = replacement.clock.queued[0];
  replacement.harness.context.hero = {}; replacement.harness.context.heroExiting = false;
  replacement.harness.render(replacement.harness.exports.Setup); replacement.clock.advance(1000); stale();
  assert.deepEqual(replacement.changes, []); assert.equal(replacement.clock.timers.size, 0); replacement.harness.unmount();
});

test('reverse hero retains 430/140ms, settles once on live reduction and releases both timer stages', () => {
  // The extraction supports checked-out CRLF as well as newly patched LF.
  const normalized = app.replace(/\r\n/g, '\n');
  const start = normalized.indexOf('  useLayoutEffect(() => {\n    if (!reverseHero) return;');
  const stop = normalized.indexOf('  // Normal handoff keeps 430ms', start);
  assert.ok(start > 0 && stop > start);
  const setup = initial => {
    const clock = fakeClock(), listeners = new Set(), changes = [];
    const harness = hookHarness(`export function Setup() { ${normalized.slice(start, stop)} }`, {}, {
      reverseHero: {}, reducedMotionNow: () => initial, HERO_DUR_MS: 430, HERO_FADE_MS: 140,
      subscribeReducedMotion: fn => { listeners.add(fn); return () => listeners.delete(fn); },
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      setReverseHeroExiting: value => changes.push(['exit', value]), setReverseHero: value => changes.push(['hero', value]),
    });
    harness.render(harness.exports.Setup); return { clock, listeners, changes, harness };
  };
  const normal = setup(false); normal.clock.advance(429); assert.deepEqual(normal.changes, [['exit', false]]);
  normal.clock.advance(1); assert.deepEqual(normal.changes.at(-1), ['exit', true]);
  normal.clock.advance(159); assert.equal(normal.changes.length, 2);
  normal.clock.advance(1); assert.deepEqual(normal.changes.slice(-2), [['hero', null], ['exit', false]]); normal.harness.unmount();
  const live = setup(false); live.clock.advance(100);
  for (const fn of live.listeners) fn({ matches: true });
  assert.deepEqual(live.changes, [['exit', false], ['exit', true]]);
  for (const fn of live.listeners) { fn({ matches: false }); fn({ matches: true }); }
  live.clock.advance(160); assert.equal(live.changes.length, 4); live.harness.unmount();
  const reduced = setup(true); reduced.clock.advance(0); assert.deepEqual(reduced.changes.at(-1), ['exit', true]);
  const stale = [...reduced.clock.queued]; reduced.harness.unmount();
  for (const fn of stale) fn(); assert.equal(reduced.changes.length, 2);
  assert.equal(reduced.clock.timers.size, 0); assert.equal(reduced.listeners.size, 0);
});

test('settings focus cancels native smooth movement on live reduction while retaining the requested final scroll', () => {
  const normalized = app.replace(/\r\n/g, '\n');
  const start = normalized.indexOf('  useEffect(() => {\n    if (!visible || sec !== \'playback\'');
  const stop = normalized.indexOf('  /* Материал окна', start);
  assert.ok(start > 0 && stop > start);
  const clock = fakeClock(), scrolls = [], highlight = animationElement(); let reduced = false;
  const scroller = { scrollTop: 40, getBoundingClientRect: () => ({ top: 10 }), scrollTo: options => scrolls.push(options) };
  const target = { focus: () => {}, getBoundingClientRect: () => ({ top: 150 }), querySelector: () => highlight };
  const harness = hookHarness(`export function Setup() { ${normalized.slice(start, stop)} }`, {}, {
    visible: true, sec: 'playback', crossfadeFocus: 1, handledCrossfadeFocus: { current: 0 },
    reduced, reducedMotionNow: () => reduced,
    crossfadeTargetRef: { current: target }, settingsScrollRef: { current: scroller },
    requestAnimationFrame: fn => clock.setTimeout(fn, 16), cancelAnimationFrame: clock.clearTimeout,
  });
  harness.render(harness.exports.Setup); clock.advance(16);
  assert.deepEqual(JSON.parse(JSON.stringify(scrolls)), [{ top: 162, behavior: 'smooth' }]);
  reduced = true; harness.context.reduced = true; harness.render(harness.exports.Setup);
  assert.deepEqual(JSON.parse(JSON.stringify(scrolls.at(-1))), { top: 162, behavior: 'instant' });
  assert.equal(highlight.calls[0].cancelled, true); harness.unmount(); assert.equal(clock.timers.size, 0);
});

test('SoundCloud waveform distinguishes dense sections with identical peaks', () => {
  const bars = [
    ...Array(10).fill(Array(8).fill(0)),
    ...Array(55).fill([255, ...Array(7).fill(230)]),
    ...Array(55).fill([255, ...Array(7).fill(248)]),
  ];
  const path = makeSoundCloudWaveformPath(Uint8Array.from(bars.flat()));
  const heights = Array.from(path.matchAll(/M[\d.]+ ([\d.]+)V([\d.]+)/g),
    ([, top, bottom]) => Number(bottom) - Number(top));
  assert.equal(heights.length, 120);
  assert.equal(heights[0], 2);
  assert.ok(heights[80] - heights[20] > 6);
  assert.equal(new Set(heights.slice(65)).size, 1, 'equal levels stay equal');
});

test('track waveform entrance follows the player reveal and both color layers restart together', () => {
  const begin = app.indexOf('function ProgressBar('), end = app.indexOf('const MENU_VARIANTS', begin);
  const clock = fakeClock();
  let reduced = false;
  const harness = hookHarness(`${app.slice(begin, end)}\nexport { ProgressBar };`, {}, {
    useReducedMotion: () => reduced, fmt: String,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    requestAnimationFrame: fn => clock.setTimeout(fn, 16), cancelAnimationFrame: clock.clearTimeout,
    document: { addEventListener() {}, removeEventListener() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  const props = { progressRef: { current: 0.5 }, audioRef: { current: null }, total: 100,
    visible: true, waveformPath: 'M2 4V20M6 3V21', trackId: 'first', entranceDelay: 280 };
  const render = () => harness.render(harness.exports.ProgressBar, props);
  const isWave = node => node.props?.className === 'player-wave-pattern';
  const wave = tree => findNode(tree, isWave);
  assert.equal(wave(render()).props['data-entrance'], 'wait');
  clock.advance(280);
  const tree = render();
  const base = wave(tree);
  const played = findNode(tree, node => node.props?.className === 'player-wave-played');
  assert.equal(base.props['data-entrance'], 'play');
  assert.deepEqual(Array.from(base.props.children, path => path.props.style.animationDelay), ['0ms', '18ms']);
  assert.equal(wave(played), base);
  props.trackId = 'next';
  assert.notEqual(wave(render()).key, base.key);
  reduced = true;
  assert.equal(wave(render()).props['data-entrance'], undefined);
  props.visible = false; render();
  props.visible = true; reduced = false;
  assert.equal(wave(render()).props['data-entrance'], 'wait');
  harness.unmount();
  assert.equal(clock.timers.size, 0);
});

test('progress clips the track waveform at the decoder position and keeps seeking available', () => {
  const begin = app.indexOf('function ProgressBar('), end = app.indexOf('const MENU_VARIANTS', begin);
  assert.ok(begin > 0 && end > begin);
  const clock = fakeClock(), seeks = [];
  const harness = hookHarness(`${app.slice(begin, end)}\nexport { ProgressBar };`, {}, {
    useReducedMotion: () => true, isFineHover: event => isFineHover(event, () => ({ matches: true })),
    fmt: String, requestAnimationFrame: fn => clock.setTimeout(fn, 16), cancelAnimationFrame: clock.clearTimeout,
    document: { addEventListener() {}, removeEventListener() {} },
    ResizeObserver: class { constructor(callback) { this.callback = callback; } observe(el) { el.offsetWidth = 100; this.callback(); } disconnect() {} },
  });
  const props = { progressRef: { current: 0.75 }, audioRef: { current: { duration: 100, currentTime: 75 } },
    total: 100, visible: true, isPlaying: false, waveformPath: 'M2 4V20', onSeek: fraction => seeks.push(fraction) };
  let tree = harness.render(harness.exports.ProgressBar, props);
  const fill = findNode(tree, node => node.props?.className === 'player-wave-played');
  const thumb = findNode(tree, node => node.ref && node.props?.style?.transform === 'translate(0, -50%)');
  clock.advance(16); assert.equal(fill.ref.current.style.clipPath, 'inset(0 25.000% 0 0)');
  assert.equal(thumb.ref.current.style.transform, 'translate(calc(75.00px - 50%), -50%)');
  props.isPlaying = true; tree = harness.render(harness.exports.ProgressBar, props);
  assert.equal(findNode(tree, node => node.type === 'path').props.d, props.waveformPath);
  const hit = findNode(tree, node => node.props?.onPointerEnter && node.props?.onMouseDown);
  hit.props.onPointerEnter({ pointerType: 'mouse' }); tree = harness.render(harness.exports.ProgressBar, props);
  const rail = findNode(tree, node => node.props?.className === 'player-wave-track');
  rail.ref.current.getBoundingClientRect = () => ({ left: 0, width: 100 });
  hit.props.onMouseDown({ clientX: 25 }); tree = harness.render(harness.exports.ProgressBar, props);
  assert.deepEqual(seeks, [0.25]); assert.equal(rail.props['data-motion-position'], '');
  assert.equal(findNode(tree, node => node.props?.className === 'player-wave').props['data-engaged'], true);
  props.classic = true; props.isPlaying = false;
  tree = harness.render(harness.exports.ProgressBar, props);
  clock.advance(16);
  assert.equal(findNode(tree, node => node.props?.className === 'player-wave').props['data-classic'], true);
  assert.equal(fill.ref.current.style.transform, 'scaleX(0.75000)');
  assert.equal(findNode(tree, node => node.props?.className === 'player-classic-glow').ref.current.style['--pb-glow'], '0.75000');
  assert.equal(findNode(tree, node => node.props?.className === 'player-wave-track').ref, rail.ref);
  harness.unmount(); assert.equal(clock.timers.size, 0);
});

test('uncached lyrics can mount their loading meter during playback and release it after loading', () => {
  const begin = app.indexOf('function AudioMeter('), end = app.indexOf('function LyricsPanel(', begin);
  const bars = Array.from({ length: 5 }, () => ({ style: {} }));
  const clock = fakeClock();
  let disposed = false;
  const harness = hookHarness(`${app.slice(begin, end)}\nexport { AudioMeter };`, {}, {
    useRef: () => ({ current: { querySelectorAll: () => bars } }),
    connectPlaybackAnalyser: () => ({
      analyser: { fftSize: 1024, frequencyBinCount: 512, context: { sampleRate: 48000 },
        getByteFrequencyData: bins => bins.fill(255) },
      dispose: () => { disposed = true; },
    }),
    requestAnimationFrame: fn => clock.setTimeout(() => fn(clock.now), 16), cancelAnimationFrame: clock.clearTimeout,
  });
  harness.render(harness.exports.AudioMeter, { audioRef: { current: {} }, playing: true });
  clock.advance(16);
  assert.ok(bars.every(bar => bar.style.transform === 'scaleY(1)'));
  harness.unmount();
  assert.equal(disposed, true);
  assert.equal(clock.timers.size, 0);
});

test('live wave reads the active audio and keeps seeking usable with reduced motion', () => {
  const begin = app.indexOf('function ProgressBar('), end = app.indexOf('const MENU_VARIANTS', begin);
  const clock = fakeClock();
  const connected = [], released = [];
  let reduced = true;
  const harness = hookHarness(`${app.slice(begin, end)}\nexport { ProgressBar };`, {}, {
    useReducedMotion: () => reduced, fmt: String,
    requestAnimationFrame: fn => clock.setTimeout(() => fn(clock.now), 16), cancelAnimationFrame: clock.clearTimeout,
    document: { addEventListener() {}, removeEventListener() {} },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(el) { el.offsetWidth = 200; this.callback(); }
      disconnect() {}
    },
    connectPlaybackAnalyser(audio, options) {
      assert.equal(options.beforeVolume, true);
      connected.push(audio);
      return {
        analyser: { fftSize: 1024, frequencyBinCount: 512, context: { sampleRate: 48000 },
          minDecibels: -100, maxDecibels: -30, getFloatFrequencyData(samples) {
          samples.fill(-Infinity);
          samples.fill(-40, audio.bandStart, audio.bandEnd);
        } },
        dispose: () => released.push(audio),
      };
    },
  });
  const audio = { currentTime: 1, duration: 10, readyState: 2, bandStart: 1, bandEnd: 4 };
  const props = { progressRef: { current: 0.1 }, audioRef: { current: audio }, total: 10,
    visible: true, isPlaying: false, signal: true, positionVersion: 0 };
  const render = () => harness.render(harness.exports.ProgressBar, props);
  const tree = render();
  assert.equal(findNode(tree, node => node.props['data-signal']).props['data-signal'], true);
  const path = findNode(tree, node => node.type === 'path').ref.current;
  path.setAttribute = (key, value) => { path[key] = value; };
  const fill = findNode(tree, node => node.props.className === 'player-wave-played').ref.current;
  assert.equal(findNode(tree, node => node.props.className === 'player-wave-cursor'), null);
  clock.advance(48);
  assert.equal(fill.style.clipPath, 'inset(0 90.000% 0 0)');
  assert.equal(fill.style['--signal-progress'], '10.000%');
  assert.equal(clock.timers.size, 0);

  audio.currentTime = 7.5;
  props.positionVersion++;
  render();
  clock.advance(48);
  assert.equal(fill.style.clipPath, 'inset(0 25.000% 0 0)');
  assert.equal(fill.style['--signal-progress'], '75.000%');
  assert.deepEqual(connected, []);

  reduced = false;
  props.isPlaying = true;
  render();
  clock.advance(48);
  assert.deepEqual(connected, [audio]);
  const strokes = () => Array.from(path.d.matchAll(/M([\d.]+) 28V([\d.]+)/g),
    ([, x, top]) => ({ x: Number(x), top: Number(top) }));
  assert.ok(strokes().some(({ top }) => top < 14));
  assert.ok(strokes().every(({ x, top }) => x < 220 && top < 28));
  clock.advance(1000);
  const atFullVolume = path.d;
  audio.volume = 0.03;
  clock.advance(96);
  assert.equal(path.d, atFullVolume);

  const nextAudio = { ...audio, bandStart: 160, bandEnd: 240 };
  props.audioRef.current = nextAudio;
  clock.advance(48);
  assert.deepEqual(connected, [audio, nextAudio]);
  assert.deepEqual(released, [audio]);
  assert.ok(strokes().some(({ top }) => top < 14));
  assert.ok(strokes().every(({ x, top }) => x > 440 && top < 28));

  reduced = true;
  render();
  assert.deepEqual(released, [audio, nextAudio]);
  assert.equal(path.d, '');
  harness.unmount();
  assert.equal(clock.timers.size, 0);
});

test('the live wave taps the track before volume and shares an existing element capture', () => {
  const start = app.indexOf('const playbackCaptureTaps');
  const end = app.indexOf('function AudioMeter(', start);
  const calls = [];
  const captureSource = {
    connect: () => calls.push('connect'),
    disconnect: () => calls.push('disconnect'),
  };
  const audio = {
    volume: 0,
    captureStream() {
      calls.push('capture');
      const track = { stop: () => calls.push('stop') };
      return { getAudioTracks: () => [track], getTracks: () => [track] };
    },
  };
  class AudioContext {
    createMediaStreamSource() { return { ...captureSource, context: this }; }
    createAnalyser() { return {}; }
    async resume() {}
    async close() { calls.push('close'); }
  }
  const bus = {
    context: { createAnalyser: () => ({ mixed: true }) },
    connect: () => calls.push('connect mix'),
    disconnect: () => calls.push('disconnect mix'),
  };
  const { exports: { connectPlaybackAnalyser } } = hookHarness(
    `${app.slice(start, end)}\nexport { connectPlaybackAnalyser };`, {},
    { _afx: { decks: new Map([[audio, {}]]), bus: { input: bus } }, window: { AudioContext } },
  );
  const mix = connectPlaybackAnalyser(audio);
  const first = connectPlaybackAnalyser(audio, { beforeVolume: true });
  const second = connectPlaybackAnalyser(audio, { beforeVolume: true });
  assert.equal(mix.analyser.mixed, true);
  assert.equal(first.analyser, second.analyser);
  assert.deepEqual(calls, ['connect mix', 'capture', 'connect']);
  first.dispose();
  assert.deepEqual(calls, ['connect mix', 'capture', 'connect']);
  second.dispose();
  mix.dispose();
  assert.deepEqual(calls.slice(3), ['disconnect', 'stop', 'close', 'disconnect mix']);
  assert.equal(audio.volume, 0);
});

test('shared artwork follows the sidebar even when its slot changes position only', () => {
  const start = app.lastIndexOf('  useLayoutEffect(() => {', app.indexOf('const libraryPanel = document.getElementById'));
  const end = app.indexOf('partyLayoutOpen, partyControlsAligned]);', start) + 'partyLayoutOpen, partyControlsAligned]);'.length;
  const slot = { left: 350, getBoundingClientRect() { return { left: this.left, top: 50, width: 300, height: 300 }; } };
  const sidebar = {};
  const cover = { style: {} };
  const observed = new Map();
  const harness = hookHarness(`export function Setup() { ${app.slice(start, end)} }`, {}, {
    sharedCoverMotion: null, sharedCoverRef: { current: cover }, fullscreenArtRef: { current: null },
    fullScreen: false, fullscreenSurface: false, track: { id: 1 }, inPlayer: true,
    partyLayoutOpen: false, partyControlsAligned: false,
    document: { getElementById: id => id === 'player-album-art' ? slot : sidebar },
    window: { addEventListener() {}, removeEventListener() {} },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(element) { observed.set(element, this.callback); }
      disconnect() { observed.clear(); }
    },
  });
  harness.render(harness.exports.Setup);
  assert.equal(cover.style.left, '350px');
  slot.left = 310; observed.get(sidebar)();
  assert.equal(cover.style.left, '310px');
  assert.equal(cover.style.width, '300px');
  harness.unmount();
  assert.equal(observed.size, 0);
});

test('AlbumArt reports only the requested drawn cover, and failed new artwork cannot uncover the old layer', () => {
  const begin = app.indexOf('function AlbumArt('), end = app.indexOf('/* ── AmbientGlow', begin);
  assert.ok(begin > 0 && end > begin);
  const clock = fakeClock(), reported = [];
  const harness = hookHarness(`${app.slice(begin, end)}\nexport { AlbumArt };`, {}, {
    window: {}, CoverLayer: 'cover-layer', CoverTint: 'tint', setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  const props = { track: { coverUrl: 'old' }, instant: true, onReady: () => reported.push(props.track.coverUrl) };
  const render = () => harness.render(harness.exports.AlbumArt, props);
  const layer = tree => findNode(tree, node => node.type === 'cover-layer' && node.props.isTop);
  let tree = render(); assert.deepEqual(reported, []);
  layer(tree).props.onLoaded('old'); tree = render(); assert.deepEqual(reported, ['old']);
  props.track = { coverUrl: 'new' }; render(); tree = render();
  assert.deepEqual(reported, ['old']); assert.equal(layer(tree).props.url, 'new');
  layer(tree).props.onLoaded('new'); tree = render(); assert.deepEqual(reported, ['old', 'new']);
  layer(tree).props.onFailed('new'); tree = render();
  assert.equal(findNode(tree, node => node.type === 'cover-layer'), null);
  assert.equal(reported.at(-1), 'new', 'the current placeholder is ready, not the preceding cover');
  for (let i = 0; i < 4; i++) assert.equal(findNode(render(), node => node.type === 'cover-layer'), null, 'failure must stay settled after subsequent renders');
  harness.unmount(); assert.equal(clock.timers.size, 0);
  assert.match(app, /useLayoutEffect\(\(\) => \{ artReadyRef\.current = false; \}, \[track\?\.id, track\?\.coverUrl\]\)/);
});

function albumArtHarness(initialUrl, instant = true) {
  const begin = app.indexOf('function AlbumArt('), end = app.indexOf('/* ── AmbientGlow', begin);
  assert.ok(begin > 0 && end > begin);
  const clock = fakeClock(), reported = [];
  const harness = hookHarness(`${app.slice(begin, end)}\nexport { AlbumArt };`, {}, {
    window: {}, CoverLayer: 'cover-layer', CoverTint: 'tint', setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  const props = { track: { id: 1, coverUrl: initialUrl }, instant, onReady: () => reported.push(props.track.coverUrl) };
  return { harness, clock, reported, props,
    render: () => harness.render(harness.exports.AlbumArt, props),
    layer: tree => findNode(tree, node => node.type === 'cover-layer' && node.props.isTop),
  };
}

test('coverless to new artwork never reports readiness before its current layer is decoded', () => {
  const t = albumArtHarness(null); t.render(); assert.deepEqual(t.reported, [null]);
  t.reported.length = 0; t.props.track = { id: 2, coverUrl: 'new' };
  for (let i = 0; i < 4; i++) t.render();
  assert.deepEqual(t.reported, []); const tree = t.render(); assert.equal(t.layer(tree).props.ready, false);
  t.layer(tree).props.onLoaded('new'); t.render(); t.render(); assert.deepEqual(t.reported, ['new']);
  t.harness.unmount(); assert.equal(t.clock.timers.size, 0);
});

test('a failed request remains a placeholder; a different URL waits for decode and may later retry the old source', () => {
  const t = albumArtHarness('broken'); const failed = t.layer(t.render()); failed.props.onFailed('broken');
  for (let i = 0; i < 4; i++) assert.equal(t.layer(t.render()), null);
  assert.deepEqual(t.reported, ['broken']); failed.props.onLoaded('broken'); t.render(); assert.equal(t.layer(t.render()), null);
  t.props.track = { id: 2, coverUrl: 'different' }; t.reported.length = 0;
  for (let i = 0; i < 4; i++) t.render(); assert.deepEqual(t.reported, []);
  const next = t.layer(t.render()); next.props.onLoaded('different'); t.render(); assert.deepEqual(t.reported, ['different']);
  t.props.track = { id: 3, coverUrl: 'broken' }; t.reported.length = 0; t.render(); const retry = t.layer(t.render());
  assert.equal(retry.props.url, 'broken'); assert.notEqual(retry.key, failed.key);
  failed.props.onFailed('broken'); failed.props.onLoaded('broken'); t.render();
  assert.deepEqual(t.reported, []); assert.equal(t.layer(t.render()).key, retry.key);
  retry.props.onLoaded('broken'); t.render(); assert.deepEqual(t.reported, ['broken']);
  t.harness.unmount(); assert.equal(t.clock.timers.size, 0);
});

test('callbacks from a retired layer cannot drop or prematurely report a different requested cover', () => {
  const t = albumArtHarness('old'); const old = t.layer(t.render()); old.props.onLoaded('old'); t.render();
  t.props.track = { id: 2, coverUrl: 'new' }; t.reported.length = 0; t.render(); const next = t.layer(t.render());
  old.props.onFailed('old'); old.props.onLoaded('old');
  for (let i = 0; i < 3; i++) t.render();
  assert.deepEqual(t.reported, []); assert.equal(t.layer(t.render()).key, next.key);
  next.props.onLoaded('new'); t.render(); assert.deepEqual(t.reported, ['new']); t.harness.unmount();
});

test('no-cover and shared-cover track changes report only the actual current placeholder or drawn image', () => {
  const t = albumArtHarness('same'); const first = t.layer(t.render()); first.props.onLoaded('same'); t.render();
  t.reported.length = 0; t.props.track = { id: 2, coverUrl: 'same' }; t.render(); assert.deepEqual(t.reported, ['same']);
  t.props.track = { id: 3, coverUrl: null }; t.reported.length = 0; t.render(); assert.deepEqual(t.reported, []);
  const tree = t.render(); assert.equal(t.layer(tree), null); assert.deepEqual(t.reported, [null]);
  first.props.onFailed('same'); first.props.onLoaded('same'); t.render(); assert.deepEqual(t.reported, [null]);
  t.harness.unmount();
});

test('AlbumArt keeps normal crossfade layers until pruning and rejects late callbacks after unmount', () => {
  const t = albumArtHarness('old', false); const old = t.layer(t.render()); old.props.onLoaded('old'); t.render();
  t.props.track = { id: 2, coverUrl: 'new' }; t.render(); const next = t.layer(t.render());
  const hasOld = tree => findNode(tree, node => node.type === 'cover-layer' && node.props.url === 'old');
  assert.ok(hasOld(t.render())); next.props.onLoaded('new'); t.render(); assert.ok(hasOld(t.render()));
  t.clock.advance(799); assert.ok(hasOld(t.render())); t.clock.advance(1); assert.equal(hasOld(t.render()), null);
  const stale = [...t.clock.queued]; t.harness.unmount(); const reported = t.reported.slice();
  next.props.onFailed('new'); next.props.onLoaded('new'); for (const callback of stale) callback();
  assert.deepEqual(t.reported, reported); assert.equal(t.clock.timers.size, 0);
});

test('replacement heroes reset exit state before paint and retired handoff timers cannot fade the new clone', () => {
  const start = app.indexOf('  // Normal handoff keeps 430ms');
  assert.match(app.slice(start, app.indexOf('  const artEntranceTweenRef', start)), /useLayoutEffect\(\(\) => \{\s*if \(!hero\) return;\s*setHeroExiting\(false\)/);
  assert.match(app, /useLayoutEffect\(\(\) => \{\s*if \(!reverseHero\) return;\s*setReverseHeroExiting\(false\)/);
  const t = handoffHarness(false); t.clock.advance(430); assert.deepEqual(t.changes, [false, true]);
  const stale = [...t.clock.queued]; t.harness.context.hero = {}; t.harness.render(t.harness.exports.Setup);
  assert.deepEqual(t.changes, [false, true, false]); for (const callback of stale) callback();
  assert.deepEqual(t.changes, [false, true, false]); t.clock.advance(430); assert.equal(t.changes.at(-1), true); t.harness.unmount();
});

test('actual smooth scroll cancels active frames on preference changes, wheel interrupts and newer targets win', () => {
  const begin = app.indexOf('const _smoothScrolls ='), end = app.indexOf('function fmt(', begin);
  assert.ok(begin > 0 && end > begin);
  const clock = fakeClock(), listeners = new Set(); let reduced = false;
  const harness = hookHarness(`${app.slice(begin, end)}\nexport { smoothScroll, stopSmoothScroll, bindScrollInterrupt };`, {}, {
    reducedMotionNow: () => reduced, subscribeReducedMotion: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    performance: { now: () => clock.now }, requestAnimationFrame: fn => clock.setTimeout(() => fn(clock.now), 16), cancelAnimationFrame: clock.clearTimeout,
  });
  const handlers = new Map(), el = { scrollTop: 0, addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) };
  harness.exports.smoothScroll(el, 100, 420); clock.advance(100); assert.ok(el.scrollTop > 0 && el.scrollTop < 100);
  reduced = true; for (const fn of [...listeners]) fn({ matches: true }); assert.equal(el.scrollTop, 100); assert.equal(clock.timers.size, 0);
  for (const fn of clock.queued) fn(); assert.equal(el.scrollTop, 100); assert.equal(listeners.size, 0);
  harness.exports.smoothScroll(el, 200, 420); assert.equal(el.scrollTop, 200); assert.equal(clock.timers.size, 0);
  reduced = false; const unbind = harness.exports.bindScrollInterrupt(el);
  harness.exports.smoothScroll(el, 0, 420); clock.advance(32); handlers.get('wheel')(); const stopped = el.scrollTop;
  clock.advance(500); assert.equal(el.scrollTop, stopped);
  harness.exports.smoothScroll(el, 10, 420); harness.exports.smoothScroll(el, 20, 420); clock.advance(432);
  assert.equal(el.scrollTop, 20); assert.equal(listeners.size, 0); unbind(); assert.equal(handlers.size, 0);
});

test('GSAP entrance rejects delayed loaders and settles active art when the preference changes', async () => {
  const begin = app.indexOf('  const artEntranceTweenRef =');
  const end = app.indexOf('  /* плавный ресайз', begin);
  assert.ok(begin > 0 && end > begin);
  const art = animationElement(), calls = [], pending = [];
  const gsap = { fromTo: (...args) => { const tween = { killed: false, kill() { this.killed = true; } }; calls.push({ args, tween }); return tween; } };
  const harness = hookHarness(`export function Setup() { ${app.slice(begin, end)} }`, {}, {
    reduced: false, view: 'player', hero: null, artEntranceRef: { current: art },
    loadGsap: () => new Promise(resolve => pending.push(resolve)),
  });
  harness.render(harness.exports.Setup); harness.context.reduced = true; harness.render(harness.exports.Setup);
  pending.shift()(gsap); await Promise.resolve(); assert.equal(calls.length, 0); assert.equal(art.style.opacity, '1'); assert.equal(art.style.transform, 'none');
  harness.context.reduced = false; harness.render(harness.exports.Setup);
  assert.equal(pending.length, 0, 'preference changes alone cannot replay an entrance');
  harness.context.view = 'home'; harness.render(harness.exports.Setup);
  harness.context.view = 'player'; harness.render(harness.exports.Setup); pending.shift()(gsap); await Promise.resolve();
  assert.equal(calls.length, 1); assert.equal(calls[0].args[2].duration, 0.5); assert.equal(calls[0].args[1].y, 14);
  harness.context.reduced = true; harness.render(harness.exports.Setup); assert.equal(calls[0].tween.killed, true); harness.unmount();
});

test('reduced smooth-position retains true slider fractions and cancels its spatial spring', () => {
  const begin = app.indexOf('function useSmoothPosition('), end = app.indexOf('function useRail(', begin);
  assert.ok(begin > 0 && end > begin);
  const target = { value: 0, set(value) { this.value = value; }, get() { return this.value; } }, jumps = [];
  const spring = { jump: value => jumps.push(value) };
  const harness = hookHarness(`${app.slice(begin, end)}\nexport { useSmoothPosition };`, {}, {
    useReducedMotion: () => true, useMotionValue: () => target, useSpring: () => spring, sliderFraction,
  });
  const result = harness.render(harness.exports.useSmoothPosition, 6, -12, 12, { current: false });
  assert.equal(result.position, target); assert.equal(target.value, 0.75); assert.deepEqual(jumps, [0.75]);
  assert.match(app, /left: on \? 19 : 3\.5/); assert.match(app, /left: th\.accentGrad \? 16 : 3/);
  assert.match(css, /\[role="switch"\] > div \{ transition:none !important; \}/);
  const rule = css.match(/\[data-motion-position\] \{([^}]+)\}/)?.[1];
  assert.ok(rule); assert.doesNotMatch(rule, /transform\s*:|left\s*:|top\s*:|width\s*:/);
  assert.doesNotMatch(css, /\.smooth-slider-(?:fill|thumb)[^{}]*\{[^}]*transform:none/);
});

test('scoped CSS keeps reduced mini presses stationary, lyrics readable and hover movement fine-pointer-only', () => {
  assert.match(css, /\.mini-player-button, \.mini-player-button:not\(:disabled\):active \{ transform:none;/);
  assert.match(css, /\.lyric-highlight \{[^}]*transform:none !important; animation:none !important;/);
  assert.match(css, /\.lyric-wave \{ animation:none !important;/);
  assert.match(css, /@media \(hover:hover\) and \(pointer:fine\) \{\s*\.home-card-anim:hover \{ transform:scale\(1\.03\);/);
  assert.doesNotMatch(css, /\.mini-player-track[^{}]*:hover/);
  assert.match(readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8'), /<MotionConfig reducedMotion="user">/);
  for (const name of ['disclosure.jsx', 'party-player-layout.jsx']) assert.match(readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'), /useReducedMotion.*from '\.\/use-motion-preference\.js'/);
});

test('only generic popup exits use the existing strong ease-out with unchanged durations and origins', () => {
  const exits = app.split(/\r?\n/).filter(line => line.includes('exit={{') && line.includes('transition:'));
  const responsive = exits.filter(exit => /ease:\s*\[0\.22,\s*1,\s*0\.36,\s*1\]/.test(exit));
  assert.equal(responsive.length, 6);
  assert.equal(responsive.filter(exit => /duration:\s*0\.14/.test(exit)).length, 3);
  assert.equal(responsive.filter(exit => /duration:\s*0\.13/.test(exit)).length, 2);
  assert.equal(responsive.filter(exit => /duration:\s*0\.12/.test(exit)).length, 1);
  assert.doesNotMatch(exits.join('\n'), /easeIn|\[0\.4, 0, 1, 1\]/);
  assert.match(app, /transformOrigin: 'top left'/); assert.match(app, /variants=\{MENU_VARIANTS\}/);
  assert.match(app, /const MENU_VARIANTS =/); assert.match(app, /const HERO_DUR_MS\s*= 430/);
  assert.match(app, /opacity 0\.12s ease-in, transform 0\.12s ease-in/);
});
