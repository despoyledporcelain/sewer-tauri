import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';

const app = readFileSync(new URL('../src/app.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('../src/mini-player.jsx', import.meta.url), 'utf8');
const context = { module: { exports: {} }, require: () => React };
vm.runInNewContext(transformSync(source, { loader: 'jsx', format: 'cjs' }).code, context);
const { MiniPlayer } = context.module.exports;
const labels = { player: 'Миниплеер', previous: 'Предыдущий трек', next: 'Следующий трек',
  play: 'Воспроизвести', pause: 'Пауза', untitled: 'Без названия', openPlayer: 'Открыть плеер' };
const track = { id: 42, title: 'a song', artist: 'an artist', coverUrl: 'https://example.com/cover.jpg' };
const props = { visible: true, track, isPlaying: true, labels };

function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(child => find(child, predicate));
  if (!React.isValidElement(tree)) return [];
  return [...(predicate(tree) ? [tree] : []),
    ...find(tree.props.children, predicate)];
}
const buttons = tree => find(tree, node => node.type === 'button');
const transportButtons = tree => buttons(tree).filter(node => node.props.className.includes('mini-player-button'));

test('mini transport invokes the shared callbacks in previous/play/next order', () => {
  const calls = [];
  const tree = MiniPlayer({ ...props, onPrev: () => calls.push('previous'),
    onToggle: () => calls.push('toggle'), onNext: () => calls.push('next') });
  const controls = transportButtons(tree);
  assert.equal(controls.length, 3);
  for (const control of controls) {
    assert.equal(control.props.type, 'button');
    assert.equal(control.props.disabled, false);
    assert.ok(control.props['aria-label']);
    control.props.onClick();
  }
  assert.deepEqual(calls, ['previous', 'toggle', 'next']);
  assert.equal(controls[1].props['aria-label'], labels.pause);
});

test('pause retains the transport and changes only playback state and accessible action', () => {
  const tree = MiniPlayer({ ...props, isPlaying: false });
  assert.equal(transportButtons(tree)[1].props['aria-label'], labels.play);
  const group = find(tree, node => node.props.role === 'group')[0];
  assert.equal(group.props['data-visible'], 'true');
  assert.equal(group.props['data-playing'], 'false');
  assert.equal(group.props.inert, undefined);
  assert.equal(group.props['aria-hidden'], false);
});

test('cover and title share an open-player button, separate from playback controls', () => {
  const calls = [];
  const tree = MiniPlayer({ ...props, onOpen: () => calls.push('open'),
    onPrev: () => calls.push('previous'), onToggle: () => calls.push('toggle'), onNext: () => calls.push('next') });
  const open = buttons(tree).find(node => node.props.className === 'mini-player-track');
  assert.equal(open.props.type, 'button');
  assert.equal(open.props['aria-label'], `${labels.openPlayer}: ${track.title}`);
  assert.equal(find(open, node => node.props.className === 'mini-player-cover').length, 1);
  assert.equal(find(open, node => node.props.className === 'mini-player-title').length, 1);
  assert.equal(find(open, node => node.type === 'button').length, 1);
  open.props.onClick();
  assert.deepEqual(calls, ['open']);
  for (const control of transportButtons(tree)) control.props.onClick();
  assert.deepEqual(calls, ['open', 'previous', 'toggle', 'next']);
});

test('hidden transport cannot be clicked, focused or announced', () => {
  const tree = MiniPlayer({ ...props, visible: false });
  const group = find(tree, node => node.props.role === 'group')[0];
  assert.equal(group.props['data-visible'], 'false');
  assert.equal(group.props['aria-hidden'], true);
  assert.equal(group.props.inert, '');
  for (const control of buttons(tree)) {
    assert.equal(control.props.disabled, true);
    assert.equal(control.props.tabIndex, -1);
    assert.equal(control.props.onClick, undefined);
  }
});

test('metadata is escaped, missing artwork has a fallback and failed artwork can recover', () => {
  const html = renderToStaticMarkup(React.createElement(MiniPlayer,
    { ...props, track: { title: '<script>no</script>', artist: 'a & b' } }));
  assert.ok(html.includes('&lt;script&gt;no&lt;/script&gt;'));
  assert.ok(html.includes('a &amp; b'));
  assert.equal(html.includes('<img'), false);
  assert.ok(renderToStaticMarkup(React.createElement(MiniPlayer,
    { ...props, track: {} })).includes(labels.untitled));
  const image = find(MiniPlayer(props), node => node.type === 'img')[0];
  assert.equal(image.props.alt, '');
  assert.equal(image.key, track.coverUrl);
  const element = { hidden: false };
  image.props.onError({ currentTarget: element });
  assert.equal(element.hidden, true);
  const replacement = find(MiniPlayer({ ...props, track: { ...track, coverUrl: 'new-cover' } }),
    node => node.type === 'img')[0];
  assert.notEqual(replacement.key, image.key);
});

function topbar() {
  const functionSource = app.slice(app.indexOf('function TopBar('), app.indexOf('/* ── примитивы настроек'));
  const effects = [], observers = [], properties = new Map();
  const fakeBar = { clientWidth: 900, style: {
    setProperty: (name, value) => properties.set(name, value), removeProperty: name => properties.delete(name),
  } };
  const context = { React, MiniPlayer, useLang: () => key => key, useRef: initial => ({ current: initial }),
    useState: initial => [initial, () => {}], useLayoutEffect: effect => effects.push(effect),
    createPortal: tree => tree, NavIcon: () => null, HistoryIcon: () => null,
    document: { getElementById: () => fakeBar },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
      observe(target) { this.targets.push(target); }
      disconnect() { this.disconnected = true; }
    } };
  vm.runInNewContext(transformSync(`${functionSource}\nglobalThis.TopBar = TopBar;`,
    { loader: 'jsx' }).code, context);
  return { TopBar: context.TopBar, effects, fakeBar, properties, observers };
}

