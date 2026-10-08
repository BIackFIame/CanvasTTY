import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { CameraState, SessionBounds } from "../../../../shared/contracts";
import type { CameraStore } from "./cameraStore";

/**
 * The one lifecycle every canvas surface (terminal card, plugin frame, Settings section) follows.
 * Hiding a surface visually is not enough: a surface nobody can see must also stop its work, and
 * suspending must never destroy state (PTYs, scrollback, plugin documents stay alive).
 *
 * - `mounted`: the surface exists, no visibility decision has been applied to it yet.
 * - `visible`: drawn on screen and doing live work.
 * - `active`: visible and holding keyboard focus.
 * - `suspended`: exists but is not drawn (summary thumbnail, HOME editing, off-screen, window
 *   minimized, Settings closed); its producers pause and it catches up when it becomes visible again.
 */
export type SurfaceLifecycle = "mounted" | "visible" | "active" | "suspended";

/** Why a surface might not be drawn. Every field is optional; absent means "not a reason". */
export interface SurfaceVisibility {
  /** Zoomed out below the summary threshold: the card shows a thumbnail instead of its surface. */
  summary?: boolean;
  /** An ancestor hides it with CSS (HOME editing hides the whole window layer). */
  hidden?: boolean;
  /** Outside the viewport, beyond the on-screen margin. */
  offscreen?: boolean;
  /** The app window is minimized or hidden (`document.hidden`). */
  windowHidden?: boolean;
  /** The Settings dialog is closed (Settings sections only). */
  closed?: boolean;
  /** The surface holds keyboard focus. */
  focused?: boolean;
}

export function surfaceLifecycle(visibility: SurfaceVisibility): Exclude<SurfaceLifecycle, "mounted"> {
  if (visibility.summary || visibility.hidden || visibility.offscreen || visibility.windowHidden || visibility.closed) {
    return "suspended";
  }
  return visibility.focused ? "active" : "visible";
}

/** A surface in this state does live work (receives output, runs timers). */
export function surfaceIsLive(state: SurfaceLifecycle): boolean {
  return state === "visible" || state === "active";
}

export interface SurfaceGate {
  /** Applies the new state; the side effect runs only when liveness changes (and always the first time). */
  set(state: SurfaceLifecycle): void;
  /** The surface goes away: it is no longer live. */
  dispose(): void;
  readonly state: SurfaceLifecycle;
}

/**
 * Turns lifecycle states into one side effect per real liveness change. The first state is always applied
 * (the producer's default may differ from the surface's first state); repeating the same liveness is free;
 * disposing a live surface applies "not live" once.
 */
export function createSurfaceGate(apply: (live: boolean) => void): SurfaceGate {
  let state: SurfaceLifecycle = "mounted";
  let applied: boolean | null = null;
  let disposed = false;
  return {
    get state() {
      return state;
    },
    set(next) {
      if (disposed) return;
      state = next;
      if (next === "mounted") return;
      const live = surfaceIsLive(next);
      if (applied === live) return;
      applied = live;
      apply(live);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      state = "mounted";
      if (applied !== false) apply(false);
      applied = false;
    }
  };
}

/** Screen margin, as a fraction of the viewport, inside which an off-screen card still counts as on screen. */
export const OFFSCREEN_MARGIN = 0.25;
/** How long a card must stay off-screen before it is suspended, so a pan across it does not flap. */
export const OFFSCREEN_SUSPEND_DELAY_MS = 600;

export interface ViewportSize {
  width: number;
  height: number;
}

/** Whether a card at canvas `bounds` is outside the viewport (plus margin) under `camera`. */
export function surfaceOffscreen(
  bounds: SessionBounds,
  camera: CameraState,
  viewport: ViewportSize,
  margin = OFFSCREEN_MARGIN
): boolean {
  if (viewport.width <= 0 || viewport.height <= 0) return false;
  const marginX = viewport.width * margin;
  const marginY = viewport.height * margin;
  const left = camera.x + bounds.position.x * camera.zoom;
  const top = camera.y + bounds.position.y * camera.zoom;
  const right = left + bounds.size.width * camera.zoom;
  const bottom = top + bounds.size.height * camera.zoom;
  return right < -marginX || bottom < -marginY || left > viewport.width + marginX || top > viewport.height + marginY;
}

function windowViewport(): ViewportSize {
  return typeof window === "undefined" ? { width: 0, height: 0 } : { width: window.innerWidth, height: window.innerHeight };
}

/**
 * True once the card has been off-screen for OFFSCREEN_SUSPEND_DELAY_MS; false as soon as it is back.
 * Renders only when the on-screen answer changes, not on every camera move.
 */
export function useSurfaceOffscreen(camera: CameraStore, bounds: SessionBounds, enabled = true): boolean {
  const subscribe = useCallback((listener: () => void) => {
    const unsubscribe = camera.subscribe(listener);
    window.addEventListener("resize", listener);
    return () => {
      unsubscribe();
      window.removeEventListener("resize", listener);
    };
  }, [camera]);
  const offscreenNow = useSyncExternalStore(
    subscribe,
    () => enabled && surfaceOffscreen(bounds, camera.get(), windowViewport())
  );
  const [offscreen, setOffscreen] = useState(false);
  useEffect(() => {
    if (!offscreenNow) {
      setOffscreen(false);
      return;
    }
    const timer = window.setTimeout(() => setOffscreen(true), OFFSCREEN_SUSPEND_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [offscreenNow]);
  return offscreen && offscreenNow;
}

function subscribeDocumentVisibility(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

/** The app window is minimized or otherwise hidden. */
export function useWindowHidden(): boolean {
  return useSyncExternalStore(subscribeDocumentVisibility, () => document.visibilityState === "hidden");
}
