export function sliderFraction(value, min, max) {
  if (!(max > min) || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

export function sliderValue(fraction, min, max, step) {
  const raw = min + Math.max(0, Math.min(1, fraction)) * (max - min);
  const value = min + Math.round((raw - min) / step) * step;
  return Math.max(min, Math.min(max, Math.round(value * 1e6) / 1e6));
}

export function pointerFraction(event, rect, vertical = false, inset = 0) {
  const length = (vertical ? rect.height : rect.width) - inset * 2;
  if (!(length > 0)) return 0;
  const offset = vertical ? event.clientY - rect.top : event.clientX - rect.left;
  const fraction = Math.max(0, Math.min(1, (offset - inset) / length));
  return vertical ? 1 - fraction : fraction;
}
