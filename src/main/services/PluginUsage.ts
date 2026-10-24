import type { PluginPermission, ProviderId, SessionEvent, SessionRemovedEvent, TerminalDataEvent } from "../../shared/contracts.ts";
import { IPC } from "../../shared/contracts.ts";
import type { UsageCollectionHealth, UsageEvent } from "../../shared/usageHistory.ts";
import type { Source } from "./LocalUsageCollector.ts";
import { MAX_PLUGIN_HOMES, validatePluginHome } from "./pluginHomes.ts";

/** What usage answers need about a card (TerminalManager.usageContext): no text, no paths. */
export interface CardUsageContext {
  id: string;
  provider: ProviderId;
  /** The provider conversation the card is attached to, as the card records it. */
  threadId?: string;
  /** Plugins whose launch options the card's launches carry (the card's saved `options`). */
  contributors: string[];
  /** The plugin that started the card with `sessions.create`. */
  owner: string | null;
}

/** The part of UsageHistoryService plugin usage reads; nothing is copied or changed. */
export interface PluginUsageHistory {
  peek(): { startedAt: number; collectedAt: number; events: readonly UsageEvent[]; health: readonly UsageCollectionHealth[] };
}

/** One account home's reader: LocalUsageCollector with `only`. */
export interface PluginHomeCollector {
  collect(now: number): Promise<{ events: UsageEvent[]; complete: boolean; lost: boolean }>;
}

export interface PluginUsageDependencies {
  /** Core's usage history; null until it has loaded. */
  history(): PluginUsageHistory | null;
  cards: {
    usageContext(id: string): CardUsageContext | null;
    usageContexts(): CardUsageContext[];
  };
  /**
   * The plugin is installed and enabled and its active manifest has the permission, asked of the host's registry at
   * the moment of the call (not of the service's start-time spec).
   */
  allowed(pluginId: string, permission: PluginPermission): boolean;
  /** A reader of one account home's logs; `home` is its canonical path. */
  homeCollector(source: Source, home: string): PluginHomeCollector;
  now?: () => number;
  /** Minimum time between two reads of one account home (default 60 s, as core's own collection). */
  homeIntervalMs?: number;
}

export type UsageGroupKey = "provider" | "model" | "home";

export interface UsageCounts {
  /** Prompt tokens, cached ones included. */
  input: number;
  /** Output tokens, reasoning included. */
  output: number;
  /** The cache-read part of `input`. */
  cached: number;
  /** Usage records (one per model response, or one per counter change for Hermes). */
  events: number;
  /**
   * Sum of the agents' own price estimates in USD (OpenCode's `cost`) over the records that carry one; absent when none
   * does. An estimate from the agent's model list, not a bill: subscription use and other agents have none.
   */
  providerCostEstimate?: number;
}

export interface UsageCoverage {
  /** When core's history last collected; 0 before its first collection. */
  collectedAt: number;
  /** Every collection over the period read every source to its end; false means the numbers may be low. */
  complete: boolean;
}

export type UsageSessionAnswer =
  | {
    cardId: string;
    provider: ProviderId;
    measured: true;
    totals: UsageCounts;
    /** Per model; `model` is null where the log named none. */
    models: Array<UsageCounts & { model: string | null }>;
    firstAt: number | null;
    lastAt: number | null;
    coverage: UsageCoverage;
  }
  | {
    cardId: string;
    provider: ProviderId;
    measured: false;
    /** `provider-not-recorded`: no usage log of this agent is read. `conversation-unknown`: the card has no conversation id yet. */
    reason: "provider-not-recorded" | "conversation-unknown";
  };

export interface UsageSummaryRow extends UsageCounts {
  provider?: string;
  model?: string | null;
  /** Index into the request's `homes`; null for core's history (the person's default homes). */
  home?: number | null;
  /** Distinct conversations. */
  sessions: number;
}

export interface UsageSummaryAnswer {
  since: number;
  until: number;
  groupBy: UsageGroupKey[];
  totals: UsageCounts & { sessions: number };
  rows: UsageSummaryRow[];
  /** More groups than MAX_ROWS: the smallest were left out (totals still count them). */
  truncated: boolean;
  coverage: UsageCoverage;
}

