import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import * as lifecycle from '../src/motion-lifecycle.js';
import { hookHarness, animationElement, findNode } from './motion-harness.mjs';

const app = readFileSync(new URL('../src/app.jsx', import.meta.url), 'utf8');
const feedbackHook = readFileSync(new URL('../src/use-motion-feedback.js', import.meta.url), 'utf8');

test('track feedback is a two-phase 160ms transform pulse with no pinned inline style', () => {
  const el = animationElement(), owner = lifecycle.createFeedbackMotion(el);
  owner.pulse(); const animation = el.calls[0];
  assert.deepEqual(animation.frames, [{ transform: 'scale(1)' }, { transform: 'scale(0.97)', offset: 0.5 }, { transform: 'scale(1)' }]);
  assert.deepEqual(animation.options, { duration: 160, easing: lifecycle.FEEDBACK_EASE });
  animation.onfinish(); assert.equal(animation.cancelled, true); assert.deepEqual(el.style, {});
});

test('rapid pulse starts from rendered geometry and a stale completion cannot cancel its successor', () => {
  const el = animationElement(), owner = lifecycle.createFeedbackMotion(el);
  owner.pulse(); const first = el.calls[0]; el.visibleTransform = 'matrix(0.985, 0, 0, 0.985, 0, 0)';
  owner.pulse(); const second = el.calls[1];
  assert.equal(first.cancelled, true); assert.equal(second.frames[0].transform, el.visibleTransform);
  first.onfinish(); assert.equal(second.cancelled, false);
  owner.cancel(); assert.equal(second.cancelled, true); assert.deepEqual(el.style, {});
  owner.pulse(true); assert.equal(el.calls.length, 2);
  assert.doesNotThrow(() => lifecycle.createFeedbackMotion({ style: {} }).pulse());
});

test('actual PlayBtn does not pulse on mount, repeats on tracks and keeps its transport button/press layer', () => {
  let reduced = false;
  const begin = app.indexOf('function PlayBtn('), end = app.indexOf('/* ── NavIcon', begin);
  assert.ok(begin > 0 && end > begin);
  const harness = hookHarness(`${app.slice(begin, end)}\nexport { PlayBtn };`, {}, {
    motion: { button: 'button', path: 'path' }, useReducedMotion: () => reduced,
    createFeedbackMotion: lifecycle.createFeedbackMotion, isFineHover: event => event.pointerType === 'mouse',
  });
  let toggles = 0;
  const props = { isPlaying: true, trackKey: 'one', onToggle: () => toggles++, title: 'pause' };
  const render = () => harness.render(harness.exports.PlayBtn, props);
  let tree = render(); const layer = findNode(tree, node => node.ref && node.type === 'span').ref.current;
  assert.equal(tree.type, 'button'); assert.equal(tree.key, null); assert.equal(layer.calls.length, 0);
  assert.equal(tree.props.whileTap.scale, 0.95); tree.props.onClick(); assert.equal(toggles, 1);
  assert.equal(tree.props['data-playing'], true);
  const pause = findNode(tree, node => node.type === 'path');
  assert.equal(pause.props.initial, false);
  assert.equal(pause.props.transition.duration, 0.24);
  props.isPlaying = false; tree = render();
  assert.equal(tree.props['data-playing'], false);
  const play = findNode(tree, node => node.type === 'path');
  assert.notEqual(play.props.animate.d, pause.props.animate.d);
  assert.deepEqual(play.props.animate.d.match(/[MLQZ]/g), pause.props.animate.d.match(/[MLQZ]/g));
  assert.equal(layer.calls.length, 0, 'playback state uses the icon morph only');
  props.trackKey = 'two'; tree = render(); assert.equal(layer.calls.length, 1);
  props.trackKey = 'three'; tree = render(); assert.equal(layer.calls.length, 2); assert.equal(layer.calls[0].cancelled, true);
  assert.equal(tree.ref, null); assert.equal(tree.props.animate, undefined);
  reduced = true; tree = render(); assert.equal(layer.calls[1].cancelled, true); assert.equal(tree.props.whileTap, undefined);
  assert.equal(tree.props['data-reduced-motion'], true);
  assert.equal(findNode(tree, node => node.type === 'path').props.transition.duration, 0);
  props.trackKey = 'four'; render(); assert.equal(layer.calls.length, 2);
  reduced = false; render(); assert.equal(layer.calls.length, 2, 'preference alone does not add a pulse');
  props.disabled = true; props.trackKey = 'five'; tree = render(); assert.equal(layer.calls.length, 2); assert.equal(tree.props.disabled, true);
  props.disabled = false; props.trackKey = 'six'; render(); harness.unmount(); assert.equal(layer.calls.at(-1).cancelled, true);
});

