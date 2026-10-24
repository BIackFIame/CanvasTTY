import type { AvailableUpdate, UpdateAdapter } from "./UpdateController.ts";

/**
 * CanvasTTY Edge never updates itself: the official channels (Sparkle feed, GitHub releases) would replace it with
 * the official app, so nothing is checked, downloaded or installed. It is rebuilt from its own branch instead.
 */
export const EDGE_UPDATE_MESSAGE = "CanvasTTY Edge does not update itself. Rebuild it from the edge branch (see edge-notes).";

export class EdgeUpdateAdapter implements UpdateAdapter {
  async check(): Promise<AvailableUpdate | null> { throw new Error(EDGE_UPDATE_MESSAGE); }
  async download(): Promise<void> { throw new Error(EDGE_UPDATE_MESSAGE); }
  async install(): Promise<void> { throw new Error(EDGE_UPDATE_MESSAGE); }
}
