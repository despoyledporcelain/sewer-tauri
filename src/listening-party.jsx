import React, { useEffect, useRef } from 'react';
import { validPartyCode } from './listening-party.js';
import './listening-party.css';

const STRINGS = {
  ru: {
    title: 'комнаты', close: 'вернуться к плееру',
    headline: 'слушай\nне один.', subtitle: 'любимые треки\nна двоих и больше',
    create: 'создать комнату', join: 'войти по коду', back: 'назад',
    joinTitle: 'тебя\nуже ждут?', joinSubtitle: 'введи код друга',
    codeLabel: 'код комнаты', codePlaceholder: 'ABC 234', codeHint: '6 букв и цифр',
    codeError: '6 букв и цифр, без 0 и 1', joinRoom: 'войти в комнату',
    ownRoom: 'твоя комната', joinedRoom: 'комната друга',
    people: 'участники', you: 'ты', host: 'ведущий', guest: 'участник',
    friendSeat: 'место для друга', inviteFriend: 'по приглашению',
    copy: 'скопировать код комнаты', copied: 'код скопирован',
    copyError: 'выдели код и скопируй вручную', invitation: 'пригласить друга',
    followsHost: 'трек и перемотка у ведущего',
    leave: 'выйти из комнаты', end: 'закрыть комнату',
    confirmLeave: 'выйти из комнаты?', confirmEnd: 'закрыть комнату для всех?', stay: 'остаться',
    connecting: 'подключение', connected: 'вместе', reconnecting: 'переподключение', leaving: 'выходим', creating: 'создаём комнату', joining: 'входим в комнату',
    retry: 'повторить', login: 'войти в soundcloud',
    error_login_required: 'сначала войди в soundcloud', error_soundcloud_only: 'для комнаты выбери soundcloud-трек',
    error_track_loading: 'дождись загрузки трека', error_room_not_found: 'комната не найдена или уже закрыта',
    error_room_full: 'в комнате уже 8 участников', error_rate_limited: 'слишком много попыток, попробуй через минуту',
    error_connection_failed: 'не удалось подключиться, попробуй ещё раз', error_protocol_error: 'версия сервера не совпадает с плеером',
    error_track_unavailable: 'этот трек недоступен, проверь свой soundcloud', error_playback_blocked: 'нажми «повторить», чтобы разрешить звук',
    error_host_only: 'трек и перемотку меняет ведущий', error_host_left: 'ведущий закрыл комнату',
    error_expired: 'время комнаты истекло', error_replaced: 'комната открыта в другом окне',
    error_leave_unconfirmed: 'сервер не подтвердил выход, комната может оставаться открытой',
  },
  en: {
    title: 'rooms', close: 'back to the player',
    headline: 'never listen\nalone.', subtitle: 'favourite tracks\nfor two or more',
    create: 'create a room', join: 'join with a code', back: 'back',
    joinTitle: 'someone\nwaiting for you?', joinSubtitle: 'enter your friend’s code',
    codeLabel: 'room code', codePlaceholder: 'ABC 234', codeHint: '6 letters and numbers',
    codeError: '6 letters and numbers, no 0 or 1', joinRoom: 'join the room',
    ownRoom: 'your room', joinedRoom: 'a friend’s room',
    people: 'listeners', you: 'you', host: 'host', guest: 'listener',
    friendSeat: 'a place for a friend', inviteFriend: 'by invitation',
    copy: 'copy the room code', copied: 'code copied',
    copyError: 'select the code and copy it manually', invitation: 'invite a friend',
    followsHost: 'the host chooses tracks and seeks',
    leave: 'leave the room', end: 'close the room',
    confirmLeave: 'leave this room?', confirmEnd: 'close the room for everyone?', stay: 'stay',
    connecting: 'connecting', connected: 'together', reconnecting: 'reconnecting', leaving: 'leaving', creating: 'creating a room', joining: 'joining the room',
    retry: 'retry', login: 'sign in to soundcloud',
    error_login_required: 'sign in to soundcloud first', error_soundcloud_only: 'choose a soundcloud track for the room',
    error_track_loading: 'wait for the track to load', error_room_not_found: 'the room was not found or has closed',
    error_room_full: 'the room already has 8 listeners', error_rate_limited: 'too many attempts, try again in a minute',
    error_connection_failed: 'could not connect, try again', error_protocol_error: 'the server version does not match the player',
    error_track_unavailable: 'this track is unavailable, check your soundcloud', error_playback_blocked: 'press retry to allow audio',
    error_host_only: 'only the host can change tracks or seek', error_host_left: 'the host closed the room',
    error_expired: 'the room has expired', error_replaced: 'the room is open in another window',
    error_leave_unconfirmed: 'the server did not confirm leaving, the room may still be open',
  },
};

