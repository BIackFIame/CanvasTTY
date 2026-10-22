import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat, type FileHandle } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  LimitProviderId,
  LimitSource,
  LimitUnavailableReason,
  LimitWindow,
  LimitsSnapshot,
  ProviderLimitsSnapshot
} from "../../shared/contracts";
import {
  providerChildProcessLaunch,
  type AvailableProviderCli,
  type ProviderCliRegistry
} from "./providerCliRegistry.ts";
import { NdjsonLineReader } from "../../agent-runtime/ndjson.mjs";
import { immutableSqliteTarget, openPlainFile } from "./plainFile.ts";

export { openPlainFile };

const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
// `codex app-server` holds about 55-60 MB while it runs. It is started by the
// first Codex limits read and stopped after this long without one, so it is not
// kept for the whole session when nothing reads limits (window hidden, no
// widget, Even G2 idle). The renderer reads every 60 s while it is visible.
const CODEX_IDLE_MS = 3 * 60_000;
const MAX_LINE_BYTES = 1_048_576;
const MAX_BUFFER_BYTES = MAX_LINE_BYTES * 2;
const MAX_WINDOWS = 12;
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const LIMIT_PROVIDERS: readonly LimitProviderId[] = ["codex", "claude", "qwen", "kimi", "opencode", "grok"];
/**
 * An additional CLI home (an account home a plugin keeps in its own data folder) is read at most this often: each
 * read may start a CLI process (Codex) or make a provider request, and pools hold many homes.
 */
const HOME_CACHE_TTL_MS = 3 * 60_000;
/** Additional homes remembered at once (cache and last good values); the oldest is forgotten first. */
const MAX_HOME_ENTRIES = 64;
/** Additional-home reads running at once, across every plugin. */
const MAX_HOME_READS = 2;
/**
 * How each provider's reader is pointed at an additional home: the variable the CLI itself reads its data root from,
 * or the files the reader opens there.
 * - codex: `codex app-server` with CODEX_HOME=<home>;
 * - claude: CLAUDE_CONFIG_DIR=<home> (its `.credentials.json`, or on macOS the Keychain entry Claude Code keeps for it);
 * - grok: `<home>/auth.json` (GROK_HOME);
 * - kimi: `kimi web` with KIMI_CODE_HOME=<home> (and KIMI_SHARE_DIR for older releases);
 * - opencode: the OpenCode Go key in `<home>/auth.json`, or `<home>/opencode/auth.json` when the home is the XDG data
 *   root OpenCode runs with;
 * - qwen: QWEN_HOME=<home>. Qwen Code has no quota protocol (see readQwenHomeState): read passively, no request.
 */
export const HOME_LIMIT_PROVIDERS: readonly LimitProviderId[] = ["codex", "claude", "qwen", "kimi", "opencode", "grok"];
/**
 * Early resets. A window is reset early when its used share drops substantially before the reset time the previous
 * snapshot announced: by at least EARLY_RESET_MIN_DROP points and at least half of what was used, or down to
 * EARLY_RESET_NEAR_ZERO or less (by more than the noise of EARLY_RESET_NOISE points). A drop within
 * NORMAL_RESET_GRACE_MS of the announced time, or after it, is the normal reset. What the provider reports as the next
 * reset time afterwards (a new one, or the old one kept) does not decide it, and a reset time that only moves is not a
 * reset.
 */
const EARLY_RESET_MIN_DROP = 5;
const EARLY_RESET_NEAR_ZERO = 5;
const EARLY_RESET_NOISE = 2;
const NORMAL_RESET_GRACE_MS = 5 * 60_000;
/** Reset times this close count as the same announced time (providers round and jitter them). */
const SAME_RESET_TIME_MS = 60_000;

interface CacheEntry<T = LimitsSnapshot> {
  cachedAt: number;
  value: T;
}

export interface LimitsServiceOptions {
  codexIdleMs?: number;
  /** Minimum age before an additional home is read again (default 3 minutes; never below cacheTtlMs). */
  homeCacheTtlMs?: number;
  /** Environment used to locate CODEX_HOME; defaults to the one the Codex app-server inherits. */
  environment?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  cacheTtlMs?: number;
  claude?: Omit<ClaudeUsageReadOptions, "onScope">;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

interface RawLimitBucket {
  snapshot: Record<string, unknown>;
  isDefaultBucket: boolean;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: LimitsAdapterError): void;
  timer: NodeJS.Timeout;
}

/** A window whose allowance came back before the reset time the previous snapshot announced. */
export interface LimitEarlyReset {
  provider: LimitProviderId;
  /** The account home it was read for; absent for the default login. */
  home?: string;
  windowId: string;
  /** The window's kind as the snapshot names it: slot, label ("5h", "7d", "monthly", a model's name) and length. */
  slot: "primary" | "secondary";
  windowLabel: string | null;
  windowMinutes: number | null;
  /** Used share (percent) before and after the drop. */
  usedBefore: number;
  usedAfter: number;
  /** The reset time announced before the drop. */
  announcedResetAt: number;
  /** The reset time the provider reports after it: a new one, the same one, or none. */
  reportedResetAtAfter: number | null;
  /** The provider still reports the old announced reset time (within a minute). */
  resetTimeKept: boolean;
}

/**
 * A snapshot LimitsService published that differs from the one before it (timestamps aside). `home` names the
 * additional CLI home it was read for; absent for the default login. Account scopes are still present here: they are
 * stripped (pluginLimitsResult) before anything leaves the main process.
 */
export interface LimitsChange {
  snapshot: LimitsSnapshot;
  home?: { provider: LimitProviderId; home: string };
  earlyResets: LimitEarlyReset[];
}

interface HomeEntry {
  cachedAt: number;
  value: ProviderLimitsSnapshot;
  lastGood: Extract<ProviderLimitsSnapshot, { state: "available" }> | null;
}

interface GrokCredential {
  token: string;
  authMode: number;
  expiresAt: number;
  sessionExpired: boolean;
}

async function codexConfigurationFingerprint(home: string): Promise<string | null> {
  return readFile(join(home, "config.toml"))
    .then(contents => createHash("sha256").update(contents).digest("hex")).catch(() => null);
}

export class LimitsService {
  private codex: CodexAppServerClient;
  private kimi: KimiWebUsageClient;
  private readonly providerClis: ProviderCliRegistry;
  private readonly clientVersion: string;
  private readonly cacheTtlMs: number;
  private readonly codexHome: string;
  private readonly claudeOptions: Omit<ClaudeUsageReadOptions, "onScope">;
  private cache: CacheEntry | null = null;
  private inFlight: Promise<LimitsSnapshot> | null = null;
  private readonly providerCache = new Map<LimitProviderId, CacheEntry<ProviderLimitsSnapshot>>();
  private readonly providerLoads = new Map<LimitProviderId, Promise<ProviderLimitsSnapshot>>();
  // undefined until the first Codex read; null when that read found no account.
  private lastCodexScope: string | null | undefined = undefined;
  private lastCodexConfiguration: string | null | undefined = undefined;
  private lastGoodCodex: Extract<ProviderLimitsSnapshot, { state: "available" }> | null = null;
  private lastGoodClaude: Extract<ProviderLimitsSnapshot, { state: "available" }> | null = null;
  private lastGoodKimi: Extract<ProviderLimitsSnapshot, { state: "available" }> | null = null;
  private lastGoodOpenCode: Extract<ProviderLimitsSnapshot, { state: "available" }> | null = null;
  private lastGoodGrok: Extract<ProviderLimitsSnapshot, { state: "available" }> | null = null;
  private disposed = false;
  private readonly listeners = new Set<(change: LimitsChange) => void>();
  private readonly homes = new Map<string, HomeEntry>();
  private readonly homeLoads = new Map<string, Promise<ProviderLimitsSnapshot>>();
  private readonly homeClients = new Set<CodexAppServerClient | KimiWebUsageClient>();
  private homeReadsRunning = 0;
  private readonly homeReadQueue: Array<() => void> = [];
  private readonly homeCacheTtlMs: number;
  private readonly providerReadListeners = new Set<(snapshot: ProviderLimitsSnapshot) => void>();

  private readonly codexIdleMs: number;

  constructor(providerClis: ProviderCliRegistry, clientVersion = "unknown", options: LimitsServiceOptions = {}) {
    this.providerClis = providerClis;
    this.clientVersion = clientVersion;
    this.codexIdleMs = options.codexIdleMs ?? CODEX_IDLE_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
    this.homeCacheTtlMs = Math.max(options.homeCacheTtlMs ?? HOME_CACHE_TTL_MS, this.cacheTtlMs);
    const environment = options.environment ?? process.env;
    this.codexHome = environment.CODEX_HOME || join(options.homeDirectory ?? homedir(), ".codex");
    this.claudeOptions = options.claude ?? {};
    this.codex = new CodexAppServerClient(availableCli(providerClis, "codex"), clientVersion, this.codexIdleMs);
    this.kimi = new KimiWebUsageClient(availableCli(providerClis, "kimi"));
  }

