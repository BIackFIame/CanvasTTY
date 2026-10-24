import { useSyncExternalStore } from "react";
import type { InstalledPlugin, LocaleId } from "../../../../shared/contracts";

/**
 * Installed plugins for places that only hold a plugin id (a card's "Started by"). The app sets it whenever its plugin
 * list changes. A card shows the manifest's name in the person's language (`name.<locale>`) when there is one, else the
 * manifest's name; an unknown id (a plugin since removed) gives null, and the caller shows the id.
 */
let current: readonly InstalledPlugin[] = [];
const listeners = new Set<() => void>();

export function setPluginNames(plugins: readonly InstalledPlugin[]): void {
  current = plugins;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The plugins as set last (what the hook reads). */
export function pluginNamesSnapshot(): readonly InstalledPlugin[] { return current; }

export function pluginDisplayName(plugins: readonly InstalledPlugin[], id: string | undefined, locale: LocaleId): string | null {
  const manifest = id ? plugins.find((plugin) => plugin.manifest.id === id)?.manifest : undefined;
  if (!manifest) return null;
  const localized = (manifest as unknown as Record<string, unknown>)[`name.${locale}`];
  return typeof localized === "string" && localized.trim() ? localized.trim() : manifest.name;
}

/** The display name of an installed plugin in `locale`, or null when it is not installed (or no id). */
export function usePluginName(id: string | undefined, locale: LocaleId): string | null {
  const plugins = useSyncExternalStore(subscribe, pluginNamesSnapshot);
  return pluginDisplayName(plugins, id, locale);
}
