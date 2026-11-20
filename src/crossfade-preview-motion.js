// The crossfade preview keeps its electrical effect independently of the EQ.
const ENVELOPE = [[0, 1], [90, 0.34], [150, 0.95], [240, 0.3],
  [330, 0.72], [450, 0.3], [600, 0.12], [880, 0]];

export function crossfadeBoltEnvelope(time) {
  for (let index = 1; index < ENVELOPE.length; index++) {
    const [end, to] = ENVELOPE[index];
    if (time > end) continue;
    const [start, from] = ENVELOPE[index - 1];
    return from + (to - from) * ((time - start) / (end - start || 1));
  }
  return 0;
}

export function crossfadeBoltPath(points) {
  let path = '';
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index];
    const dx = b.x - a.x, dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length, ny = dx / length;
    if (!path) path = `M${a.x.toFixed(1)} ${a.y.toFixed(1)}`;
    for (let step = 1; step <= 3; step++) {
      const fraction = step / 3;
      const amplitude = step === 3 ? 0 : Math.min(9, length * 0.17);
      const offset = (Math.random() * 2 - 1) * amplitude;
      path += `L${(a.x + dx * fraction + nx * offset).toFixed(1)} ${(a.y + dy * fraction + ny * offset).toFixed(1)}`;
    }
  }
  return path;
}

export function crossfadeBoltBranches(points) {
  let path = '';
  for (let index = 1; index < points.length; index++) {
    if (Math.random() < 0.45) continue;
    const point = points[index];
    const angle = Math.random() * Math.PI * 2;
    const first = 6 + Math.random() * 11, second = 4 + Math.random() * 8;
    const bend = Math.random() * 1.1 - 0.55;
    const x1 = point.x + Math.cos(angle) * first, y1 = point.y + Math.sin(angle) * first;
    const x2 = x1 + Math.cos(angle + bend) * second, y2 = y1 + Math.sin(angle + bend) * second;
    path += `M${point.x.toFixed(1)} ${point.y.toFixed(1)}L${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }
  return path;
}
