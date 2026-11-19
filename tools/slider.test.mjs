import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { sliderFraction, sliderValue, pointerFraction } from '../src/slider.js';

test('horizontal and vertical pointer positions are bounded and respect the native thumb inset', () => {
  const rect = { left: 10, top: 20, width: 114, height: 100 };
  assert.equal(pointerFraction({ clientX: 17 }, rect, false, 7), 0);
  assert.equal(pointerFraction({ clientX: 117 }, rect, false, 7), 1);
  assert.equal(pointerFraction({ clientX: 67 }, rect, false, 7), 0.5);
  assert.equal(pointerFraction({ clientY: 20 }, rect, true), 1);
  assert.equal(pointerFraction({ clientY: 120 }, rect, true), 0);
  assert.equal(pointerFraction({ clientY: 70 }, rect, true), 0.5);
  assert.equal(sliderFraction(100, -12, 12), 1);
  assert.equal(sliderFraction(NaN, 0, 1), 0);
});

test('discrete values are rounded relative to minimum without float tails', () => {
  assert.equal(sliderValue(0, 0.5, 12, 0.5), 0.5);
  assert.equal(sliderValue(1, 0.5, 12, 0.5), 12);
  assert.equal(sliderValue(0.54, 0.75, 1.25, 0.01), 1.02);
  assert.equal(sliderValue(0.501, -12, 12, 0.5), 0);
});

const app = readFileSync(new URL('../src/app.jsx', import.meta.url), 'utf8');
const begin = app.indexOf('function useRail(');
const end = app.indexOf('/* вертикальный фейдер', begin);
assert.ok(begin >= 0 && end > begin);

function rail({ value = 0, min = -12, max = 12, step = 0.5, vertical = true } = {}) {
  const frames = new Map(), values = [], positions = [];
  let id = 0;
  const context = {
    sliderFraction, sliderValue, pointerFraction,
    useRef: current => ({ current }), useCallback: fn => fn, useEffect: () => {},
    useSmoothPosition: () => ({ target: { set: value => positions.push(value) }, position: {} }),
    requestAnimationFrame: callback => { frames.set(++id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
  };
  vm.runInNewContext(`${app.slice(begin, end)}\nglobalThis.use = useRail;`, context);
  const events = context.use({ value, min, max, step, vertical, onChange: value => values.push(value) });
  let capture = false;
  const target = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    setPointerCapture: () => { capture = true; }, hasPointerCapture: () => capture,
    releasePointerCapture: () => { capture = false; },
  };
  events.ref.current = target;
  const event = coords => ({ button: 0, pointerId: 1, currentTarget: target, ...coords });
  return { events, event, frames, values, positions };
}

test('EQ drag remains continuous between value steps and commits the last position on release', () => {
  const t = rail();
  t.events.onPointerDown(t.event({ clientY: 50 }));
  t.events.onPointerMove(t.event({ clientY: 50.1 }));
  t.events.onPointerMove(t.event({ clientY: 50.2 }));
  assert.equal(t.frames.size, 1, 'React receives at most one update per frame');
  assert.equal(t.values.length, 0);
  assert.notEqual(t.positions[1], t.positions[2], 'visual motion must not be snapped to the dB step');
  t.events.onPointerUp(t.event({ clientY: 50.2 }));
  assert.deepEqual(t.values, [0]);
  assert.equal(t.frames.size, 0);
  assert.equal(t.positions.at(-1), 0.5);
});

test('speed keyboard steps accumulate before render, and reset cancels stale drag updates', () => {
  const t = rail({ value: 1, min: 0.75, max: 1.25, step: 0.01, vertical: false });
  const key = { key: 'ArrowRight', preventDefault: () => {} };
  t.events.onKeyDown(key);
  t.events.onKeyDown(key);
  t.events.onPointerCancel();
  assert.deepEqual(t.values, [1.02]);
  t.events.onPointerDown(t.event({ clientX: 95 }));
  t.events.reset(1);
  assert.equal(t.values.at(-1), 1);
  assert.equal(t.frames.size, 0);
  assert.equal(t.positions.at(-1), 0.5);
});
