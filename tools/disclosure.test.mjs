import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { transformSync } from 'esbuild';
import { snapshotDisclosures, animateDisclosureLayout } from '../src/disclosure-motion.js';

class Element {
  children = [];
  attributes = new Map();
  calls = [];
  constructor(parent = null, top = 0, height = 40) {
    this.parentElement = parent;
    parent?.children.push(this);
    this.rect = { left: 0, top, width: 200, height };
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  getBoundingClientRect() { return { ...this.rect }; }
  contains(element) { return element === this || this.children.some(child => child.contains(element)); }
  closest() {
    for (let element = this; element; element = element.parentElement) {
      if (element.hasAttribute('data-disclosure') && element.getAttribute('data-open') === 'false') return element;
    }
    return null;
  }
  querySelectorAll() {
    return this.children.flatMap(child => [
      ...(child.hasAttribute('data-disclosure') ? [child] : []), ...child.querySelectorAll(),
    ]);
  }
  querySelector() { return this.children.find(child => child.hasAttribute('data-disclosure-background')) ?? null; }
  animate(frames, options) {
    const animation = { cancelled: false, cancel() { this.cancelled = true; this.oncancel?.(); } };
    this.calls.push({ frames, options, animation });
    return animation;
  }
}

function scene() {
  const root = new Element();
  const card = new Element(root, 0, 60);
  const surface = new Element(card, 0, 60);
  surface.setAttribute('data-disclosure-surface', '');
  const background = new Element(surface, 0, 60);
  background.setAttribute('data-disclosure-background', '');
  const toggle = new Element(surface, 0, 60);
  const disclosure = new Element(surface, 60, 0);
  disclosure.setAttribute('data-disclosure', '');
  disclosure.setAttribute('data-open', 'false');
  const controls = new Element(disclosure);
  const nextCard = new Element(root, 80, 100);
  const unrelatedControl = new Element(nextCard);
  return { root, card, surface, background, toggle, disclosure, controls, nextCard, unrelatedControl };
}

test('snapshots visit surrounding branches, not every control in the page', () => {
  const t = scene();
  const before = snapshotDisclosures(t.root);
  assert.ok(before.has(t.nextCard));
  assert.ok(before.has(t.surface));
  assert.ok(before.has(t.toggle));
  assert.equal(before.has(t.controls), false);
  assert.equal(before.has(t.unrelatedControl), false);
});

test('opening moves neighbours and the background with transforms, without scaling text', () => {
  const t = scene(), animations = new Set();
  const before = snapshotDisclosures(t.root);
  t.disclosure.setAttribute('data-open', 'true');
  t.surface.rect.height = t.card.rect.height = 260;
  t.nextCard.rect.top = 280;
  animateDisclosureLayout(before, t.root, false, animations);
  assert.equal(t.nextCard.calls[0].frames[0].transform, 'translate(0px, -200px)');
  assert.equal(t.nextCard.calls[0].options.duration, 240);
  assert.equal(t.background.calls[0].frames[0].transform, `scaleY(${60 / 260})`);
  assert.equal(t.controls.calls.length, 0);
  for (const element of [t.nextCard, t.background]) {
    for (const frame of element.calls[0].frames) assert.deepEqual(Object.keys(frame), ['transform']);
  }
});

test('nested branches subtract the inherited translation', () => {
  const root = new Element(), parent = new Element(root, 100), child = new Element(parent, 130);
  const before = new Map([
    [parent, { rect: { ...parent.rect } }], [child, { rect: { ...child.rect } }],
  ]);
  parent.rect.top = 200;
  child.rect.top = 250;
  animateDisclosureLayout(before, root, false, new Set());
  assert.equal(parent.calls[0].frames[0].transform, 'translate(0px, -100px)');
  assert.equal(child.calls[0].frames[0].transform, 'translate(0px, -20px)');
});

test('rapid reversal cancels old animations and continues from the visible background', () => {
  const t = scene(), animations = new Set();
  t.disclosure.setAttribute('data-open', 'true');
  t.surface.rect.height = 260;
  t.background.rect.height = 150; // Visible mid-expansion, not the 260px layout endpoint.
  t.nextCard.rect.top = 190;
  const previous = t.nextCard.animate([], {});
  animations.add(previous);
  const before = snapshotDisclosures(t.root);
  t.disclosure.setAttribute('data-open', 'false');
  t.surface.rect.height = 60;
  t.nextCard.rect.top = 80;
  animateDisclosureLayout(before, t.root, false, animations);
  assert.equal(previous.cancelled, true);
  assert.equal(t.nextCard.calls.at(-1).frames[0].transform, 'translate(0px, 110px)');
  assert.equal(t.nextCard.calls.at(-1).options.duration, 180);
  assert.equal(t.background.calls.at(-1).frames[0].transform, 'scaleY(2.5)');
  t.background.calls.at(-1).animation.onfinish();
  assert.equal(animations.has(t.background.calls.at(-1).animation), false);
});

test('reduced motion cancels pending transitions and skips new ones', () => {
  const t = scene(), animations = new Set();
  const previous = t.nextCard.animate([], {});
  animations.add(previous);
  animateDisclosureLayout(snapshotDisclosures(t.root), t.root, true, animations);
  assert.equal(previous.cancelled, true);
  assert.equal(animations.size, 0);
  assert.equal(t.background.calls.length, 0);
});

test('removed branches and a missing Web Animations API are safe', () => {
  const t = scene(), before = snapshotDisclosures(t.root);
  t.root.children = [t.card];
  t.surface.rect.height = 260;
  t.background.animate = undefined;
  animateDisclosureLayout(before, t.root, false, new Set());
  assert.equal(t.nextCard.calls.length, 0);
});

// Execute the actual JSX component with a tiny hook harness. No application,
// WebView, audio or browser is started by these checks.
const source = transformSync(readFileSync(new URL('../src/disclosure.jsx', import.meta.url), 'utf8'),
  { loader: 'jsx', format: 'cjs' }).code;
function disclosureHarness() {
  const hooks = [], effects = [];
  let cursor = 0;
  const react = {
    ...React,
    useRef(initial) { return hooks[cursor++] ??= { current: initial }; },
    useState(initial) {
      const index = cursor++;
      hooks[index] ??= initial;
      return [hooks[index], next => { hooks[index] = next; }];
    },
    useLayoutEffect(effect) { effects.push(effect); },
  };
  const context = { module: { exports: {} }, require: id => id === 'react' ? react
    : id === 'framer-motion' ? { useReducedMotion: () => false }
      : { snapshotDisclosures, animateDisclosureLayout } };
  vm.runInNewContext(source, context);
  return {
    ...context.module.exports,
    render(props) {
      cursor = 0;
      const tree = context.module.exports.Disclosure(props);
      for (const effect of effects.splice(0)) effect();
      return tree;
    },
  };
}

test('closed controls are hidden, inert and absent from accessibility navigation', () => {
  const t = disclosureHarness();
  const closed = t.render({ open: false, children: 'control' });
  assert.equal(closed.props['data-open'], 'false');
  assert.equal(closed.props.children.props.hidden, true);
  assert.equal(closed.props.children.props.inert, '');
  assert.equal(closed.props.children.props['aria-hidden'], true);
  const opened = t.render({ open: true, children: 'updated control' });
  assert.equal(opened.props.children.props.hidden, false);
  assert.equal(opened.props.children.props.inert, undefined);
  assert.equal(opened.props.children.props.children, 'updated control');
});

test('closing keeps the last controls until its own exit finishes; rapid reopen wins', () => {
  const t = disclosureHarness();
  t.render({ open: true, children: 'last visible control' });
  const closing = t.render({ open: false, children: null }).props.children;
  assert.equal(closing.props.hidden, false);
  assert.equal(closing.props.children, 'last visible control');
  const target = {};
  closing.props.onTransitionEnd({ target, currentTarget: target, propertyName: 'opacity' });
  assert.equal(t.render({ open: false }).props.children.props.hidden, false);
  closing.props.onTransitionEnd({ target, currentTarget: target, propertyName: 'clip-path' });
  assert.equal(t.render({ open: false }).props.children.props.hidden, true);
  const reopened = t.render({ open: true, children: 'new control' }).props.children;
  reopened.props.onTransitionEnd({ target, currentTarget: target, propertyName: 'clip-path' });
  assert.equal(reopened.props.hidden, false);
});

test('keyboard toggles skip motion, while pointer interaction restores it', () => {
  const t = disclosureHarness();
  const layout = new t.DisclosureLayout({ motionKey: 'closed', reduced: false });
  layout.props = { motionKey: 'closed', reduced: false };
  layout.root.current = new Element();
  const rendered = layout.render();
  rendered.props.onKeyDownCapture({ key: 'Enter' });
  assert.equal(layout.instant, true);
  assert.ok(layout.root.current.hasAttribute('data-instant'));
  assert.equal(layout.getSnapshotBeforeUpdate({ motionKey: 'open' }), null);
  rendered.props.onPointerDownCapture();
  assert.equal(layout.instant, false);
  assert.equal(layout.root.current.hasAttribute('data-instant'), false);
  assert.ok(layout.getSnapshotBeforeUpdate({ motionKey: 'open' }) instanceof Map);
});

test('playback settings keep crossfade, speed and pitch; EQ remains only in the player', () => {
  const app = readFileSync(new URL('../src/app.jsx', import.meta.url), 'utf8');
  const playback = app.slice(app.indexOf('    playback: ('), app.indexOf('    lyrics: (', app.indexOf('    playback: (')));
  for (const key of ['speed', 'pitch', 'hold_pitch']) assert.ok(playback.includes(`t('${key}')`));
  assert.ok(playback.includes('<CrossfadeControls settings={settings} onSettings={onSettings}/>'));
  assert.equal(playback.includes('eq'), false);
  assert.equal((playback.match(/<Card/g) || []).length, 1);
  assert.ok(app.slice(app.indexOf('function FxPanel('), app.indexOf('/* ── HomeCard')).includes('<EqFader'));
  assert.equal(app.includes('maxHeight: settings.discordRpc'), false);
  const crossfade = app.slice(app.indexOf('function CrossfadeControls('), app.indexOf('function ClearCacheCard('));
  assert.ok(crossfade.includes('<Disclosure open={config.seconds > 0}>'));
  for (const key of ['crossfade_length', 'crossfade_curve', 'crossfade_smart', 'crossfade_intro']) {
    assert.ok(crossfade.includes(`t('${key}')`));
  }
  assert.ok(app.includes('crossfadeSettings(settings).seconds > 0,'));
});

test('disclosures animate their first opening after the content was hidden', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.ok(css.includes('@starting-style'));
  assert.ok(css.includes('.disclosure[data-open="true"] > .disclosure-content'));
});

