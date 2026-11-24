import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { reducedMotionNow, subscribeReducedMotion, animateHeroFlight } from '../src/motion-preference.js';
import { isFineHover } from '../src/motion-lifecycle.js';
import { sliderFraction } from '../src/slider.js';
import { makeSoundCloudWaveformPath } from '../src/use-soundcloud-waveform.js';
import { lyricsReturnFlight } from '../src/lyrics-transition.js';
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

function sharedCoverHarness(overrides = {}) {
  const normalized = app.replace(/\r\n/g, '\n');
  const begin = normalized.indexOf('  const completedEntryFlightRef =');
  const end = normalized.indexOf('  useLayoutEffect(() => {\n    const measure = () => {', begin);
  assert.ok(begin > 0 && end > begin);
  const cover = animationElement(), events = [], clock = fakeClock();
  const track = { id: 1, coverUrl: 'cover' };
  const entry = { track, startRect: { left: 10, top: 15, width: 100 } };
  const exit = { track, startRect: { left: 120, top: 70, width: 300 },
    targetRect: { left: 10, top: 15, size: 100 } };
  const state = { coverTrack:track, coverKey:'1:cover', readyCoverKey:'1:cover', inPlayer:true,
    entryHero:entry, exitHero:null, reduced:false, sharedCoverMotion:null, ...overrides };
  const harness = hookHarness('export function Setup({ coverTrack, coverKey, readyCoverKey, inPlayer, entryHero, exitHero, reduced, sharedCoverMotion }) {'
    + normalized.slice(begin, end) + '}', {}, {
    fullScreen:false, fullscreenFlightStart:null, sharedCoverRef:{ current:cover },
    HERO_DUR_MS:430, HERO_EASE:options.easing,
    setSharedCoverRect: value => { state.rect = value; },
    setSharedCoverMotion: value => { state.sharedCoverMotion = typeof value === 'function' ? value(state.sharedCoverMotion) : value; },
    onEntryCoverFlightStart: () => events.push('entry-start'),
    onEntryCoverFlightComplete: () => events.push('entry-complete'),
    onExitCoverFlightComplete: () => events.push('exit-complete'),
    document:{ getElementById: id => {
      assert.equal(id, 'player-album-art');
      return { getBoundingClientRect: () => ({ left:120, top:70, width:300, height:300 }) };
    } },
    requestAnimationFrame: fn => clock.setTimeout(fn, 16), cancelAnimationFrame: clock.clearTimeout,
  });
  const render = () => {
    for (let i = 0; i < 5; i++) {
      const previous = state.sharedCoverMotion;
      harness.render(harness.exports.Setup, state);
      if (state.sharedCoverMotion === previous) return;
    }
    assert.fail('shared cover effects did not settle');
  };
  return { harness, state, render, cover, clock, events, entry, exit };
}

test('the live shared cover retargets replacement heroes and ignores an obsolete finish callback', () => {
  const t = sharedCoverHarness(); t.render();
  const first = t.cover.calls[0], staleFinish = first.onfinish;
  assert.equal(first.options.duration, 430);
  t.state.entryHero = { ...t.entry, startRect:{ ...t.entry.startRect, left:50 } };
  t.render();
  assert.equal(first.cancelled, true);
  assert.equal(t.cover.calls.length, 2);
  assert.notEqual(first.frames[0].transform, t.cover.calls[1].frames[0].transform);
  staleFinish();
  assert.deepEqual(t.events, ['entry-start', 'entry-start']);
  t.cover.calls[1].onfinish();
  t.render();
  assert.deepEqual(t.events, ['entry-start', 'entry-start', 'entry-complete']);
  assert.equal(t.state.sharedCoverMotion, null);
  t.harness.unmount();
});

test('reduced entry waits for the current cover to be drawn before replacing the source card', () => {
  const t = sharedCoverHarness({ reduced:true, readyCoverKey:'old' });
  t.render();
  assert.deepEqual(t.events, []);
  t.state.readyCoverKey = t.state.coverKey;
  t.render();
  assert.deepEqual(t.events, ['entry-complete']);
  assert.equal(t.cover.calls.length, 0);
  t.harness.unmount();
});

