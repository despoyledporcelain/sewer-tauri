import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';
import * as model from '../src/listening-party.js';
import { snapshotPartyPlayer, animatePartyPlayer, cancelPartyPlayerMotion, PARTY_PLAYER_EASE } from '../src/party-player-motion.js';

const { initialPartyState, partyReducer, cleanPartyCode, validPartyCode, sharedPartyTrack } = model;
const source = readFileSync(new URL('../src/listening-party.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/listening-party.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app.jsx', import.meta.url), 'utf8');
const jsx = transformSync(source, { loader: 'jsx', format: 'cjs' }).code;

function componentContext(react = React, extras = {}) {
  const context = { module: { exports: {} }, require: name => {
    if (name === 'react') return react;
    if (name === './listening-party.js') return model;
    // Pure JSX/SSR checks inspect the ref only; the real hook has its own lifecycle tests.
    if (name === './use-motion-feedback.js') return { useSuccessFeedback: () => ({ current: null }) };
    if (name.endsWith('.css')) return {};
    throw new Error(`unexpected import: ${name}`);
  }, ...extras };
  vm.runInNewContext(jsx, context);
  return context.module.exports;
}

const { PartySurface, PartyAvatar, partyLabels } = componentContext();
const l = partyLabels('ru');
const user = { username: 'a listener', avatarUrl: 'https://example.com/avatar.png' };
const roomState = role => {
  const state = partyReducer(initialPartyState, { type: 'session', code: 'SW7K2M', memberId: 'self', role });
  return partyReducer(state, { type: 'snapshot', code: 'SW7K2M', you: { id: 'self', role }, track: null,
    playback: { revision: 0 }, members: [
      ...(role === 'guest' ? [{ id: 'leader', role: 'host', name: 'a host', avatarUrl: null }] : []),
      { id: 'self', role, name: user.username, avatarUrl: user.avatarUrl },
    ] });
};
const host = () => roomState('host');
const guest = () => roomState('guest');
const props = state => ({ state, labels: l, user, dispatch: () => {}, onCreate: () => {},
  onJoin: () => {}, onCopy: () => {}, onClose: () => {}, onLeave: () => {}, onRetry: () => {}, onLogin: () => {} });

function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(child => find(child, predicate));
  if (!React.isValidElement(tree)) return [];
  return [...(predicate(tree) ? [tree] : []), ...find(tree.props.children, predicate)];
}
const withClass = (tree, className) => find(tree, node => node.props.className === className)[0];
const markup = state => renderToStaticMarkup(React.createElement(PartySurface, props(state)));

test('rooms omit the personal SoundCloud caption while preserving actionable errors and guest transport guidance', () => {
  for (const locale of ['ru', 'en']) {
    const labels = partyLabels(locale);
    for (const state of [initialPartyState, host()]) {
      const html = renderToStaticMarkup(React.createElement(PartySurface, { ...props(state), labels }));
      assert.doesNotMatch(html, /party-footer|soundcloud/i);
    }
    const guestHtml = renderToStaticMarkup(React.createElement(PartySurface, { ...props(guest()), labels }));
    assert.ok(guestHtml.includes(labels.followsHost));
    const failedHtml = renderToStaticMarkup(React.createElement(PartySurface, { ...props({ ...host(), playbackError: 'track_unavailable' }), labels }));
    assert.ok(failedHtml.includes(labels.error_track_unavailable));
    assert.ok(failedHtml.includes(labels.retry));
  }
  assert.doesNotMatch(source, /ownAccess|soundcloud у каждого участника|each listener uses their soundcloud/);
});

test('room codes accept separated lower-case input and reject malformed invitations', () => {
  assert.equal(cleanPartyCode(' sw7-k2m '), 'SW7K2M');
  for (const code of ['abc234', 'ABC 234', 'AB-C2-34']) assert.equal(validPartyCode(code), true);
  for (const code of ['', 'abc23', 'abc2345', 'ABC201', 'ABC!23', 'https://room.example/ABC234']) {
    assert.equal(validPartyCode(code), false);
  }
});

class MotionElement {
  hidden = false;
  opacity = 1;
  calls = [];
  style = { display: '', position: '', left: '', top: '', width: '', height: '' };
  constructor(rect, kind = null, parent = null) {
    this.rect = rect;
    this.kind = kind;
    this.parentElement = parent;
  }
  getBoundingClientRect() {
    return this.hidden && this.style.display !== 'flex'
      ? { left: 0, top: 0, width: 0, height: 0 } : { ...this.rect };
  }
  getAttribute() { return this.kind; }
  animate(frames, options) {
    // Browser cancel events are queued, not delivered inside cancel().
    const animation = { cancel() { this.cancelled = true; } };
    this.calls.push({ frames, options, animation });
    return animation;
  }
}

