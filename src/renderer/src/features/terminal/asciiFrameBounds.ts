import type { AsciiPiece } from "../../vendor/ascii-rest/mount.js";

export interface AsciiFrameTransform { scale: number; offsetX: number; offsetY: number }

export function asciiFrameBounds(width: number, height: number, meta: AsciiPiece["meta"], pixelRatio = 1,
  transform: AsciiFrameTransform = { scale: 100, offsetX: 0, offsetY: 0 }): { x: number; y: number; width: number; height: number } {
  const { cols = 80, rows = 24, cell = 2 } = meta;
  const sceneWidth = cols * 6;
  const sceneHeight = rows * cell * 6;
  const fit = Math.min(width / sceneWidth, height / sceneHeight);
  const containWidth = sceneWidth * fit;
  const containHeight = sceneHeight * fit;
  const scale = Math.min(width * 0.8 / sceneWidth, height * 0.8 / sceneHeight, 1.25 * pixelRatio);
  const zoom = transform.scale / 100;
  const aspect = sceneWidth / sceneHeight;
  const coverWidth = Math.max(width, height * aspect);
  const coverHeight = Math.max(height, width / aspect);
  const artWidth = (meta.contain ? containWidth : meta.fullBleed || cell === 1 ? width : meta.cover ? coverWidth : Math.min(width, cols * 6 * scale)) * zoom;
  const artHeight = (meta.contain ? containHeight : meta.fullBleed || cell === 1 ? height : meta.cover ? coverHeight : Math.min(height, rows * cell * 6 * scale)) * zoom;
  return { x: (width - artWidth) / 2 + width * transform.offsetX / 100,
    y: (height - artHeight) / 2 + height * transform.offsetY / 100, width: artWidth, height: artHeight };
}
