import { useEffect, useState } from "react";
import type {
  AgentProviderId,
  InstalledPlugin,
  LocaleId,
  PluginLaunchField,
  PluginLaunchFieldOptions,
  PluginLaunchValues
} from "../../../../shared/contracts";
import { t } from "../../lib/i18n";
import { withServiceOptions } from "./launchFieldOptions";

interface LaunchOptionPlugin {
  pluginId: string;
  name: string;
  fields: PluginLaunchField[];
}

/** Plugins whose trusted launch service offers options for this agent. */
export function launchOptionPlugins(plugins: readonly InstalledPlugin[], provider: AgentProviderId): LaunchOptionPlugin[] {
  return plugins.flatMap((plugin) => {
    const launch = plugin.manifest.services?.find((service) => service.launch)?.launch;
    if (!plugin.enabled || !plugin.nativeCodeTrusted || !launch) return [];
    if (!plugin.manifest.permissions.includes("launch:contribute")) return [];
    if (launch.appliesTo && !launch.appliesTo.includes(provider)) return [];
    // A policy-only contributor has nothing to choose: it is asked on every launch anyway.
    if (launch.policy && launch.fields.length === 0) return [];
    return [{ pluginId: plugin.manifest.id, name: plugin.manifest.name, fields: launch.fields }];
  }).sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

function defaults(fields: readonly PluginLaunchField[]): PluginLaunchValues {
  return Object.fromEntries(fields.map((field) => [field.key, field.default
    ?? (field.kind === "boolean" ? false : field.kind === "select" ? field.options?.[0]?.value ?? "" : "")]));
}

/**
 * The launcher's "Advanced" section: one block per plugin, off until the person chooses it.
 * Only chosen plugins' values are returned, and only those plugins prepare the launch.
 */
export function LaunchOptionsSection({ provider, locale, onChange }: {
  provider: AgentProviderId;
  locale: LocaleId;
  onChange(options: Record<string, PluginLaunchValues>): void;
}): React.JSX.Element | null {
  const [plugins, setPlugins] = useState<LaunchOptionPlugin[]>([]);
  const [offered, setOffered] = useState<Record<string, PluginLaunchFieldOptions>>({});
  const [chosen, setChosen] = useState<Record<string, PluginLaunchValues>>({});

  useEffect(() => {
    let active = true;
    setChosen({});
    setOffered({});
    void window.canvasTTY.plugins.list().then((installed) => {
      if (!active) return;
      const available = launchOptionPlugins(installed, provider);
      setPlugins(available);
      // Selects filled by the plugin's service (its accounts, say): asked once per launcher, never blocking it.
      for (const plugin of available.filter((entry) => entry.fields.some((field) => field.optionsFrom === "service"))) {
        void window.canvasTTY.plugins.launchFieldOptions(plugin.pluginId, provider).then((options) => {
          if (active) setOffered((current) => ({ ...current, [plugin.pluginId]: options }));
        }).catch(() => undefined);
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [provider]);

  useEffect(() => onChange(chosen), [chosen, onChange]);

  if (plugins.length === 0) return null;
  const update = (pluginId: string, values: PluginLaunchValues | null): void => {
    setChosen((current) => {
      const next = { ...current };
      if (values) next[pluginId] = values;
      else delete next[pluginId];
      return next;
    });
  };

  return (
    <details className="launch-advanced">
      <summary>{t(locale, "launchAdvanced")}</summary>
      {plugins.map((plugin) => {
        const values = chosen[plugin.pluginId];
        const fields = withServiceOptions(plugin.fields, offered[plugin.pluginId]);
        return (
          <fieldset key={plugin.pluginId} className="launch-advanced__plugin">
            <label className="launch-advanced__use">
              <input type="checkbox" checked={Boolean(values)}
                onChange={(event) => update(plugin.pluginId, event.target.checked ? defaults(fields) : null)} />
              <span>{t(locale, "launchUsePlugin")} {plugin.name}</span>
            </label>
            {values && fields.map((field) => (
              <label key={field.key} className={`launch-advanced__field launch-advanced__field--${field.kind}`}>
                {field.kind === "boolean" && (
                  <input type="checkbox" checked={values[field.key] === true}
                    onChange={(event) => update(plugin.pluginId, { ...values, [field.key]: event.target.checked })} />
                )}
                <span>{field.label}</span>
                {field.kind === "select" && (
                  <select value={String(values[field.key])}
                    onChange={(event) => update(plugin.pluginId, { ...values, [field.key]: event.target.value })}>
                    {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                )}
                {field.kind === "text" && (
                  <input type="text" value={String(values[field.key])} maxLength={field.maxLength ?? 200}
                    onChange={(event) => update(plugin.pluginId, { ...values, [field.key]: event.target.value })} />
                )}
              </label>
            ))}
          </fieldset>
        );
      })}
    </details>
  );
}
