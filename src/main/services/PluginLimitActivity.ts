import type { ProviderLimitsSnapshot } from "../../shared/contracts";

/**
 * `canvastty.activity` `limit.exhausted`: when a limits read shows that a provider's default-login allowance is used
 * up, services of plugins holding `limits:read` are told once, with the window and its reset time. The event carries
 * no more than the `LimitsSnapshot` those plugins may already read (`limits.get`), and nothing that identifies the
 * account. It follows reads that happen anyway (HOME, a plugin page); it starts none.
 */

export interface LimitExhaustedActivity {
  type: "limit.exhausted";
  at: number;
  provider: string;
  /** Always `default`: the CLI's own sign-in, the one LimitsService reads. */
  accountId: "default";
  window: { id: string; label: string | null; windowMinutes: number | null };
  resetAt?: number;
}

export interface PluginLimitActivityDeps {
  /** Running-or-trusted services and their manifest permissions (PluginManager.trustedServiceSpecs). */
  services(): ReadonlyArray<{ pluginId: string; serviceId: string; permissions: readonly string[] }>;
  /** The registry still grants `limits:read` to the plugin now (enabled, permission in its active manifest). */
  allowed(pluginId: string): boolean;
  notify(pluginId: string, serviceId: string, method: "canvastty.activity", params: LimitExhaustedActivity): boolean;
  now?(): number;
}

export class PluginLimitActivity {
  private readonly deps: PluginLimitActivityDeps;
  /** `<provider> <window id>` currently used up; an event goes out when one enters this set. */
  private readonly exhausted = new Set<string>();

  constructor(deps: PluginLimitActivityDeps) {
    this.deps = deps;
  }

  /** One provider snapshot from a read. */
  observe(snapshot: ProviderLimitsSnapshot): void {
    if (snapshot.state !== "available") return;
    const prefix = `${snapshot.provider} `;
    const current = new Set<string>();
    for (const window of snapshot.windows) {
      if (!window.isDefaultBucket || window.usedPercent === null || window.usedPercent < 100) continue;
      const key = `${prefix}${window.id}`;
      current.add(key);
      if (this.exhausted.has(key)) continue;
      this.exhausted.add(key);
      this.publish({
        type: "limit.exhausted",
        at: (this.deps.now ?? Date.now)(),
        provider: snapshot.provider,
        accountId: "default",
        window: { id: window.id, label: window.label, windowMinutes: window.windowMinutes },
        ...(window.resetsAt !== null ? { resetAt: window.resetsAt } : {})
      });
    }
    // A window with room again can be used up again later, and is reported then.
    for (const key of [...this.exhausted]) if (key.startsWith(prefix) && !current.has(key)) this.exhausted.delete(key);
  }

  private publish(event: LimitExhaustedActivity): void {
    for (const service of this.deps.services()) {
      if (!service.permissions.includes("limits:read")) continue;
      let allowed = false;
      try {
        allowed = this.deps.allowed(service.pluginId);
      } catch {
        allowed = false;
      }
      if (allowed) this.deps.notify(service.pluginId, service.serviceId, "canvastty.activity", structuredClone(event));
    }
  }
}