export function partyLabels(locale) {
  return STRINGS[locale === 'en' ? 'en' : 'ru'];
}

function Icon({ name, size = 16 }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14"/>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
    back: <path d="M19 12H5m5-5-5 5 5 5"/>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="3"/><path d="M15 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    crown: <path d="m3 7 4 4 5-7 5 7 4-4-2 12H5L3 7Z"/>,
    exit: <><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M10 12h11m-4-4 4 4-4 4"/></>,
    headphones: <><path d="M4 14v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="12" width="4" height="8" rx="2"/><rect x="17" y="12" width="4" height="8" rx="2"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function PartyAvatar({ user }) {
  return <span className="party-avatar" aria-hidden="true">
    {String(user?.username || user?.name || 's').slice(0, 1).toLowerCase()}
    {user?.avatarUrl && <img key={user.avatarUrl} src={user.avatarUrl} alt="" draggable={false}
      onError={event => { event.currentTarget.hidden = true; }}
    />}
  </span>;
}

// The left side of the player stage. The real artwork and transport remain owned by App.
export function PartySurface({ state, labels: l, user, dispatch, onCreate, onJoin, onCopy, onClose, onLeave, onRetry, onLogin }) {
  const room = state.room;
  const host = room?.role === 'host';
  const username = user?.username || l.you;
  const copyStatus = state.copied ? l.copied : state.copyError ? l.copyError : '';
  const error = state.playbackError || state.notice;
  const members = room ? room.members : [{ id: 'self', name: username, avatarUrl: user?.avatarUrl }];

  return <>
    <header className="party-header">
      <span className="party-header-title"><span className="party-icon" aria-hidden="true"/>{l.title}</span>
      {(room || state.busy) && <span className="party-connection" role="status">{l[state.connection] || l.connecting}</span>}
      <button type="button" className="party-icon-button party-close" onClick={onClose} aria-label={l.close} title={l.close}><Icon name="close" size={12}/></button>
    </header>

    {state.screen === 'lobby' && <div className="party-lobby">
      <h2>{l.headline}</h2><p>{l.subtitle}</p>
      <div className="party-lobby-actions">
        <button type="button" className="party-button party-button-primary" onClick={onCreate} disabled={state.busy} aria-busy={state.busy}><Icon name="plus" size={14}/>{state.busy ? l.creating : l.create}</button>
        <button type="button" className="party-button party-button-secondary" disabled={state.busy} onClick={() => dispatch({ type: 'show-join' })}>{l.join}<Icon name="arrow" size={13}/></button>
      </div>
    </div>}

    {state.screen === 'join' && <div className="party-join">
      <button type="button" className="party-back" disabled={state.busy} onClick={() => dispatch({ type: 'back' })}><Icon name="back" size={13}/>{l.back}</button>
      <h2>{l.joinTitle}</h2><p>{l.joinSubtitle}</p>
      <form onSubmit={event => { event.preventDefault(); onJoin(); }}>
        <label className="party-eyebrow" htmlFor="party-code-input">{l.codeLabel}</label>
        <div className="party-code-field" data-error={state.error ? 'true' : 'false'}>
          <input id="party-code-input" value={state.draft} disabled={state.busy} maxLength={16} placeholder={l.codePlaceholder}
            autoComplete="off" autoCapitalize="characters" spellCheck={false} aria-invalid={state.error}
            aria-describedby="party-code-hint" onChange={event => dispatch({ type: 'draft', value: event.target.value })}/>
        </div>
        <span id="party-code-hint" className="party-input-hint" data-error={state.error ? 'true' : 'false'} role={state.error ? 'alert' : undefined}>
          {state.error ? l.codeError : l.codeHint}
        </span>
        <button type="submit" className="party-button party-button-primary" aria-busy={state.busy} disabled={state.busy || !validPartyCode(state.draft)}>{state.busy ? l.joining : l.joinRoom}</button>
      </form>
    </div>}

    {state.screen === 'room' && room && <div className="party-room-heading">
      <h2>{host ? l.ownRoom : l.joinedRoom}</h2>
      <span><Icon name={host ? 'crown' : 'headphones'} size={12}/>{host ? l.host : l.guest}</span>
    </div>}

    {state.screen !== 'join' && <div className="party-members">
      <div className="party-section-heading"><h3 className="party-eyebrow">{l.people}</h3><span>{String(members.length).padStart(2, '0')}</span></div>
      <ul>
        {members.map(member => <li key={member.id}><PartyAvatar user={member}/><span className="party-member-meta"><strong>{member.name}</strong><span>{member.id === room?.memberId ? `${l.you} · ` : ''}{member.role ? l[member.role] : l.you}</span></span></li>)}
        {(!room || host && members.length < 8) && <li className="party-empty-seat"><span className="party-avatar party-avatar-invite" aria-hidden="true"><Icon name="plus" size={15}/></span><span className="party-member-meta"><strong>{l.friendSeat}</strong><span>{l.inviteFriend}</span></span></li>}
      </ul>
    </div>}

    {state.screen === 'room' && room && <>
      <div className="party-invitation">
        <span className="party-eyebrow">{l.invitation}</span>
        <div className="party-invite-code">
          <span className="party-room-code" aria-label={l.codeLabel}>{room.code.slice(0, 3)} {room.code.slice(3)}</span>
          <button type="button" className="party-copy-button" onClick={onCopy} aria-label={state.copied ? l.copied : l.copy} title={state.copied ? l.copied : l.copy}>
            <Icon name={state.copied ? 'check' : 'copy'} size={14}/>
          </button>
        </div>
        {copyStatus && <span className="party-copy-status" role="status">{copyStatus}</span>}
      </div>
      <div className="party-room-bottom">
        {state.confirmLeave ? <div className="party-leave-confirm" role="group" aria-label={host ? l.confirmEnd : l.confirmLeave}>
          <span>{host ? l.confirmEnd : l.confirmLeave}</span>
          <button type="button" disabled={state.connection === 'leaving'} onClick={() => dispatch({ type: 'cancel-leave' })}>{l.stay}</button>
          <button type="button" className="party-leave-yes" disabled={state.connection === 'leaving'} onClick={onLeave}>{state.connection === 'leaving' ? l.leaving : host ? l.end : l.leave}</button>
        </div> : <button type="button" className="party-leave" onClick={() => dispatch({ type: 'confirm-leave' })}><Icon name="exit" size={12}/>{host ? l.end : l.leave}</button>}
      </div>
    </>}

    {(error || room && !host) && <footer className="party-footer">
      {error ? <><small className="party-error" role="alert">{l[`error_${error}`] || l.error_connection_failed}</small>
        {error === 'login_required' ? <button type="button" className="party-back" onClick={onLogin}>{l.login}<Icon name="arrow" size={12}/></button>
          : state.playbackError && <button type="button" className="party-back" onClick={onRetry}>{l.retry}</button>}</>
        : <small>{l.followsHost}</small>}
    </footer>}
  </>;
}

