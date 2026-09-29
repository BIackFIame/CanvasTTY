import type { SessionStatus } from "../../../../shared/contracts";

export const PIXEL_SKIN_THEMES = ["sakura", "matrix", "forest-cabin", "gold-black", "cat", "gothic-eclipse"] as const;
export type PixelSkinThemeId = typeof PIXEL_SKIN_THEMES[number];
export type PixelSkinDetailLevel = "minimal" | "detailed" | "master";
export type PixelSkinArtState = "idle" | "working" | "completed";
export type PixelSkinImageState = PixelSkinArtState;

interface PixelSkinDefinition {
  fileStem: string;
  detailStems: Readonly<Record<PixelSkinDetailLevel, string>>;
}

export const PIXEL_SKIN_CATALOG: Readonly<Record<PixelSkinThemeId, PixelSkinDefinition>> = {
  sakura: { fileStem: "sakura", detailStems: { minimal: "l1", detailed: "l2", master: "master" } },
  matrix: { fileStem: "matrix", detailStems: { minimal: "l1", detailed: "l2", master: "master" } },
  "forest-cabin": { fileStem: "forest_cabin", detailStems: { minimal: "minimal", detailed: "detailed", master: "master" } },
  "gold-black": { fileStem: "gold_black", detailStems: { minimal: "l1", detailed: "detailed", master: "master" } },
  cat: { fileStem: "cat", detailStems: { minimal: "minimal", detailed: "detailed", master: "master" } },
  "gothic-eclipse": { fileStem: "gothic_eclipse", detailStems: { minimal: "minimal", detailed: "detailed", master: "master" } }
};

export function pixelSkinAssetFilename(
  theme: PixelSkinThemeId,
  detail: PixelSkinDetailLevel,
  state: PixelSkinArtState
): string {
  const definition = PIXEL_SKIN_CATALOG[theme];
  return `${definition.fileStem}_${definition.detailStems[detail]}_${state}.png`;
}

export function isPixelSkinThemeId(value: unknown): value is PixelSkinThemeId {
  return typeof value === "string" && (PIXEL_SKIN_THEMES as readonly string[]).includes(value);
}

export type PixelSkinAssetResolution =
  | { kind: "asset"; filename: string; resolvedDetail: PixelSkinDetailLevel; url: string }
  | { kind: "missing"; filename: string };

/**
 * A missing detail may use a lower-resolution image from the same theme and
 * state. It never borrows another theme or another state.
 */
export function resolvePixelSkinAsset(
  theme: PixelSkinThemeId,
  detail: PixelSkinDetailLevel,
  state: PixelSkinImageState,
  availableAssets: Readonly<Record<string, string | undefined>>
): PixelSkinAssetResolution {
  const levels: PixelSkinDetailLevel[] = ["minimal", "detailed", "master"];
  const requestedIndex = levels.indexOf(detail);
  for (const candidate of levels.slice(0, requestedIndex + 1).reverse()) {
    const filename = pixelSkinAssetFilename(theme, candidate, state);
    const url = availableAssets[filename];
    if (url) return { kind: "asset", filename, resolvedDetail: candidate, url };
  }
  return { kind: "missing", filename: pixelSkinAssetFilename(theme, detail, state) };
}

/** Both process exit paths are terminal states, independent of success. */
export function pixelSkinStateForSession(status: SessionStatus, turnCompleted = false): PixelSkinImageState {
  if (status === "working") return "working";
  if (status === "done" || status === "failed") return "completed";
  return status === "idle" && turnCompleted ? "completed" : "idle";
}