test('live motion reduction settles an active entry and cannot replay the same artwork flight', () => {
  const t = sharedCoverHarness(); t.render();
  const flight = t.cover.calls[0], staleFinish = flight.onfinish;
  t.state.reduced = true;
  t.render();
  assert.equal(flight.cancelled, true);
  assert.equal(t.state.sharedCoverMotion, null);
  assert.deepEqual(t.events, ['entry-start', 'entry-complete']);
  t.state.reduced = false;
  t.render();
  staleFinish();
  assert.equal(t.cover.calls.length, 1);
  assert.deepEqual(t.events, ['entry-start', 'entry-complete']);
  t.harness.unmount();
});

test('missing WAAPI completes the shared artwork handoff and unmount rejects a retired finish', () => {
  const missing = sharedCoverHarness();
  missing.cover.animate = undefined;
  missing.render();
  assert.deepEqual(missing.events, ['entry-complete']);
  assert.equal(missing.state.sharedCoverMotion, null);
  missing.harness.unmount();

  const t = sharedCoverHarness(); t.render();
  const staleFinish = t.cover.calls[0].onfinish;
  t.harness.unmount();
  staleFinish();
  assert.equal(t.cover.calls[0].cancelled, true);
  assert.deepEqual(t.events, ['entry-start']);
});

test('source card remains hidden until artwork is ready and retired readiness frames cannot clear a replacement', () => {
  const normalized = app.replace(/\r\n/g, '\n');
  const begin = normalized.indexOf('  useEffect(() => {\n    if (!hero || !heroExiting) return;');
  const end = normalized.indexOf('  }, [hero, heroExiting]);', begin) + '  }, [hero, heroExiting]);'.length;
  assert.ok(begin > 0 && end > begin);
  const setup = (ready, status = 'complete') => {
    const clock = fakeClock(), changes = [];
    const harness = hookHarness('export function Setup() {' + normalized.slice(begin, end) + '}', {}, {
      hero:{}, heroExiting:true, artReadyRef:{ current:ready }, entryCoverFlightRef:{ current:status }, ART_READY_WAIT_MS:900,
      performance:{ now: () => clock.now },
      requestAnimationFrame: fn => clock.setTimeout(fn, 16), cancelAnimationFrame: clock.clearTimeout,
      setHero: value => changes.push(['hero', value]), setHeroExiting: value => changes.push(['exit', value]),
    });
    harness.render(harness.exports.Setup); return { clock, changes, harness };
  };
  const ready = setup(true);
  ready.clock.advance(16);
  assert.deepEqual(ready.changes, [['hero', null], ['exit', false]]);
  ready.harness.unmount();

  const waiting = setup(false);
  waiting.clock.advance(896);
  assert.deepEqual(waiting.changes, []);
  waiting.clock.advance(16);
  assert.deepEqual(waiting.changes, [['hero', null], ['exit', false]]);
  waiting.harness.unmount();

  const replacement = setup(true, 'started'), stale = replacement.clock.queued[0];
  replacement.clock.advance(1000);
  assert.deepEqual(replacement.changes, []);
  replacement.harness.context.hero = {};
  replacement.harness.context.heroExiting = false;
  replacement.harness.render(replacement.harness.exports.Setup);
  stale();
  assert.deepEqual(replacement.changes, []);
  assert.equal(replacement.clock.timers.size, 0);
  replacement.harness.unmount();
});

