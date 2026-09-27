import { useMemo, useSyncExternalStore } from "react";
import type {
  PluginCardActionEntry,
  PluginCardBadge,
  PluginCardDecorations,
  SessionMetadata
} from "../../../../shared/contracts";
import { cardActionMatches } from "../../../../shared/pluginCardActions";

/** Badges and actions plugins add to cards (EP-7), shared by every card and pushed by the main process. */
const EMPTY: PluginCardDecorations = { badges: {}, actions: [] };
let current = EMPTY;
let started = false;
const listeners = new Set<() => void>();

function update(next: PluginCardDecorations): void {
  current = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  if (!started) {
    started = true;
    window.canvasTTY.plugins.onCardDecorations(update);
    void window.canvasTTY.plugins.cardDecorations().then(update).catch(() => undefined);
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What plugins show on this card: its badges and the actions whose filter matches it. */
export function usePluginCardDecorations(
  session: Pick<SessionMetadata, "id" | "provider" | "role" | "environment">
): { badges: PluginCardBadge[]; actions: PluginCardActionEntry[] } {
  const decorations = useSyncExternalStore(subscribe, () => current);
  const { id, provider, role } = session;
  const kind = session.environment?.kind;
  return useMemo(() => ({
    badges: decorations.badges[id] ?? [],
    actions: decorations.actions.filter((action) => cardActionMatches(action.when, {
      provider, role, ...(kind ? { environment: { kind } } : {})
    }))
  }), [decorations, id, provider, role, kind]);
}
