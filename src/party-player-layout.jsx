import React from 'react';
import { useReducedMotion } from './use-motion-preference.js';
import { snapshotPartyPlayer, animatePartyPlayer, cancelPartyPlayerMotion } from './party-player-motion.js';

// Like DisclosureLayout, a pre-commit snapshot avoids reading the old layout
// too late in a layout effect. The actual artwork instance is never replaced.
export class PartyLayout extends React.Component {
  root = React.createRef();
  animations = new Set();

  getSnapshotBeforeUpdate(previous) {
    if (previous.open === this.props.open && previous.controlsAligned === this.props.controlsAligned
      || !previous.enabled || !this.props.enabled) return null;
    return snapshotPartyPlayer(this.root.current);
  }

  componentDidUpdate(previous, state, snapshot) {
    if (previous.open !== this.props.open || previous.controlsAligned !== this.props.controlsAligned || previous.enabled !== this.props.enabled
      || previous.reduced !== this.props.reduced || previous.instant !== this.props.instant) {
      animatePartyPlayer(snapshot, this.root.current, { ...this.props, layoutOnly: previous.open === this.props.open }, this.animations);
    }
  }

  componentWillUnmount() {
    cancelPartyPlayerMotion(this.animations);
  }

  render() {
    return <div ref={this.root} className={this.props.className} style={this.props.style}
      data-party-controls-aligned={this.props.controlsAligned ? 'true' : 'false'}>{this.props.children}</div>;
  }
}

export function PartyPlayerLayout(props) {
  const reduced = useReducedMotion();
  return <PartyLayout {...props} reduced={reduced}/>;
}
