import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSoundCloudFollowing } from '../src/soundcloud-followings.js';

const auth = { userId: 'soundcloud:users:12', token: 'token', clientId: 'client' };
const endpoint = 'https://api-v2.soundcloud.com/users/12/followings';
const firstPage = `${endpoint}?limit=200&linked_partitioning=1`;
const nextPage = `${endpoint}?offset=200`;

test('a confirmed subscription can be found on a later page via numeric ID or URN', async () => {
  const calls = [];
  const following = await checkSoundCloudFollowing(async (url, token, clientId) => {
    calls.push([url, token, clientId]);
    if (url === firstPage) return { data: { collection: [{ id: 31 }], next_href: nextPage } };
    return { data: { collection: [{ urn: 'soundcloud:users:42' }], next_href: null } };
  }, auth, 42);
  assert.equal(following, true);
  assert.deepEqual(calls, [[firstPage, auth.token, auth.clientId], [nextPage, auth.token, auth.clientId]]);
});

test('an exhausted list means not subscribed and a failed request means unknown', async () => {
  for (const response of [{ error: 404 }, { error: 403 }, { error: 429 }, { data: null }]) {
    assert.equal(await checkSoundCloudFollowing(async () => response, auth, 42), null);
  }
  assert.equal(await checkSoundCloudFollowing(async () => { throw new Error('offline'); }, auth, 42), null);
  assert.equal(await checkSoundCloudFollowing(async () => ({ data: { collection: [], next_href: null } }), auth, 42), false);
});

test('pagination stops after cancellation, a repeated link or a link outside the account endpoint', async () => {
  for (const next of [nextPage, firstPage, 'https://example.com/users/12/followings', endpoint.replace('/12/', '/34/')]) {
    const controller = new AbortController();
    const calls = [];
    const following = await checkSoundCloudFollowing(async url => {
      calls.push(url);
      if (next === nextPage) controller.abort();
      return { data: { collection: [], next_href: next } };
    }, auth, 42, controller.signal);
    assert.equal(following, null);
    assert.deepEqual(calls, [firstPage]);
  }
});