function motionScene() {
  const rect = (left, top, width, height) => ({ left, top, width, height });
  const root = new MotionElement(rect(100, 40, 760, 580));
  const info = new MotionElement(rect(100, 60, 760, 40), 'info', root);
  const art = new MotionElement(rect(280, 110, 400, 400));
  const artSlot = new MotionElement({ ...art.rect }, 'art', root);
  const progress = new MotionElement(rect(100, 530, 760, 30), 'progress', root);
  const controls = new MotionElement(rect(100, 580, 760, 60), 'controls', root);
  const sidebar = new MotionElement(rect(110, 60, 224, 490), null, root);
  sidebar.hidden = true;
  root.targets = [info, artSlot, progress, controls];
  root.querySelectorAll = selector => { assert.equal(selector, '[data-party-motion]'); return root.targets; };
  root.querySelector = selector => {
    if (selector === '#player-album-art') return artSlot;
    assert.equal(selector, '.party-sidebar'); return sidebar;
  };
  root.contains = element => root.targets.includes(element) || element === sidebar;
  const library = { getAnimations: () => [] };
  root.ownerDocument = {
    defaultView: { getComputedStyle: element => ({ opacity: String(element.opacity) }) },
    querySelector(selector) {
      if (selector === '[data-party-shared-art]') return art;
      assert.equal(selector, '[data-player-library-panel]'); return library;
    },
  };
  const open = () => {
    sidebar.hidden = false;
    artSlot.rect = rect(440, 150, 300, 300);
    art.rect = { ...artSlot.rect };
    info.rect = rect(350, 100, 510, 40);
    progress.rect = rect(350, 470, 510, 30);
    controls.rect.top = 550;
  };
  return { root, info, art, artSlot, progress, controls, sidebar, open };
}

test('the cover flies from its actual previous box while labels, progress and buttons move without scaling text', () => {
  const s = motionScene(), animations = new Set();
  const before = snapshotPartyPlayer(s.root);
  assert.equal(before.sidebar, null);
  assert.equal(before.elements.size, 3);
  s.open();
  animatePartyPlayer(before, s.root, { open: true }, animations);
  assert.deepEqual(s.art.calls[0].frames[0], { translate:'-160px -40px', scale:String(4 / 3) });
  assert.equal(s.art.style.width, '300px');
  for (const element of [s.info, s.progress, s.controls]) {
    const { frames, options } = element.calls[0];
    assert.equal(options.duration, 280);
    assert.equal(options.easing, PARTY_PLAYER_EASE);
    for (const frame of frames) assert.match(frame.transform, /^translate\([^)]*\)$/);
  }
  assert.equal(s.sidebar.calls[0].frames[0].opacity, 0);
  assert.equal(s.sidebar.calls[0].options.fill, 'backwards');
  assert.equal(s.sidebar.calls[0].options.delay, 40);
});

test('closing retains only an inert visual of the room and cleans up its pinned box after fading', () => {
  const s = motionScene(), animations = new Set();
  s.open();
  const before = snapshotPartyPlayer(s.root);
  s.sidebar.hidden = true;
  animatePartyPlayer(before, s.root, { open: false }, animations);
  assert.equal(s.sidebar.hidden, true);
  assert.equal(s.sidebar.style.position, 'absolute');
  assert.equal(s.sidebar.style.left, '10px');
  assert.equal(s.sidebar.style.top, '20px');
  const fade = s.sidebar.calls.at(-1);
  assert.equal(fade.frames[1].opacity, 0);
  assert.equal(fade.options.duration, 160);
  fade.animation.onfinish();
  assert.equal(s.sidebar.style.display, '');
  assert.equal(s.sidebar.style.position, '');
  assert.equal(animations.size, 0);
});

