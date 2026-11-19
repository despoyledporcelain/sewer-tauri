import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discordSnapshot, updateDiscordPlayback } from '../src/discord-presence.js';

const track = { id: 1, title: 'song', artist: 'artist', duration: 200,
  coverUrl: 'http://asset.localhost/C%3A%5Ccovers%5C1.jpg' };
const audio = () => ({ currentTime: 12.5, duration: 200.5, playbackRate: 1,
  readyState: 4, paused: false, ended: false, seeking: false });
const snapshot = options => discordSnapshot({ track, audio: audio(), playing: true,
  settings: {}, switching: false, sampledAt: 1_800_000_000_000, ...options });

test('SoundCloud uses the original CDN cover, not the UI asset host', () => {
  const result = snapshot({ originalTrack: { coverUrl: 'https://i1.sndcdn.com/cover.jpg' } });
  assert.equal(result.coverUrl, 'https://i1.sndcdn.com/cover.jpg');
  assert.equal(result.isPlaying, true);
  assert.equal(result.position, 12.5);
  assert.equal(result.duration, 200.5);
});

test('local artwork remains uploadable; cover toggle removes it', () => {
  assert.equal(snapshot().coverUrl, track.coverUrl);
  const local = { ...track, coverUrl: 'data:image/jpeg;base64,aW1hZ2U=' };
  assert.equal(snapshot({ track: local }).coverUrl, local.coverUrl);
  assert.equal(snapshot({ settings: { discordCover: false } }).coverUrl, null);
});

test('missing or blank track clears presence', () => {
  assert.equal(snapshot({ track: null }), null);
  assert.equal(snapshot({ track: { id: 0, title: '', artist: '', duration: 0 } }), null);
});

test('pause, seek and buffering cannot start a running timer', () => {
  for (const state of [{ paused: true }, { seeking: true }, { __sewRpcWaiting: true }, { ended: true }]) {
    assert.equal(snapshot({ audio: { ...audio(), ...state } }).isPlaying, false);
    assert.equal(snapshot({ audio: { ...audio(), ...state }, settings: { discordPause: 'hide' } }), null);
  }
});

test('advancing decoder recovers from waiting even without another playing event', () => {
  const el = audio();
  updateDiscordPlayback(el, 'waiting');
  assert.equal(snapshot({ audio: el }).isPlaying, false);
  assert.equal(updateDiscordPlayback(el, 'timeupdate'), false);
  el.currentTime += 0.25;
  assert.equal(updateDiscordPlayback(el, 'timeupdate'), true);
  assert.equal(snapshot({ audio: el }).isPlaying, true);
  assert.equal(updateDiscordPlayback(el, 'timeupdate'), false);
});

test('track change does not reuse the old deck position or progress', () => {
  const result = snapshot({ switching: true, progress: 0.9 });
  assert.equal(result.position, 0);
  assert.equal(result.duration, track.duration);
  assert.equal(result.isPlaying, false);
  assert.equal(snapshot({ audio: { ...audio(), duration: Infinity } }).duration, track.duration);
});