test('top bar shows the mini player only outside the player with an actual selected track', () => {
  const { TopBar } = topbar();
  for (const hasTrack of [false, true]) {
    for (const inPlayer of [false, true]) {
      const onPrev = () => {}, onNext = () => {}, onTogglePlayback = () => {};
      const tree = TopBar({ hasTrack, inPlayer, track, isPlaying: false, onPrev, onNext, onTogglePlayback });
      const mini = find(tree, node => node.type === MiniPlayer)[0];
      assert.equal(mini.props.visible, hasTrack && !inPlayer);
      assert.equal(mini.props.track, track);
      assert.equal(mini.props.onPrev, onPrev);
      assert.equal(mini.props.onNext, onNext);
      assert.equal(mini.props.onToggle, onTogglePlayback);
    }
  }
});

test('appearance preference hides the mini player during playback and pause without touching transport', () => {
  const { TopBar } = topbar();
  for (const isPlaying of [false, true]) {
    for (const hideMiniPlayer of [undefined, false, true]) {
      const tree = TopBar({ hasTrack: true, inPlayer: false, track, isPlaying, hideMiniPlayer });
      const mini = find(tree, node => node.type === MiniPlayer)[0];
      assert.equal(mini.props.visible, !hideMiniPlayer);
      assert.equal(mini.props.isPlaying, isPlaying);
      assert.equal(mini.props.track, track);
    }
  }
});

test('opening from the mini player follows the existing full-player navigation route', () => {
  const { TopBar } = topbar();
  const destinations = [];
  const tree = TopBar({ hasTrack: true, inPlayer: false, track, onNav: id => destinations.push(id) });
  const mini = find(tree, node => node.type === MiniPlayer)[0];
  mini.props.onOpen();
  assert.deepEqual(destinations, ['library']);
  assert.equal(mini.props.labels.openPlayer, 'mini_player_open');
});

test('mini player preference defaults to visible, preserves old preferences and participates in show all', () => {
  const defaults = app.slice(app.indexOf('const UI_HIDDEN_NONE ='), app.indexOf('function SettingsView('));
  const setter = app.match(/const setHidden = \(k, v\) => onSettings\(s => \(\{[\s\S]*?\}\)\);/)[0];
  let settings = { volume: 0.6, uiHidden: { source: true, sort: true } };
  const context = { onSettings: update => { settings = update(settings); } };
  vm.runInNewContext(`${defaults}\n${setter}\nglobalThis.hiddenOf = uiHiddenOf; globalThis.setHidden = setHidden;`, context);
  for (const old of [undefined, {}, { uiHidden: null }, settings]) {
    assert.equal(context.hiddenOf(old).miniPlayer, false);
  }
  context.setHidden('miniPlayer', true);
  assert.equal(settings.uiHidden.miniPlayer, true);
  assert.equal(settings.uiHidden.source, true);
  assert.equal(settings.uiHidden.sort, true);
  // Another control may write before the mini player's next render.
  context.setHidden('volume', true);
  context.setHidden('miniPlayer', false);
  assert.equal(settings.uiHidden.volume, true);
  context.setHidden('miniPlayer', true);
  context.setHidden(null);
  assert.equal(Object.values(settings.uiHidden).some(Boolean), false);
  assert.equal(settings.uiHidden.miniPlayer, false);
  assert.equal(settings.volume, 0.6);
});

