// Unicode Braille bit order, with a fixed spatial threshold for stable video dithering.
export const BRAILLE_DOTS = [
  { x: 0, y: 0, bit: 1, threshold: .0625 },
  { x: 1, y: 0, bit: 8, threshold: .5625 },
  { x: 0, y: 1, bit: 2, threshold: .8125 },
  { x: 1, y: 1, bit: 16, threshold: .3125 },
  { x: 0, y: 2, bit: 4, threshold: .4375 },
  { x: 1, y: 2, bit: 32, threshold: .9375 },
  { x: 0, y: 3, bit: 64, threshold: .6875 },
  { x: 1, y: 3, bit: 128, threshold: .1875 },
] as const;

export function appendFineDots(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  char: string, x: number, y: number, height: number): void {
  const mask = char.charCodeAt(0) - 0x2800;
  if (mask <= 0 || mask > 255) return;
  const radius = Math.min(3, height / 4) * .4;
  for (const dot of BRAILLE_DOTS) {
    if (!(mask & dot.bit)) continue;
    const cx = x + (dot.x + .5) * 3, cy = y + (dot.y + .5) * height / 4;
    ctx.moveTo(cx + radius, cy);
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  }
}

export function fineDotSvgDefinitions(height: number): string {
  const radius = Math.min(3, height / 4) * .4;
  return "<defs>" + Array.from({ length: 255 }, (_, i) => {
    const mask = i + 1;
    const circles = BRAILLE_DOTS.filter(dot => mask & dot.bit).map(dot =>
      `<circle cx="${(dot.x + .5) * 3}" cy="${(dot.y + .5) * height / 4}" r="${radius}"/>`).join("");
    return `<g id="dot${mask}">${circles}</g>`;
  }).join("") + "</defs>";
}
