import React from 'react';
import { FEEDBACK_EASE } from './motion-lifecycle.js';

const shift = y => `translateY(${y}px)`;

function visibleRows(body, viewport) {
  const rows = new Map();
  if (!viewport.height) return rows;
  for (const row of body.querySelectorAll('[data-queue-row-key]')) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > viewport.top && rect.top < viewport.bottom) {
      rows.set(row.dataset.queueRowKey, { row, rect });
    }
  }
  return rows;
}

// Capture the still-visible queue before React removes the promoted row.
export class QueueTrackMotion extends React.Component {
  body = React.createRef();
  animations = new Set();
  ghost = null;

  getSnapshotBeforeUpdate(previous) {
    if (!previous.enabled || !this.props.enabled || this.props.reduced
      || !previous.trackKey || previous.trackKey === this.props.trackKey) return null;
    const body = this.body.current;
    const current = body.querySelector('.queue-current');
    if (!current?.animate) return null;
    const viewport = body.getBoundingClientRect();
    const rect = current.getBoundingClientRect();
    const rows = visibleRows(body, viewport);
    const next = Array.from(rows.values()).find(({ row }) => row.dataset.queueTrackKey === this.props.trackKey);
    const outgoing = rect.bottom > viewport.top && rect.top < viewport.bottom ? current.cloneNode(true) : null;
    return { rows, next, outgoing, top: rect.top, opacity: getComputedStyle(current).opacity };
  }

  componentDidUpdate(previous, state, snapshot) {
    if (!this.props.enabled || this.props.reduced || !this.props.trackKey) {
      this.cancel();
      return;
    }
    if (!snapshot) return;
    this.cancel();
    const body = this.body.current;
    const current = body.querySelector('.queue-current');
    const layer = body.querySelector('.queue-current-exit');
    const viewport = body.getBoundingClientRect();
    const rows = visibleRows(body, viewport);
    const currentTop = current?.getBoundingClientRect().top;
    const incomingY = snapshot.next ? snapshot.next.rect.top - currentTop : 0;

    if (snapshot.outgoing && layer && current) {
      const ghost = snapshot.outgoing;
      ghost.removeAttribute('aria-current');
      layer.append(ghost);
      this.ghost = ghost;
      const from = snapshot.top - currentTop;
      this.play(ghost, [{ opacity: snapshot.opacity, transform: shift(from) },
        { opacity: 0, transform: shift(from - 10) }], 150, () => {
        ghost.remove();
        if (this.ghost === ghost) this.ghost = null;
      });
    }
    if (current && currentTop >= viewport.top - 42 && currentTop < viewport.bottom) {
      const offset = incomingY > 0 && incomingY <= 120 ? incomingY : 10;
      this.play(current, [{ opacity: .28, transform: shift(offset) },
        { opacity: 1, transform: shift(0) }], 230);
    }
    for (const [key, { row, rect }] of rows) {
      const before = snapshot.rows.get(key);
      if (!before) continue;
      const delta = before.rect.top - rect.top;
      if (Math.abs(delta) > 1 && Math.abs(delta) <= 120) {
        this.play(row, [{ transform: shift(delta) }, { transform: shift(0) }], 200);
      }
    }
  }

  play(element, frames, duration, done) {
    const animation = element.animate(frames, { duration, easing: FEEDBACK_EASE });
    this.animations.add(animation);
    animation.onfinish = () => {
      this.animations.delete(animation);
      done?.();
    };
  }

  cancel() {
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
    this.ghost?.remove();
    this.ghost = null;
  }

  componentWillUnmount() { this.cancel(); }

  render() {
    return <div className="queue-body" ref={this.body}>{this.props.children}</div>;
  }
}