test('active chips have their own stationary fills, never shared layout projections', () => {
  const app = readFileSync(new URL('../src/app.jsx', import.meta.url), 'utf8');
  const start = app.indexOf('function SelectionFill(');
  const end = app.indexOf('function Segmented(', start);
  const component = transformSync(`${app.slice(start, end)}\nexport { SelectionFill };`,
    { loader: 'jsx', format: 'cjs' }).code;
  const context = { React, module: { exports: {} } };
  vm.runInNewContext(component, context);
  const fill = context.module.exports.SelectionFill;
  for (const active of [false, true, false, true]) {
    const node = fill({ active, style: { position: 'absolute' } });
    assert.equal(node.type, 'div');
    assert.equal(node.props['aria-hidden'], 'true');
    assert.equal(node.props['data-active'], String(active));
    assert.equal(node.props.layoutId, undefined);
    assert.equal(node.props.style.transform, undefined);
  }
  assert.equal(app.includes('layoutId='), false);
  assert.equal((app.match(/<SelectionFill active=/g) || []).length, 4);
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.selection-fill \{ opacity:0; pointer-events:none; transition:opacity 140ms ease-out; \}/);
  assert.match(css, /\.selection-fill\[data-active="true"\] \{ opacity:1; \}/);
  assert.ok(css.includes('.selection-fill, .disclosure-content { transition:none !important; }'));
});