test('reverse shared artwork flies for 430ms and live reduction releases its scroll listener immediately', () => {
  const t = sharedCoverHarness({ entryHero:null });
  const listeners = new Map();
  const anchor = { scrollTop:0, addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name) };
  t.state.exitHero = { ...t.exit, scrollAnchor:{ element:anchor, top:0 } };
  t.render();
  const flight = t.cover.calls[0], staleFinish = flight.onfinish;
  assert.equal(flight.options.duration, 430);
  assert.deepEqual(t.events, []);
  assert.equal(listeners.size, 1);
  anchor.scrollTop = 24;
  listeners.get('scroll')();
  assert.equal(t.clock.timers.size, 1);
  t.state.reduced = true;
  t.render();
  staleFinish();
  assert.deepEqual(t.events, ['exit-complete']);
  assert.equal(flight.cancelled, true);
  assert.equal(listeners.size, 0);
  assert.equal(t.clock.timers.size, 0);
  t.harness.unmount();

  const normal = sharedCoverHarness({ entryHero:null });
  normal.state.exitHero = normal.exit;
  normal.render();
  const finish = normal.cover.calls[0].onfinish;
  finish(); finish(); normal.render();
  assert.deepEqual(normal.events, ['exit-complete']);
  normal.harness.unmount();
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
  const clock = fakeClock(), seeks = [], body = {};
  const harness = hookHarness(`${app.slice(begin, end)}\nexport { ProgressBar };`, {}, {
    useReducedMotion: () => true, isFineHover: event => isFineHover(event, () => ({ matches: true })),
    fmt: String, requestAnimationFrame: fn => clock.setTimeout(fn, 16), cancelAnimationFrame: clock.clearTimeout,
    document: { body, addEventListener() {}, removeEventListener() {} },
    createPortal: (node, target) => { assert.equal(target, body); return node; },
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
  rail.ref.current.getBoundingClientRect = () => ({ left: 180, width: 100 });
  hit.props.onPointerMove({ pointerType:'mouse', clientX:205, currentTarget:{ getBoundingClientRect: () => ({ top:510 }) } });
  tree = harness.render(harness.exports.ProgressBar, props);
  const tooltip = findNode(tree, node => node.props?.className === 'player-progress-tooltip');
  assert.equal(tooltip.props.style.left, 205);
  assert.equal(tooltip.props.style.top, 506);
  assert.equal(tooltip.props.children, '25');
  hit.props.onPointerLeave();
  tree = harness.render(harness.exports.ProgressBar, props);
  assert.equal(findNode(tree, node => node.props?.className === 'player-progress-tooltip'), null);
  hit.props.onMouseDown({ clientX: 205 }); tree = harness.render(harness.exports.ProgressBar, props);
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

  const tallestTop = () => Math.min(...strokes().map(({ top }) => top));
  const playingTop = tallestTop();
  props.isPlaying = false;
  render();
  assert.equal(tallestTop(), playingTop);
  clock.advance(64);
  assert.ok(tallestTop() > playingTop && tallestTop() < 28);
  assert.deepEqual(released, [audio, nextAudio]);
  clock.advance(500);
  assert.equal(path.d, '');
  assert.equal(clock.timers.size, 0);

  props.isPlaying = true;
  render();
  clock.advance(48);
  assert.deepEqual(connected, [audio, nextAudio, nextAudio]);
  assert.ok(strokes().length > 0);

  reduced = true;
  render();
  assert.deepEqual(released, [audio, nextAudio, nextAudio]);
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
    fullScreen: false, track: { id: 1 }, inPlayer: true,
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

test('fullscreen lyrics moves one metadata layer and hides the player copy until handoff', () => {
  const anchorStart = app.indexOf('function lyricsMetadataAnchor(');
  const anchorEnd = app.indexOf('function lyricsFlightSource(', anchorStart);
  const effectStart = app.lastIndexOf('  useLayoutEffect(() => {', app.indexOf('const source = fullscreenFlightStart?.metaSource'));
  const deps = '}, [fullscreenFlightStart, reduced, playerInfoRef]);';
  const effectEnd = app.indexOf(deps, effectStart) + deps.length;
  const compact = animationElement(), full = animationElement();
  compact.querySelector = () => ({ getBoundingClientRect: () => ({ left:100, top:130, width:300, height:20 }) });
  full.querySelector = () => ({ getBoundingClientRect: () => ({ left:0, top:40, width:300, height:20 }) });
  const harness = hookHarness(`${app.slice(anchorStart, anchorEnd)}
    export function Setup(fullscreenFlightStart, reduced) { ${app.slice(effectStart, effectEnd)} }`, {}, {
    playerInfoRef: { current: compact }, fullscreenMetaRef: { current: full }, HERO_DUR_MS: 430, HERO_EASE: 'ease',
  });
  harness.render(harness.exports.Setup, { direction:'in', metaSource:{ x:250, y:140 } }, false);
  assert.deepEqual(Array.from(full.calls[0].frames, frame => frame.translate), ['100px 90px', '0px 0px']);
  assert.equal(compact.style.visibility, 'hidden');

  // Close while still between the two anchors.
  harness.render(harness.exports.Setup, { direction:'out', metaSource:{ x:180, y:75 } }, false);
  assert.ok(full.calls[0].cancelled);
  assert.deepEqual(Array.from(full.calls[1].frames, frame => frame.translate), ['30px 25px', '100px 90px']);
  assert.equal(compact.style.visibility, 'hidden');

  harness.render(harness.exports.Setup, null, false);
  assert.ok(full.calls[1].cancelled);
  assert.equal(compact.style.visibility, undefined);
  assert.deepEqual(compact.calls, []);
  harness.render(harness.exports.Setup, { direction:'out', metaSource:{ x:180, y:75 } }, true);
  assert.equal(full.calls.length, 2);
});

test('the return flight aligns the old active word and reveals the compact viewport at landing', () => {
  const source = { rect:{ left:400, top:30, width:520, height:420, bottom:450 },
    word:{ left:440, top:130, bottom:158, height:28 }, font:28, scale:1 };
  const target = { rect:{ left:16, top:80, width:220, height:180, right:236, bottom:260 },
    word:{ left:26, top:150, height:14 }, font:14 };
  const { travel, fade, reveal } = lyricsReturnFlight(source, target, 'ease');
  assert.equal(travel[1].transform, 'translate3d(-394px, 70px, 0) scale(0.5)');
  assert.equal(travel[1].clipPath, 'inset(0px 60px 100px 20px)');
  assert.equal(travel[1].offset, reveal[1].offset);
  assert.equal(travel[2].transform, travel[1].transform);
  assert.equal(travel[2].clipPath, travel[1].clipPath);
  assert.equal(reveal[0].clipPath, 'inset(56px 0px 82px)');
  assert.equal(reveal[1].offset, fade[1].offset);
  assert.equal(fade[1].opacity, 1);
  assert.deepEqual(reveal[2], { opacity:1, clipPath:'inset(0px)' });

  const interrupted = lyricsReturnFlight({ ...source, scale:1.5, font:20, word:{ ...source.word, height:35 } }, target, 'ease');
  assert.equal(interrupted.travel[0].transform, 'translate3d(0px, 0px, 0) scale(1.5)');
  assert.equal(interrupted.travel[1].transform, 'translate3d(-390px, 80px, 0) scale(0.6)');
});

test('closing after manual scrolling anchors the flight to a visible lyric', () => {
  const begin = app.indexOf('function lyricsFlightSource(');
  const end = app.indexOf('const playbackCaptureTaps', begin);
  const lineAt = (top, bottom) => ({
    rect: { top, bottom, height:bottom - top },
    getBoundingClientRect() { return this.rect; },
  });
  const hidden = lineAt(200, 220), center = lineAt(132, 152), edge = lineAt(85, 105);
  const layer = animationElement();
  layer.setAttribute = () => {};
  const list = { style:{ width:'100px' }, scrollTop:90, cloneNode:() => layer,
    getBoundingClientRect:() => ({ left:50, width:100, height:120, top:80, bottom:200 }) };
  const harness = hookHarness(`${app.slice(begin, end)}\nexport { lyricsFlightSource };`, {}, {
    lyricOpeningWordRect: line => line?.rect,
    getComputedStyle: () => ({ getPropertyValue:() => '0px', fontSize:'16px' }),
  });
  const snapshot = harness.exports.lyricsFlightSource(list, hidden, [edge, center, hidden]);
  assert.equal(snapshot.line, center);
  assert.equal(snapshot.word, center.rect);
  assert.equal(snapshot.scrollTop, 90);
});

test('the compact lyrics layout is already final before the departing layer is removed', () => {
  const begin = app.indexOf('  useLayoutEffect(() => {', app.indexOf('const lyricsVisible ='));
  const end = app.indexOf('  useEffect(() => {', begin);
  const list = animationElement(), layer = animationElement();
  const layout = { left:12, top:80, width:240, height:180, right:252, bottom:260 };
  const compactSlot = { getBoundingClientRect: () => layout };
  let layerMounted = false;
  list.classList = { toggle() {} };
  list.after = node => { assert.equal(node, layer); layerMounted = true; };
  layer.remove = () => { layerMounted = false; };
  const flightRef = { current: null };
  const harness = hookHarness(`export function Setup() { ${app.slice(begin, end)} }`, {}, {
    bodyRef:{ current:list }, compactLinesSlotRef:{ current:compactSlot }, fullScreen:false, reduced:false, lyricsVisible:true,
    lyricsLayoutRef:{ current:{ list, fullScreen:true, visible:true } }, lyricsFlightRef:flightRef,
    lyricsExitSourceRef:{ current:{ layer, rect:{ left:400, top:50, width:500, height:420 }, scale:1, scrollTop:90 } },
    lineRefs:{ current:[] }, activeLyricsLineRef:{ current:-1 }, autoUntilRef:{ current:0 }, userScrollRef:{ current:0 },
    stopSmoothScroll() {}, lyricOpeningWordRect:() => null, lyricsReturnFlight, HERO_DUR_MS:430, HERO_EASE:'ease',
    window:{ addEventListener() {}, removeEventListener() {} }, ResizeObserver:class { observe() {} disconnect() {} },
  });
  harness.render(harness.exports.Setup);
  assert.equal(list.style.width, '240px');
  assert.equal(list.style.height, '180px');
  assert.equal(layer.scrollTop, 90);
  assert.equal(layerMounted, true);
  assert.ok(layer.calls.every(animation => animation.options.duration === flightRef.current.options.duration));
  list.scrollTop = 126;
  flightRef.current.onfinish();
  assert.equal(layerMounted, false);
  assert.equal(list.scrollTop, 126);
  assert.equal(list.style.height, '180px');
  assert.equal(list.style.zIndex, '8');
  assert.equal(flightRef.current, null);
  harness.unmount();
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
  assert.match(app, /useLayoutEffect\(\(\) => \{ artReadyRef\.current = false; \}, \[playerDisplayTrack\?\.id, playerDisplayTrack\?\.coverUrl\]\)/);
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

test('replacement heroes reset exit state and only the current cover can reach the timeout fallback', () => {
  const callback = app.indexOf('  const beginHeroFlight = useCallback');
  const callbackEnd = app.indexOf('  const handleExitCoverFlightComplete', callback);
  const fallback = app.indexOf('  useLayoutEffect(() => {', app.indexOf('  // Release the source card'));
  const fallbackEnd = app.indexOf('  const artEntranceTweenRef', fallback);
  assert.ok(callback > 0 && callbackEnd > callback && fallback > callbackEnd && fallbackEnd > fallback);
  const clock = fakeClock(), exits = [];
  const entryCoverFlightRef = { current:'started' };
  const harness = hookHarness(`export function Setup() { ${app.slice(callback, callbackEnd)}
    ${app.slice(fallback, fallbackEnd)} return beginHeroFlight; }`, {}, {
    hero:{}, entryCoverFlightRef, ART_READY_WAIT_MS:900, HERO_DUR_MS:430,
    setTimeout:clock.setTimeout, clearTimeout:clock.clearTimeout,
    setHeroExiting: value => exits.push(value), setEntryCoverFlightStarted() {}, setReverseHero() {},
    setHero: value => { harness.context.hero = value; },
  });
  const replace = harness.render(harness.exports.Setup), retired = clock.queued.at(-1);
  clock.advance(400); replace({ id:2 }); harness.render(harness.exports.Setup);
  assert.equal(entryCoverFlightRef.current, 'idle');
  retired();
  assert.deepEqual(exits, [false]);
  clock.advance(1579);
  assert.deepEqual(exits, [false]);
  clock.advance(1);
  assert.equal(entryCoverFlightRef.current, 'fallback');
  assert.deepEqual(exits, [false, true]);

  replace({ id:3 }); harness.render(harness.exports.Setup);
  entryCoverFlightRef.current = 'complete';
  clock.advance(1580);
  assert.deepEqual(exits, [false, true, false]);
  harness.unmount();
  assert.equal(clock.timers.size, 0);
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
  assert.match(app, /const MENU_VARIANTS = \{\s*hidden: \{ opacity: 0, scale: 0\.92, y: -7 \}/);
});