  async get(): Promise<LimitsSnapshot> {
    const now = Date.now();
    if (this.cache && now - this.cache.cachedAt < this.cacheTtlMs) {
      return structuredClone(this.cache.value);
    }

    if (!this.inFlight) {
      this.inFlight = this.refresh().finally(() => {
        this.inFlight = null;
      });
    }

    return structuredClone(await this.inFlight);
  }

  /**
   * The last snapshot a read produced, however old, without starting one: no process, file or network access.
   * Null before the first read finished (or after the provider CLIs changed).
   */
  peek(): LimitsSnapshot | null {
    return this.cache ? structuredClone(this.cache.value) : null;
  }

  /**
   * Reads only the requested providers (usage history needs Codex and Claude) without
   * starting the others. Fresh results are shared with get(), so both callers together
   * make at most one provider request per cache interval.
   */
  async getProviders(providers: readonly LimitProviderId[]): Promise<LimitsSnapshot> {
    const full = this.cache && Date.now() - this.cache.cachedAt < this.cacheTtlMs ? this.cache.value : null;
    const checkedAt = Date.now();
    const values = await Promise.all(providers.map((provider) => {
      const cached = full?.providers.find((candidate) => candidate.provider === provider);
      return cached ? Promise.resolve(cached) : this.loadShared(provider, checkedAt);
    }));
    return structuredClone({ fetchedAt: Date.now(), providers: values });
  }

  /**
   * Called with every snapshot that differs from the previous one of the same login or home (timestamps aside),
   * with the windows that reset early. Returns the unsubscribe function.
   */
  onChange(listener: (change: LimitsChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Limits of one provider for an additional CLI home (CODEX_HOME, CLAUDE_CONFIG_DIR or GROK_HOME), read by the same
   * reader as the default login with that home. The caller has validated `home`; this never decides which folders
   * may be read. Each home is read at most once per home cache interval and at most MAX_HOME_READS at once; other
   * providers answer `unsupported-protocol` without any read.
   */
  async getHome(provider: LimitProviderId, home: string): Promise<LimitsSnapshot> {
    const value = await this.loadHome(provider, home);
    return structuredClone({ fetchedAt: Date.now(), providers: [value] });
  }

  /** The cached value for an additional home, however old, without reading; null when it was never read. */
  peekHome(provider: LimitProviderId, home: string): LimitsSnapshot | null {
    const entry = this.homes.get(homeKey(provider, home));
    return entry ? structuredClone({ fetchedAt: entry.cachedAt, providers: [entry.value] }) : null;
  }

  /**
   * Called with every provider snapshot a read produced (not for cached answers). Starts no read by itself. A
   * listener that throws is ignored. Returns the function that removes it.
   */
  onProviderRead(listener: (snapshot: ProviderLimitsSnapshot) => void): () => void {
    this.providerReadListeners.add(listener);
    return () => { this.providerReadListeners.delete(listener); };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.codex.dispose();
    this.kimi.dispose();
    for (const client of this.homeClients) client.dispose();
    this.homeClients.clear();
    this.listeners.clear();
  }

  async providerClisRefreshed(): Promise<void> {
    await this.inFlight?.catch(() => undefined);
    await Promise.allSettled([...this.providerLoads.values()]);
    if (this.disposed) return;
    this.codex.dispose();
    this.kimi.dispose();
    this.codex = new CodexAppServerClient(availableCli(this.providerClis, "codex"), this.clientVersion, this.codexIdleMs);
    this.kimi = new KimiWebUsageClient(availableCli(this.providerClis, "kimi"));
    this.cache = null;
    this.providerCache.clear();
    this.homes.clear();
    this.lastCodexScope = undefined;
    this.lastCodexConfiguration = undefined;
    this.lastGoodCodex = null;
    this.lastGoodClaude = null;
    this.lastGoodKimi = null;
    this.lastGoodOpenCode = null;
    this.lastGoodGrok = null;
  }

  private async refresh(): Promise<LimitsSnapshot> {
    const checkedAt = Date.now();
    const providers = await Promise.all(LIMIT_PROVIDERS.map((provider) => this.loadShared(provider, checkedAt)));
    const value: LimitsSnapshot = {
      fetchedAt: Date.now(),
      providers
    };

    const previous = this.cache?.value ?? null;
    this.cache = { cachedAt: Date.now(), value };
    this.publish(previous, value);
    return value;
  }

  /** Tells listeners about a snapshot that differs from `previous`; early resets are computed here, once. */
  private publish(previous: LimitsSnapshot | null, next: LimitsSnapshot, home?: { provider: LimitProviderId; home: string }): void {
    if (this.disposed || this.listeners.size === 0) return;
    if (previous && limitsContentKey(previous) === limitsContentKey(next)) return;
    const change: LimitsChange = {
      snapshot: structuredClone(next),
      ...(home ? { home: { ...home } } : {}),
      earlyResets: previous ? detectEarlyResets(previous, next, Date.now(), home?.home) : []
    };
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch {
        // A listener's failure never affects the read or the other listeners.
      }
    }
  }

  private loadHome(provider: LimitProviderId, home: string): Promise<ProviderLimitsSnapshot> {
    const key = homeKey(provider, home);
    const cached = this.homes.get(key);
    if (cached && Date.now() - cached.cachedAt < this.homeCacheTtlMs) return Promise.resolve(cached.value);
    let load = this.homeLoads.get(key);
    if (!load) {
      load = this.withHomeReadSlot(() => this.readHome(provider, home, cached?.lastGood ?? null)).then((result) => {
        const previous = this.homes.get(key)?.value ?? null;
        this.homes.delete(key);
        this.homes.set(key, { cachedAt: Date.now(), value: result.value, lastGood: result.lastGood });
        // The oldest home is forgotten first: memory stays bounded however many homes are asked about.
        while (this.homes.size > MAX_HOME_ENTRIES) this.homes.delete(this.homes.keys().next().value!);
        const at = Date.now();
        this.publish(
          previous ? { fetchedAt: at, providers: [previous] } : null,
          { fetchedAt: at, providers: [result.value] },
          { provider, home }
        );
        return result.value;
      }).finally(() => {
        this.homeLoads.delete(key);
      });
      this.homeLoads.set(key, load);
    }
    return load;
  }

  private async withHomeReadSlot<T>(read: () => Promise<T>): Promise<T> {
    if (this.homeReadsRunning >= MAX_HOME_READS) {
      await new Promise<void>((resolve) => this.homeReadQueue.push(resolve));
    } else {
      this.homeReadsRunning += 1;
    }
    try {
      return await read();
    } finally {
      const next = this.homeReadQueue.shift();
      if (next) next();
      else this.homeReadsRunning -= 1;
    }
  }

  private async readHome(
    provider: LimitProviderId,
    home: string,
    lastGood: Extract<ProviderLimitsSnapshot, { state: "available" }> | null
  ): Promise<{ value: ProviderLimitsSnapshot; lastGood: Extract<ProviderLimitsSnapshot, { state: "available" }> | null }> {
    const checkedAt = Date.now();
    const source = LIMIT_SOURCES[provider];
    if (this.providerClis.get(provider).state === "unavailable") {
      return { value: unavailable(provider, source, "cli-not-found", checkedAt), lastGood: null };
    }
    if (this.disposed) return { value: unavailable(provider, source, "protocol-error", checkedAt), lastGood };
    // The caller validated the home; it must still be a real folder, not a link, when it is read.
    if (!(await verifiedHomeFolder(home))) return { value: unavailable(provider, source, "not-authenticated", checkedAt), lastGood: null };
    if (provider === "qwen") {
      return { value: unavailable(provider, source, await readQwenHomeState(home), checkedAt), lastGood: null };
    }
    try {
      let windows: LimitWindow[];
      if (provider === "codex") {
        // One app-server for this read only, started with the home's CODEX_HOME and stopped right after.
        const client = new CodexAppServerClient(availableCli(this.providerClis, "codex"), this.clientVersion, 0, { CODEX_HOME: home });
        this.homeClients.add(client);
        try {
          windows = normalizeCodexLimits(await client.readRateLimits());
        } finally {
          client.dispose();
          this.homeClients.delete(client);
        }
        if (windows.length === 0) throw new LimitsAdapterError("not-authenticated");
      } else if (provider === "kimi") {
        // One `kimi web` for this read only, started with the home as its data root and stopped right after.
        const client = new KimiWebUsageClient(availableCli(this.providerClis, "kimi"), { KIMI_CODE_HOME: home, KIMI_SHARE_DIR: home });
        this.homeClients.add(client);
        try {
          windows = normalizeKimiLimits(await client.readUsage());
        } finally {
          client.dispose();
          this.homeClients.delete(client);
        }
        if (windows.length === 0) throw new LimitsAdapterError("protocol-error");
      } else if (provider === "opencode") {
        // The home is OpenCode's data folder, or the XDG data root it runs with (`<root>/opencode`): only folders that
        // are real folders under the home, never reached through a link.
        const dataDirs = (await Promise.all([verifiedHomeFolder(home), verifiedHomeFolder(home, ["opencode"])]))
          .filter((folder): folder is string => folder !== null);
        windows = normalizeOpenCodeGoLimits(await readOpenCodeGoUsage(this.clientVersion, dataDirs, { home: true }));
        if (windows.length === 0) throw new LimitsAdapterError("protocol-error");
      } else if (provider === "claude") {
        const { CLAUDE_SECURESTORAGE_CONFIG_DIR: _shared, ...environment } = this.claudeOptions.environment ?? process.env;
        windows = normalizeClaudeLimits(await readClaudeUsage(this.clientVersion, { ...this.claudeOptions, environment, configRoot: home, refuseSymlinks: true }));
        if (windows.length === 0) throw new LimitsAdapterError("protocol-error");
      } else {
        windows = normalizeGrokLimits(await readGrokUsage(this.clientVersion, home));
        if (windows.length === 0) throw new LimitsAdapterError("protocol-error");
      }
      const available: Extract<ProviderLimitsSnapshot, { state: "available" }> = {
        provider, state: "available", source, fetchedAt: Date.now(), windows
      };
      return { value: available, lastGood: available };
    } catch (error) {
      const reason = adapterReason(error);
      if (lastGood) return { value: { ...lastGood, state: "stale", failedAt: Date.now(), reason }, lastGood };
      return { value: unavailable(provider, source, reason, checkedAt), lastGood: null };
    }
  }

  /** One request per provider at a time, reused while younger than the cache interval. */
  private loadShared(provider: LimitProviderId, checkedAt: number): Promise<ProviderLimitsSnapshot> {
    const cached = this.providerCache.get(provider);
    if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) return Promise.resolve(cached.value);
    let load = this.providerLoads.get(provider);
    if (!load) {
      load = this.loadProvider(provider, checkedAt).then((value) => {
        this.providerCache.set(provider, { cachedAt: Date.now(), value });
        for (const listener of this.providerReadListeners) {
          try {
            listener(structuredClone(value));
          } catch {
            // A listener never breaks a read.
          }
        }
        return value;
      }).finally(() => {
        this.providerLoads.delete(provider);
      });
      this.providerLoads.set(provider, load);
    }
    return load;
  }

