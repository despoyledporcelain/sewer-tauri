import React from 'react';

/* One transport, two surfaces. App owns both playback and navigation. */
export function MiniPlayer({ visible, track, isPlaying, onPrev, onToggle, onNext, onOpen, labels, transportLocked = false }) {
  const title = track?.title || labels.untitled;
  const artist = track?.artist || '';
  const button = (action, label, className, children) => (
    <button type="button" className={`mini-player-button ${className}`}
      title={label} aria-label={label} disabled={!visible || transportLocked} tabIndex={visible && !transportLocked ? 0 : -1}
      onClick={visible && !transportLocked ? action : undefined}>{children}</button>
  );

  return (
    <div className="mini-player-slot">
      <div className="mini-player" data-visible={visible ? 'true' : 'false'}
        data-playing={isPlaying ? 'true' : 'false'} role="group" aria-label={labels.player}
        aria-hidden={!visible} inert={visible ? undefined : ''}>
        <button type="button" className="mini-player-track" disabled={!visible} tabIndex={visible ? 0 : -1}
          onClick={visible ? onOpen : undefined} aria-label={`${labels.openPlayer}: ${title}`}
          title={`${labels.openPlayer}: ${title}${artist ? ` · ${artist}` : ''}`}>
          <span className="mini-player-cover" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18V5l11-2v13M9 8l11-2"/>
              <ellipse cx="6" cy="18" rx="3" ry="2.5"/>
              <ellipse cx="17" cy="16" rx="3" ry="2.5"/>
            </svg>
            {track?.coverUrl && <img key={track.coverUrl} src={track.coverUrl} alt="" draggable={false}
              onError={e => { e.currentTarget.hidden = true; }}/>}
            {track?.coverUrl && <span className="mini-player-cover-tint"/>}
          </span>
          <span className="mini-player-meta">
            <span className="mini-player-title">{title}</span>
            {artist && <span className="mini-player-artist">{artist}</span>}
          </span>
        </button>
        <div className="mini-player-transport">
          {button(onPrev, labels.previous, 'mini-player-skip',
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="4" y="5" width="2.5" height="14" rx="1"/>
              <path d="M18.5 5.3c.6-.4 1.5 0 1.5.7v12c0 .7-.9 1.1-1.5.7l-9-6a.8.8 0 0 1 0-1.4z"/>
            </svg>)}
          {button(onToggle, isPlaying ? labels.pause : labels.play, 'mini-player-toggle',
            <span className="mini-player-toggle-icons" aria-hidden="true">
              <svg className="mini-player-play-icon" width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 4.8c0-.8.9-1.3 1.6-.8l12 7.2a.9.9 0 0 1 0 1.6L9.6 20c-.7.5-1.6 0-1.6-.8z"/>
              </svg>
              <svg className="mini-player-pause-icon" width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" rx="1.2"/>
                <rect x="14" y="4" width="4" height="16" rx="1.2"/>
              </svg>
            </span>)}
          {button(onNext, labels.next, 'mini-player-skip',
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="17.5" y="5" width="2.5" height="14" rx="1"/>
              <path d="M5.5 5.3C4.9 4.9 4 5.3 4 6v12c0 .7.9 1.1 1.5.7l9-6a.8.8 0 0 0 0-1.4z"/>
            </svg>)}
        </div>
      </div>
    </div>
  );
}
