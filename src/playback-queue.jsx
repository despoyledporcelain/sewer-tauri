import React, { useEffect, useRef, useState } from 'react';
import { queueTrackKey } from './playback-queue.js';
import { QueueTrackMotion } from './queue-track-motion.jsx';
import './playback-queue.css';

const iconPaths = {
  add: 'M3 5h14M3 10h14M3 15h7m7-4v10m-5-5h10',
  next: 'M3 5h18M3 10h10M3 15h7m8-3v9m-4-5 4-4 4 4',
  note: 'M9 18V6l11-2v12M9 18a3 2 0 1 1-6 0 3 2 0 0 1 6 0Zm11-2a3 2 0 1 1-6 0 3 2 0 0 1 6 0Z',
  close: 'm6 6 12 12M18 6 6 18',
  play: 'm8 5 12 7-12 7z',
  pause: 'M9 5v14m6-14v14',
  grip: 'M9 5h.1M15 5h.1M9 12h.1M15 12h.1M9 19h.1M15 19h.1',
};

export function QueueIcon({ name, size = 16 }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth={name === 'grip' ? 2.8 : 1.65} strokeLinecap="round" strokeLinejoin="round">
    <path d={iconPaths[name]}/>
  </svg>;
}

function TrackDetails({ track, t }) {
  const [failedCover, setFailedCover] = useState(null);
  const title = track.title || t('track_untitled');
  return <>
    <span className="queue-cover" aria-hidden="true">
      <QueueIcon name="note" size={15}/>
      {track.coverUrl && failedCover !== track.coverUrl && <>
        <img src={track.coverUrl} alt="" loading="lazy" decoding="async"
          onError={() => setFailedCover(track.coverUrl)}/>
        <span className="queue-cover-tint"/>
      </>}
    </span>
    <span className="queue-track-text">
      <strong title={title}>{title}</strong>
      {track.artist && <span title={track.artist}>{track.artist}</span>}
    </span>
  </>;
}