  private loadProvider(provider: LimitProviderId, checkedAt: number): Promise<ProviderLimitsSnapshot> {
    switch (provider) {
      case "codex": return this.loadCodex(checkedAt);
      case "claude": return this.loadClaude(checkedAt);
      case "qwen": return this.loadQwen(checkedAt);
      case "kimi": return this.loadKimi(checkedAt);
      case "opencode": return this.loadOpenCode(checkedAt);
      case "grok": return this.loadGrok(checkedAt);
    }
  }

  private async loadCodex(checkedAt: number): Promise<ProviderLimitsSnapshot> {
    if (this.providerClis.get("codex").state === "unavailable") {
      return unavailable("codex", "codex-app-server", "cli-not-found", checkedAt);
    }
    if (this.disposed) {
      return unavailable("codex", "codex-app-server", "protocol-error", checkedAt);
    }

    let requestScope: string | null | undefined;
    let requestConfiguration: string | null | undefined;
    try {
      // The account is bound around the request: a login change before, during or since
      // the previous read cannot be attributed, so that observation stays account-unknown.
      const before = await readCodexAccountScope(this.codexHome);
      requestScope = before;
      const accountChanged = this.lastCodexScope !== undefined && before !== this.lastCodexScope;
      this.lastCodexScope = before;
      // The app-server captures the provider/profile configuration at startup too.
      // Keep only a fingerprint: configuration can contain private provider settings.
      const configuration = await codexConfigurationFingerprint(this.codexHome);
      requestConfiguration = configuration;
      const configurationChanged = this.lastCodexConfiguration !== undefined && configuration !== this.lastCodexConfiguration;
      this.lastCodexConfiguration = configuration;
      if (accountChanged || configurationChanged) this.codex.restart();
      if (accountChanged || configurationChanged) this.lastGoodCodex = null;
      const raw = await this.codex.readRateLimits();
      const after = await readCodexAccountScope(this.codexHome);
      if (configuration !== await codexConfigurationFingerprint(this.codexHome)) {
        this.lastGoodCodex = null;
        throw new LimitsAdapterError("protocol-error");
      }
      const windows = normalizeCodexLimits(raw);
      if (windows.length === 0) throw new LimitsAdapterError("not-authenticated");

      const available: Extract<ProviderLimitsSnapshot, { state: "available" }> = {
        provider: "codex",
        state: "available",
        source: "codex-app-server",
        fetchedAt: Date.now(),
        windows,
        accountScope: !accountChanged && before !== null && before === after ? before : null
      };
      // A response spanning a login change is unscoped and cannot seed the stale cache.
      this.lastGoodCodex = before === after ? available : null;
      return available;
    } catch (error) {
      if ((requestScope !== undefined && requestScope !== await readCodexAccountScope(this.codexHome))
        || (requestConfiguration !== undefined && requestConfiguration !== await codexConfigurationFingerprint(this.codexHome))) {
        this.lastGoodCodex = null;
        return unavailable("codex", "codex-app-server", "protocol-error", checkedAt);
      }
      const reason = adapterReason(error);
      // API-backed profiles cannot retain subscription quotas from an earlier configuration.
      if (reason === "api-profile") this.lastGoodCodex = null;
      if (this.lastGoodCodex) {
        return {
          ...this.lastGoodCodex,
          state: "stale",
          failedAt: Date.now(),
          reason
        };
      }
      return unavailable("codex", "codex-app-server", reason, checkedAt);
    }
  }

  private async loadClaude(checkedAt: number): Promise<ProviderLimitsSnapshot> {
    if (this.providerClis.get("claude").state === "unavailable") {
      return unavailable("claude", "claude-usage-api", "cli-not-found", checkedAt);
    }
    try {
      let accountScope: string | null = null;
      const raw = await readClaudeUsage(this.clientVersion, {
        ...this.claudeOptions,
        onScope: (scope) => {
          accountScope = scope;
        }
      });
      const windows = normalizeClaudeLimits(raw);
      if (windows.length === 0) throw new LimitsAdapterError("protocol-error");

      const available: Extract<ProviderLimitsSnapshot, { state: "available" }> = {
        provider: "claude",
        state: "available",
        source: "claude-usage-api",
        fetchedAt: Date.now(),
        windows,
        accountScope
      };
      this.lastGoodClaude = available;
      return available;
    } catch (error) {
      const reason = adapterReason(error);
      if (this.lastGoodClaude) {
        return {
          ...this.lastGoodClaude,
          state: "stale",
          failedAt: Date.now(),
          reason
        };
      }
      return unavailable("claude", "claude-usage-api", reason, checkedAt);
    }
  }

  private async loadKimi(checkedAt: number): Promise<ProviderLimitsSnapshot> {
    if (this.providerClis.get("kimi").state === "unavailable") {
      return unavailable("kimi", "kimi-usage-api", "cli-not-found", checkedAt);
    }
    try {
      const raw = await this.kimi.readUsage();
      const windows = normalizeKimiLimits(raw);
      if (windows.length === 0) throw new LimitsAdapterError("protocol-error");

      const available: Extract<ProviderLimitsSnapshot, { state: "available" }> = {
        provider: "kimi",
        state: "available",
        source: "kimi-usage-api",
        fetchedAt: Date.now(),
        windows
      };
      this.lastGoodKimi = available;
      return available;
    } catch (error) {
      const reason = adapterReason(error);
      if (this.lastGoodKimi) {
        return {
          ...this.lastGoodKimi,
          state: "stale",
          failedAt: Date.now(),
          reason
        };
      }
      return unavailable("kimi", "kimi-usage-api", reason, checkedAt);
    }
  }

  private async loadQwen(checkedAt: number): Promise<ProviderLimitsSnapshot> {
    if (this.providerClis.get("qwen").state === "unavailable") {
      return unavailable("qwen", "qwen-cli", "cli-not-found", checkedAt);
    }
    // Qwen Code can use Alibaba Coding Plan, arbitrary OpenAI-compatible APIs,
    // or local models. Its CLI exposes no provider-neutral read-only quota
    // protocol, so CanvasTTY must not synthesize one usage value for all of them.
    return unavailable("qwen", "qwen-cli", "unsupported-protocol", checkedAt);
  }

  private async loadOpenCode(checkedAt: number): Promise<ProviderLimitsSnapshot> {
    if (this.providerClis.get("opencode").state === "unavailable") {
      return unavailable("opencode", "opencode-go-usage-api", "cli-not-found", checkedAt);
    }
    try {
      const raw = await readOpenCodeGoUsage(this.clientVersion);
      const windows = normalizeOpenCodeGoLimits(raw);
      if (windows.length === 0) throw new LimitsAdapterError("protocol-error");

      const available: Extract<ProviderLimitsSnapshot, { state: "available" }> = {
        provider: "opencode",
        state: "available",
        source: "opencode-go-usage-api",
        fetchedAt: Date.now(),
        windows
      };
      this.lastGoodOpenCode = available;
      return available;
    } catch (error) {
      const reason = adapterReason(error);
      if (this.lastGoodOpenCode) {
        return {
          ...this.lastGoodOpenCode,
          state: "stale",
          failedAt: Date.now(),
          reason
        };
      }
      return unavailable("opencode", "opencode-go-usage-api", reason, checkedAt);
    }
  }

