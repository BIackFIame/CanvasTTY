import { fineDotSvgDefinitions } from "./asciiFineDots.ts";
import type { AsciiPiece } from "../../vendor/ascii-rest/mount.js";

const escape = (value: string): string => value.replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function asciiFrameSvg(text: string, meta: AsciiPiece["meta"], color?: Uint8Array): string {
  const { cols = 80, rows = 24, cell = 2, palette, ground = "#07090f" } = meta;
  const width = cols * 6, height = rows * cell * 6;
  const lines = text.split("\n");
  if (meta.fineDots) {
    let dots = "";
    for (let y = 0; y < Math.min(lines.length, rows); y++) {
      const chars = [...lines[y]].slice(0, cols);
      for (let x = 0; x < chars.length; x++) {
        const mask = chars[x].charCodeAt(0) - 0x2800;
        if (mask <= 0 || mask > 255) continue;
        const ink = palette?.[color?.[y * cols + x] ?? 0] ?? "#f7f4ec";
        dots += `<use href="#dot${mask}" x="${x * 6}" y="${y * cell * 6}" fill="${escape(ink)}"/>`;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><rect width="100%" height="100%" fill="${escape(ground)}"/>${fineDotSvgDefinitions(cell * 6)}${dots}</svg>`;
  }
  let content = "";
  for (let y = 0; y < Math.min(lines.length, rows); y++) {
    const chars = [...lines[y]].slice(0, cols);
    let spans = "";
    for (let x = 0; x < chars.length;) {
      const ink = palette?.[color?.[y * cols + x] ?? 0] ?? "#f7f4ec";
      const start = x++;
      while (x < chars.length && (palette?.[color?.[y * cols + x] ?? 0] ?? "#f7f4ec") === ink) x++;
      const run = chars.slice(start, x).join("");
      if (run.trim()) spans += `<text x="${start * 6}" y="${cell * 3}" textLength="${(x - start) * 6}" lengthAdjust="spacingAndGlyphs" fill="${escape(ink)}">${escape(run)}</text>`;
    }
    content += `<svg y="${y * cell * 6}" width="${width}" height="${cell * 6}" overflow="hidden">${spans}</svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" font-family="Consolas,DejaVu Sans Mono,monospace" font-size="10" dominant-baseline="central" xml:space="preserve"><rect width="100%" height="100%" fill="${escape(ground)}"/>${content}</svg>`;
}
