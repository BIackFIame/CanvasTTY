/**
 * Decides whether the reply to a plugin frame request may still be posted when the request finishes.
 *
 * Replies go to the frame's window with target origin "*" (the sandboxed document has a null origin),
 * and that window object survives navigation. A request that is still running when the frame reloads
 * or navigates must not be answered into the next document: it would receive data it never asked for
 * (a secret, say) and could resolve its own unrelated request that happens to reuse the same id.
 *
 * The host cannot see a navigation start, only its load event, and a new document's first requests
 * are sent while its scripts run, before that event. The injected plugin SDK numbers requests from "1"
 * in every document, so a request "1" marks a new document as soon as it speaks. A load that no such
 * request preceded (a page without the SDK, or one that has not asked anything yet) marks it as well.
 */
export interface FrameReplyGate {
  /** The frame fired its load event. */
  loaded(): void;
  /** A request arrived from the frame's window; the result says whether its reply may still be sent. */
  received(requestId: string, source: unknown): (currentWindow: unknown) => boolean;
}

export function createFrameReplyGate(): FrameReplyGate {
  let generation = 0;
  let announcedSinceLoad = false;
  return {
    loaded() {
      if (!announcedSinceLoad) generation += 1;
      announcedSinceLoad = false;
    },
    received(requestId, source) {
      if (requestId === "1") {
        generation += 1;
        announcedSinceLoad = true;
      }
      const requestGeneration = generation;
      return (currentWindow) => requestGeneration === generation && currentWindow === source;
    }
  };
}
