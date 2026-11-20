import React, { forwardRef, useId, useImperativeHandle, useLayoutEffect, useRef } from 'react';

// The curve shares the faders' animated positions, not their target settings.
// No per-frame React renders or layout reads are needed to follow a drag.
export function createEqContourModel(count) {
  const listeners = new Set();
  return {
    positions: Array(count).fill(0.5),
    set(index, position) {
      this.positions[index] = Math.max(0, Math.min(1, position));
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function contourPath(points, width) {
  const first = points[0], last = points.at(-1);
  let path = `M0 ${first.y} L${first.x} ${first.y}`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], middle = (a.x + b.x) / 2;
    path += ` C${middle} ${a.y} ${middle} ${b.y} ${b.x} ${b.y}`;
  }
  return `${path} L${width} ${last.y}`;
}

// Sample the same Béziers as the real curve. The silk moves along its normals,
// so it wraps steep presets rather than becoming a separate horizontal wave.
function sampleContour(points, width) {
  const samples = [{ x: 0, y: points[0].y, nx: 0, ny: 1 }];
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index], middle = (a.x + b.x) / 2;
    for (let step = 0; step <= 10; step++) {
      if (index > 1 && step === 0) continue;
      const t = step / 10, u = 1 - t;
      const dx = 3 * (u * u * (middle - a.x) + t * t * (b.x - middle));
      const dy = 6 * u * t * (b.y - a.y), length = Math.hypot(dx, dy) || 1;
      samples.push({
        x: u ** 3 * a.x + 3 * u * t * middle + t ** 3 * b.x,
        y: a.y + (b.y - a.y) * (3 * t * t - 2 * t ** 3),
        nx: -dy / length, ny: dx / length,
      });
    }
  }
  samples.push({ x: width, y: points.at(-1).y, nx: 0, ny: 1 });
  return samples;
}