test('opacity acknowledgment retargets only its local layer and missing WAAPI stays fully visible', () => {
  const el = animationElement(), owner = lifecycle.createFeedbackMotion(el);
  owner.acknowledge(160); const first = el.calls[0];
  assert.deepEqual(first.frames, [{ opacity: 0.45 }, { opacity: 1 }]);
  el.visibleOpacity = '0.7'; owner.acknowledge(160);
  assert.equal(first.cancelled, true); assert.equal(el.calls[1].frames[0].opacity, '0.7');
  assert.equal(el.calls[1].options.duration, 160); assert.equal(el.calls[1].options.easing, lifecycle.FEEDBACK_EASE);
  owner.acknowledge(180, true); assert.equal(el.calls[1].cancelled, true); assert.equal(el.calls.length, 2);
  const unsupported = { style: {} }; lifecycle.createFeedbackMotion(unsupported).acknowledge(180);
  assert.deepEqual(unsupported.style, {});
});

test('real success hook excludes initial saved/errors, cancels on preference updates and cleans unmount', () => {
  let reduced = false;
  const harness = hookHarness(feedbackHook, {
    './use-motion-preference.js': { useReducedMotion: () => reduced }, './motion-lifecycle.js': lifecycle,
  });
  const render = status => harness.render(harness.exports.useSuccessFeedback, status, 180);
  const ref = render('saved'); assert.equal(ref.current.calls.length, 0);
  render('dirty'); render('error'); assert.equal(ref.current.calls.length, 0);
  render('saving'); render('error'); assert.equal(ref.current.calls.length, 0);
  render('saving'); render('saved'); assert.equal(ref.current.calls.length, 1);
  assert.equal(ref.current.calls[0].options.duration, 180);
  reduced = true; render('saved'); assert.equal(ref.current.calls[0].cancelled, true);
  render('saving'); render('saved'); assert.equal(ref.current.calls.length, 1);
  reduced = false; render('saving'); render('saved'); assert.equal(ref.current.calls.length, 2);
  harness.unmount(); assert.equal(ref.current.calls[1].cancelled, true);
});

test('room-copy uses the real clipboard result, fixed icon slot and immediate accessible status', async () => {
  const source = readFileSync(new URL('../src/listening-party.jsx', import.meta.url), 'utf8');
  const begin = source.indexOf('  const copy = async () => {'), end = source.indexOf('\n  return <section', begin);
  assert.ok(begin > 0 && end > begin);
  const body = source.slice(begin, end);
  const results = [];
  let reject = true;
  const harness = hookHarness(`${body}\nexport { copy };`, {}, {
    state: { room: { code: 'ABC234' } }, dispatch: result => results.push(result),
    navigator: { clipboard: { writeText: async code => { assert.equal(code, 'ABC234'); if (reject) throw new Error('denied'); } } },
  });
  await harness.exports.copy(); assert.equal(results[0].ok, false);
  reject = false; await harness.exports.copy(); assert.equal(results[1].ok, true);
  assert.match(source, /useSuccessFeedback\(state\.copied \? 'saved' : 'saving', 160\)/);
  assert.match(source, /ref=\{copiedFeedbackRef\} className="party-copy-icon"/);
  assert.match(source, /party-copy-status" role="status">\{copyStatus\}/);
  const css = readFileSync(new URL('../src/listening-party.css', import.meta.url), 'utf8');
  assert.match(css, /\.party-copy-icon \{[^}]*width:14px; height:14px;/);
});

test('artist play-all press is pointer-only, disabled is real and transport executes immediately', () => {
  const begin = app.indexOf('<button type="button" className="artist-play-all"');
  const end = app.indexOf('</button>', begin) + '</button>'.length;
  assert.ok(begin > 0 && end > begin);
  const tracks = [{ id: 1 }, { id: 2 }], calls = [];
  const harness = hookHarness(`export function Button({ canPlay }) { return (${app.slice(begin, end)}); }`, {}, {
    artistTracks: tracks, onPlayTrack: (...args) => calls.push(args), t: key => key,
  });
  let tree = harness.render(harness.exports.Button, { canPlay: false });
  const target = { dataset: {}, style: {} }, event = { currentTarget: target, button: 0, pointerType: 'mouse' };
  tree.props.onPointerDown(event); tree.props.onClick(); assert.equal(tree.props.disabled, true);
  assert.deepEqual(calls, []); assert.deepEqual(target.dataset, {});
  tree = harness.render(harness.exports.Button, { canPlay: true }); tree.props.onPointerDown(event);
  assert.equal(target.dataset.pointerPressed, 'true'); tree.props.onClick(); assert.deepEqual(calls, [[tracks[0], tracks]]);
  tree.props.onPointerUp(event); assert.deepEqual(target.dataset, {});
  tree.props.onPointerDown(event); tree.props.onKeyDown({ ...event, key: 'Enter' }); assert.deepEqual(target.dataset, {});
  tree.props.onClick(); assert.equal(calls.length, 2);
  for (const cleanup of ['onPointerCancel', 'onPointerLeave', 'onBlur']) {
    tree.props.onPointerDown(event); tree.props[cleanup](event); assert.deepEqual(target.dataset, {});
  }
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.artist-play-all, \.artist-follow \{[^}]*transition:[^;]*transform 120ms var\(--ease-out\);/);
  assert.match(css, /\.artist-play-all\[data-pointer-pressed="true"\]:not\(:disabled\) \{ transform:scale\(0\.97\); \}/);
  assert.doesNotMatch(css, /\.artist-play-all:active/);
});