export function ListeningParty({ visible, instant, state, dispatch, onClose, triggerRef, user, locale = 'ru', onCreate, onJoin, onLeave, onRetry, onLogin }) {
  const sidebarRef = useRef(null);
  const l = partyLabels(locale);

  useEffect(() => {
    if (!visible) return;
    const escape = event => {
      if (event.key !== 'Escape') return;
      // An inline room must not steal Escape from lyrics, effects or title editing.
      if (!sidebarRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose(event);
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [visible, onClose, triggerRef]);

  useEffect(() => {
    if (!visible) return;
    const target = state.screen === 'join' ? sidebarRef.current?.querySelector('input') : sidebarRef.current;
    target?.focus({ preventScroll: true });
  }, [visible, state.screen]);

  const close = event => { onClose(event); triggerRef.current?.focus({ preventScroll: true }); };
  const copy = async () => {
    const code = state.room?.code;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      dispatch({ type: 'copy-result', ok: true });
    } catch {
      dispatch({ type: 'copy-result', ok: false });
    }
  };

  return <section id="listening-party-stage" ref={sidebarRef} className="party-sidebar"
    hidden={!visible} aria-hidden={!visible || undefined} inert={!visible ? '' : undefined}
    aria-label={l.title} tabIndex={-1} data-instant={instant ? 'true' : undefined}
    onKeyDownCapture={event => { if (event.key === 'Tab') event.stopPropagation(); }}>
    <PartySurface state={state} labels={l} user={user} dispatch={dispatch}
      onCreate={onCreate} onJoin={onJoin} onLeave={onLeave} onRetry={onRetry} onLogin={onLogin} onCopy={copy} onClose={close}/>
  </section>;
}