const DAY_MS = 86_400_000;
const RETENTION_MS = 30 * DAY_MS;
const DEFAULT_HOME_INTERVAL_MS = 60_000;
/** Calls one plugin may make per minute, both methods together. */
export const USAGE_CALLS_PER_MINUTE = 30;
/** Account homes in one call. */
export const MAX_HOMES_PER_CALL = 8;
/** Rows in a summary, and models in a session answer. */
export const MAX_ROWS = 256;
/** Home reads running at once, across all plugins. */
const MAX_CONCURRENT_HOME_READS = 2;
/** Homes whose records stay in memory (the least recently used is forgotten and read again from the start). */
const MAX_CACHED_HOMES = 64;
/** Records one home keeps; older ones are dropped and that home's answers say incomplete. */
const MAX_HOME_EVENTS = 100_000;
/** Closed cards remembered for this app run, so usage can still be read after a card was closed. */
const MAX_CLOSED_CARDS = 1_000;
const MAX_CARD_ID = 128;
/** Conversations remembered per card (resumes and restarts). */
const MAX_THREADS_PER_CARD = 16;
/** Providers whose usage logs core reads. */
const RECORDED: ReadonlySet<string> = new Set(["claude", "codex", "hermes", "opencode", "qwen", "kimi"]);
const HOME_SOURCES: ReadonlySet<string> = new Set(["claude", "codex", "opencode", "qwen", "kimi"]);
export const UNKNOWN_CARD = "The card is not one this plugin launched or contributed to.";

interface Tracked {
  context: CardUsageContext;
  /** Lower-case conversation ids, oldest first, at most MAX_THREADS_PER_CARD. */
  threads: string[];
}

interface HomeRequest {
  source: Source;
  home: string;
  canonical: string;
}

interface HomeRecords {
  collector: PluginHomeCollector;
  events: Map<string, UsageEvent>;
  readAt: number;
  complete: boolean;
  reading: Promise<void> | null;
}

/**
 * Measured token usage for plugin services (`usage.session`, `usage.summary`, behind `usage:read`). It answers from
 * core's usage history (UsageHistoryService, read by its own 60 s collection; nothing is collected for a call) and,
 * with `launch:contribute` too, from account homes in the calling plugin's own data folder, which this reads with the
 * same log readers, limited to that one folder.
 *
 * Scope: a plugin sees the conversations of cards it started (`sessions.create`) or whose launches carry its launch
 * options, and everything in the account homes it names. Answers are counts only: no prompt, no path, no account or
 * conversation id.
 */
