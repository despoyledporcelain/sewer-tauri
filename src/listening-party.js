// UI state contains public room data only. Credentials live in PartyClient.

export const initialPartyState = {
  screen: 'lobby', draft: '', error: false, room: null,
  copied: false, copyError: false, confirmLeave: false,
  busy: false, connection: 'idle', notice: '', playbackError: '',
};

export function cleanPartyCode(value) {
  return String(value || '').toUpperCase().replace(/[\s-]/g, '');
}

export function validPartyCode(value) {
  return /^[A-Z2-9]{6}$/.test(cleanPartyCode(value));
}

export function partyImageURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (url.hostname === 'sndcdn.com' || url.hostname.endsWith('.sndcdn.com')) && url.href.length <= 512 ? url.href : null;
  } catch { return null; }
}

export function sharedPartyTrack(track) {
  if (!track || track.path || !/^[1-9][0-9]{0,19}$/.test(String(track.id))) return null;
  const duration = Number(track.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) return null;
  return { source: 'soundcloud', id: String(track.id), title: String(track.title || '').slice(0, 160),
    artist: String(track.artist || '').slice(0, 160), coverUrl: partyImageURL(track.remoteCoverUrl) || partyImageURL(track.coverUrl), duration };
}

export function partyReducer(state, action) {
  switch (action.type) {
    case 'show-join': return state.busy || state.room ? state : { ...state, screen: 'join', error: false, notice: '' };
    case 'back': return state.busy || state.room ? state : { ...state, screen: 'lobby', error: false, notice: '' };
    case 'draft': return state.busy ? state : { ...state, draft: action.value.slice(0, 16), error: false, notice: '' };
    case 'invalid-code': return { ...state, error: true };
    case 'request': return { ...state, busy: true, notice: '', error: false, playbackError: '', connection: 'connecting' };
    case 'session': return { ...initialPartyState, screen: 'room', connection: 'connecting',
      room: { code: action.code, role: action.role, memberId: action.memberId, members: [], track: null } };
    case 'snapshot': return state.room?.code === action.code ? { ...state, connection: 'connected', busy: false, notice: '',
      room: { code: action.code, role: action.you.role, memberId: action.you.id,
        members: action.members.map(({ id, role, name, avatarUrl }) => ({ id, role, name, avatarUrl })),
        track: sharedPartyTrack(action.track), revision: action.playback.revision } } : state;
    case 'connection': return state.room ? { ...state, connection: action.value } : state;
    case 'failed': return { ...state, busy: false, connection: 'idle', notice: action.error };
    case 'playback-error': return { ...state, playbackError: action.error };
    case 'closed': return { ...initialPartyState, notice: action.reason || '' };
    case 'copy-result': return state.room ? { ...state, copied: action.ok, copyError: !action.ok } : state;
    case 'confirm-leave': return { ...state, confirmLeave: true };
    case 'cancel-leave': return { ...state, confirmLeave: false };
    default: return state;
  }
}
