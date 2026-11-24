import React from 'react';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

export function animationElement() {
  const calls = [];
  const style = {};
  Object.defineProperty(style, 'setProperty', { value(name, value) { this[name] = value; } });
  const element = { style, calls, dataset: {},
    ownerDocument: { defaultView: { getComputedStyle: () => ({ transform: element.visibleTransform || 'none', opacity: element.visibleOpacity ?? '1' }) } },
    animate(frames, options) {
      const animation = { frames, options, cancelled: false, cancel() { this.cancelled = true; } };
      calls.push(animation);
      return animation;
    },
  };
  return element;
}

export function hookHarness(source, imports = {}, globals = {}) {
  let cursor = 0;
  const slots = [], pending = [], cleanups = new Map();
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = { ...React,
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useCallback(callback, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (same(previous?.deps, deps)) return previous.callback;
      slots[index] = { callback, deps };
      return callback;
    },
    useLayoutEffect(effect, deps) {
      const index = cursor++;
      if (same(slots[index], deps)) return;
      slots[index] = deps;
      pending.push(() => { cleanups.get(index)?.(); cleanups.set(index, effect()); });
    },
    useEffect(effect, deps) { react.useLayoutEffect(effect, deps); },
  };
  const context = { module: { exports: {} }, React: react, ...react, ...globals,
    require: name => name === 'react' ? react : imports[name] || (() => { throw new Error(`unexpected import: ${name}`); })(),
  };
  vm.runInNewContext(transformSync(source, { loader: 'jsx', format: 'cjs' }).code, context);
  const attach = node => {
    if (!node || typeof node !== 'object') return;
    if (node.ref && typeof node.ref === 'object') node.ref.current ||= animationElement();
    const children = node.props?.children;
    for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) attach(child);
  };
  return {
    exports: context.module.exports, context, react,
    render(fn, ...args) {
      cursor = 0;
      const result = fn(...args);
      attach(result);
      // A hook may return its ref rather than JSX.
      if (result && Object.hasOwn(result, 'current')) result.current ||= animationElement();
      for (const effect of pending.splice(0)) effect();
      return result;
    },
    unmount() { for (const cleanup of cleanups.values()) cleanup?.(); cleanups.clear(); },
  };
}

export function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
    const result = findNode(child, predicate);
    if (result) return result;
  }
  return null;
}

export function fakeClock() {
  let now = 0, id = 0;
  const timers = new Map(), queued = [];
  return {
    timers, queued,
    get now() { return now; },
    setTimeout(callback, delay) { timers.set(++id, { callback, at: now + delay }); queued.push(callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= end);
        if (!next) break;
        const [id, timer] = next;
        now = timer.at; timers.delete(id); timer.callback();
      }
      now = end;
    },
  };
}