export class PluginUsage {
  private readonly deps: PluginUsageDependencies;
  private readonly now: () => number;
  private readonly homeIntervalMs: number;
  /**
   * Cards some plugin may read: the last context and every conversation the card was attached to in this run (a
   * resume or restart can move it to a new one), so earlier conversations and closed cards stay readable.
   */
  private readonly known = new Map<string, Tracked>();
  private readonly closed = new Map<string, Tracked>();
  private readonly calls = new Map<string, number[]>();
  private readonly pluginHomes = new Map<string, Map<string, HomeRequest>>();
  private readonly homes = new Map<string, HomeRecords>();
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(deps: PluginUsageDependencies) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.homeIntervalMs = deps.homeIntervalMs ?? DEFAULT_HOME_INTERVAL_MS;
  }

  /**
   * A service's `usage.*` call; undefined for a method this does not know. `permissions` are the service's active
   * manifest permissions and `dataDir` its plugin data folder, both from the host's record of the service.
   */
  handle(pluginId: string, method: string, params: unknown, permissions: readonly PluginPermission[], dataDir: string): unknown {
    if (method !== "usage.session" && method !== "usage.summary") return undefined;
    const values = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
    const need = (permission: PluginPermission): void => {
      if (!permissions.includes(permission) || !this.deps.allowed(pluginId, permission)) {
        throw new Error(`Plugin does not have the ${permission} permission.`);
      }
    };
    need("usage:read");
    let homes: HomeRequest[] = [];
    if (values.homes !== undefined) {
      need("launch:contribute");
      homes = this.homeRequests(pluginId, values.homes, dataDir);
    }
    this.count(pluginId);
    return method === "usage.session" ? this.session(pluginId, values, homes) : this.summary(pluginId, values, homes);
  }

  /** Fed every terminal manager event, like the other in-process observers. */
  observe(channel: string, payload: SessionEvent | SessionRemovedEvent | TerminalDataEvent): void {
    if (channel === IPC.terminalRemoved && "id" in payload && !("data" in payload)) {
      const last = this.known.get(payload.id);
      this.known.delete(payload.id);
      if (!last) return;
      this.closed.delete(payload.id);
      this.closed.set(payload.id, last);
      while (this.closed.size > MAX_CLOSED_CARDS) this.closed.delete(this.closed.keys().next().value!);
      return;
    }
    if (channel !== IPC.terminalSession || !("session" in payload)) return;
    const context = this.deps.cards.usageContext(payload.session.id);
    if (!context || (!context.owner && context.contributors.length === 0)) return;
    this.known.set(context.id, { context, threads: withThread(this.known.get(context.id)?.threads ?? [], context.threadId) });
  }

  /** A card with every conversation it had in this run, live or closed; undefined when unknown. */
  private tracked(id: string): Tracked | undefined {
    const live = this.deps.cards.usageContext(id);
    const tracked = this.known.get(id) ?? this.closed.get(id);
    if (!live) return tracked;
    return { context: live, threads: withThread(tracked?.threads ?? [], live.threadId) };
  }

  private card(pluginId: string, cardId: unknown): Tracked {
    if (typeof cardId !== "string" || cardId.length === 0 || cardId.length > MAX_CARD_ID) throw new Error(UNKNOWN_CARD);
    const tracked = this.tracked(cardId);
    if (!tracked || !owns(pluginId, tracked.context)) throw new Error(UNKNOWN_CARD);
    return tracked;
  }

  private async session(pluginId: string, values: Record<string, unknown>, homes: HomeRequest[]): Promise<UsageSessionAnswer> {
    const { context: card, threads } = this.card(pluginId, values.cardId);
    const base = { cardId: card.id, provider: card.provider };
    if (!RECORDED.has(card.provider)) return { ...base, measured: false, reason: "provider-not-recorded" };
    if (threads.length === 0) return { ...base, measured: false, reason: "conversation-unknown" };
    const homeRecords = await this.readHomes(homes);
    const history = this.history();
    const seen = new Set<string>();
    const models = new Map<string, UsageCounts & { model: string | null }>();
    const totals = emptyCounts();
    let firstAt: number | null = null;
    let lastAt: number | null = null;
    const take = (event: UsageEvent): void => {
      if (seen.has(event.id) || !threads.includes(event.session.toLowerCase()) || !sameAgent(event, card.provider)) return;
      seen.add(event.id);
      add(totals, event);
      const model = event.model ?? null;
      const key = model ?? "";
      const row = models.get(key) ?? { model, ...emptyCounts() };
      add(row, event);
      models.set(key, row);
      firstAt = firstAt === null ? event.from : Math.min(firstAt, event.from);
      lastAt = lastAt === null ? event.to : Math.max(lastAt, event.to);
    };
    for (const event of history.events) take(event);
    for (const records of homeRecords) for (const event of records.events.values()) take(event);
    const since = firstAt ?? history.startedAt;
    return {
      ...base,
      measured: true,
      totals,
      models: [...models.values()].sort(bySize).slice(0, MAX_ROWS),
      firstAt,
      lastAt,
      coverage: this.coverage(history, since, this.now(), homeRecords)
    };
  }

  private async summary(pluginId: string, values: Record<string, unknown>, homes: HomeRequest[]): Promise<UsageSummaryAnswer> {
    const now = this.now();
    const until = values.until === undefined ? now : time(values.until, "until");
    const since = values.since === undefined ? until - DAY_MS : time(values.since, "since");
    if (since >= until) throw new Error("usage.summary since must be before until.");
    if (until - since > RETENTION_MS) throw new Error("usage.summary covers at most 30 days.");
    const groupBy = groups(values.groupBy);
    const homeRecords = await this.readHomes(homes);
    const history = this.history();

    // Conversations of the cards this plugin may read, by conversation id.
    const threads = new Map<string, ProviderId[]>();
    const ids = new Set([...this.closed.keys(), ...this.known.keys(), ...this.deps.cards.usageContexts().map((context) => context.id)]);
    for (const id of ids) {
      const tracked = this.tracked(id);
      if (!tracked || !owns(pluginId, tracked.context) || !RECORDED.has(tracked.context.provider)) continue;
      for (const thread of tracked.threads) threads.set(thread, [...threads.get(thread) ?? [], tracked.context.provider]);
    }

    const seen = new Set<string>();
    const rows = new Map<string, UsageSummaryRow & { conversations: Set<string> }>();
    const totals = emptyCounts();
    const conversations = new Set<string>();
    const take = (event: UsageEvent, home: number | null): void => {
      if (event.to < since || event.to >= until || seen.has(event.id)) return;
      seen.add(event.id);
      const conversation = `${event.app}\u0000${event.session.toLowerCase()}`;
      add(totals, event);
      conversations.add(conversation);
      const row: UsageSummaryRow = { ...emptyCounts(), sessions: 0 };
      if (groupBy.includes("provider")) row.provider = event.provider;
      if (groupBy.includes("model")) row.model = event.model ?? null;
      if (groupBy.includes("home")) row.home = home;
      const key = JSON.stringify([row.provider, row.model, row.home]);
      const entry = rows.get(key) ?? { ...row, conversations: new Set<string>() };
      add(entry, event);
      entry.conversations.add(conversation);
      rows.set(key, entry);
    };
    for (const event of history.events) {
      const providers = threads.get(event.session.toLowerCase());
      if (providers?.some((provider) => sameAgent(event, provider))) take(event, null);
    }
    // A home named twice adds nothing the second time: its records are already seen.
    homeRecords.forEach((records, index) => {
      for (const event of records.events.values()) take(event, index);
    });

    const sorted = [...rows.values()].map(({ conversations: set, ...row }) => ({ ...row, sessions: set.size })).sort(bySize);
    return {
      since,
      until,
      groupBy,
      totals: { ...totals, sessions: conversations.size },
      rows: sorted.slice(0, MAX_ROWS),
      truncated: sorted.length > MAX_ROWS,
      coverage: this.coverage(history, since, Math.min(until, now), homeRecords)
    };
  }

  private history(): ReturnType<PluginUsageHistory["peek"]> {
    const history = this.deps.history();
    if (!history) throw new Error("Usage history is not ready yet.");
    return history.peek();
  }

  private coverage(history: ReturnType<PluginUsageHistory["peek"]>, since: number, until: number, homes: HomeRecords[]): UsageCoverage {
    let complete = history.collectedAt > 0 && history.startedAt <= since && homes.every((records) => records.complete);
    if (complete) {
      for (const entry of history.health) {
        if (entry.at >= since && entry.at <= until + DEFAULT_HOME_INTERVAL_MS && !entry.complete) {
          complete = false;
          break;
        }
      }
    }
    return { collectedAt: history.collectedAt, complete };
  }

  /** Rate limit: USAGE_CALLS_PER_MINUTE per plugin over a sliding minute. */
  private count(pluginId: string): void {
    const now = this.now();
    const recent = (this.calls.get(pluginId) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= USAGE_CALLS_PER_MINUTE) {
      this.calls.set(pluginId, recent);
      const wait = Math.max(1, Math.ceil((recent[0]! + 60_000 - now) / 1000));
      throw new Error(`Usage requests are limited to ${USAGE_CALLS_PER_MINUTE} a minute; try again in ${wait} s.`);
    }
    recent.push(now);
    this.calls.set(pluginId, recent);
  }

  private homeRequests(pluginId: string, value: unknown, dataDir: string): HomeRequest[] {
    if (!Array.isArray(value) || value.length > MAX_HOMES_PER_CALL) {
      throw new Error(`usage homes must be an array of at most ${MAX_HOMES_PER_CALL} { provider, home }.`);
    }
    const known = this.pluginHomes.get(pluginId) ?? new Map<string, HomeRequest>();
    const requests: HomeRequest[] = [];
    for (const entry of value) {
      const values = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
      if (typeof values.provider !== "string" || !HOME_SOURCES.has(values.provider)) {
        throw new Error("usage homes provider must be claude, codex, opencode, qwen or kimi.");
      }
      const source = values.provider as Source;
      const { home, canonical } = validatePluginHome(dataDir, values.home);
      const key = homeKey(source, canonical);
      if (!known.has(key)) {
        if (known.size >= MAX_PLUGIN_HOMES) {
          // Homes that no longer pass the check (removed accounts) free their place.
          for (const [entryKey, request] of known) {
            try {
              validatePluginHome(dataDir, request.home);
            } catch {
              known.delete(entryKey);
            }
          }
        }
        if (known.size >= MAX_PLUGIN_HOMES) throw new Error(`A plugin can read usage for at most ${MAX_PLUGIN_HOMES} account homes.`);
        known.set(key, { source, home, canonical });
        this.pluginHomes.set(pluginId, known);
      }
      requests.push({ source, home, canonical });
    }
    return requests;
  }

  /** Each home read at most once per homeIntervalMs, single-flight, at most two at once across all plugins. */
  private async readHomes(requests: HomeRequest[]): Promise<HomeRecords[]> {
    return Promise.all(requests.map(async (request) => {
      const key = homeKey(request.source, request.canonical);
      let records = this.homes.get(key);
      if (!records) {
        records = { collector: this.deps.homeCollector(request.source, request.canonical), events: new Map(), readAt: 0, complete: false, reading: null };
        this.homes.set(key, records);
        while (this.homes.size > MAX_CACHED_HOMES) this.homes.delete(this.homes.keys().next().value!);
      } else {
        // Most recently used last.
        this.homes.delete(key);
        this.homes.set(key, records);
      }
      const current = records;
      if (!current.reading && (current.readAt === 0 || this.now() - current.readAt >= this.homeIntervalMs)) {
        current.reading = this.readHome(current).finally(() => {
          current.reading = null;
        });
      }
      if (current.reading) await current.reading;
      return current;
    }));
  }

  private async readHome(records: HomeRecords): Promise<void> {
    await this.slot();
    try {
      const now = this.now();
      let result: Awaited<ReturnType<PluginHomeCollector["collect"]>>;
      try {
        result = await records.collector.collect(now);
      } catch {
        records.readAt = now;
        records.complete = false;
        return;
      }
      for (const event of result.events) {
        const existing = records.events.get(event.id);
        records.events.set(event.id, existing ? {
          ...existing,
          from: Math.min(existing.from, event.from),
          to: Math.max(existing.to, event.to),
          input: Math.max(existing.input, event.input),
          output: Math.max(existing.output, event.output),
          cached: Math.max(existing.cached, event.cached),
          ...(existing.model ?? event.model ? { model: existing.model ?? event.model } : {})
        } : event);
      }
      let complete = result.complete && !result.lost;
      for (const [id, event] of records.events) if (event.to < now - RETENTION_MS) records.events.delete(id);
      if (records.events.size > MAX_HOME_EVENTS) {
        const oldest = [...records.events.values()].sort((left, right) => left.to - right.to).slice(0, records.events.size - MAX_HOME_EVENTS);
        for (const event of oldest) records.events.delete(event.id);
        complete = false;
      }
      records.complete = complete;
      records.readAt = now;
    } finally {
      this.release();
    }
  }

  private slot(): Promise<void> {
    if (this.running < MAX_CONCURRENT_HOME_READS) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(() => {
      this.running += 1;
      resolve();
    }));
  }

  private release(): void {
    this.running -= 1;
    this.waiting.shift()?.();
  }
}