  private async loadGrok(checkedAt: number): Promise<ProviderLimitsSnapshot> {
    if (this.providerClis.get("grok").state === "unavailable") {
      return unavailable("grok", "grok-billing-api", "cli-not-found", checkedAt);
    }
    try {
      const raw = await readGrokUsage(this.clientVersion);
      const windows = normalizeGrokLimits(raw);
      if (windows.length === 0) throw new LimitsAdapterError("protocol-error");

      const available: Extract<ProviderLimitsSnapshot, { state: "available" }> = {
        provider: "grok",
        state: "available",
        source: "grok-billing-api",
        fetchedAt: Date.now(),
        windows
      };
      this.lastGoodGrok = available;
      return available;
    } catch (error) {
      const reason = adapterReason(error);
      if (this.lastGoodGrok) {
        return {
          ...this.lastGoodGrok,
          state: "stale",
          failedAt: Date.now(),
          reason
        };
      }
      return unavailable("grok", "grok-billing-api", reason, checkedAt);
    }
  }
}

export interface ClaudeUsageReadOptions {
  configRoot?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  account?: string;
  keychainRequest?: (service: string, account: string) => Promise<string>;
  request?: (
    url: string,
    accessToken: string,
    additionalHeaders: Record<string, string>
  ) => Promise<unknown>;
  /**
   * Receives a one-way fingerprint of the OAuth credential used for this request, never
   * the credential. A token refresh starts a new epoch: it separates credentials
   * conservatively but is not a permanent account identity.
   */
  onScope?: (scope: string) => void;
  /** An account home: its credential file is read only when it is a plain file, never through a symbolic link. */
  refuseSymlinks?: boolean;
}

export async function readClaudeUsage(
  clientVersion: string,
  options: ClaudeUsageReadOptions = {}
): Promise<unknown> {
  const environment = options.environment ?? process.env;
  const defaultConfigRoot = join(options.homeDirectory ?? homedir(), ".claude");
  const configRoot = (options.configRoot ?? environment.CLAUDE_CONFIG_DIR) || defaultConfigRoot;
  const credentials = await readClaudeCredentials(configRoot, defaultConfigRoot, environment, options);
  const oauth = isRecord(credentials.claudeAiOauth) ? credentials.claudeAiOauth : null;
  const accessToken = cleanSecret(oauth?.accessToken);
  // Missing credentials describe only this runtime user; they do not prove anything about the user's plan.
  if (!accessToken) throw new LimitsAdapterError("not-authenticated");
  options.onScope?.(accountScopeFingerprint("claude", accessToken));

  return (options.request ?? fetchUsageJson)(CLAUDE_USAGE_URL, accessToken, {
    "anthropic-beta": "oauth-2025-04-20",
    "user-agent": `canvastty/${clientVersion}`
  });
}

async function readClaudeCredentials(
  configRoot: string,
  defaultConfigRoot: string,
  environment: Readonly<Record<string, string | undefined>>,
  options: ClaudeUsageReadOptions
): Promise<Record<string, unknown>> {
  if ((options.platform ?? process.platform) !== "darwin") {
    return readCredentialFile(join(configRoot, ".credentials.json"), "not-authenticated", options.refuseSymlinks === true);
  }

  const secureStorageRoot = Object.hasOwn(environment, "CLAUDE_SECURESTORAGE_CONFIG_DIR")
    ? environment.CLAUDE_SECURESTORAGE_CONFIG_DIR || defaultConfigRoot
    : configRoot;
  const service = secureStorageRoot === defaultConfigRoot
    ? CLAUDE_KEYCHAIN_SERVICE
    : `${CLAUDE_KEYCHAIN_SERVICE}-${createHash("sha256")
        .update(secureStorageRoot.normalize("NFC"))
        .digest("hex")
        .slice(0, 8)}`;
  const account = options.account ?? userInfo().username;
  const keychainRequest = options.keychainRequest ?? readMacOSClaudeCredentials;

  try {
    const parsed: unknown = JSON.parse(await keychainRequest(service, account));
    if (!isRecord(parsed)) throw new LimitsAdapterError("protocol-error");
    return parsed;
  } catch (error) {
    if (error instanceof LimitsAdapterError) throw error;
    throw new LimitsAdapterError(keychainErrorReason(error));
  }
}

function keychainErrorReason(error: unknown): LimitUnavailableReason {
  if (!isRecord(error)) return "protocol-error";
  if (error.killed === true || error.code === "ETIMEDOUT") return "timeout";
  if (error.code === 44 || error.code === "44") return "not-authenticated";
  return "protocol-error";
}

function readMacOSClaudeCredentials(service: string, account: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { encoding: "utf8", maxBuffer: MAX_LINE_BYTES, timeout: REQUEST_TIMEOUT_MS },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      }
    );
  });
}

/**
 * The OpenCode Go key in the first of `dataDirs` (OpenCode's data folders, `<XDG data>/opencode`) that holds a sign-in.
 * OpenCode V2 keeps credentials in its SQLite database (`opencode.db`, or OPENCODE_DB for the default login) and only
 * imports the legacy `auth.json` once, so a database with a credential table decides; otherwise `auth.json` does.
 * An account home (`home`) never follows a symbolic link to a credential file or database.
 */
async function readOpenCodeGoUsage(clientVersion: string, dataDirs: readonly string[] = openCodeDataDirs(), options: { home?: boolean } = {}): Promise<unknown> {
  let accessToken: string | null = null;
  for (const dataDir of dataDirs) {
    const database = openCodeDatabasePath(dataDir, options.home ? undefined : process.env.OPENCODE_DB);
    const stored = database ? await readOpenCodeGoKeyFromDatabase(database, { refuseSymlinks: options.home === true }) : undefined;
    if (stored === null) throw new LimitsAdapterError("subscription-required");
    if (typeof stored === "string") {
      accessToken = stored;
      break;
    }
    let credentials: Record<string, unknown>;
    try {
      credentials = await readCredentialFile(join(dataDir, "auth.json"), "subscription-required", options.home === true);
    } catch (error) {
      if (error instanceof LimitsAdapterError && error.reason === "subscription-required") continue;
      throw error;
    }
    const go = isRecord(credentials[OPENCODE_GO_INTEGRATION]) ? credentials[OPENCODE_GO_INTEGRATION] : null;
    accessToken = cleanSecret(go?.key);
    break;
  }
  if (!accessToken) throw new LimitsAdapterError("subscription-required");

  return fetchUsageJson(OPENCODE_GO_USAGE_URL, accessToken, {
    "user-agent": `canvastty/${clientVersion}`
  });
}

async function readGrokUsage(clientVersion: string, home?: string): Promise<unknown> {
  const configRoot = home ?? (process.env.GROK_HOME || join(homedir(), ".grok"));
  const credentials = await readCredentialFile(join(configRoot, "auth.json"), "not-authenticated", home !== undefined);
  const credential = selectGrokCredential(credentials);
  if (!credential) throw new LimitsAdapterError("not-authenticated");
  if (credential.sessionExpired) throw new LimitsAdapterError("session-expired");

  return fetchUsageJson(GROK_BILLING_URL, credential.token, {
    "x-xai-token-auth": "xai-grok-cli",
    "user-agent": `canvastty/${clientVersion}`
  });
}

const MAX_QWEN_SETTINGS_BYTES = 1_048_576;

/**
 * Qwen Code exposes no read-only quota protocol: no command or endpoint reports what is left (its `/stats` counts the
 * current session only), Qwen OAuth's free tier ended on 2026-04-15, and Alibaba Coding Plan usage is shown only in
 * the Model Studio console and its separate `bl` CLI, under an Alibaba Cloud sign-in that is not in the Qwen home (and
 * the plan's terms forbid using its key from scripts). So a Qwen home is read passively, without a request: which
 * sign-in it holds decides the reason. Only `security.auth.selectedType` (or the older `selectedAuthType`) is read
 * from settings.json and only whether oauth_creds.json exists; no value from them leaves this function.
 */
export async function readQwenHomeState(home: string): Promise<LimitUnavailableReason> {
  let selectedType: string | null = null;
  try {
    const raw = await readPlainText(join(home, "settings.json"), true);
    if (Buffer.byteLength(raw) > MAX_QWEN_SETTINGS_BYTES) return "protocol-error";
    const parsed: unknown = JSON.parse(raw.replace(/^\s*\/\/.*$/gmu, ""));
    if (isRecord(parsed)) {
      const security = isRecord(parsed.security) ? parsed.security : null;
      const auth = security && isRecord(security.auth) ? security.auth : null;
      const value = auth?.selectedType ?? parsed.selectedAuthType;
      selectedType = typeof value === "string" ? value : null;
    }
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
    if (code !== "ENOENT" && code !== "EACCES") return "protocol-error";
  }
  let oauth = false;
  try {
    oauth = (await lstat(join(home, "oauth_creds.json"))).isFile();
  } catch {
    oauth = false;
  }
  // The discontinued free tier: there is no plan to read.
  if (selectedType === "qwen-oauth" || (selectedType === null && oauth)) return "subscription-required";
  // An API key, Token Plan or Coding Plan: usage lives with that provider, not in anything Qwen Code exposes.
  if (selectedType !== null) return "unsupported-protocol";
  return "not-authenticated";
}

