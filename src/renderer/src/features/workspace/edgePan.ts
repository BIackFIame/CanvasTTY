import type { EdgePanSpeed, Point } from "../../../../shared/contracts";

export interface EdgePanViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface EdgePanOptions {
  /** Distance from a viewport edge where panning engages, in px. */
  zone?: number;
  /** Camera speed at the very edge, in px per second. */
  maxSpeed?: number;
}

export const EDGE_PAN_ZONE = 56;
export const EDGE_PAN_MAX_SPEED = 900;

export const EDGE_PAN_SPEEDS: Record<EdgePanSpeed, number> = {
  slow: 450,
  normal: EDGE_PAN_MAX_SPEED,
  fast: 1400
};

/**
 * RTS-style edge panning: the camera drifts while the pointer rests near a
 * viewport edge. Velocity ramps linearly from zero at the zone boundary to
 * `maxSpeed` at the edge itself. Returns null when the pointer is outside the
 * viewport or too far from every edge.
 */
export function edgePanVelocity(
  pointer: Point,
  viewport: EdgePanViewport,
  options: EdgePanOptions = {}
): Point | null {
  const zone = options.zone ?? EDGE_PAN_ZONE;
  const maxSpeed = options.maxSpeed ?? EDGE_PAN_MAX_SPEED;
  const localX = pointer.x - viewport.left;
  const localY = pointer.y - viewport.top;

  if (localX < 0 || localY < 0 || localX > viewport.width || localY > viewport.height) {
    return null;
  }

  const x = axisVelocity(localX, viewport.width, zone, maxSpeed);
  const y = axisVelocity(localY, viewport.height, zone, maxSpeed);
  return x === 0 && y === 0 ? null : { x, y };
}

function axisVelocity(position: number, length: number, zone: number, maxSpeed: number): number {
  const effectiveZone = Math.min(zone, length / 2);
  if (position < effectiveZone) {
    return maxSpeed * (1 - position / effectiveZone);
  }
  if (position > length - effectiveZone) {
    return -maxSpeed * (1 - (length - position) / effectiveZone);
  }
  return 0;
}

export interface EdgePanLoopDeps {
  requestFrame(callback: (time: number) => void): number;
  cancelFrame(handle: number): void;
  /** The camera velocity for the pointer this frame, or null when nothing should pan (the loop stops). */
  velocity(pointer: Point): Point | null;
  /** Moves the camera by `velocity` for `dt` seconds. */
  commit(velocity: Point, dt: number): void;
}

export interface EdgePanLoop {
  /** The pointer moved: remember it and start the loop if it is not running. */
  move(pointer: Point): void;
  /** The pointer left the canvas: the next frame ends the loop. */
  leave(): void;
  /** Ends the loop now (window blur, gesture cancel, unmount): no frame stays requested. */
  stop(): void;
  readonly running: boolean;
}

/**
 * The edge-pan animation loop. It runs off the last pointer position alone, not off a pointer-down
 * gesture, so anything that ends the hover without a pointerleave (the window losing focus) must call
 * `stop()`, or the loop keeps requesting frames and moving the camera in the background.
 */
export function createEdgePanLoop(deps: EdgePanLoopDeps): EdgePanLoop {
  let pointer: Point | null = null;
  let frame: number | null = null;
  let lastTime = 0;
  const step = (time: number): void => {
    frame = null;
    if (!pointer) return;
    const velocity = deps.velocity(pointer);
    if (!velocity) return;
    const dt = lastTime === 0 ? 0 : Math.min(0.05, (time - lastTime) / 1000);
    lastTime = time;
    deps.commit(velocity, dt);
    frame = deps.requestFrame(step);
  };
  return {
    get running() {
      return frame !== null;
    },
    move(next) {
      pointer = next;
      if (frame !== null) return;
      lastTime = 0;
      frame = deps.requestFrame(step);
    },
    leave() {
      pointer = null;
    },
    stop() {
      if (frame !== null) deps.cancelFrame(frame);
      frame = null;
      pointer = null;
      lastTime = 0;
    }
  };
}
