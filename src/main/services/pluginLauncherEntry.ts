/**
 * C5: the person chose a plugin's entry in HOME's launcher. The host checks the plugin may answer it now (enabled,
 * native code trusted, the entry and `sessions:launch` in its active manifest: `service` throws otherwise), that its
 * service runs, and sends the host-only `canvastty.launcher.entry { locale }`. The service then starts or focuses its
 * card itself through `sessions.create`, under the same rules as any card it starts. A second choice while the first
 * is still being answered does nothing.
 */
export function createLauncherEntryHandler(deps: {
  service(pluginId: string): string;
  running(pluginId: string, serviceId: string): boolean;
  call(pluginId: string, serviceId: string, method: "canvastty.launcher.entry", params: unknown, timeoutMs: number): Promise<unknown>;
  locale(): string;
  timeoutMs?: number;
}): (pluginId: unknown) => Promise<void> {
  const running = new Set<string>();
  return async (pluginId) => {
    if (typeof pluginId !== "string") throw new Error("Plugin identifier is required.");
    const serviceId = deps.service(pluginId);
    if (!deps.running(pluginId, serviceId)) throw new Error("The plugin's service is not running yet. Try again in a moment.");
    if (running.has(pluginId)) return;
    running.add(pluginId);
    try {
      await deps.call(pluginId, serviceId, "canvastty.launcher.entry", { locale: deps.locale() }, deps.timeoutMs ?? 15_000);
    } finally {
      running.delete(pluginId);
    }
  };
}
