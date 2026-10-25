/**
 * C5: the person chose a plugin's entry in HOME's launcher. The host checks the plugin may answer it now (enabled,
 * native code trusted, the entry and `sessions:launch` in its active manifest: `service` throws otherwise), that its
 * service runs, and sends the host-only `canvastty.launcher.entry { locale }`. The service then starts or focuses its
 * card itself through `sessions.create`, under the same rules as any card it starts. A second choice while the first
 * is still being answered does nothing. The service may answer `{ open: <sessionId> }` (its card already runs): the
 * host then brings that card to the front, but only when that plugin started it; any other id is ignored.
 */
export function createLauncherEntryHandler(deps: {
  service(pluginId: string): string;
  running(pluginId: string, serviceId: string): boolean;
  call(pluginId: string, serviceId: string, method: "canvastty.launcher.entry", params: unknown, timeoutMs: number): Promise<unknown>;
  locale(): string;
  /** The plugin that started a card, or null. */
  owner(sessionId: string): string | null;
  timeoutMs?: number;
}): (pluginId: unknown) => Promise<{ focus: string } | null> {
  const running = new Set<string>();
  return async (pluginId) => {
    if (typeof pluginId !== "string") throw new Error("Plugin identifier is required.");
    const serviceId = deps.service(pluginId);
    if (!deps.running(pluginId, serviceId)) throw new Error("The plugin's service is not running yet. Try again in a moment.");
    if (running.has(pluginId)) return null;
    running.add(pluginId);
    try {
      const answer = await deps.call(pluginId, serviceId, "canvastty.launcher.entry", { locale: deps.locale() }, deps.timeoutMs ?? 15_000);
      const open = answer && typeof answer === "object" && !Array.isArray(answer) ? (answer as { open?: unknown }).open : undefined;
      if (typeof open !== "string" || open.length === 0 || open.length > 200) return null;
      let owner: string | null = null;
      try { owner = deps.owner(open); } catch { owner = null; }
      return owner === pluginId ? { focus: open } : null;
    } finally {
      running.delete(pluginId);
    }
  };
}
