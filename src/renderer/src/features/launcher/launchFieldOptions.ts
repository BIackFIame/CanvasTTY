import type { PluginLaunchField, PluginLaunchFieldOptions } from "../../../../shared/contracts";

/** Declared choices first, then those the plugin's service offered for `optionsFrom: "service"` selects. */
export function withServiceOptions(fields: readonly PluginLaunchField[], offered: PluginLaunchFieldOptions | undefined): PluginLaunchField[] {
  return fields.map((field) => {
    const extra = field.optionsFrom === "service" ? offered?.[field.key] : undefined;
    if (!extra?.length) return field;
    const declared = new Set(field.options?.map((option) => option.value));
    return { ...field, options: [...(field.options ?? []), ...extra.filter((option) => !declared.has(option.value))] };
  });
}