const OPENCODE_GO_INTEGRATION = "opencode-go";
/** OpenCode's database name in release builds; other release channels name theirs `opencode-<channel>.db`. */
const OPENCODE_DATABASE = "opencode.db";
const MAX_CREDENTIAL_VALUE_BYTES = 64 * 1024;

/** OpenCode's data folders, in the order the default login looks: `$XDG_DATA_HOME/opencode` first. */
function openCodeDataDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.XDG_DATA_HOME) dirs.push(join(process.env.XDG_DATA_HOME, "opencode"));
  if (process.platform === "darwin") {
    dirs.push(join(homedir(), "Library", "Application Support", "opencode"));
  } else if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    dirs.push(join(process.env.LOCALAPPDATA, "opencode"));
  }
  dirs.push(join(homedir(), ".local", "share", "opencode"));
  return [...new Set(dirs)];
}

/** OpenCode's own rule: OPENCODE_DB (resolved against the data folder) or `opencode.db` there; none for `:memory:`. */
export function openCodeDatabasePath(dataDir: string, override?: string): string | null {
  const name = override || OPENCODE_DATABASE;
  if (name === ":memory:") return null;
  return isAbsolute(name) ? name : resolve(dataDir, name);
}

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await lstat(path)).size;
  } catch {
    return null;
  }
}

/**
 * The OpenCode Go key in an OpenCode V2 database, read without changing anything beside it. The database is opened
 * first as a file (O_NOFOLLOW for an account home) and checked to be a regular file; the read-only SQLite connection
 * then reads
 * - without WAL frames (no or an empty `-wal`): `immutable` through `/dev/fd/<n>`, the file already open (no lock, no
 *   side file; on macOS bound to that open file, so a path swapped after the check is not read);
 * - with WAL frames and `-shm` (a running OpenCode): `mode=ro` by path, through the existing `-wal` and `-shm` (it
 *   creates none); for an account home both must be plain files, not links;
 * - WAL frames without `-shm` (a writer that stopped uncleanly) cannot be read without creating `-shm`: skipped.
 * After the read the path must still be the file opened first (same device and inode), or the result is dropped.
 * Returns the key, null when the database holds credentials but no OpenCode Go key, or undefined when there is no
 * usable database (missing, a link for a home, an older runtime without SQLite URI support, another schema).
 */
export async function readOpenCodeGoKeyFromDatabase(
  database: string,
  options: { refuseSymlinks?: boolean; /** Tests only: runs between opening the file and the SQLite read. */ afterOpen?: () => Promise<void> } = {}
): Promise<string | null | undefined> {
  const noFollow = options.refuseSymlinks === true;
  let opened: { handle: FileHandle; dev: number; ino: number };
  try {
    opened = await openPlainFile(database, noFollow);
  } catch {
    return undefined;
  }
  try {
    await options.afterOpen?.();
    const sideFile = async (suffix: string): Promise<number | null | "link"> => {
      try {
        const info = await lstat(`${database}${suffix}`);
        return noFollow && !info.isFile() ? "link" : info.size;
      } catch {
        return null;
      }
    };
    const [wal, shm] = await Promise.all([sideFile("-wal"), sideFile("-shm")]);
    if (wal === "link" || shm === "link") return undefined;
    const frames = wal !== null && wal > 0;
    let result: string | null | undefined;
    if (!frames) {
      result = await queryOpenCodeGoKey(immutableSqliteTarget(opened.handle, database));
    } else if (shm !== null) {
      result = await queryOpenCodeGoKey(`${pathToFileURL(database).href}?mode=ro`);
    } else {
      return undefined;
    }
    const after = await (noFollow ? lstat(database) : stat(database)).catch(() => null);
    if (!after || after.dev !== opened.dev || after.ino !== opened.ino) return undefined;
    return result;
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

async function queryOpenCodeGoKey(target: string): Promise<string | null | undefined> {
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
  } catch {
    return undefined;
  }
  let db: import("node:sqlite").DatabaseSync | null = null;
  try {
    // A runtime without SQLite URI support reads `target` as a plain name that does not exist; read-only, it creates
    // nothing and fails.
    db = new sqlite.DatabaseSync(target, { readOnly: true, timeout: 2_000 });
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'credential'").get()) return undefined;
    const row = db.prepare("SELECT value FROM credential WHERE integration_id = ? ORDER BY active DESC, time_updated DESC LIMIT 1")
      .get(OPENCODE_GO_INTEGRATION) as { value?: unknown } | undefined;
    if (!row) return null;
    if (typeof row.value !== "string" || Buffer.byteLength(row.value) > MAX_CREDENTIAL_VALUE_BYTES) return null;
    const value: unknown = JSON.parse(row.value);
    return isRecord(value) && value.type === "key" ? cleanSecret(value.key) : null;
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed.
    }
  }
}

function selectGrokCredential(credentials: Record<string, unknown>): GrokCredential | null {
  const candidates = Object.values(credentials)
    .filter(isRecord)
    .map((credential) => ({
      token: cleanSecret(credential.key),
      authMode: credential.auth_mode === "oidc" ? 1 : 0,
      expiresAt: numericValue(credential.expires_at) ?? 0,
      sessionExpired: cleanSecret(credential.refresh_token) !== null && hasExpired(credential.expires_at)
    }))
    .filter((candidate): candidate is GrokCredential => candidate.token !== null)
    .sort((left, right) => right.authMode - left.authMode || right.expiresAt - left.expiresAt);
  return candidates[0] ?? null;
}

/**
 * Stable Codex account scope: a one-way fingerprint of tokens.account_id from the local
 * login. API-key-only, keyring-stored, missing or unreadable auth is an unknown account.
 */
export async function readCodexAccountScope(codexHome: string): Promise<string | null> {
  try {
    const auth = await readCredentialFile(join(codexHome, "auth.json"), "not-authenticated");
    const tokens = isRecord(auth.tokens) ? auth.tokens : null;
    const accountId = cleanSecret(tokens?.account_id);
    return accountId ? accountScopeFingerprint("codex", accountId) : null;
  } catch {
    return null;
  }
}

function accountScopeFingerprint(provider: "codex" | "claude", value: string): string {
  return createHash("sha256")
    .update(`canvastty-usage-scope/v1/${provider}\0`)
    .update(value)
    .digest("hex")
    .slice(0, 24);
}

const LIMIT_SOURCES: Record<LimitProviderId, LimitSource> = {
  codex: "codex-app-server",
  claude: "claude-usage-api",
  qwen: "qwen-cli",
  kimi: "kimi-usage-api",
  opencode: "opencode-go-usage-api",
  grok: "grok-billing-api"
};

function homeKey(provider: LimitProviderId, home: string): string {
  return `${provider}\u0000${home}`;
}

/** What a snapshot says, without when it was read: equal keys mean nothing changed for a reader of the windows. */
export function limitsContentKey(snapshot: LimitsSnapshot): string {
  return JSON.stringify(snapshot.providers.map((provider) => provider.state === "unavailable"
    ? [provider.provider, provider.state, provider.reason]
    : [provider.provider, provider.state, provider.state === "stale" ? provider.reason : null,
      provider.windows.map((window) => [window.id, window.usedPercent, window.used, window.limit, window.resetsAt])]));
}

/** A window's used share in percent: usedPercent, or used of limit; null when neither is known. */
function usedShare(window: LimitWindow): number | null {
  if (window.usedPercent !== null) return window.usedPercent;
  if (window.used !== null && window.limit !== null && window.limit > 0) return Math.min(100, Math.max(0, window.used / window.limit * 100));
  return null;
}

/**
 * Windows reset early between two snapshots of one login or home, matched by window id (5h, daily, weekly, monthly
 * and model windows alike). Only a substantial drop of the used share before the previously announced reset time
 * counts (see EARLY_RESET_MIN_DROP); a reset time that moved, earlier or later, without such a drop is not a reset, and
 * a drop at or after the announced time (or within NORMAL_RESET_GRACE_MS before it) is the normal reset. When the
 * provider keeps reporting the old reset time after an early reset, that time arriving later is again a normal reset,
 * so it is flagged only if the share drops substantially again before it.
 */
