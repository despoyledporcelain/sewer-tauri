import React, { useEffect, useMemo, useState } from 'react';
import { groupListeningHistory, historyDay } from './listening-history.js';

export function HistoryIcon({ size = 17 }) {
  return <span className="history-icon" style={{ width:size, height:size }} aria-hidden="true"/>;
}

export function ListeningHistory({ visible, entries, currentKey, isPlaying, localTracks, cloudTracks = [], covers = {},
  loadingId, errorId, onPlay, onClear, locale = 'ru-RU', labels }) {
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => { if (!visible || !entries.length) setConfirmClear(false); }, [visible, entries.length]);
  const groups = useMemo(() => groupListeningHistory(entries), [entries]);
  const localByPath = useMemo(() => new Map(localTracks.map(track => [track.path?.toLowerCase(), track])), [localTracks]);
  const cloudById = useMemo(() => new Map(cloudTracks.map(track => [String(track.id), track])), [cloudTracks]);
  // Other pages can update at animation frequency; don't render a hidden list.
  if (!visible) return null;
  const activeId = entries.find(entry => entry.key === currentKey)?.id;
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const dateFormat = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' });
  const timeFormat = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const dayLabel = group => group.day === historyDay(today.getTime()) ? labels.today
    : group.day === historyDay(yesterday.getTime()) ? labels.yesterday : dateFormat.format(group.timestamp);

  return <section className="listening-history scroll-thin" data-visible="true" aria-label={labels.title}>
    <div className="history-content">
      <header className="history-heading">
        <div><h1>{labels.title}</h1><p>{labels.subtitle}</p></div>
        {!!entries.length && <div className="history-actions">
          <span className="history-count" aria-label={labels.count.replace('{n}', entries.length)}>{entries.length}</span>
          {confirmClear ? <>
            <span className="history-confirm-label">{labels.confirmClear}</span>
            <button type="button" className="history-text-button history-clear" onClick={() => { onClear(); setConfirmClear(false); }}>{labels.clear}</button>
            <button type="button" className="history-text-button" onClick={() => setConfirmClear(false)}>{labels.cancel}</button>
          </> : <button type="button" className="history-text-button" onClick={() => setConfirmClear(true)}>{labels.clear}</button>}
        </div>}
      </header>
      {!entries.length ? <div className="history-empty" role="status">
        <HistoryIcon size={32}/>
        <h2>{labels.empty}</h2><p>{labels.emptyHint}</p>
      </div> : groups.map(group => <section className="history-day" key={group.day}>
        <h2>{dayLabel(group)}</h2>
        <ol className="history-list">{group.entries.map(entry => {
          const local = entry.source === 'local' ? localByPath.get(entry.track.path.toLowerCase()) : null;
          const track = local || entry.track;
          const unavailable = entry.source === 'local' && !local;
          const active = entry.id === activeId;
          const loading = entry.id === loadingId;
          const failed = entry.id === errorId;
          const cover = local?.coverUrl || covers[entry.key]
            || (entry.source === 'sc' && cloudById.get(String(entry.track.id))?.coverUrl) || entry.track.coverUrl;
          const title = track.title || labels.untitled;
          const artist = unavailable ? labels.unavailable : failed ? labels.playError : track.artist;
          const duration = Number.isFinite(track.duration) && track.duration > 0 ? Math.floor(track.duration) : 0;
          return <li key={entry.id}>
            <button type="button" className="history-row" data-active={active ? 'true' : 'false'}
              aria-label={`${labels.play}: ${title}`} aria-current={active ? 'true' : undefined}
              aria-busy={loading} disabled={unavailable || loading} title={unavailable ? labels.unavailable : title} onClick={() => onPlay(entry)}>
              <span className="history-cover" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2.5"/><ellipse cx="17" cy="16" rx="3" ry="2.5"/>
                </svg>
                {cover && <>
                  <img key={cover} src={cover} alt="" loading="lazy" draggable={false}
                    onError={event => { event.currentTarget.hidden = true; }}/>
                  <span className="history-cover-tint"/>
                </>}
                <span className="history-cover-action" data-on={loading || (active && isPlaying) ? 'true' : 'false'}>
                  {loading ? <span className="history-spinner"/> : active && isPlaying
                    ? <span className="history-playing"><i/><i/><i/></span>
                    : <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l12-7z"/></svg>}
                </span>
              </span>
              <span className="history-track-meta"><span className="history-track-title">{title}</span>
                {!!artist && <span className="history-track-artist" data-error={unavailable || failed ? 'true' : 'false'}>{artist}</span>}
              </span>
              <span className="history-source">{entry.source === 'sc' ? 'soundcloud' : labels.local}</span>
              <span className="history-duration" aria-hidden="true">{duration ? `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}` : ''}</span>
              <time className="history-listen-time" dateTime={new Date(entry.playedAt).toISOString()}
                title={dateFormat.format(entry.playedAt)}>{timeFormat.format(entry.playedAt)}</time>
            </button>
          </li>;
        })}</ol>
      </section>)}
    </div>
  </section>;
}