test('rapid reversals restart at the currently visible cover size and room opacity, not the old endpoints', () => {
  const s = motionScene(), animations = new Set();
  const before = snapshotPartyPlayer(s.root);
  s.open();
  animatePartyPlayer(before, s.root, { open: true }, animations);
  const previous = s.art.calls[0].animation;
  s.art.rect = { left: 330, top: 125, width: 375, height: 375 };
  s.sidebar.opacity = 0.6;
  const midFlight = snapshotPartyPlayer(s.root);
  s.artSlot.rect = before.artworkRect;
  s.sidebar.hidden = true;
  animatePartyPlayer(midFlight, s.root, { open: false }, animations);
  assert.equal(previous.cancelled, true);
  assert.deepEqual(s.art.calls.at(-1).frames[0], { translate:'50px 15px', scale:'0.9375' });
  assert.equal(s.art.calls.at(-1).options.duration, 240);
  assert.equal(s.sidebar.calls.at(-1).frames[0].opacity, 0.6);
  const oldFade = s.sidebar.calls.at(-1).animation;
  const fading = snapshotPartyPlayer(s.root);
  s.open();
  animatePartyPlayer(fading, s.root, { open: true }, animations);
  assert.equal(oldFade.cancelled, true);
  assert.equal(s.sidebar.style.position, '');
  assert.equal(s.sidebar.calls.at(-1).frames[0].opacity, 0.6);
  assert.equal(s.sidebar.calls.at(-1).options.delay, 0);
  cancelPartyPlayerMotion(animations);
  assert.equal(animations.size, 0);
});

test('queued old cancellation events cannot leave a pinned room or disturb a newer fade during button spam', () => {
  const s = motionScene(), animations = new Set();
  const pending = [];
  let before = snapshotPartyPlayer(s.root);
  for (let i = 0; i < 40; i++) {
    const open = i % 2 === 0;
    if (open) s.open();
    else s.sidebar.hidden = true;
    pending.push(...animations);
    animatePartyPlayer(before, s.root, { open }, animations);
    assert.equal(s.sidebar.style.position, open ? '' : 'absolute');
    const active = [...animations];
    const expectedPosition = s.sidebar.style.position;
    // A browser can deliver previous cancel events only after the next click.
    for (const animation of pending.splice(0)) animation.oncancel?.();
    assert.equal(s.sidebar.style.position, expectedPosition);
    assert.deepEqual([...animations], active);
    s.sidebar.opacity = open ? 0.7 : 0.3;
    before = snapshotPartyPlayer(s.root);
  }
  cancelPartyPlayerMotion(animations);
  assert.equal(s.sidebar.style.display, '');
  assert.equal(s.sidebar.style.position, '');
  assert.equal(animations.size, 0);
});

test('reduced motion, keyboard toggles, missing WAAPI and removed elements skip flights safely', () => {
  for (const preference of [{ reduced: true }, { instant: true }]) {
    const s = motionScene(), animations = new Set();
    s.open();
    const before = snapshotPartyPlayer(s.root);
    s.sidebar.hidden = true;
    animatePartyPlayer(before, s.root, { open: false }, animations);
    assert.equal(s.sidebar.style.display, 'flex');
    animatePartyPlayer(before, s.root, { open: false, ...preference }, animations);
    assert.equal(s.sidebar.calls.length, 1);
    assert.equal(s.sidebar.style.display, '');
    assert.equal(animations.size, 0);
  }
  const s = motionScene(), animations = new Set();
  const before = snapshotPartyPlayer(s.root);
  s.open();
  s.root.targets = s.root.targets.filter(element => element !== s.info);
  s.art.animate = s.sidebar.animate = undefined;
  animatePartyPlayer(before, s.root, { open: true }, animations);
  assert.equal(s.info.calls.length, 0);
  assert.equal(s.art.calls.length, 0);
  assert.equal(s.sidebar.calls.length, 0);
});

test('the pre-commit layout snapshot handles room switches, avoids hero flights and cleans up on unmount', () => {
  const layoutSource = transformSync(readFileSync(new URL('../src/party-player-layout.jsx', import.meta.url), 'utf8'),
    { loader: 'jsx', format: 'cjs' }).code;
  const context = { module: { exports: {} }, require: name => name === 'react' ? React
    : name === 'framer-motion' ? { useReducedMotion: () => false }
      : { snapshotPartyPlayer, animatePartyPlayer, cancelPartyPlayerMotion } };
  vm.runInNewContext(layoutSource, context);
  const { PartyLayout } = context.module.exports;
  const s = motionScene();
  const previous = { open: false, enabled: true };
  const layout = new PartyLayout({ open: true, enabled: true });
  layout.root.current = s.root;
  const snapshot = layout.getSnapshotBeforeUpdate(previous);
  s.open();
  layout.componentDidUpdate(previous, null, snapshot);
  assert.equal(layout.animations.size, 5);
  assert.equal(layout.getSnapshotBeforeUpdate(layout.props), null);
  assert.equal(layout.getSnapshotBeforeUpdate({ ...previous, enabled: false }), null);
  layout.componentWillUnmount();
  assert.equal(layout.animations.size, 0);
  assert.equal(s.art.calls[0].animation.cancelled, true);
  assert.match(app, /enabled=\{view === 'player' && playerVisible && !hero && !reverseHero\}/);
  assert.match(app, /data-party-motion="info"[\s\S]*?ref=\{playerInfoRef\}/);
  assert.match(app, /data-party-motion="art"/);
  assert.match(app, /data-party-motion="progress"[\s\S]*?className="player-stage-progress"/);
  assert.match(app, /data-party-motion="controls"/);
});

