import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { LimitProviderId, LimitsSnapshot, PluginPermission } from "../../shared/contracts.ts";
import { LIMIT_PROVIDERS } from "../../shared/contracts.ts";
import { pluginLimitsResult, type LimitEarlyReset, type LimitsChange } from "./LimitsService.ts";

/** The part of LimitsService plugin services reach. */
export interface PluginLimitsSource {
  get(): Promise<LimitsSnapshot>;
  peek(): LimitsSnapshot | null;
  getHome(provider: LimitProviderId, home: string): Promise<LimitsSnapshot>;
  onChange(listener: (change: LimitsChange) => void): () => void;
}

/** Params of `canvastty.limits.changed`: the `limits.get` answer, plus what reset early. */
export interface PluginLimitsChangedParams {
  state: "ready";
  snapshot: LimitsSnapshot;
  /** True when at least one window's allowance came back before its announced reset time. */
  earlyReset: boolean;
  earlyResets: LimitEarlyReset[];
  /** For an account home this plugin asked about with `limits.get { provider, home }`; absent for the default login. */
  provider?: LimitProviderId;
  home?: string;
}

export interface PluginLimitsDependencies {
  limits: PluginLimitsSource;
  /** Sends a notification to a running service; false when it is not running. */
  notify(pluginId: string, serviceId: string, method: "canvastty.limits.changed", params: PluginLimitsChangedParams): boolean;
  /**
   * The plugin is installed and enabled and its active manifest has the permission, asked of the host's registry at
   * the moment of the call or notification (not of the service's start-time spec).
   */
  allowed(pluginId: string, permission: PluginPermission): boolean;
  /** Changes arriving within this window are sent as one notification (default 2 s). */
  debounceMs?: number;
  /** Minimum time between two refreshes a service starts when the cached snapshot is old (default 5 minutes). */
  serviceRefreshMs?: number;
  now?: () => number;
}

/** The renderer refreshes limits every 60 s while visible; a snapshot younger than this is served as it is. */
const FRESH_MS = 60_000;
const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_SERVICE_REFRESH_MS = 5 * 60_000;
/** Account homes one plugin may ask about (a pool of subscription accounts); unknown or removed homes free a place. */
export const MAX_LIMIT_HOMES_PER_PLUGIN = 32;
const MAX_HOME_LENGTH = 4_096;
const UNKNOWN_HOME = "The home is not an account home in this plugin's data folder.";

interface Subscriber {
  pluginId: string;
  serviceId: string;
}

/**
 * Subscription limits for plugin services (`limits.get`, `limits.subscribe`, `limits.unsubscribe` and the
 * `canvastty.limits.changed` notification). The answer is the one plugin surfaces get (pluginLimitsResult), behind the
 * same `limits:read` permission, read from LimitsService's cache:
 *
 * - the default login: a snapshot younger than 60 s is served as it is; an older one starts a refresh at most once per
 *   `serviceRefreshMs` across all services, and in between the last snapshot is served with its `fetchedAt`;
 * - an account home (`{ provider, home }`, also `launch:contribute`): only an existing folder strictly inside the
 *   calling plugin's own data folder, reached without a symbolic link, at most MAX_LIMIT_HOMES_PER_PLUGIN of them;
 *   LimitsService reads each at most once per home interval.
 */
export class PluginLimits {
  private readonly deps: PluginLimitsDependencies;
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly homes = new Map<string, Map<string, { provider: LimitProviderId; home: string }>>();
  private readonly pending = new Map<string, LimitsChange>();
  private readonly debounceMs: number;
  private readonly serviceRefreshMs: number;
  private readonly now: () => number;
  private lastServiceRefresh: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly unsubscribe: () => void;

  constructor(deps: PluginLimitsDependencies) {
    this.deps = deps;
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.serviceRefreshMs = deps.serviceRefreshMs ?? DEFAULT_SERVICE_REFRESH_MS;
    this.now = deps.now ?? Date.now;
    this.unsubscribe = deps.limits.onChange((change) => this.queue(change));
  }

