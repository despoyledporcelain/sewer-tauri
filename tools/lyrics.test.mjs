import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../src/app.jsx', import.meta.url), 'utf8');
const lyrics = app.slice(app.indexOf('function cleanTrackName('), app.indexOf('/* ── кеш текста'));

function lyricsLookup(handleRequest = () => { throw new Error('Unexpected request'); }) {
  return runInNewContext(lyrics + '\n({ trackQueries, lyricsMatch, fetchLrclib, fetchGenius })', {
    URLSearchParams,
    setTimeout,
    clearTimeout,
    window: { electronAPI: { netFetch: async url => handleRequest(new URL(url)) } },
  });
}

const json = (body, status = 200) => ({ status, body: JSON.stringify(body) });
const deadline = () => Date.now() + 5000;

test('SoundCloud titles retain full names and add variants for credits, Unicode and artist prefixes', () => {
  const { trackQueries, lyricsMatch } = lyricsLookup();
  const pairs = trackQueries('archive channel', 'sekairotten + @седьмоенебо - туман (prod. x) #2001', true);
  assert.ok(lyricsMatch(pairs, 'Туман', '@sedmoenebo')?.artistMatch);
  assert.equal(lyricsMatch(pairs, 'Туман', 'Different Artist'), null);

  assert.ok(trackQueries('lux aeterna', '☆☩𝖆𝖋𝖙𝖊𝖗 𝖈𝖍𝖚𝖗𝖈𝖍...☩☆ #333', true)
    .some(pair => pair.title === 'after church'));
  assert.ok(trackQueries('Artist', '1979', false).some(pair => pair.title === '1979'));
  assert.ok(trackQueries('Artist', 'Song - Live Forever', false)
    .some(pair => pair.title === 'Song - Live Forever'));
  assert.ok(!trackQueries('Artist', 'Other - Title', false).some(pair => pair.artist === 'Other'));
});

test('LRCLIB filters by identity before duration and continues past a plain hit', async () => {
  const { trackQueries, fetchLrclib } = lyricsLookup(url => {
    if (url.pathname.endsWith('/get')) return json({
      trackName: 'carnival', artistName: '@sedmoenebo', duration: 128, plainLyrics: 'Plain fallback',
    });
    assert.equal(url.searchParams.has('duration'), false);
    return json([
      { trackName: 'carnival', artistName: 'Playboi Carti', duration: 128, syncedLyrics: '[00:00.00] Wrong artist' },
      { trackName: 'another song', artistName: '@sedmoenebo', duration: 128, syncedLyrics: '[00:00.00] Wrong title' },
      { trackName: 'carnival', artistName: '@sedmoenebo', duration: 129, syncedLyrics: '[00:01.00] Correct song' },
    ]);
  });
  const found = await fetchLrclib(trackQueries('@седьмоенебо', 'carnival * prod. @x', true), 128, deadline());
  assert.equal(found.synced, true);
  assert.equal(found.lines[0].text, 'Correct song');
});

test('LRCLIB can search by title alone and gives plain lyrics when timing is unsuitable', async () => {
  const { trackQueries, fetchLrclib } = lyricsLookup(url => {
    assert.equal(url.pathname, '/api/search');
    assert.equal(url.searchParams.has('artist_name'), false);
    return json([{ trackName: 'A longer title', artistName: 'Artist', duration: 200, syncedLyrics: '[00:01.00] A line' }]);
  });
  const found = await fetchLrclib(trackQueries('', 'A longer title', false), 150, deadline());
  assert.equal(found.synced, false);
  assert.equal(found.lines[0].text, 'A line');
  assert.equal(found.lines[0].t, null);
});

test('LRCLIB does not attach original timestamps to a slowed version of the same length', async () => {
  const { trackQueries, fetchLrclib } = lyricsLookup(url => url.pathname.endsWith('/get')
    ? json({}, 404)
    : json([{ trackName: 'Song', artistName: 'Artist', duration: 130, syncedLyrics: '[00:01.00] A line' }]));
  const found = await fetchLrclib(trackQueries('Artist', 'Song (Slowed + Reverb) prod. x', true), 130, deadline());
  assert.equal(found.synced, false);
  assert.equal(found.lines[0].text, 'A line');
});

test('Genius reads the matching song when an unrelated one is first in the response', async () => {
  const { trackQueries, fetchGenius } = lyricsLookup(url => {
    if (url.pathname.endsWith('/multi')) return json({ response: { sections: [{
      type: 'song',
      hits: [
        { result: { id: 1, title: 'туман', primary_artist_names: 'Different Artist' } },
        { result: { id: 2, title: 'туман', primary_artist_names: '@sedmoenebo' } },
      ],
    }] } });
    assert.equal(url.pathname, '/songs/2');
    return { status: 200, body: '<div data-lyrics-container="true">Correct song<br>Second line</div>' };
  });
  const found = await fetchGenius(trackQueries('archive', '@седьмоенебо - туман (prod. x)', true), deadline());
  assert.equal(found.synced, false);
  assert.equal(found.lines[0].text, 'Correct song');
  assert.equal(found.lines.length, 2);
});