export function detectEarlyResets(previous: LimitsSnapshot, next: LimitsSnapshot, now: number, home?: string): LimitEarlyReset[] {
  const found: LimitEarlyReset[] = [];
  for (const provider of next.providers) {
    if (provider.state !== "available") continue;
    const before = previous.providers.find((candidate) => candidate.provider === provider.provider);
    if (!before || before.state === "unavailable") continue;
    for (const window of provider.windows) {
      const old = before.windows.find((candidate) => candidate.id === window.id);
      if (!old || old.resetsAt === null || now >= old.resetsAt - NORMAL_RESET_GRACE_MS) continue;
      const usedBefore = usedShare(old);
      const usedAfter = usedShare(window);
      if (usedBefore === null || usedAfter === null) continue;
      const drop = usedBefore - usedAfter;
      const substantial = drop >= Math.max(EARLY_RESET_MIN_DROP, usedBefore / 2)
        || (usedAfter <= EARLY_RESET_NEAR_ZERO && drop > EARLY_RESET_NOISE);
      if (!substantial) continue;
      found.push({
        provider: provider.provider as LimitProviderId,
        ...(home ? { home } : {}),
        windowId: window.id,
        slot: window.slot,
        windowLabel: window.label,
        windowMinutes: window.windowMinutes,
        usedBefore,
        usedAfter,
        announcedResetAt: old.resetsAt,
        reportedResetAtAfter: window.resetsAt,
        resetTimeKept: window.resetsAt !== null && Math.abs(window.resetsAt - old.resetsAt) <= SAME_RESET_TIME_MS
      });
    }
  }
  return found;
}

/**
 * The answer every plugin caller of `limits.get` receives, a surface or a service: one shape, built in one place, with
 * account scopes removed.
 */
export function pluginLimitsResult(snapshot: LimitsSnapshot): { state: "ready"; snapshot: LimitsSnapshot } {
  return { state: "ready", snapshot: withoutAccountScope(snapshot) };
}

/** Account scope is for local usage history only; plugins and paired devices never see it. */
export function withoutAccountScope(snapshot: LimitsSnapshot): LimitsSnapshot {
  return {
    ...snapshot,
    providers: snapshot.providers.map((provider) => {
      if (provider.state === "unavailable") return { ...provider };
      const { accountScope: _omitted, ...rest } = provider;
      return rest;
    })
  };
}

/** A text file; with `noFollow` only a plain file, never through a symbolic link at its last step (openPlainFile). */
async function readPlainText(path: string, noFollow: boolean): Promise<string> {
  if (!noFollow) return readFile(path, "utf8");
  const { handle } = await openPlainFile(path, true);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * For an account home: `home/<segments>` when the home and every folder below it on the way is a real folder (not a
 * symbolic link) that resolves to the same place under the home's real path; null otherwise.
 */
export async function verifiedHomeFolder(home: string, segments: readonly string[] = []): Promise<string | null> {
  try {
    if (!(await lstat(home)).isDirectory()) return null;
    const real = await realpath(home);
    let path = home;
    let canonical = real;
    for (const segment of segments) {
      path = join(path, segment);
      canonical = join(canonical, segment);
      if (!(await lstat(path)).isDirectory() || await realpath(path) !== canonical) return null;
    }
    return path;
  } catch {
    return null;
  }
}

async function readCredentialFile(path: string, missingReason: LimitUnavailableReason, noFollow = false): Promise<Record<string, unknown>> {
  try {
    const raw = await readPlainText(path, noFollow);
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new LimitsAdapterError("protocol-error");
    return parsed;
  } catch (error) {
    if (error instanceof LimitsAdapterError) throw error;
    const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
    if (code === "ENOENT" || code === "EACCES") throw new LimitsAdapterError(missingReason);
    throw new LimitsAdapterError("protocol-error");
  }
}

async function fetchUsageJson(
  url: string,
  accessToken: string,
  additionalHeaders: Record<string, string> = {}
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref();

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        ...additionalHeaders
      },
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403) {
      throw new LimitsAdapterError("not-authenticated");
    }
    if (!response.ok) throw new LimitsAdapterError("protocol-error");

    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_BUFFER_BYTES) throw new LimitsAdapterError("protocol-error");
    return JSON.parse(body) as unknown;
  } catch (error) {
    if (error instanceof LimitsAdapterError) throw error;
    if (controller.signal.aborted) throw new LimitsAdapterError("timeout");
    throw new LimitsAdapterError("protocol-error");
  } finally {
    clearTimeout(timer);
  }
}

function cleanSecret(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function availableCli(
  registry: ProviderCliRegistry,
  provider: LimitProviderId
): AvailableProviderCli | null {
  const resolution = registry.get(provider);
  return resolution.state === "available" ? resolution : null;
}

class KimiWebUsageClient {
  private readonly cli: AvailableProviderCli | null;
  /** Set over the inherited environment (an additional home's data root). */
  private readonly environment: Readonly<Record<string, string>>;
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private baseUrl: string | null = null;
  private token: string | null = null;
  private buffer = "";
  private disposed = false;

  constructor(cli: AvailableProviderCli | null, environment: Readonly<Record<string, string>> = {}) {
    this.cli = cli;
    this.environment = environment;
  }

  async readUsage(): Promise<unknown> {
    await this.ensureConnected();
    if (!this.baseUrl || !this.token) throw new LimitsAdapterError("protocol-error");
    try {
      return await fetchUsageJson(`${this.baseUrl}/api/v1/oauth/usage`, this.token);
    } catch (error) {
      this.resetConnection();
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopChild();
  }

  private ensureConnected(): Promise<void> {
    if (this.disposed) return Promise.reject(new LimitsAdapterError("protocol-error"));
    if (this.ready) return this.ready;
    this.ready = this.startChild().catch((error: unknown) => {
      this.resetConnection();
      throw error;
    });
    return this.ready;
  }

  private async startChild(): Promise<void> {
    if (!this.cli) throw new LimitsAdapterError("cli-not-found");
    const port = await reserveLoopbackPort();
    // dispose() during the await found no child to stop; starting one now would
    // leave `kimi web` (a local server with a token in its URL) running.
    if (this.disposed) throw new LimitsAdapterError("protocol-error");
    const launch = providerChildProcessLaunch(
      this.cli,
      ["web", "--no-open", "--port", String(port), "--log-level", "silent"]
    );
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.command, launch.args, {
        shell: false,
        env: { ...process.env, ...launch.environment, ...this.environment },
        stdio: ["pipe", "pipe", "pipe"],
        ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
      });
    } catch {
      throw new LimitsAdapterError("cli-not-found");
    }

    this.child = child;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stderr.resume();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new LimitsAdapterError("timeout"));
      }, REQUEST_TIMEOUT_MS);
      timer.unref();

      const cleanup = (): void => {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("error", onError);
        child.off("close", onClose);
      };
      const fail = (reason: LimitUnavailableReason): void => {
        cleanup();
        reject(new LimitsAdapterError(reason));
      };
      const onError = (error: NodeJS.ErrnoException): void => fail(error.code === "ENOENT" ? "cli-not-found" : "protocol-error");
      const onClose = (): void => fail("protocol-error");
      const onData = (chunk: string): void => {
        this.buffer += chunk;
        if (Buffer.byteLength(this.buffer) > MAX_BUFFER_BYTES) {
          fail("protocol-error");
          return;
        }
        const match = this.buffer.match(/Local:\s+(http:\/\/127\.0\.0\.1:\d+)\/#token=([A-Za-z0-9_-]+)/);
        if (!match) return;
        this.baseUrl = match[1];
        this.token = match[2];
        this.buffer = "";
        cleanup();
        resolve();
      };

      child.stdout.on("data", onData);
      child.once("error", onError);
      child.once("close", onClose);
    });

    child.once("error", () => this.resetConnection());
    child.once("close", () => this.resetConnection());
  }

  private resetConnection(): void {
    this.ready = null;
    this.baseUrl = null;
    this.token = null;
    this.stopChild();
  }

  private stopChild(): void {
    const child = this.child;
    this.child = null;
    this.buffer = "";
    if (!child) return;
    child.removeAllListeners();
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    try {
      child.stdin.end();
      child.kill();
    } catch {
      // The local provider process may already be gone.
    }
  }
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", () => reject(new LimitsAdapterError("protocol-error")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new LimitsAdapterError("protocol-error"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(new LimitsAdapterError("protocol-error"));
        else resolve(port);
      });
    });
  });
}