function withThread(threads: readonly string[], threadId: string | undefined): string[] {
  const thread = threadId?.toLowerCase();
  if (!thread || threads.includes(thread)) return [...threads];
  return [...threads, thread].slice(-MAX_THREADS_PER_CARD);
}

function owns(pluginId: string, context: CardUsageContext): boolean {
  return context.owner === pluginId || context.contributors.includes(pluginId);
}

/** A usage record of the card's agent: Hermes records come from Hermes' own store, the others from the CLI's logs. */
function sameAgent(event: UsageEvent, provider: ProviderId): boolean {
  if (provider === "hermes") return event.app === "Hermes";
  return event.app !== "Hermes" && event.provider === provider;
}

function homeKey(source: Source, canonical: string): string {
  return `${source}\u0000${canonical}`;
}

function emptyCounts(): UsageCounts {
  return { input: 0, output: 0, cached: 0, events: 0 };
}

function add(counts: UsageCounts, event: UsageEvent): void {
  counts.input += event.input;
  counts.output += event.output;
  counts.cached += event.cached;
  counts.events += 1;
  if (event.providerCostEstimate !== undefined) {
    counts.providerCostEstimate = Math.round(((counts.providerCostEstimate ?? 0) + event.providerCostEstimate) * 1e6) / 1e6;
  }
}

function bySize(left: UsageCounts, right: UsageCounts): number {
  return right.input + right.output - (left.input + left.output);
}

function time(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`usage.summary ${name} must be a time in milliseconds.`);
  return value;
}

function groups(value: unknown): UsageGroupKey[] {
  const list = value === undefined ? ["provider"] : typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || list.length === 0 || list.length > 3
    || list.some((entry) => entry !== "provider" && entry !== "model" && entry !== "home")
    || new Set(list).size !== list.length) {
    throw new Error("usage.summary groupBy must be provider, model or home, or a list of them.");
  }
  return (["provider", "model", "home"] as const).filter((key) => list.includes(key));
}
