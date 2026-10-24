import type { AsciiPiece } from "../../vendor/ascii-rest/mount.js";
import { appendFineDots } from "./asciiFineDots.ts";
import { asciiFrameBounds, type AsciiFrameTransform } from "./asciiFrameBounds.ts";

export function drawAsciiFrame(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, text: string, meta: AsciiPiece["meta"], color?: Uint8Array, pixelRatio = 1, transform?: AsciiFrameTransform): void {
  const { cols = 80, rows = 24, cell = 2, palette, ground = "#07090f" } = meta;
  const width = cols * 6, height = rows * cell * 6;
  const bounds = asciiFrameBounds(ctx.canvas.width, ctx.canvas.height, meta, pixelRatio, transform);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(bounds.width / width, 0, 0, bounds.height / height, bounds.x, bounds.y);
  ctx.font = "10px Consolas, 'DejaVu Sans Mono', monospace";
  ctx.textBaseline = "middle";
  const lines = text.split("\n");
  for (let y = 0; y < Math.min(lines.length, rows); y++) {
    const chars = [...lines[y]].slice(0, cols);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y * cell * 6, width, cell * 6);
    ctx.clip();
    for (let x = 0; x < chars.length;) {
      const ink = palette?.[color?.[y * cols + x] ?? 0] ?? "#f7f4ec";
      const start = x++;
      while (x < chars.length && (palette?.[color?.[y * cols + x] ?? 0] ?? "#f7f4ec") === ink) x++;
      const run = chars.slice(start, x).join("");
      if (run.trim()) {
        ctx.fillStyle = ink;
        if (meta.fineDots) {
          ctx.beginPath();
          for (let column = start; column < x; column++) appendFineDots(ctx, chars[column], column * 6, y * cell * 6, cell * 6);
          ctx.fill();
        } else ctx.fillText(run, start * 6, (y + 0.5) * cell * 6, (x - start) * 6);
      }
    }
    ctx.restore();
  }
}