test('saved and Discord feedback remain local and do not modify saving/RPC/playback logic', () => {
  assert.match(app, /useSuccessFeedback\(status, 180\)/);
  assert.match(app, /setStatus\(artFailed \? 'error' : 'saved'\)/);
  assert.match(app, /if \(!\(await verify\(\)\)\)[\s\S]*?setStatus\('error'\)/);
  assert.match(app, /<span ref=\{savedFeedbackRef\} role="status">\{STATUS\.text\}<\/span>/);
  const begin = app.indexOf('width:6, height:6, borderRadius:\'50%\', background:map.c');
  assert.ok(begin > 0);
  const dot = app.slice(begin, app.indexOf('/>', begin));
  assert.match(dot, /transition:'background-color 160ms ease, box-shadow 160ms ease'/);
  assert.doesNotMatch(dot, /animation|setSettings|onClick|scale/);
});

test('playlist card keeps its normal spring but requires actual fine-mouse hover, including after a preference update', () => {
  const begin = app.indexOf('function PlaylistCard('), end = app.indexOf('/* ── PlaylistsView', begin);
  assert.ok(begin > 0 && end > begin);
  let fine = true, reduced = false;
  const harness = hookHarness(`${app.slice(begin, end)}\nexport { PlaylistCard };`, {}, {
    useReducedMotion: () => reduced, useLang: () => key => key, CoverTint: 'tint', motion: { div: 'div' },
    isFineHover: event => lifecycle.isFineHover(event, () => ({ matches: fine })),
  });
  const props = { playlist: {}, onOpen: () => {}, onEdit: () => {} }, render = () => harness.render(harness.exports.PlaylistCard, props);
  let tree = render(); assert.equal(tree.props.animate.scale, 1);
  for (const pointerType of ['touch', 'pen']) { tree.props.onPointerEnter({ pointerType }); tree = render(); assert.equal(tree.props.animate.scale, 1); }
  fine = false; tree.props.onPointerEnter({ pointerType: 'mouse' }); tree = render(); assert.equal(tree.props.animate.scale, 1);
  fine = true; tree.props.onPointerEnter({ pointerType: 'mouse' }); tree = render(); assert.equal(tree.props.animate.scale, 1.03);
  assert.equal(tree.props.transition.stiffness, 380); assert.equal(tree.props.initial.scale, 0.92);
  reduced = true; tree = render(); assert.equal(tree.props.animate.scale, 1);
  tree.props.onPointerLeave(); reduced = false; tree = render(); assert.equal(tree.props.animate.scale, 1);
  harness.unmount();
});
