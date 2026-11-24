export function lyricsReturnFlight(source, target, travelEase) {
  const { rect, word, font } = target;
  const anchor = word && source.word && source.word.bottom > source.rect.top && source.word.top < source.rect.bottom;
  const fontScale = source.font > 0 && font > 0 ? font / source.font : source.scale;
  const scale = anchor && source.word.height > 0 && word.height > 0
    ? source.scale * word.height / source.word.height : fontScale;
  const ratio = scale / source.scale;
  const x = anchor ? word.left - source.rect.left - (source.word.left - source.rect.left) * ratio : rect.left - source.rect.left;
  const y = anchor ? word.top - source.rect.top - (source.word.top - source.rect.top) * ratio : rect.top - source.rect.top;
  const lineCenter = anchor ? word.top + word.height / 2 - rect.top : rect.height / 2;
  const top = Math.max(0, lineCenter - (font || 16) * 1.5);
  const bottom = Math.max(0, rect.height - lineCenter - (font || 16) * 1.5);
  const handoff = 0.72;
  const revealEase = 'ease-in-out';
  const open = 'inset(0px)';
  const narrow = `inset(${top}px 0px ${bottom}px)`;
  const landedLeft = source.rect.left + x;
  const landedTop = source.rect.top + y;
  const landedRight = landedLeft + source.rect.width * ratio;
  const landedBottom = landedTop + source.rect.height * ratio;
  const crop = [rect.top - landedTop, landedRight - rect.right, landedBottom - rect.bottom, rect.left - landedLeft]
    .map(edge => `${Math.max(0, edge / scale)}px`).join(' ');
  const landed = { transform:`translate3d(${x}px, ${y}px, 0) scale(${scale})`, clipPath:`inset(${crop})` };
  return {
    travel: [
      { transform:`translate3d(0px, 0px, 0) scale(${source.scale})`, clipPath:open, easing:travelEase },
      { ...landed, offset:handoff },
      landed,
    ],
    fade: [{ opacity:1 }, { opacity:1, offset:handoff, easing:revealEase }, { opacity:0 }],
    reveal: [
      { opacity:0, clipPath:narrow },
      { opacity:0, clipPath:narrow, offset:handoff, easing:revealEase },
      { opacity:1, clipPath:open },
    ],
  };
}