test('controls use the artwork grid only for an open room with the library collapsed', () => {
  assert.match(app, /<PartyPlayerLayout\b[^>]*\bopen=\{partyOpen\}[^>]*\bcontrolsAligned=\{partyOpen && libCollapsed\}/);
  assert.match(app, /className="player-controls-layout">\s*<div data-party-motion="controls"/);
  assert.match(css, /\.player-controls-layout \{ width:100%; display:grid; grid-template-columns:minmax\(0, 1fr\); \}/);
  assert.match(css, /\.player-stage-party,\s*\.player-composition\[data-party-controls-aligned="true"\] \.player-controls-layout \{\s*display:grid; grid-template-columns:clamp\(184px, 30cqw, 224px\) minmax\(0, 1fr\)/);
  assert.match(css, /\.player-controls-layout > \[data-party-motion="controls"\] \{ grid-column:-2 \/ -1; min-width:0; \}/);
  assert.doesNotMatch(css.match(/\.player-controls-layout \{[^}]+\}/)[0], /transition|animation/);
  const code = transformSync(readFileSync(new URL('../src/party-player-layout.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
  const context = { module: { exports: {} }, require: name => name === 'react' ? React
    : name === 'framer-motion' ? { useReducedMotion: () => false }
      : { snapshotPartyPlayer, animatePartyPlayer, cancelPartyPlayerMotion } };
  vm.runInNewContext(code, context);
  const { PartyLayout } = context.module.exports;
  for (const open of [false, true]) for (const collapsed of [false, true]) {
    const layout = new PartyLayout({ open, controlsAligned: open && collapsed });
    assert.equal(layout.render().props['data-party-controls-aligned'], open && collapsed ? 'true' : 'false');
  }
  const s = motionScene(); s.open();
  const previous = { open: true, controlsAligned: false, enabled: true };
  const layout = new PartyLayout({ ...previous, controlsAligned: true }); layout.root.current = s.root;
  const before = layout.getSnapshotBeforeUpdate(previous);
  assert.ok(before);
  s.controls.rect = { ...s.controls.rect, left: 350, width: 510 };
  layout.componentDidUpdate(previous, null, before);
  assert.equal(layout.animations.size, 1);
  assert.equal(s.controls.calls[0].frames[0].transform, 'translate(-125px, 0px)');
  assert.equal(s.sidebar.calls.length, 0);
  assert.equal(layout.getSnapshotBeforeUpdate(layout.props), null);
  layout.componentWillUnmount();
});

test('rapid control alignment reversals continue from visible geometry without replaying the room fade', () => {
  const s = motionScene(), animations = new Set(); s.open();
  const before = snapshotPartyPlayer(s.root);
  s.controls.rect = { ...s.controls.rect, left: 350, width: 510 };
  animatePartyPlayer(before, s.root, { open: true, layoutOnly: true }, animations);
  const old = s.controls.calls[0].animation;
  s.controls.rect.left = 300; // Mid-flight displayed box, not the destination.
  const during = snapshotPartyPlayer(s.root);
  s.controls.rect = { ...s.controls.rect, left: 100, width: 760 };
  animatePartyPlayer(during, s.root, { open: true, layoutOnly: true }, animations);
  assert.equal(old.cancelled, true);
  assert.equal(s.controls.calls.at(-1).frames[0].transform, 'translate(75px, 0px)');
  assert.equal(s.sidebar.calls.length, 0);
  animatePartyPlayer(during, s.root, { open: true, layoutOnly: true, reduced: true }, animations);
  assert.equal(animations.size, 0);
});

test('the UI stores only public room data, never credentials, local paths or signed streams', () => {
  const original = { ...initialPartyState };
  const state = partyReducer(original, { type: 'session', code: 'SW7K2M', role: 'host', memberId: 'self', token: 'secret',
    track: { path: 'C:\\private.mp3', resolvedUrl: 'signed-url' }, isPlaying: true });
  assert.deepEqual(original, initialPartyState);
  assert.equal(state.screen, 'room');
  assert.deepEqual(state.room, { code: 'SW7K2M', role: 'host', memberId: 'self', members: [], track: null });
  assert.equal(JSON.stringify(state).includes('secret'), false);
  assert.equal(JSON.stringify(state).includes('private'), false);
  assert.equal(JSON.stringify(state).includes('signed-url'), false);
  assert.equal(guest().room.role, 'guest');
  assert.equal(guest().room.members.length, 2);
  assert.equal(sharedPartyTrack({ path: 'C:\\private.mp3', id: 1, duration: 180 }), null);
  const shared = sharedPartyTrack({ id: 123, duration: 180, title: 'song', artist: 'artist',
    token: 'secret', streamUrl: 'signed-url', queue: [1, 2], eq: [6] });
  assert.deepEqual(Object.keys(shared), ['source', 'id', 'title', 'artist', 'coverUrl', 'duration']);
});

test('join validation, request state, copy feedback and leave confirmation remain reversible', () => {
  let state = partyReducer(initialPartyState, { type: 'show-join' });
  assert.equal(state.screen, 'join');
  state = partyReducer(state, { type: 'invalid-code' });
  assert.equal(state.error, true);
  assert.equal(state.room, null);
  state = partyReducer(state, { type: 'draft', value: 'abc234' });
  assert.equal(state.error, false);
  state = partyReducer(state, { type: 'request' });
  assert.equal(state.busy, true);
  assert.equal(partyReducer(state, { type: 'back' }), state);
  assert.equal(partyReducer(state, { type: 'draft', value: 'other' }), state);
  state = partyReducer(state, { type: 'session', code: 'ABC234', role: 'guest', memberId: 'self' });
  assert.equal(state.screen, 'room');
  state = partyReducer(state, { type: 'copy-result', ok: false });
  assert.equal(state.copyError, true);
  state = partyReducer(state, { type: 'copy-result', ok: true });
  assert.equal(state.copied, true);
  assert.equal(state.copyError, false);
  state = partyReducer(state, { type: 'confirm-leave' });
  assert.equal(state.confirmLeave, true);
  state = partyReducer(state, { type: 'cancel-leave' });
  assert.equal(state.confirmLeave, false);
  assert.ok(state.room);
  state = partyReducer(state, { type: 'closed' });
  assert.deepEqual(state, initialPartyState);
  assert.equal(partyReducer(state, { type: 'copy-result', ok: true }), state);
});

test('rooms show real members and connection status with no duplicate player, fake listeners or effects controls', () => {
  for (const state of [initialPartyState, host(), guest()]) {
    const html = markup(state);
    assert.equal(html.includes('макет'), false);
    assert.equal(html.includes('пример участника'), false);
    assert.equal(html.includes('эквалайзер и стерео'), false);
    assert.ok(html.includes(l.people));
    assert.equal(html.includes('type="range"'), false);
    assert.equal(html.includes('<audio'), false);
  }
  assert.ok(markup(initialPartyState).includes(l.create));
  assert.ok(markup(host()).includes(l.friendSeat));
  assert.ok(markup(guest()).includes('a host'));
  assert.ok(markup(guest()).includes(l.connected));
  assert.equal(markup(guest()).includes(l.friendSeat), false);
});

test('create, join, copy, close and leave controls call only their explicit UI callbacks', () => {
  const calls = [];
  const dispatch = action => calls.push(action.type);
  const lobby = PartySurface({ ...props(initialPartyState), dispatch, onCreate: () => calls.push('create') });
  withClass(lobby, 'party-button party-button-primary').props.onClick();
  withClass(lobby, 'party-button party-button-secondary').props.onClick();
  const room = PartySurface({ ...props(host()), dispatch, onCopy: () => calls.push('copy'), onClose: () => calls.push('close') });
  withClass(room, 'party-copy-button').props.onClick();
  withClass(room, 'party-icon-button party-close').props.onClick();
  withClass(room, 'party-leave').props.onClick();
  assert.deepEqual(calls, ['create', 'show-join', 'copy', 'close', 'confirm-leave']);
  const confirm = PartySurface({ ...props({ ...host(), confirmLeave: true }), dispatch, onLeave: () => calls.push('leave') });
  assert.equal(withClass(confirm, 'party-leave'), undefined);
  withClass(confirm, 'party-leave-yes').props.onClick();
  assert.equal(calls.at(-1), 'leave');
});

test('code entry is labelled, invalid submit is disabled and Enter uses the same join action', () => {
  const calls = [];
  const tree = draft => PartySurface({ ...props({ ...initialPartyState, screen: 'join', draft }),
    dispatch: action => calls.push(action), onJoin: () => calls.push('join') });
  const invalid = tree('abc');
  const input = find(invalid, node => node.type === 'input')[0];
  assert.equal(input.props.id, 'party-code-input');
  assert.equal(input.props['aria-describedby'], 'party-code-hint');
  assert.equal(withClass(invalid, 'party-button party-button-primary').props.disabled, true);
  input.props.onChange({ target: { value: 'ABC234' } });
  assert.equal(calls[0].type, 'draft');
  assert.equal(calls[0].value, 'ABC234');
  const valid = tree('ABC234');
  assert.equal(withClass(valid, 'party-button party-button-primary').props.disabled, false);
  find(valid, node => node.type === 'form')[0].props.onSubmit({ preventDefault: () => calls.push('prevent') });
  assert.deepEqual(calls.slice(1), ['prevent', 'join']);
});

test('participant names are escaped, avatar failures fall back and locale dictionaries stay equivalent', () => {
  const state = host();
  state.room.members[0].name = '<script>bad</script>';
  const html = renderToStaticMarkup(React.createElement(PartySurface, props(state)));
  assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;'));
  const image = find(PartyAvatar({ user }), node => node.type === 'img')[0];
  assert.equal(image.key, user.avatarUrl);
  assert.equal(image.props.alt, '');
  const failed = { hidden: false };
  image.props.onError({ currentTarget: failed });
  assert.equal(failed.hidden, true);
  assert.deepEqual(Object.keys(partyLabels('ru')), Object.keys(partyLabels('en')));
  assert.equal(partyLabels('unknown'), partyLabels('ru'));
  assert.ok(renderToStaticMarkup(React.createElement(PartySurface,
    { ...props(host()), labels: partyLabels('en') })).includes('together'));
});

function sidebar(state, visible = true, clipboard = { writeText: async () => {} }) {
  const effects = [], listeners = new Map(), refs = [], events = [], actions = [];
  const fakeReact = { ...React, useRef: value => {
    const ref = { current: value }; refs.push(ref); return ref;
  }, useEffect: effect => effects.push(effect) };
  const triggerRef = { current: { focus: () => events.push('trigger-focus'), contains: target => target?.trigger === true } };
  const document = {
    addEventListener: (name, callback, capture) => { assert.equal(capture, true); listeners.set(name, callback); },
    removeEventListener: (name, callback, capture) => { assert.equal(capture, true); assert.equal(listeners.get(name), callback); listeners.delete(name); },
  };
  const { ListeningParty } = componentContext(fakeReact, { document, navigator: { clipboard } });
  const tree = ListeningParty({ visible, state, dispatch: action => actions.push(action),
    onClose: () => events.push('close'), triggerRef, user });
  refs[0].current = { focus: () => events.push('sidebar-focus'), contains: target => target?.room === true,
    querySelector: () => ({ focus: () => events.push('input-focus') }) };
  return { tree, effects, listeners, events, actions };
}

test('inline rooms have no portal or outside-click dismissal; Escape restores focus and cleans up', () => {
  const s = sidebar(host());
  assert.equal(s.tree.type, 'section');
  assert.equal(s.tree.props.id, 'listening-party-stage');
  assert.equal(s.tree.props.className, 'party-sidebar');
  assert.equal(s.tree.props.role, undefined);
  const cleanup = s.effects[0]();
  s.effects[1]();
  assert.deepEqual(s.events, ['sidebar-focus']);
  assert.equal(s.listeners.has('pointerdown'), false);
  s.listeners.get('keydown')({ key: 'Escape', target: { titleEditor: true },
    preventDefault: () => assert.fail('room must not steal Escape from another control'),
    stopPropagation: () => assert.fail('room must not steal Escape from another control') });
  assert.deepEqual(s.events, ['sidebar-focus']);
  s.listeners.get('keydown')({ key: 'Escape', target: { room: true }, preventDefault: () => {}, stopPropagation: () => {} });
  assert.deepEqual(s.events, ['sidebar-focus', 'close', 'trigger-focus']);
  cleanup();
  assert.equal(s.listeners.size, 0);
  let stopped = false;
  s.tree.props.onKeyDownCapture({ key: 'Tab', stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true);
  const hidden = sidebar(host(), false);
  assert.equal(hidden.tree.props.hidden, true);
  assert.equal(hidden.tree.props['aria-hidden'], true);
  assert.equal(hidden.tree.props.inert, '');
  for (const effect of hidden.effects) assert.equal(effect(), undefined);
  assert.equal(hidden.listeners.size, 0);
});

test('join focuses the code field; clipboard success and denial have honest local feedback', async () => {
  const codeEntry = sidebar({ ...initialPartyState, screen: 'join' });
  codeEntry.effects[1]();
  assert.deepEqual(codeEntry.events, ['input-focus']);
  for (const ok of [true, false]) {
    const codes = [];
    const s = sidebar(host(), true, { writeText: async code => { codes.push(code); if (!ok) throw new Error('denied'); } });
    await s.tree.props.children.props.onCopy();
    assert.deepEqual(codes, ['SW7K2M']);
    assert.equal(s.actions[0].type, 'copy-result');
    assert.equal(s.actions[0].ok, ok);
  }
});

test('the room view keeps real progress under the artwork and the lower controls outside the switched stage', () => {
  const player = app.slice(app.indexOf('className="player-composition"'), app.indexOf('{/* volume panel.'));
  const sidebarIndex = player.indexOf('<ListeningParty visible=');
  const mediaIndex = player.indexOf('className="player-stage-media"');
  const artIndex = player.indexOf('id="player-album-art"');
  const stageEnd = player.indexOf('shared artwork stage;');
  const progressIndex = player.indexOf('<ProgressBar progressRef=');
  const mediaEnd = player.indexOf('player-stage-media end:');
  const transportIndex = player.indexOf('<PlayBtn isPlaying=');
  assert.ok(sidebarIndex < mediaIndex && mediaIndex < artIndex && artIndex < stageEnd);
  assert.ok(artIndex < progressIndex && progressIndex < mediaEnd && mediaEnd < stageEnd && stageEnd < transportIndex);
  assert.match(player, /className="player-stage-progress" data-motion-spatial="" style=\{\{\s*width:partyOpen\s*\? 'min\(100%, clamp\(320px, 54vw, 760px\), clamp\(240px, 58vh, 760px\)\)'/);
  assert.equal((app.match(/<AlbumArt /g) || []).length, 1);
  assert.match(app, /data-party-shared-art=[^\n]+[\s\S]*?<AlbumArt track=\{coverTrack\}/);
  assert.equal((player.match(/<ProgressBar /g) || []).length, 1);
  assert.equal((player.match(/<PlayBtn /g) || []).length, 1);
  assert.match(player, /ref=\{playerArtRef\}/);
  assert.match(player, /ref=\{playerInfoRef\}/);
  assert.match(player, /text=\{playerDisplayTrack.title\}/);
  assert.match(player, /splitArtists\(playerDisplayTrack.artist\)/);
  assert.doesNotMatch(source, /createPortal|new Audio|AudioContext|\.play\(|setIsPlaying|scFetch|WebSocket|fetch\(/);
});

test('the wider room column sizes to its content without an internal scroll area or clipped controls', () => {
  const sidebarStyles = css.match(/\.party-sidebar\s*\{([^}]+)\}/)[1];
  assert.doesNotMatch(sidebarStyles, /max-height|overflow|overscroll/);
  assert.doesNotMatch(source, /scroll-thin|l\.personal/);
  assert.match(css, /grid-template-columns:clamp\(184px, 30cqw, 224px\) minmax\(0, 1fr\)/);
  assert.match(css, /@container \(max-width:470px\)\s*\{\s*\.player-stage-party,\s*\.player-composition\[data-party-controls-aligned="true"\] \.player-controls-layout \{ grid-template-columns:164px minmax\(0,1fr\)/);
  const english = renderToStaticMarkup(React.createElement(PartySurface,
    { ...props(host()), labels: partyLabels('en') }));
  assert.equal(english.includes('your EQ and stereo'), false);
});

test('artist and title visibility follows player state even when metadata remounts or the room is toggled rapidly', () => {
  const start = app.indexOf('<div ref={playerInfoRef} className="player-info"');
  assert.ok(start > 0);
  const end = app.indexOf('</div>{/* playerInfoRef end */}', start) + '</div>'.length;
  const metadata = app.slice(start, end);
  const compiled = transformSync(`module.exports = (${metadata});`, { loader: 'jsx', format: 'cjs' }).code;
  for (let i = 0; i < 40; i++) {
    const visible = i % 3 !== 0;
    const context = { module: { exports: {} }, React, playerInfoRef: { current: null }, playerVisible: visible,
      hasTrack: true, scPlayingTrack: i % 2 ? { id: 1 } : null, pendingPlayerTrack: null, editingTitle: false,
      playerDisplayTrack: { title: 'a favourite song', artist: 'a favourite artist' },
      formatArtistDisplay: artist => artist, splitArtists: artist => [{ name: artist, sep: '' }],
      MarqueeText: ({ text }) => React.createElement('span', null, text) };
    // A fresh render each time also covers replacing the metadata DOM while
    // playerVisible is already true, without any visibility effect rerunning.
    vm.runInNewContext(compiled, context);
    const tree = context.module.exports;
    assert.equal(tree.props['data-visible'], String(visible));
    assert.equal(tree.props.style, undefined);
    const html = renderToStaticMarkup(tree);
    assert.ok(html.includes('a favourite song'));
    assert.ok(html.includes('a favourite artist'));
    assert.match(html, /class="player-info-artist" data-lyrics-meta-anchor=""/);
  }
  assert.match(css, /\.player-info\[data-visible="true"\]\s*\{\s*opacity:1; visibility:visible; pointer-events:auto;/);
  assert.match(css, /prefers-reduced-motion:reduce[\s\S]*?\.player-info[^{}]+\{ transition:none; transform:none;/);
  assert.doesNotMatch(app, /const el = playerInfoRef\.current|gsap\.(?:fromTo|to)\(playerInfoRef/);
});

test('party entry switches only the player view and preserves the unsaved playlist guard', () => {
  const callback = app.slice(app.indexOf('const toggleParty = event =>'), app.indexOf('/* ── Кнопки «назад/вперёд»'));
  const run = (view, partyOpen, editingPlaylist = null) => {
    const events = [];
    const context = { view, partyOpen, editingPlaylist,
      plEditorRef: { current: { requestClose: () => events.push('guard') } },
      setPartyInstant: value => events.push(['instant', value]), setPartyOpen: value => events.push(['open', value]),
      setHomeVisible: value => events.push(['home', value]), setPlayerVisible: value => events.push(['player', value]),
      setView: value => events.push(['view', value]), setNavActive: value => events.push(['nav', value]),
    };
    vm.runInNewContext(`${callback}\ntoggleParty({ detail:0 });`, context);
    return events;
  };
  assert.deepEqual(run('home', false), [['instant', true], ['open', true], ['home', false], ['player', true], ['view', 'player'], ['nav', 'library']]);
  assert.deepEqual(run('player', true), [['instant', true], ['open', false]]);
  assert.deepEqual(run('player', false), [['instant', true], ['open', true]]);
  assert.deepEqual(run('playlistEditor', false, { id: 1 }), ['guard']);
});

test('party icon precedes list collapse, uses the supplied PNG and preserves the theme and reduced-motion settings', () => {
  const topbar = app.slice(app.indexOf('function TopBar('), app.indexOf('/* ── примитивы настроек'));
  const triggerIndex = topbar.indexOf('className="party-trigger"');
  const collapseIndex = topbar.indexOf('onClick={onToggleLib}');
  assert.ok(triggerIndex > 0 && triggerIndex < collapseIndex);
  assert.match(topbar, /aria-controls="listening-party-stage"/);
  assert.doesNotMatch(topbar, /aria-haspopup=/);
  assert.equal((app.match(/\bnav_party:/g) || []).length, 2);
  assert.match(css, /mask:url\('\/assets\/party.png'\)/);
  assert.match(css, /\.player-stage-party,\s*\.player-composition\[data-party-controls-aligned="true"\] \.player-controls-layout\s*\{[\s\S]*?display:grid; grid-template-columns:[\s\S]*?minmax\(0, 1fr\)/);
  assert.match(css, /@supports \(color:color-mix\(in oklch/);
  assert.match(css, /@container \(max-width:470px\)/);
  assert.match(css, /prefers-reduced-motion:reduce[\s\S]*?transition:none/);
  assert.doesNotMatch(css, /backdrop-filter|\.party-sidebar[^{}]*\{[^{}]*position:(?:fixed|absolute)/);
  const image = readFileSync(new URL('../public/assets/party.png', import.meta.url));
  assert.deepEqual(Array.from(image.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
});
