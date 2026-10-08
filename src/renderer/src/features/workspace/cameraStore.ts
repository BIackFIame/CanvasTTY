import { useSyncExternalStore } from "react";
import type { CameraState } from "../../../../shared/contracts";

/**
 * The canvas camera outside React state. A pan or zoom changes it on every pointer or wheel event; kept in
 * App state it rendered the whole application tree per event. The store applies the scene transform
 * directly (see `sceneTransform`), and only the parts that really depend on the camera subscribe:
 * the minimap's camera rectangle and the browser card (its native view follows the card) take every change, cards take
 * derived values that change rarely (summary mode, WebGL eligibility), and pointer handlers read `get()`.
 */
export interface CameraStore {
  get(): CameraState;
  set(next: CameraState): void;
  subscribe(listener: () => void): () => void;
}

export function createCameraStore(initial: CameraState): CameraStore {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (next) => {
      if (next === current
        || (next.x === current.x && next.y === current.y && next.zoom === current.zoom)) return;
      current = next;
      // Listeners are called synchronously, in subscription order: the scene transform (subscribed first by
      // the workspace) is on the DOM before React renders anything that measures it.
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

/** A camera that never moves (the fullscreen layer draws at scale 1). */
export function fixedCameraStore(camera: CameraState): CameraStore {
  return { get: () => camera, set: () => undefined, subscribe: () => () => undefined };
}

/** A value derived from the camera; the component renders only when the value changes (Object.is). */
export function useCameraSelector<T>(store: CameraStore, select: (camera: CameraState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

/** The scene's CSS transform for a camera. */
export function sceneTransform(camera: CameraState): string {
  return `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`;
}

/** Below this zoom a card shows its semantic summary instead of its live surface. */
export const SUMMARY_ZOOM = 0.5;

/** How much a card's summary is enlarged so it stays legible when zoomed out; 1 outside summary mode. */
export function summaryScaleForZoom(zoom: number): number {
  return zoom < SUMMARY_ZOOM ? Math.min(2.5, Math.max(1, SUMMARY_ZOOM / zoom)) : 1;
}