  /**
   * A service's `limits.*` call; undefined for a method this does not know. `permissions` are the service's active
   * manifest permissions and `dataDir` its plugin data folder, both from the host's record of the service.
   */
  handle(pluginId: string, serviceId: string, method: string, params: unknown, permissions: readonly PluginPermission[], dataDir: string): unknown {
    const values = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
    const need = (permission: PluginPermission): void => {
      if (!permissions.includes(permission) || !this.deps.allowed(pluginId, permission)) {
        throw new Error(`Plugin does not have the ${permission} permission.`);
      }
    };
    switch (method) {
      case "limits.get":
        need("limits:read");
        if (values.provider === undefined && values.home === undefined) return this.defaultLogin();
        need("launch:contribute");
        return this.accountHome(pluginId, values, dataDir);
      case "limits.subscribe": {
        need("limits:read");
        this.subscribers.set(`${pluginId}:${serviceId}`, { pluginId, serviceId });
        // Subscribing never starts a read: the last snapshot, or loading until the first one exists.
        const snapshot = this.deps.limits.peek();
        return snapshot ? pluginLimitsResult(snapshot) : { state: "loading", snapshot: null };
      }
      case "limits.unsubscribe":
        this.subscribers.delete(`${pluginId}:${serviceId}`);
        return null;
      default:
        return undefined;
    }
  }

  /** A stopped service subscribes again when it starts. */
  serviceStopped(pluginId: string, serviceId: string): void {
    this.subscribers.delete(`${pluginId}:${serviceId}`);
  }

  dispose(): void {
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.subscribers.clear();
  }

  private async defaultLogin(): Promise<unknown> {
    const now = this.now();
    const cached = this.deps.limits.peek();
    if (cached && now - cached.fetchedAt < FRESH_MS) return pluginLimitsResult(cached);
    if (cached && this.lastServiceRefresh !== null && now - this.lastServiceRefresh < this.serviceRefreshMs) {
      return pluginLimitsResult(cached);
    }
    this.lastServiceRefresh = now;
    return pluginLimitsResult(await this.deps.limits.get());
  }

  private async accountHome(pluginId: string, values: Record<string, unknown>, dataDir: string): Promise<unknown> {
    const provider = values.provider;
    if (typeof provider !== "string" || !(LIMIT_PROVIDERS as readonly string[]).includes(provider)) {
      throw new Error("limits.get provider must be one of the providers CanvasTTY reads limits for.");
    }
    const home = validateLimitsHome(dataDir, values.home);
    const known = this.homes.get(pluginId) ?? new Map<string, { provider: LimitProviderId; home: string }>();
    const key = homeKey(provider as LimitProviderId, home);
    if (!known.has(key)) {
      if (known.size >= MAX_LIMIT_HOMES_PER_PLUGIN) {
        // Homes that no longer pass the check (removed accounts) free their place.
        for (const [entry, value] of known) {
          try {
            validateLimitsHome(dataDir, value.home);
          } catch {
            known.delete(entry);
          }
        }
      }
      if (known.size >= MAX_LIMIT_HOMES_PER_PLUGIN) {
        throw new Error(`A plugin can read limits for at most ${MAX_LIMIT_HOMES_PER_PLUGIN} account homes.`);
      }
      known.set(key, { provider: provider as LimitProviderId, home });
      this.homes.set(pluginId, known);
    }
    return pluginLimitsResult(await this.deps.limits.getHome(provider as LimitProviderId, home));
  }

  private queue(change: LimitsChange): void {
    const key = change.home ? homeKey(change.home.provider, change.home.home) : "";
    const earlier = this.pending.get(key);
    this.pending.set(key, earlier ? { ...change, earlyResets: mergeEarlyResets(earlier.earlyResets, change.earlyResets) } : change);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
    this.timer.unref?.();
  }

