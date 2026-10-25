import { useState } from "react";
import type { InstalledPlugin, LocaleId, PluginLauncherEntry, SessionSnapshot } from "../../../../shared/contracts";
import { UiIcon } from "../../components/UiIcon";
import { pluginName } from "../../../../shared/pluginLocalizedText.ts";

/** The plugins whose launcher entry HOME shows (C5): enabled, native code trusted, the entry in the active manifest. */
export function launcherEntries(plugins: readonly InstalledPlugin[]): Array<{ plugin: InstalledPlugin; entry: PluginLauncherEntry }> {
  return plugins.flatMap((plugin) => {
    if (!plugin.enabled || !plugin.nativeCodeTrusted || !plugin.manifest.permissions.includes("sessions:launch")) return [];
    const entry = plugin.manifest.services?.find((service) => service.launcherEntry)?.launcherEntry;
    return entry ? [{ plugin, entry }] : [];
  });
}

function text(entry: PluginLauncherEntry, key: "title" | "description", locale: LocaleId): string {
  return (locale === "ru" || locale === "en" ? entry[`${key}.${locale}`] : undefined) || entry[key] || "";
}

/**
 * The entries first in HOME's launcher. Choosing one only asks the plugin's service (`canvastty.launcher.entry`) to
 * start or focus its card; nothing else is chosen here. Loaded only when a trusted plugin declares one.
 */
export function PluginLauncherEntries({ plugins, locale, sessions, onError, onFocusSession }: {
  plugins: readonly InstalledPlugin[];
  locale: LocaleId;
  sessions: readonly SessionSnapshot[];
  onError(message: string): void;
  /** The plugin's card already runs (its answer `{ open }`, checked by the host to be that plugin's card). */
  onFocusSession(session: SessionSnapshot): void;
}): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <>
      {launcherEntries(plugins).map(({ plugin, entry }) => {
        const id = plugin.manifest.id;
        const title = text(entry, "title", locale);
        const description = text(entry, "description", locale);
        return (
          <button
            className="launcher-button launcher-button--plugin"
            type="button"
            key={id}
            disabled={busy === id}
            title={`${title} · ${pluginName(plugin.manifest, locale)}${description ? `\n${description}` : ""}`}
            aria-label={`${title} · ${pluginName(plugin.manifest, locale)}`}
            onClick={() => {
              setBusy(id);
              void window.canvasTTY.plugins.launcherEntry(id)
                .then((answer) => {
                  const card = answer ? sessions.find((session) => session.id === answer.focus) : undefined;
                  if (card) onFocusSession(card);
                })
                .catch((error: unknown) => onError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "") : String(error)))
                .finally(() => setBusy(null));
            }}
          >
            <UiIcon name="blocks" size="2.4em" />
            <span className="launcher-button__label">{title}</span>
          </button>
        );
      })}
    </>
  );
}