class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private disposed = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly cli: AvailableProviderCli | null;
  private readonly clientVersion: string;
  private readonly idleMs: number;
  /** Set over the inherited environment (an additional home's CODEX_HOME). */
  private readonly environment: Readonly<Record<string, string>>;

  constructor(cli: AvailableProviderCli | null, clientVersion: string, idleMs: number, environment: Readonly<Record<string, string>> = {}) {
    this.cli = cli;
    this.clientVersion = clientVersion;
    this.idleMs = idleMs;
    this.environment = environment;
  }

  async readRateLimits(): Promise<unknown> {
    this.clearIdleTimer();
    try {
      await this.ensureConnected();
      const auth = await this.request("account/read", { refreshToken: false });
      if (!isRecord(auth) || typeof auth.requiresOpenaiAuth !== "boolean"
        || !(auth.account === null || isRecord(auth.account) && typeof auth.account.type === "string")) {
        throw new LimitsAdapterError("protocol-error");
      }
      if (!auth.requiresOpenaiAuth || isRecord(auth.account) && auth.account.type === "apiKey") {
        throw new LimitsAdapterError("api-profile");
      }
      if (auth.account === null) throw new LimitsAdapterError("not-authenticated");
      return await this.request("account/rateLimits/read");
    } finally {
      this.scheduleIdleStop();
    }
  }

  /** Drops the current app-server so the next read starts one with the current login. */
  restart(): void {
    if (this.disposed) return;
    this.resetConnection();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIdleTimer();
    this.rejectPending("protocol-error");
    this.stopChild();
  }

  /** Stops the app-server once no read came for `idleMs`; the next read starts it again. */
  private scheduleIdleStop(): void {
    this.clearIdleTimer();
    if (this.disposed || !this.child || this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size === 0) this.resetConnection();
    }, this.idleMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private ensureConnected(): Promise<void> {
    if (this.disposed) return Promise.reject(new LimitsAdapterError("protocol-error"));
    if (this.ready) return this.ready;

    this.startChild();
    this.ready = this.request("initialize", {
      clientInfo: { name: "canvastty", version: this.clientVersion }
    }).then(() => {
      this.notify("initialized", {});
    }).catch((error: unknown) => {
      this.resetConnection();
      throw error;
    });
    return this.ready;
  }

  private startChild(): void {
    if (!this.cli) throw new LimitsAdapterError("cli-not-found");
    const launch = providerChildProcessLaunch(
      this.cli,
      ["app-server", "--listen", "stdio://"]
    );
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.command, launch.args, {
        shell: false,
        env: { ...process.env, ...launch.environment, ...this.environment },
        stdio: ["pipe", "pipe", "pipe"],
        ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
      });
    } catch {
      throw new LimitsAdapterError("cli-not-found");
    }

    this.child = child;
    const lines = new NdjsonLineReader({ maxLineBytes: MAX_LINE_BYTES });
    child.stdout.on("data", (chunk: Buffer) => this.consume(child, lines, chunk));
    child.stdin.on("error", () => this.connectionFailed("protocol-error", child));
    child.stderr.resume();
    child.once("error", (error: NodeJS.ErrnoException) => {
      this.connectionFailed(error.code === "ENOENT" ? "cli-not-found" : "protocol-error", child);
    });
    child.once("close", () => this.connectionFailed("protocol-error", child));
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const child = this.child;
    if (!child || !child.stdin.writable || this.disposed) {
      return Promise.reject(new LimitsAdapterError("protocol-error"));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LimitsAdapterError("timeout"));
        this.resetConnection();
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });

      if (!this.write({ id, method, ...(params === undefined ? {} : { params }) })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new LimitsAdapterError("protocol-error"));
        this.resetConnection();
      }
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.write({ method, params })) {
      throw new LimitsAdapterError("protocol-error");
    }
  }

  private write(message: object): boolean {
    const child = this.child;
    if (!child || !child.stdin.writable || this.disposed) return false;
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return false;
    try {
      child.stdin.write(line);
      return true;
    } catch {
      return false;
    }
  }

  private consume(child: ChildProcessWithoutNullStreams, lines: NdjsonLineReader, chunk: Buffer): void {
    if (this.disposed || child !== this.child) return;
    let complete: Buffer[];
    try {
      complete = lines.push(chunk);
    } catch {
      this.connectionFailed("protocol-error", child);
      return;
    }
    for (const raw of complete) {
      if (child !== this.child) return;
      const line = raw.toString("utf8").trim();
      if (line) this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      this.connectionFailed("protocol-error", this.child);
      return;
    }

    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if (message.error !== undefined) {
      pending.reject(new LimitsAdapterError("protocol-error"));
      return;
    }
    pending.resolve(message.result);
  }

  private connectionFailed(reason: LimitUnavailableReason, child: ChildProcessWithoutNullStreams | null): void {
    if (child && child !== this.child) return;
    this.rejectPending(reason);
    this.resetConnection();
  }

  private rejectPending(reason: LimitUnavailableReason): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new LimitsAdapterError(reason));
    }
    this.pending.clear();
  }

  private resetConnection(): void {
    this.ready = null;
    this.rejectPending("protocol-error");
    this.stopChild();
  }

  private stopChild(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;

    child.removeAllListeners("error");
    child.removeAllListeners("close");
    child.stdout.removeAllListeners("data");
    try {
      child.stdin.end();
      child.kill();
    } catch {
      // The process may already be gone.
    }

    if (child.exitCode === null && child.signalCode === null) {
      const hardKillTimer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        } catch {
          // Best-effort hardening during shutdown.
        }
      }, 500);
      hardKillTimer.unref();
    }
  }
}

class LimitsAdapterError extends Error {
  readonly reason: LimitUnavailableReason;

  constructor(reason: LimitUnavailableReason) {
    super(reason);
    this.reason = reason;
  }
}

function adapterReason(error: unknown): LimitUnavailableReason {
  return error instanceof LimitsAdapterError ? error.reason : "protocol-error";
}

function unavailable(
  provider: LimitProviderId,
  source: LimitSource,
  reason: LimitUnavailableReason,
  checkedAt: number
): ProviderLimitsSnapshot {
  return { provider, state: "unavailable", source, checkedAt, reason };
}

export function normalizeOpenCodeGoLimits(raw: unknown): LimitWindow[] {
  if (!isRecord(raw) || !isRecord(raw.usage)) throw new LimitsAdapterError("protocol-error");
  const usage = raw.usage;
  const definitions: Array<{
    key: "rolling" | "weekly" | "monthly";
    slot: "primary" | "secondary";
    label: string;
    windowMinutes: number | null;
  }> = [
    { key: "rolling", slot: "primary", label: "5h", windowMinutes: 300 },
    { key: "weekly", slot: "secondary", label: "7d", windowMinutes: 10_080 },
    { key: "monthly", slot: "secondary", label: "monthly", windowMinutes: null }
  ];

  return definitions.flatMap(({ key, slot, label, windowMinutes }) => {
    const candidate = usage[key];
    if (!isRecord(candidate)) return [];
    const usedPercent = numericValue(candidate.percent);
    const resetsAt = epochMilliseconds(candidate.resetsAt);
    if (usedPercent === null && resetsAt === null) return [];
    return [{
      id: `opencode-go:${key}`,
      bucketId: "opencode-go",
      slot,
      isDefaultBucket: true,
      label,
      usedPercent: usedPercent === null ? null : clampPercent(usedPercent),
      used: null,
      limit: null,
      windowMinutes,
      resetsAt
    }];
  });
}

export function normalizeGrokLimits(raw: unknown): LimitWindow[] {
  if (!isRecord(raw)) throw new LimitsAdapterError("protocol-error");
  const config = isRecord(raw.config) ? raw.config : raw;
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : {};
  const usedPercent = numericValue(config.creditUsagePercent);
  const startsAt = epochMilliseconds(period.start ?? config.billingPeriodStart);
  const resetsAt = epochMilliseconds(period.end ?? config.billingPeriodEnd);
  if (usedPercent === null && resetsAt === null) return [];

  const rawWindowMinutes = startsAt !== null && resetsAt !== null
    ? Math.round((resetsAt - startsAt) / 60_000)
    : null;
  const windowMinutes = rawWindowMinutes !== null && rawWindowMinutes > 0 ? rawWindowMinutes : null;
  const periodType = typeof period.type === "string" ? period.type.toLowerCase() : "period";
  const isWeekly = periodType.includes("week") || windowMinutes === 10_080;

  return [{
    id: isWeekly ? "grok:weekly" : `grok:${cleanId(periodType) ?? "period"}`,
    bucketId: "grok",
    slot: "secondary",
    isDefaultBucket: true,
    label: windowMinutes === null ? null : formatWindowLabel(windowMinutes),
    usedPercent: usedPercent === null ? null : clampPercent(usedPercent),
    used: null,
    limit: null,
    windowMinutes,
    resetsAt
  }];
}

export function normalizeClaudeLimits(raw: unknown): LimitWindow[] {
  if (!isRecord(raw)) throw new LimitsAdapterError("protocol-error");
  const source = isRecord(raw.rate_limits) ? raw.rate_limits : raw;
  const definitions: Array<{
    key: string;
    slot: "primary" | "secondary";
    label: string;
    windowMinutes: number;
  }> = [
    { key: "five_hour", slot: "primary", label: "5h", windowMinutes: 300 },
    { key: "seven_day", slot: "secondary", label: "7d", windowMinutes: 10_080 }
  ];

  return definitions.flatMap(({ key, slot, label, windowMinutes }) => {
    const candidate = source[key];
    if (!isRecord(candidate)) return [];
    const usedPercent = numericValue(candidate.used_percentage) ?? numericValue(candidate.utilization);
    const resetsAt = epochMilliseconds(candidate.resets_at);
    if (usedPercent === null && resetsAt === null) return [];
    return [{
      id: `claude:${key}`,
      bucketId: "claude",
      slot,
      isDefaultBucket: true,
      label,
      usedPercent: usedPercent === null ? null : clampPercent(usedPercent),
      used: null,
      limit: null,
      windowMinutes,
      resetsAt
    }];
  });

}

