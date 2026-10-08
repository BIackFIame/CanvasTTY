import type {
  BrowserViewportBounds,
  BrowserViewportClipBounds,
  Size
} from "../../../shared/contracts.ts";

const MIN_BROWSER_PAGE_SCALE = 0.5;
const MAX_BROWSER_PAGE_SCALE = 3;

export function normalizeBrowserViewportBounds(value: unknown): BrowserViewportBounds | null {
  if (!value || typeof value !== "object") return null;
  const bounds = value as BrowserViewportBounds;
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return null;
  if (bounds.surface !== "native" && bounds.surface !== "placeholder" && bounds.surface !== "hidden") {
    return null;
  }
  const clipBounds = normalizeClipBounds(bounds.clipBounds);
  if (bounds.clipBounds !== undefined && !clipBounds) return null;

  const width = Math.max(0, bounds.width);
  const height = Math.max(0, bounds.height);
  const left = Math.floor(bounds.x);
  const top = Math.floor(bounds.y);
  const right = width === 0 ? left : Math.ceil(bounds.x + width);
  const bottom = height === 0 ? top : Math.ceil(bounds.y + height);
  const canvasScale = Number.isFinite(bounds.canvasScale)
    ? Math.min(MAX_BROWSER_PAGE_SCALE, Math.max(MIN_BROWSER_PAGE_SCALE, bounds.canvasScale!))
    : undefined;

  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
    surface: bounds.surface,
    ...(clipBounds ? { clipBounds } : {}),
    ...(canvasScale === undefined ? {} : { canvasScale }),
    showAgentPresence: bounds.showAgentPresence === true
  };
}

/** Two normalized viewports place the page exactly alike (the renderer reports sub-pixel moves that round the same). */
export function sameBrowserViewport(a: BrowserViewportBounds, b: BrowserViewportBounds): boolean {
  const clipA = a.clipBounds;
  const clipB = b.clipBounds;
  const sameClip = clipA === undefined || clipB === undefined
    ? clipA === clipB
    : clipA.x === clipB.x && clipA.y === clipB.y && clipA.width === clipB.width && clipA.height === clipB.height;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.surface === b.surface
    && a.canvasScale === b.canvasScale && a.showAgentPresence === b.showAgentPresence && sameClip;
}

export function clipBrowserViewportBounds(
  bounds: BrowserViewportBounds,
  hostSize: Size
): BrowserViewportClipBounds | null {
  if (![hostSize.width, hostSize.height].every(Number.isFinite)) return null;
  const hostRight = Math.max(0, Math.floor(hostSize.width));
  const hostBottom = Math.max(0, Math.floor(hostSize.height));
  const clip = bounds.clipBounds;
  const left = Math.max(0, clip?.x ?? 0, bounds.x);
  const top = Math.max(0, clip?.y ?? 0, bounds.y);
  const right = Math.min(hostRight, clip ? clip.x + clip.width : hostRight, bounds.x + bounds.width);
  const bottom = Math.min(hostBottom, clip ? clip.y + clip.height : hostBottom, bounds.y + bounds.height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function normalizeClipBounds(value: unknown): BrowserViewportClipBounds | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return null;
  const bounds = value as BrowserViewportClipBounds;
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return null;

  const width = Math.max(0, bounds.width);
  const height = Math.max(0, bounds.height);
  const left = Math.ceil(bounds.x);
  const top = Math.ceil(bounds.y);
  const right = width === 0 ? left : Math.floor(bounds.x + width);
  const bottom = height === 0 ? top : Math.floor(bounds.y + height);
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  };
}
