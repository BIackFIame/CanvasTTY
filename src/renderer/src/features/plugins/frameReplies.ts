/**
 * Decides whether the reply to a plugin frame request may still be posted when the request finishes.
 *
 * Replies go to the frame's window with target origin "*" (the sandboxed document has a null origin),
 * and that window object survives navigation. A request that is still running when the frame shows
 * another document must not be answered into it: the new document would receive data it never asked
 * for (a secret, say) and could resolve its own unrelated request that happens to reuse the same id.
 *
 * Every request captures three things when it arrives: the window that sent it, the plugin the frame
 * served, and the frame's document generation. The reply goes out only while all three still hold.
 * The generation changes the moment the host points the frame at another document (`showing` with a
 * new plugin or entry, before any load event can fire), and whenever a new document announces itself:
 * the injected plugin SDK numbers requests from "1" in every document, so a request "1" is a new
 * document as soon as it speaks. A load event with no such request before it (a page that navigated
 * itself and asks nothing yet) also counts; it only ever adds a cut, never lets a reply through.
 */
export interface FrameReplyGate {
  /** The host shows this document in the frame (plugin id and entry URL); a change starts a new generation. */
  showing(pluginId: string, entryUrl: string): void;
  /** The frame fired its load event. */
  loaded(): void;
  /**
   * A request arrived from `source` while the frame served `pluginId`. The result says, when the request
   * finishes, whether its reply may still go to `currentWindow` of a frame now serving `currentPluginId`.
   */
  received(requestId: string, source: unknown, pluginId: string): (currentWindow: unknown, currentPluginId: string) => boolean;
}

export function createFrameReplyGate(): FrameReplyGate {
  let generation = 0;
  let shown: string | null = null;
  let announcedSinceLoad = false;
  return {
    showing(pluginId, entryUrl) {
      const key = `${pluginId}\n${entryUrl}`;
      if (key === shown) return;
      shown = key;
      generation += 1;
      announcedSinceLoad = false;
    },
    loaded() {
      if (!announcedSinceLoad) generation += 1;
      announcedSinceLoad = false;
    },
    received(requestId, source, pluginId) {
      if (requestId === "1") {
        generation += 1;
        announcedSinceLoad = true;
      }
      const requestGeneration = generation;
      return (currentWindow, currentPluginId) => requestGeneration === generation
        && currentWindow === source && currentPluginId === pluginId;
    }
  };
}