  private flush(): void {
    this.timer = null;
    const changes = [...this.pending.entries()];
    this.pending.clear();
    for (const [key, change] of changes) {
      const params: PluginLimitsChangedParams = {
        ...pluginLimitsResult(change.snapshot),
        earlyReset: change.earlyResets.length > 0,
        earlyResets: structuredClone(change.earlyResets),
        ...(change.home ? { provider: change.home.provider, home: change.home.home } : {})
      };
      for (const [id, subscriber] of [...this.subscribers]) {
        if (!this.deps.allowed(subscriber.pluginId, "limits:read")) continue;
        // An account home's numbers go only to the plugin whose data folder holds it.
        if (key && (!this.homes.get(subscriber.pluginId)?.has(key) || !this.deps.allowed(subscriber.pluginId, "launch:contribute"))) continue;
        if (!this.deps.notify(subscriber.pluginId, subscriber.serviceId, "canvastty.limits.changed", params)) {
          this.subscribers.delete(id);
        }
      }
    }
  }
}

function homeKey(provider: LimitProviderId, home: string): string {
  return `${provider}\u0000${home}`;
}

/**
 * Keeps each window once across debounced changes: the share and announced time before the first drop, and the share
 * and reported time after the last one.
 */
function mergeEarlyResets(earlier: readonly LimitEarlyReset[], later: readonly LimitEarlyReset[]): LimitEarlyReset[] {
  const merged = new Map<string, LimitEarlyReset>();
  const key = (reset: LimitEarlyReset): string => `${reset.provider}\u0000${reset.home ?? ""}\u0000${reset.windowId}`;
  for (const reset of earlier) merged.set(key(reset), { ...reset });
  for (const reset of later) {
    const first = merged.get(key(reset));
    if (!first) {
      merged.set(key(reset), { ...reset });
      continue;
    }
    merged.set(key(reset), {
      ...reset,
      usedBefore: first.usedBefore,
      announcedResetAt: first.announcedResetAt,
      resetTimeKept: reset.reportedResetAtAfter !== null && Math.abs(reset.reportedResetAtAfter - first.announcedResetAt) <= 60_000
    });
  }
  return [...merged.values()];
}

/** A folder path without trailing separators (`/a/b/` names the same folder as `/a/b`). */
function withoutTrailingSeparator(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  return trimmed === "" || /^[A-Za-z]:$/u.test(trimmed) ? path : trimmed;
}

/**
 * An account home a service may ask limits for: an exact absolute path (no `..`, no relative part) strictly inside
 * `dataDir` (the host's record of the calling plugin's data folder, never a value from the plugin), where the data
 * folder and every folder below it down to the home is a real directory, not a symbolic link, and resolves to the
 * same place. Returns the home; anything else throws one generic refusal, so the answer reveals nothing about paths.
 */
export function validateLimitsHome(dataDir: string, candidate: unknown): string {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > MAX_HOME_LENGTH || candidate.includes("\u0000")) {
    throw new Error(UNKNOWN_HOME);
  }
  const home = withoutTrailingSeparator(candidate);
  if (!isAbsolute(dataDir) || !isAbsolute(home) || resolve(home) !== home) throw new Error(UNKNOWN_HOME);
  const root = resolve(dataDir);
  const rest = relative(root, home);
  if (rest === "" || rest.startsWith("..") || isAbsolute(rest)) throw new Error(UNKNOWN_HOME);
  try {
    const rootInfo = lstatSync(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("not a real folder");
    let path = root;
    let canonical = realpathSync.native(root);
    for (const segment of rest.split(sep)) {
      path = join(path, segment);
      canonical = join(canonical, segment);
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(path) !== canonical) throw new Error("not a real folder");
    }
  } catch {
    throw new Error(UNKNOWN_HOME);
  }
  return home;
}
