export const queueSource = track => track?.path ? 'local' : 'sc';

export function queueTrackKey(track) {
  if (track?.path) return `local:${track.path}`;
  return track?.id == null ? null : `sc:${track.id}`;
}

export function moveQueuedTrack(entries, entry, offset) {
  const source = queueSource(entry.track);
  const inSource = entries.filter(item => queueSource(item.track) === source);
  const index = inSource.indexOf(entry);
  const reordered = moveQueueItem(inSource, index, index + offset);
  if (reordered === inSource) return entries;
  let position = 0;
  return entries.map(item => queueSource(item.track) === source ? reordered[position++] : item);
}

export function moveQueueItem(list, from, to) {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return list;
  const reordered = [...list];
  const [item] = reordered.splice(from, 1);
  reordered.splice(to, 0, item);
  return reordered;
}