function QueueRows({ items, limit, t, locked, onPlay, onMove, onRemove, group }) {
  const listRef = useRef(null);
  const drag = useRef(null);
  const [dragKey, setDragKey] = useState(null);
  const [dropLine, setDropLine] = useState(null);
  const occurrences = new Map();
  const rows = items.slice(0, limit).map(item => {
    const id = item.id ?? item.track.path ?? item.track.id;
    const occurrence = occurrences.get(id) || 0;
    occurrences.set(id, occurrence + 1);
    return { key: `${group}:${id}:${occurrence}`, item };
  });
  const reorderable = !!onMove && items.length > 1;

  useEffect(() => () => {
    if (drag.current?.frame) cancelAnimationFrame(drag.current.frame);
    drag.current = null;
  }, []);

  function hitRow(x, y) {
    const row = document.elementFromPoint(x, y)?.closest('[data-queue-row-key]');
    return row?.parentElement === listRef.current ? row : null;
  }

  function updateDrag() {
    const pointer = drag.current;
    const list = listRef.current;
    if (!pointer || !list) return;
    const target = hitRow(pointer.x, pointer.y);
    const children = Array.from(list.children);
    const from = children.findIndex(row => row.dataset.queueRowKey === pointer.key);
    const to = children.indexOf(target);
    const key = from >= 0 && to >= 0 && from !== to ? target.dataset.queueRowKey : null;
    const edge = to > from ? 'after' : 'before';
    setDropLine(previous => {
      if (!key) return null;
      return previous?.key === key && previous.edge === edge ? previous : { key, edge };
    });

    const scroll = list.closest('.queue-body');
    if (pointer.frame || !scroll || from < 0) return;
    const box = scroll.getBoundingClientRect();
    if (pointer.x < box.left || pointer.x > box.right || pointer.y < box.top || pointer.y > box.bottom) return;
    const step = pointer.y < box.top + 24 ? -7 : pointer.y > box.bottom - 24 ? 7 : 0;
    if (!step || (step < 0 ? scroll.scrollTop <= 0 : scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1)) return;
    pointer.frame = requestAnimationFrame(() => {
      pointer.frame = 0;
      scroll.scrollTop += step;
      updateDrag();
    });
  }

  function finishDrag(event, commit) {
    const pointer = drag.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    drag.current = null;
    if (pointer.frame) cancelAnimationFrame(pointer.frame);
    setDragKey(null);
    setDropLine(null);
    if (!commit || (!pointer.moved && Math.abs(event.clientY - pointer.start) < 4)) return;
    const from = rows.findIndex(row => row.key === pointer.key);
    const target = hitRow(event.clientX, event.clientY);
    const to = rows.findIndex(row => row.key === target?.dataset.queueRowKey);
    if (from >= 0 && to >= 0 && from !== to) onMove(rows[from].item, rows[to].item, to - from);
  }

  return <ol className="queue-list" ref={listRef}>
    {rows.map(({ key, item }, index) => {
      const title = item.track.title || t('track_untitled');
      const playLabel = `${t('playback_play')} · ${title}`;
      return <li key={key} className="queue-row" data-queue-row-key={key}
        data-queue-track-key={queueTrackKey(item.track)} data-dragging={dragKey === key || undefined}
        data-drop={dropLine?.key === key ? dropLine.edge : undefined}>
        <button type="button" className="queue-track-button" title={playLabel} aria-label={playLabel}
          disabled={locked} onClick={() => onPlay(item, index)}>
          <TrackDetails track={item.track} t={t}/>
        </button>
        {reorderable && <button type="button" className="queue-icon-button queue-grip"
          title={t('queue_reorder')} aria-label={`${t('queue_reorder')} · ${title}`} aria-keyshortcuts="ArrowUp ArrowDown"
          onPointerDown={event => {
            if (event.button !== 0 || drag.current) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { id: event.pointerId, key, start: event.clientY, frame: 0, moved: false };
          }}
          onPointerMove={event => {
            const pointer = drag.current;
            if (!pointer || pointer.id !== event.pointerId) return;
            if (!pointer.moved) {
              if (Math.abs(event.clientY - pointer.start) < 4) return;
              pointer.moved = true;
              setDragKey(key);
            }
            pointer.x = event.clientX;
            pointer.y = event.clientY;
            updateDrag();
          }}
          onPointerUp={event => finishDrag(event, true)}
          onPointerCancel={event => finishDrag(event, false)}
          onLostPointerCapture={event => finishDrag(event, false)}
          onKeyDown={event => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            const offset = event.key === 'ArrowUp' ? -1 : 1;
            const target = rows[index + offset]?.item;
            if (!target) return;
            const grip = event.currentTarget;
            onMove(item, target, offset);
            requestAnimationFrame(() => {
              if (grip.isConnected && document.activeElement === document.body) grip.focus({ preventScroll: true });
            });
          }}><QueueIcon name="grip" size={15}/></button>}
        {onRemove && <button type="button" className="queue-icon-button queue-remove" title={t('queue_remove')}
          aria-label={`${t('queue_remove')} · ${title}`}
          onClick={() => onRemove(item, index)}><QueueIcon name="close" size={13}/></button>}
      </li>;
    })}
  </ol>;
}

export function QueueToggle({ open = false, hasEntries, onClick, buttonRef, t, compact = false }) {
  const label = t(open ? 'queue_back' : 'queue_title');
  return <button type="button" className="queue-trigger" ref={buttonRef} title={label} aria-label={label}
    aria-expanded={open} aria-controls="playback-queue"
    data-has-entries={!open && hasEntries} data-compact={compact} onClick={onClick}>
    {open ? <span aria-hidden="true" className="queue-toggle-glyph queue-toggle-back"/>
      : <img className="queue-toggle-glyph" src="/assets/playback-queue-icons8.png" alt="" draggable={false}/>}
  </button>;
}

