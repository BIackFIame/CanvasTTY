import type {
  CameraState,
  MinimapInteractionMode,
  Point,
  SessionBounds,
  Size
} from "../../../../shared/contracts";
import { boundsUnion } from "./canvasCameraGeometry.ts";

export const MINIMAP_SURFACE_SIZE = { width: 172, height: 104 } as const;
export const MINIMAP_CONTENT_PADDING = 8;
const MINIMAP_EDGE_MARKER_SIZE = { width: 14, height: 14 } as const;

export interface NormalizedMinimapPoint {
  x: number;
  y: number;
}

export interface NormalizedMinimapArea extends NormalizedMinimapPoint {
  width: number;
  height: number;
}

/**
 * Fit the occupied workspace with one scale for both axes. Camera pan and zoom
 * never enter this calculation, so only layout changes can rescale the overview.
 */
export function minimapWorldBounds(content: readonly SessionBounds[]): SessionBounds {
  const contentBounds = boundsUnion(content) ?? {
    position: { x: 0, y: 0 },
    size: { width: 1, height: 1 }
  };
  const worldUnitsPerPixel = Math.max(
    Math.max(1, contentBounds.size.width) / (MINIMAP_SURFACE_SIZE.width - MINIMAP_CONTENT_PADDING * 2),
    Math.max(1, contentBounds.size.height) / (MINIMAP_SURFACE_SIZE.height - MINIMAP_CONTENT_PADDING * 2)
  );
  const size = {
    width: MINIMAP_SURFACE_SIZE.width * worldUnitsPerPixel,
    height: MINIMAP_SURFACE_SIZE.height * worldUnitsPerPixel
  };
  const center = boundsCenter(contentBounds);
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
  if (!boundsIntersect(bounds, worldBounds)) return null;

  // The surface clips the original rectangle; clipping its bounds here would
  // draw a false viewport border along the map edge.
  return {
    x: (bounds.position.x - worldBounds.position.x) / worldBounds.size.width,
    y: (bounds.position.y - worldBounds.position.y) / worldBounds.size.height,
    width: bounds.size.width / worldBounds.size.width,
    height: bounds.size.height / worldBounds.size.height
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

  const radiusX = 0.5 - MINIMAP_EDGE_MARKER_SIZE.width / 2 / MINIMAP_SURFACE_SIZE.width;
  const radiusY = 0.5 - MINIMAP_EDGE_MARKER_SIZE.height / 2 / MINIMAP_SURFACE_SIZE.height;
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