test('appearance switch is wired to persisted UI preferences with Russian and English copy', () => {
  assert.match(app, /<Row label=\{t\('ui_hide_mini_player'\)\} sub=\{t\('ui_hide_mini_player_sub'\)\}>\s*<Switch on=\{!!uiHidden\.miniPlayer\} onChange=\{v => setHidden\('miniPlayer', v\)\}/);
  assert.match(app, /hideMiniPlayer=\{uiHidden\.miniPlayer\}/);
  for (const key of ['ui_hide_mini_player', 'ui_hide_mini_player_sub']) {
    assert.equal((app.match(new RegExp(`\\b${key}:`, 'g')) || []).length, 2);
  }
});

test('the left lane tracks actual titlebar size without moving centered navigation', () => {
  const t = topbar();
  const tree = t.TopBar({ navActive: 'home', hasTrack: true, inPlayer: false, track });
  const nav = find(tree, node => node.ref && typeof node.ref !== 'function')[0];
  nav.ref.current = { offsetWidth: 152 };
  find(tree, node => node.key === 'library')[0].ref({ offsetLeft: 76, offsetWidth: 38 });
  const cleanup = t.effects[1]();
  assert.equal(t.properties.get('--topbar-left-width'), '345px');
  assert.equal(t.observers[0].targets.length, 2);
  t.fakeBar.clientWidth = 600;
  t.observers[0].callback();
  assert.equal(t.properties.get('--topbar-left-width'), '195px');
  cleanup();
  assert.equal(t.observers[0].disconnected, true);
  assert.equal(t.properties.has('--topbar-left-width'), false);
});

test('app owns transport and navigation, with Russian and English accessible labels', () => {
  const integration = app.slice(app.indexOf('<TopBar navActive='), app.indexOf('/>', app.indexOf('<TopBar navActive=')));
  assert.match(integration, /onPrev=\{handlePrev\} onNext=\{handleNext\}/);
  assert.match(integration, /onTogglePlayback=\{togglePlayback\}/);
  assert.doesNotMatch(source, /new Audio|setView|onNav|\.play\(|requestAnimationFrame/);
  for (const key of ['mini_player', 'mini_player_open', 'playback_previous', 'playback_next', 'playback_play', 'playback_pause', 'track_untitled']) {
    assert.equal((app.match(new RegExp(`\\b${key}:`, 'g')) || []).length, 2);
  }
});

test('room guests retain open-player navigation but cannot focus or invoke mini transport controls', () => {
  const calls = [];
  const tree = MiniPlayer({ ...props, visible: true, transportLocked: true,
    onPrev: () => calls.push('prev'), onToggle: () => calls.push('play'), onNext: () => calls.push('next') });
  const buttons = find(tree, node => node.type === 'button' && String(node.props.className).includes('mini-player-button'));
  for (const button of buttons) {
    assert.equal(button.props.disabled, true);
    assert.equal(button.props.tabIndex, -1);
    assert.equal(button.props.onClick, undefined);
  }
  assert.deepEqual(calls, []);
  assert.equal(find(tree, node => node.props.className === 'mini-player-track')[0].props.disabled, false);
});

test('layout keeps centered navigation, collapses metadata first and honors reduced motion', () => {
  assert.match(app, /bar\.clientWidth \/ 2 - playerCenter - 10/);
  assert.match(css, /container-type:inline-size/);
  assert.match(css, /@container \(max-width:220px\)[\s\S]*?\.mini-player-meta \{ display:none; \}/);
  assert.match(css, /@container \(max-width:140px\)[\s\S]*?\.mini-player-cover \{ display:none; \}/);
  assert.match(css, /prefers-reduced-motion:reduce[\s\S]*?\.mini-player, \.mini-player\[data-visible="true"\] \{ transform:none; transition:opacity 120ms ease-out, visibility 120ms;/);
  assert.match(css, /\.mini-player-button, \.mini-player-button:not\(:disabled\):active \{ transform:none; transition:color 140ms ease, background-color 140ms ease;/);
});

test('open-player area stays visually quiet on hover without changing transport hover feedback', () => {
  assert.doesNotMatch(css, /\.mini-player-track[^{}]*:hover/);
  assert.match(css, /\.mini-player-button:not\(:disabled\):hover/);
});
