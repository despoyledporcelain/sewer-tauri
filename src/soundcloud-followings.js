const soundCloudOrigin = 'https://api-v2.soundcloud.com';

function userId(value) {
  return /^(?:soundcloud:users:)?(\d+)$/.exec(String(value ?? ''))?.[1];
}

export async function checkSoundCloudFollowing(fetchSoundCloud, auth, artistId, signal) {
  const accountId = userId(auth?.userId);
  const targetId = userId(artistId);
  if (!accountId || !targetId || !auth.token) return null;

  const pathname = `/users/${accountId}/followings`;
  let page = new URL(`${pathname}?limit=200&linked_partitioning=1`, soundCloudOrigin);
  const visited = new Set();
  try {
    while (!signal?.aborted) {
      if (page.origin !== soundCloudOrigin || page.pathname !== pathname || visited.has(page.href)) return null;
      visited.add(page.href);
      const result = await fetchSoundCloud(page.href, auth.token, auth.clientId);
      if (signal?.aborted || result?.error || !Array.isArray(result?.data?.collection)) return null;

      const { collection, next_href: nextPage } = result.data;
      if (collection.some(account => userId(account?.id ?? account?.urn) === targetId)) return true;
      if (!nextPage) return false;
      page = new URL(nextPage, page);
    }
  } catch {
    return null;
  }
  return null;
}