const pointPath = points => points.map((point, index) =>
  `${index ? 'L' : 'M'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');

function silkThreads(samples, width, head, progress, direction) {
  return [0, 1, 2].map(thread => samples.map(point => {
    const behind = direction * (head - point.x / width);
    const envelope = Math.exp(-(((behind - 0.06) / 0.19) ** 2));
    const phase = behind * 20 - progress * 5 + (direction < 0 ? Math.PI / 2 : 0);
    const twist = thread === 0 ? Math.sin(phase)
      : thread === 1 ? -Math.sin(phase + 0.55) : Math.cos(phase + 1.1) * 0.55;
    const offset = direction * twist * envelope * Math.min(17, width * 0.07);
    return { x: point.x + point.nx * offset, y: point.y + point.ny * offset };
  }));
}

function orbitArc(point, radius, angle) {
  let path = '';
  for (const turn of [0, Math.PI]) {
    const start = angle + turn - 0.85, end = angle + turn;
    path += `M${point.x + Math.cos(start) * radius} ${point.y + Math.sin(start) * radius * 0.64}`;
    path += `A${radius} ${radius * 0.64} 0 0 1 ${point.x + Math.cos(end) * radius} ${point.y + Math.sin(end) * radius * 0.64}`;
  }
  return path;
}

export const EqContour = forwardRef(function EqContour({ model, active, reduced }, ref) {
  const gradientId = `eq-contour-${useId().replace(/:/g, '')}`;
  const hostRef = useRef(null);
  const paths = useRef({});
  const waves = useRef([0, 1].map(() => ({ threads: [], orbits: [], motes: [] })));
  const controls = useRef(null);

  useImperativeHandle(ref, () => ({ pulse: () => controls.current?.pulse() }), []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !active) return;
    let width = host.clientWidth, height = host.clientHeight, frame = 0, pulseAt = null, pulseQueued = false;
    const hidePulse = () => {
      for (const wave of waves.current) {
        for (const element of [wave.veil, wave.halo, ...wave.threads,
          ...wave.orbits, ...wave.motes]) if (element) element.style.opacity = '0';
      }
    };
    const draw = now => {
      frame = 0;
      if (!(width > 0 && height > 0)) { pulseAt = null; pulseQueued = false; hidePulse(); return; }
      const points = model.positions.map((position, index) => ({
        x: (index + 0.5) * width / model.positions.length,
        y: (1 - position) * height,
      }));
      const path = contourPath(points, width);
      paths.current.line.setAttribute('d', path);
      // Start the clock on the first rendered frame, after the preset commit.
      // Otherwise a busy render can skip the entire left-hand part of the sweep.
      if (pulseQueued) { pulseAt = now; pulseQueued = false; }
      if (pulseAt == null) return;
      const progress = Math.min(1, (now - pulseAt) / 1050);
      const travel = progress * 1.48 - 0.045;
      const opacity = Math.min(1, progress / 0.035) * Math.min(1, (1 - progress) / 0.14);
      const samples = sampleContour(points, width);
      // Independent packets enter from opposite edges and keep moving after
      // crossing. Neither wave reverses or disappears at the meeting point.
      waves.current.forEach((wave, side) => {
        const direction = side === 0 ? 1 : -1;
        const head = side === 0 ? travel : 1 - travel;
        const silk = silkThreads(samples, width, head, progress, direction);
        const silkPaths = silk.map(pointPath);
        wave.ink.setAttribute('x1', String((head - direction * 0.38) * width));
        wave.ink.setAttribute('x2', String((head + direction * 0.17) * width));
        wave.threads.forEach((thread, index) => {
          thread.setAttribute('d', silkPaths[index]);
          thread.style.opacity = String(opacity);
        });
        wave.halo.setAttribute('d', silkPaths[2]);
        wave.halo.style.opacity = String(opacity * 0.48);
        wave.veil.setAttribute('d', `${silkPaths[0]} ${pointPath([...silk[1]].reverse()).replace(/^M/, 'L')} Z`);
        wave.veil.style.opacity = String(opacity * 0.16);
        points.forEach((point, index) => {
          const age = direction * (head - (index + 0.5) / points.length) / 0.34;
          const orbit = wave.orbits[index];
          const pair = [wave.motes[index * 2], wave.motes[index * 2 + 1]];
          if (age <= 0 || age >= 1) {
            orbit.style.opacity = '0';
            for (const mote of pair) mote.style.opacity = '0';
            return;
          }
          const bloom = Math.sin(Math.PI * age);
          const radius = 7 + bloom * Math.min(9, width / points.length * 0.25);
          const angle = direction * (age * Math.PI * 1.8 + index * 0.4);
          orbit.setAttribute('d', orbitArc(point, radius, angle));
          orbit.style.opacity = String(bloom * opacity * 0.55);
          pair.forEach((mote, pole) => {
            const turn = angle + pole * Math.PI;
            mote.setAttribute('cx', String(point.x + Math.cos(turn) * radius));
            mote.setAttribute('cy', String(point.y + Math.sin(turn) * radius * 0.64));
            mote.setAttribute('r', String(0.8 + bloom * 0.75));
            mote.style.opacity = String(bloom * opacity * 0.9);
          });
        });
      });
      if (progress < 1) schedule();
      else { pulseAt = null; hidePulse(); }
    };
    function schedule() { if (!frame) frame = requestAnimationFrame(draw); }
    controls.current = { pulse() {
      if (reduced) return;
      pulseQueued = true;
      schedule();
    } };
    const unsubscribe = model.subscribe(schedule);
    const observer = new ResizeObserver(entries => {
      const { width: nextWidth, height: nextHeight } = entries[0].contentRect;
      width = nextWidth; height = nextHeight;
      schedule();
    });
    observer.observe(host);
    draw(performance.now());
    return () => {
      controls.current = null;
      unsubscribe();
      observer.disconnect();
      cancelAnimationFrame(frame);
      hidePulse();
    };
  }, [model, active, reduced]);

  return <div ref={hostRef} className="eq-contour-layer" aria-hidden="true"><svg className="eq-contour">
    <defs>
      {waves.current.map((wave, side) => <linearGradient key={side} ref={el => { wave.ink = el; }}
        id={`${gradientId}-silk-${side}`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stopColor="var(--accent)" stopOpacity="0"/>
        <stop offset="28%" stopColor="var(--accent)" stopOpacity="0.35"/>
        <stop offset="60%" stopColor="var(--text)" stopOpacity="0.95"/>
        <stop offset="78%" stopColor="var(--accent)" stopOpacity="0.8"/>
        <stop offset="100%" stopColor="var(--accent)" stopOpacity="0"/>
      </linearGradient>)}
    </defs>
    <path ref={el => { paths.current.line = el; }} className="eq-contour-line"/>
    {waves.current.map((wave, side) => <g key={side}>
      <path ref={el => { wave.veil = el; }} className="eq-contour-veil" fill={`url(#${gradientId}-silk-${side})`}/>
      <path ref={el => { wave.halo = el; }} className="eq-contour-halo" stroke={`url(#${gradientId}-silk-${side})`}/>
      {[0, 1, 2].map(index => <path key={index} ref={el => { wave.threads[index] = el; }}
        className="eq-contour-silk" data-thread={index} stroke={`url(#${gradientId}-silk-${side})`}/>)}
      {model.positions.map((_, index) => <g key={index}>
        <path ref={el => { wave.orbits[index] = el; }} className="eq-contour-orbit"/>
        {[0, 1].map(pole => <circle key={pole} ref={el => { wave.motes[index * 2 + pole] = el; }} className="eq-contour-mote"/>)}
      </g>)}
    </g>)}
  </svg></div>;
});