export function normalizeKimiLimits(raw: unknown): LimitWindow[] {
  if (!isRecord(raw)) throw new LimitsAdapterError("protocol-error");
  const payload = isRecord(raw.data) ? raw.data : raw;
  if (payload.kind === "error") {
    const message = typeof payload.message === "string" ? payload.message.toLowerCase() : "";
    throw new LimitsAdapterError(
      message.includes("auth") || message.includes("login")
        ? "not-authenticated"
        : message.includes("timed out")
          ? "timeout"
          : "protocol-error"
    );
  }
  const windows: LimitWindow[] = [];
  const managedSummary = payload.summary;
  if (isRecord(managedSummary) && isRecord(managedSummary.window)) {
    const windowMinutes = durationToMinutes(
      positiveNumericValue(managedSummary.window.duration),
      managedSummary.window.unit
    );
    const limit = positiveNumericValue(managedSummary.limit);
    const used = numericValue(managedSummary.used);
    const resetsAt = epochMilliseconds(managedSummary.reset_at);
    if (windowMinutes !== null && (limit !== null || used !== null || resetsAt !== null)) {
      windows.push({
        id: windowMinutes >= 10_080 ? "kimi:weekly" : `kimi:managed:${windowMinutes}`,
        bucketId: "kimi",
        slot: windowMinutes >= 10_080 ? "secondary" : "primary",
        isDefaultBucket: true,
        label: formatWindowLabel(windowMinutes),
        usedPercent: usagePercent(used, limit),
        used,
        limit,
        windowMinutes,
        resetsAt
      });
    }
  }

  const weekly = payload.usage;
  if (isRecord(weekly)) {
    const limit = positiveNumericValue(weekly.limit);
    const used = numericValue(weekly.used);
    const resetsAt = epochMilliseconds(weekly.resetTime);
    if (limit !== null || used !== null || resetsAt !== null) {
      windows.push({
        id: "kimi:weekly",
        bucketId: "kimi",
        slot: "secondary",
        isDefaultBucket: true,
        label: "7d",
        usedPercent: usagePercent(used, limit),
        used,
        limit,
        windowMinutes: 10_080,
        resetsAt
      });
    }
  }

  if (Array.isArray(payload.limits)) {
    for (const [index, candidate] of payload.limits.entries()) {
      if (!isRecord(candidate) || !isRecord(candidate.window)) continue;
      const duration = positiveNumericValue(candidate.window.duration);
      const windowMinutes = durationToMinutes(duration, candidate.window.timeUnit ?? candidate.window.unit);
      const detail = isRecord(candidate.detail) ? candidate.detail : candidate;
      const limit = positiveNumericValue(detail.limit);
      const remaining = numericValue(detail.remaining);
      const explicitUsed = numericValue(detail.used);
      const used = explicitUsed ?? (limit !== null && remaining !== null ? Math.max(0, limit - remaining) : null);
      const resetsAt = epochMilliseconds(detail.resetTime ?? detail.reset_at);
      if (windowMinutes === null || (limit === null && used === null && resetsAt === null)) continue;
      windows.push({
        id: `kimi:rolling:${windowMinutes}:${index}`,
        bucketId: "kimi",
        slot: "primary",
        isDefaultBucket: true,
        label: formatWindowLabel(windowMinutes),
        usedPercent: usagePercent(used, limit),
        used,
        limit,
        windowMinutes,
        resetsAt
      });
      if (windows.length >= MAX_WINDOWS) break;
    }
  }

  const managedUsages = isRecord(payload.quota) && isRecord(payload.quota.usages) ? payload.quota.usages : null;
  if (managedUsages) {
    const definitions: Array<{
      key: "limit5h" | "limit7d" | "monthTotal";
      id: string;
      slot: "primary" | "secondary";
      label: string;
      windowMinutes: number | null;
    }> = [
      { key: "limit5h", id: "kimi:managed:300", slot: "primary", label: "5h", windowMinutes: 300 },
      { key: "limit7d", id: "kimi:weekly", slot: "secondary", label: "7d", windowMinutes: 10_080 },
      { key: "monthTotal", id: "kimi:monthly", slot: "secondary", label: "monthly", windowMinutes: null }
    ];
    for (const { key, id, slot, label, windowMinutes } of definitions) {
      const candidate = managedUsages[key];
      if (!isRecord(candidate)) continue;
      const usedRatio = numericValue(candidate.usedRatio);
      const resetsAt = epochMilliseconds(candidate.resetAt);
      if (usedRatio === null && resetsAt === null) continue;
      windows.push({
        id,
        bucketId: "kimi",
        slot,
        isDefaultBucket: true,
        label,
        usedPercent: usedRatio === null ? null : clampPercent(usedRatio * 100),
        used: null,
        limit: null,
        windowMinutes,
        resetsAt
      });
    }
  }

  return windows.slice(0, MAX_WINDOWS);
}

export function normalizeCodexLimits(raw: unknown): LimitWindow[] {
  if (!isRecord(raw)) throw new LimitsAdapterError("protocol-error");
  const hasRateLimits = Object.prototype.hasOwnProperty.call(raw, "rateLimits");
  const hasRateLimitsMap = Object.prototype.hasOwnProperty.call(raw, "rateLimitsByLimitId");
  if (!hasRateLimits && !hasRateLimitsMap) throw new LimitsAdapterError("protocol-error");

  const snapshots = new Map<string, RawLimitBucket>();
  addSnapshot(snapshots, raw.rateLimits, "codex", true);
  if (isRecord(raw.rateLimitsByLimitId)) {
    for (const [key, value] of Object.entries(raw.rateLimitsByLimitId)) {
      addSnapshot(snapshots, value, key, false);
    }
  }

  const windows: LimitWindow[] = [];
  for (const [limitId, bucket] of snapshots) {
    const { snapshot, isDefaultBucket } = bucket;
    const label = cleanLabel(snapshot.limitName);
    const primary = normalizeWindow(snapshot.primary, limitId, "primary", label, isDefaultBucket);
    const secondary = normalizeWindow(snapshot.secondary, limitId, "secondary", label, isDefaultBucket);
    if (primary) windows.push(primary);
    if (secondary) windows.push(secondary);
    if (windows.length >= MAX_WINDOWS) break;
  }
  return windows.slice(0, MAX_WINDOWS);
}

function addSnapshot(
  snapshots: Map<string, RawLimitBucket>,
  candidate: unknown,
  fallbackId: string,
  isDefaultBucket: boolean
): void {
  if (!isRecord(candidate)) return;
  const id = cleanId(candidate.limitId) ?? cleanId(fallbackId);
  if (!id || snapshots.has(id)) return;
  snapshots.set(id, { snapshot: candidate, isDefaultBucket });
}

function normalizeWindow(
  raw: unknown,
  bucketId: string,
  slot: "primary" | "secondary",
  label: string | null,
  isDefaultBucket: boolean
): LimitWindow | null {
  if (!isRecord(raw)) return null;
  const usedPercent = finiteNumber(raw.usedPercent);
  const windowMinutes = positiveNumber(raw.windowDurationMins);
  const resetsAt = epochMilliseconds(raw.resetsAt);
  if (usedPercent === null && windowMinutes === null && resetsAt === null) return null;

  return {
    id: `${bucketId}:${slot}`,
    bucketId,
    slot,
    isDefaultBucket,
    label,
    usedPercent: usedPercent === null ? null : Math.min(100, Math.max(0, usedPercent)),
    used: null,
    limit: null,
    windowMinutes,
    resetsAt
  };
}

function cleanId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80);
  return cleaned || null;
}

function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
  return cleaned || null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumericValue(value: unknown): number | null {
  const number = numericValue(value);
  return number !== null && number > 0 ? number : null;
}

function positiveNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function epochMilliseconds(value: unknown): number | null {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  const number = finiteNumber(value);
  if (number === null || number <= 0) return null;
  const milliseconds = number < 1_000_000_000_000 ? number * 1_000 : number;
  return Number.isSafeInteger(Math.trunc(milliseconds)) ? Math.trunc(milliseconds) : null;
}

function hasExpired(value: unknown): boolean {
  const expiresAt = epochMilliseconds(value);
  return expiresAt !== null && expiresAt <= Date.now();
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function usagePercent(used: number | null, limit: number | null): number | null {
  if (used === null || limit === null || limit <= 0) return null;
  return clampPercent((used / limit) * 100);
}

function durationToMinutes(duration: number | null, unit: unknown): number | null {
  if (duration === null || typeof unit !== "string") return null;
  const normalizedUnit = unit.toLowerCase();
  const multiplier = unit === "TIME_UNIT_MINUTE" || normalizedUnit === "minute"
    ? 1
    : unit === "TIME_UNIT_HOUR" || normalizedUnit === "hour"
      ? 60
      : unit === "TIME_UNIT_DAY" || normalizedUnit === "day"
        ? 1_440
        : unit === "TIME_UNIT_WEEK" || normalizedUnit === "week"
          ? 10_080
          : null;
  return multiplier === null ? null : duration * multiplier;
}

function formatWindowLabel(windowMinutes: number): string {
  if (windowMinutes % 10_080 === 0) return `${windowMinutes / 10_080}w`;
  if (windowMinutes % 1_440 === 0) return `${windowMinutes / 1_440}d`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
  return `${windowMinutes}m`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
