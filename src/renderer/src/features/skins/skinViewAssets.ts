import type { PixelSkinAssetResolution, PixelSkinDetailLevel, PixelSkinImageState, PixelSkinThemeId } from "./skinCatalog.ts";
import { pixelSkinAssetFilename, resolvePixelSkinAsset } from "./skinCatalog.ts";

export function resolvePixelSkinViewAsset(
  theme: PixelSkinThemeId,
  detail: PixelSkinDetailLevel,
  state: PixelSkinImageState,
  availableAssets: Readonly<Record<string, string | undefined>>
): PixelSkinAssetResolution {
  const resolution = resolvePixelSkinAsset(theme, detail, state, availableAssets);
  if (resolution.kind === "asset" || theme !== "gold-black" || detail !== "minimal" || state !== "working") {
    return resolution;
  }

  const filename = pixelSkinAssetFilename(theme, "minimal", "idle");
  const url = filename ? availableAssets[filename] : undefined;
  return url && filename
    ? { kind: "asset", filename, resolvedDetail: "minimal", url }
    : resolution;
}

export function needsGoldMinimalWorkingMarker(
  theme: PixelSkinThemeId,
  detail: PixelSkinDetailLevel,
  state: PixelSkinImageState,
  availableAssets: Readonly<Record<string, string | undefined>>
): boolean {
  if (theme !== "gold-black" || detail !== "minimal" || state !== "working") return false;
  if (resolvePixelSkinAsset(theme, detail, state, availableAssets).kind === "asset") return false;
  const idleFilename = pixelSkinAssetFilename(theme, "minimal", "idle");
  return Boolean(idleFilename && availableAssets[idleFilename]);
}
