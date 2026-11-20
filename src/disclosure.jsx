import React, { useLayoutEffect, useRef, useState } from 'react';
import { useReducedMotion } from './use-motion-preference.js';
import { snapshotDisclosures, animateDisclosureLayout } from './disclosure-motion.js';

export function Disclosure({ open, children, inline = false, style }) {
  const opened = !!open;
  const reduced = useReducedMotion();
  const content = useRef(null);
  const retained = useRef(children);
  const [present, setPresent] = useState(opened);
  useLayoutEffect(() => {
    if (opened) {
      retained.current = children;
      setPresent(true);
    } else if (reduced || content.current?.closest('[data-instant]')) {
      setPresent(false);
    }
  }, [opened, children, reduced]);
  return <div className={`disclosure${inline ? ' disclosure-inline' : ''}`}
    data-disclosure="" data-open={String(opened)} style={style}>
    <div ref={content} className="disclosure-content" aria-hidden={!opened || undefined}
      inert={!opened ? '' : undefined} hidden={!opened && (!present || reduced)}
      onTransitionEnd={event => {
        if (!opened && event.target === event.currentTarget && event.propertyName === 'clip-path') setPresent(false);
      }}>
      {opened ? children : retained.current}
    </div>
  </div>;
}

// A snapshot lifecycle is needed here: a layout effect runs after React has
// already moved the following controls, too late to capture their old boxes.
export class DisclosureLayout extends React.Component {
  root = React.createRef();
  animations = new Set();
  instant = false;

  getSnapshotBeforeUpdate(previous) {
    if (previous.motionKey === this.props.motionKey || this.props.reduced || this.instant) return null;
    return snapshotDisclosures(this.root.current);
  }

  componentDidUpdate(previous, state, snapshot) {
    if (previous.motionKey !== this.props.motionKey || previous.reduced !== this.props.reduced) {
      animateDisclosureLayout(snapshot, this.root.current, this.props.reduced || this.instant, this.animations);
    }
  }

  componentWillUnmount() {
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
  }

  render() {
    return <div ref={this.root} style={this.props.style}
      onKeyDownCapture={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        this.instant = true;
        this.root.current.setAttribute('data-instant', '');
      }}
      onPointerDownCapture={() => {
        this.instant = false;
        this.root.current.removeAttribute('data-instant');
      }}>{this.props.children}</div>;
  }
}
