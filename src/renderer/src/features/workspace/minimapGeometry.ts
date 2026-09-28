import type {
  CameraState,
  MinimapInteractionMode,
  Point,
  SessionBounds,
  Size
} from "../../../../shared/contracts";

export const MINIMAP_SURFACE_SIZE = { width: 172, height: 104 } as const;
export const MINIMAP_VIEWPORT_MARKER_SIZE = { width: 46, height: 30 } as const;
const MINIMAP_HOME_EDGE_MARKER_SIZE = { width: 14, height: 14 } as const;

export interface NormalizedMinimapPoint {
  x: number;
  y: number;
}

export interface NormalizedMinimapArea extends NormalizedMinimapPoint {
  width: number;
  height: number;
}

/**
 * A camera-centred world window with one uniform world-units-per-pixel scale.
 * Its scale changes with zoom, but never with pan or with the number/position of
 * canvas objects, so moving away cannot auto-fit or stretch the map contents.
 */
export function minimapWorldBounds(worldViewport: SessionBounds): SessionBounds {
  const worldUnitsPerPixel = Math.max(
    worldViewport.size.width / MINIMAP_VIEWPORT_MARKER_SIZE.width,
    worldViewport.size.height / MINIMAP_VIEWPORT_MARKER_SIZE.height
  );
  const size = {
    width: MINIMAP_SURFACE_SIZE.width * worldUnitsPerPixel,
    height: MINIMAP_SURFACE_SIZE.height * worldUnitsPerPixel
  };
  const center = boundsCenter(worldViewport);
  return {
    position: { x: center.x - size.width / 2, y: center.y - size.height / 2 },
    size
  };
}

export function cameraWorldViewport(
  camera: CameraState,
  viewportSize: Size
): SessionBounds {
  return {
    position: {
      x: -camera.x / camera.zoom,
      y: -camera.y / camera.zoom
    },
    size: {
      width: viewportSize.width / camera.zoom,
      height: viewportSize.height / camera.zoom
    }
  };
}

export function minimapPointForBounds(
  bounds: SessionBounds,
  worldBounds: SessionBounds
): NormalizedMinimapPoint {
  const center = boundsCenter(bounds);
  return {
    x: (center.x - worldBounds.position.x) / worldBounds.size.width,
    y: (center.y - worldBounds.position.y) / worldBounds.size.height
  };
}

export function minimapAreaForBounds(
  bounds: SessionBounds,
  worldBounds: SessionBounds
): NormalizedMinimapArea | null {
  const left = Math.max(bounds.position.x, worldBounds.position.x);
  const top = Math.max(bounds.position.y, worldBounds.position.y);
  const right = Math.min(
    bounds.position.x + bounds.size.width,
    worldBounds.position.x + worldBounds.size.width
  );
  const bottom = Math.min(
    bounds.position.y + bounds.size.height,
    worldBounds.position.y + worldBounds.size.height
  );
  if (right <= left || bottom <= top) return null;

  return {
    x: (left - worldBounds.position.x) / worldBounds.size.width,
    y: (top - worldBounds.position.y) / worldBounds.size.height,
    width: (right - left) / worldBounds.size.width,
    height: (bottom - top) / worldBounds.size.height
  };
}

export function minimapEdgePointForBounds(
  bounds: SessionBounds,
  worldBounds: SessionBounds
): NormalizedMinimapPoint | null {
  if (boundsIntersect(bounds, worldBounds)) return null;

  const target = minimapPointForBounds(bounds, worldBounds);
  const delta = { x: target.x - 0.5, y: target.y - 0.5 };
  if (delta.x === 0 && delta.y === 0) return null;

  const radiusX = 0.5 - MINIMAP_HOME_EDGE_MARKER_SIZE.width / 2 / MINIMAP_SURFACE_SIZE.width;
  const radiusY = 0.5 - MINIMAP_HOME_EDGE_MARKER_SIZE.height / 2 / MINIMAP_SURFACE_SIZE.height;
  const scaleX = delta.x === 0 ? Number.POSITIVE_INFINITY : radiusX / Math.abs(delta.x);
  const scaleY = delta.y === 0 ? Number.POSITIVE_INFINITY : radiusY / Math.abs(delta.y);
  const scale = Math.min(scaleX, scaleY);

  return {
    x: clamp(0.5 + delta.x * scale, 0, 1),
    y: clamp(0.5 + delta.y * scale, 0, 1)
  };
}

export function minimapWorldPoint(
  normalized: Point,
  worldBounds: SessionBounds
): Point {
  return {
    x: worldBounds.position.x + clamp(normalized.x, 0, 1) * worldBounds.size.width,
    y: worldBounds.position.y + clamp(normalized.y, 0, 1) * worldBounds.size.height
  };
}

export function minimapCameraForPointerDrag(
  interactionMode: MinimapInteractionMode,
  camera: CameraState,
  pointerDelta: Point,
  surfaceSize: Size,
  worldBounds: SessionBounds
): CameraState | null {
  if (interactionMode !== "drag" || surfaceSize.width <= 0 || surfaceSize.height <= 0) {
    return null;
  }
  return {
    ...camera,
    x: camera.x + pointerDelta.x / surfaceSize.width * worldBounds.size.width * camera.zoom,
    y: camera.y + pointerDelta.y / surfaceSize.height * worldBounds.size.height * camera.zoom
  };
}

function boundsCenter(bounds: SessionBounds): Point {
  return {
    x: bounds.position.x + bounds.size.width / 2,
    y: bounds.position.y + bounds.size.height / 2
  };
}

export function boundsIntersect(left: SessionBounds, right: SessionBounds): boolean {
  return left.position.x < right.position.x + right.size.width
    && left.position.x + left.size.width > right.position.x
    && left.position.y < right.position.y + right.size.height
    && left.position.y + left.size.height > right.position.y;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