const QUEUE_PAGE_SIZE = 50;

export function PlaybackQueue({ active, entries, upcoming, current, isPlaying, isLoading,
  pausedForParty, repeatOne, onPlay, onPlaySource, onMove, onMoveSource, onRemove, onClear, onBack, backRef, t, instant,
  motionEnabled, reduced }) {
  const [limit, setLimit] = useState(QUEUE_PAGE_SIZE);
  const headingRef = useRef(null);
  const panelRef = useRef(null);

  function restoreRowFocus(action, index) {
    const focusWasInside = panelRef.current?.contains(document.activeElement);
    action();
    if (!focusWasInside) return;
    requestAnimationFrame(() => {
      if (!panelRef.current || document.activeElement !== document.body) return;
      const rows = panelRef.current.querySelectorAll('.queue-track-button:not(:disabled)');
      (rows[Math.min(index, rows.length - 1)] || headingRef.current)?.focus({ preventScroll: true });
    });
  }

  return <section id="playback-queue" className="queue-panel" ref={panelRef} aria-labelledby="queue-heading"
    aria-hidden={!active || undefined} inert={!active ? '' : undefined}
    data-queue-active={active} data-queue-instant={instant}
    onKeyDown={event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onBack(event);
    }}>
      <header className="queue-header">
        <h2 id="queue-heading" ref={headingRef} tabIndex={-1}>{t('queue_title')}</h2>
        <QueueToggle open compact buttonRef={backRef} onClick={onBack} t={t}/>
      </header>
      <QueueTrackMotion enabled={active && motionEnabled} reduced={reduced} trackKey={queueTrackKey(current)}>
        {current && <div className="queue-current-slot">
          <div className="queue-row queue-current" aria-current="true">
            <TrackDetails track={current} t={t}/>
            <span className="queue-current-state" role="img"
              aria-label={t(isPlaying ? 'queue_playing_status' : 'queue_paused_status')}>
              <QueueIcon name={isPlaying ? 'play' : 'pause'} size={14}/>
            </span>
          </div>
          <div className="queue-current-exit" aria-hidden="true"/>
        </div>}
        {pausedForParty && <p className="queue-note">{t('queue_party')}</p>}
        {entries.length > 0 && <>
          <div className="queue-section-header">
            <h3>{t('queue_manual')}</h3>
            <button type="button" className="queue-clear"
              onClick={() => restoreRowFocus(onClear, 0)}>{t('queue_clear')}</button>
          </div>
          <QueueRows items={entries} limit={entries.length} group="manual" t={t} locked={pausedForParty || isLoading}
            onPlay={(item, index) => restoreRowFocus(() => onPlay(item), index)}
            onMove={(item, _, offset) => onMove(item, offset)}
            onRemove={(item, index) => restoreRowFocus(() => onRemove(item), index)}/>
        </>}
        {!pausedForParty && <>
          {(current || upcoming.length > 0) && <div className="queue-section-header">
            <h3>{t('queue_upcoming')}</h3>
          </div>}
          {repeatOne && current ? <p className="queue-note">{t('queue_repeat_one')}</p>
            : upcoming.length > 0 ? (
              <QueueRows items={upcoming} limit={limit} group="source" t={t} locked={isLoading}
                onMove={onMoveSource} onPlay={(item, index) => restoreRowFocus(() => onPlaySource(item), entries.length + index)}/>
            ) : current ? <p className="queue-note">{t('queue_end')}</p>
              : entries.length === 0 && <p className="queue-note">{t('queue_empty')}</p>}
          {upcoming.length > limit && <button type="button" className="queue-clear queue-more"
            onClick={() => setLimit(limit + QUEUE_PAGE_SIZE)}>{t('queue_more')}</button>}
        </>}
      </QueueTrackMotion>
    </section>;
}
