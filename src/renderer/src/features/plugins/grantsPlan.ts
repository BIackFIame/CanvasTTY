import type { InstalledPlugin, PluginBrokerAccounts } from "../../../../shared/contracts";

/**
 * `grants.request` (C2): a plugin page asks for a set of grants; CanvasTTY shows ONE dialog of its own, built from
 * its registry (never from the plugin's words, except a short quoted reason), and applies only what the person
 * ticks, through the same setters as Settings. This module holds the rules; the dialog is GrantsDialog.
 *
 * Who may ask: a page (canvas app, HOME widget, settings page) of an enabled plugin, shown in CanvasTTY's main
 * window, and only while the person is in that frame (they clicked or tabbed into it; a separate plugin window cannot
 * ask). The requester must already have its native code trusted, or ask for it as one of the items: if the person
 * does not grant it, nothing else in the request is applied.
 *
 * A fresh click is required: CanvasTTY reads its own window's transient user activation (Chromium passes a click or
 * key press inside a frame up to the frames above it, for about 5 s), which a page cannot fake, together with the
 * frame having focus. The dialog's Allow button stays disabled for 1 s after it appears and after any re-layout, so
 * a click aimed at the page cannot land on it.
 *
 * Limits: one dialog at a time in the whole app; at most 3 dialogs per plugin in 10 minutes; after the person declines
 * everything (Cancel, Escape, or nothing ticked), that plugin is refused for 60 seconds; at most 24 items. Items
 * already granted are not shown. Nothing is ever accepted without the person's click on the dialog's own button.
 */

export type GrantItem =
  | { kind: "nativeCode"; plugin: string }
  | { kind: "mayStartOrchestrators" }
  | { kind: "decisionsMayAllow" }
  | { kind: "sharedRead"; provider: string; method: string }
  | { kind: "brokerGrant"; owner: string; account: string }
  | { kind: "trustUpdates"; plugin: string };

export type GrantResult = GrantItem & { result: "granted" | "declined" | "failed" | "already"; reason?: string };

/** One row of the dialog, everything shown taken from CanvasTTY's own registry. */
export interface GrantRow {
  index: number;
  item: GrantItem;
  /** Plugin ids whose native code must be trusted (now, or by a ticked row of this dialog) for this row to apply. */
  needs: string[];
  /**
   * Ticked when the dialog opens: only the low-impact rows (the requester's own native code and shared reads, one named
   * account). High-impact rows start unticked, so the person ticks each one: another plugin's native code, may start
   * orchestrators, may allow agent actions, every account of an owner (`*`), trusting updates.
   */
  ticked: boolean;
  /** The plugin the row is about, as installed. */
  subject: InstalledPlugin;
  /** For a share: the provider; for a broker grant: the owner. */
  other?: InstalledPlugin;
  /** For a broker grant: the accounts it covers now (empty when the owner's service is not running yet). */
  accounts?: PluginBrokerAccounts["accounts"];
}

export interface GrantPlan {
  requester: InstalledPlugin;
  reason: string;
  rows: GrantRow[];
  /** Items not shown (by request position): already granted, or not possible (with why). */
  settled: Array<{ index: number; result: GrantResult }>;
}

export const GRANT_LIMITS = Object.freeze({ armMs: 1_000, maxItems: 24, perWindow: 3, windowMs: 10 * 60_000, declinedMs: 60_000, reasonChars: 200, ownerWaitMs: 10_000 });

const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9.-]{0,78}[a-z0-9])?$/u;
const SHARE_METHOD = /^[a-z][a-z0-9_]{0,31}(?:\.[a-z][a-z0-9_]{0,31}){0,3}$/u;
const ACCOUNT_ID = /^(?:\*|[a-z0-9][a-z0-9._-]{0,63})$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** The request as the page sent it, or why it is refused. Unknown kinds and keys refuse the whole request. */
export function parseGrantRequest(params: unknown): { reason: string; items: GrantItem[] } {
  if (!isRecord(params) || !onlyKeys(params, ["reason", "items"]) || !Array.isArray(params.items)) {
    throw new Error("grants.request takes { reason?, items: [...] }.");
  }
  if (params.items.length === 0 || params.items.length > GRANT_LIMITS.maxItems) throw new Error(`grants.request takes 1 to ${GRANT_LIMITS.maxItems} items.`);
  if (params.reason !== undefined && typeof params.reason !== "string") throw new Error("grants.request reason must be text.");
  // eslint-disable-next-line no-control-regex
  const reason = (params.reason ?? "").replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/gu, " ").trim().slice(0, GRANT_LIMITS.reasonChars);
  const items: GrantItem[] = [];
  const seen = new Set<string>();
  for (const raw of params.items) {
    const item = parseItem(raw);
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      items.push(item);
    }
  }
  return { reason, items };
}

function parseItem(raw: unknown): GrantItem {
  if (!isRecord(raw) || typeof raw.kind !== "string") throw new Error("Every grants.request item needs a kind.");
  const plugin = (key: string): string => {
    const value = raw[key];
    if (typeof value !== "string" || !PLUGIN_ID.test(value)) throw new Error(`grants.request item ${raw.kind as string} needs ${key}: a plugin id.`);
    return value;
  };
  switch (raw.kind) {
    case "nativeCode":
    case "trustUpdates":
      if (!onlyKeys(raw, ["kind", "plugin"])) break;
      return { kind: raw.kind, plugin: plugin("plugin") };
    case "mayStartOrchestrators":
    case "decisionsMayAllow":
      if (!onlyKeys(raw, ["kind"])) break;
      return { kind: raw.kind };
    case "sharedRead":
      if (!onlyKeys(raw, ["kind", "provider", "method"]) || typeof raw.method !== "string" || !SHARE_METHOD.test(raw.method)) break;
      return { kind: "sharedRead", provider: plugin("provider"), method: raw.method };
    case "brokerGrant":
      if (!onlyKeys(raw, ["kind", "owner", "account"]) || typeof raw.account !== "string" || !ACCOUNT_ID.test(raw.account)) break;
      return { kind: "brokerGrant", owner: plugin("owner"), account: raw.account };
    default:
      throw new Error(`grants.request does not know the item kind ${String(raw.kind).slice(0, 40)}.`);
  }
  throw new Error(`grants.request item ${raw.kind} has invalid fields.`);
}

/**
 * Turns the parsed items into dialog rows against the registry as it is now. `broker(owner)` answers the owner's
 * offer and the current grants (Settings' own call); it is asked only for owners that are trusted.
 */
export async function planGrants(
  requesterId: string,
  request: { reason: string; items: GrantItem[] },
  plugins: readonly InstalledPlugin[],
  broker: (ownerId: string) => Promise<PluginBrokerAccounts | null>
): Promise<GrantPlan> {
  const find = (id: string): InstalledPlugin | undefined => plugins.find((candidate) => candidate.manifest.id === id);
  const requester = find(requesterId);
  if (!requester || !requester.enabled) throw new Error("Only an enabled plugin may ask for grants.");
  const asksOwnTrust = request.items.some((item) => item.kind === "nativeCode" && item.plugin === requesterId);
  if (!requester.nativeCodeTrusted && !asksOwnTrust) {
    throw new Error("This plugin's native code is not trusted: ask for it first (an item { kind: \"nativeCode\", plugin: <its own id> }).");
  }
  const rows: GrantRow[] = [];
  const settled: Array<{ index: number; result: GrantResult }> = [];
  const own = (plugin: InstalledPlugin): string[] => [plugin.manifest.id];
  // Until the requester is trusted, every other row depends on it: an untrusted plugin is granted nothing.
  const withRequester = (needs: string[]): string[] => [...new Set([...(requester.nativeCodeTrusted ? [] : [requesterId]), ...needs])];
  const brokerCache = new Map<string, Promise<PluginBrokerAccounts | null>>();
  for (const [index, item] of request.items.entries()) {
    const fail = (reason: string): void => { settled.push({ index, result: { ...item, result: "failed", reason } }); };
    const already = (): void => { settled.push({ index, result: { ...item, result: "already" } }); };
    if (item.kind === "nativeCode") {
      const subject = find(item.plugin);
      if (!subject || !subject.enabled) { fail("not installed or disabled"); continue; }
      if (!subject.manifest.services?.length) { fail("has no native code"); continue; }
      if (subject.nativeCodeTrusted) { already(); continue; }
      rows.push({ index, item, needs: item.plugin === requesterId ? [] : withRequester([]), ticked: item.plugin === requesterId, subject });
    } else if (item.kind === "trustUpdates") {
      const subject = find(item.plugin);
      if (!subject || !subject.enabled || !subject.manifest.services?.length) { fail("not installed, disabled or without native code"); continue; }
      if (!subject.sourceUrl.startsWith("https://github.com/")) { fail("has no repository"); continue; }
      if (subject.trustUpdates) { already(); continue; }
      rows.push({ index, item, needs: withRequester(own(subject)), ticked: false, subject });
    } else if (item.kind === "mayStartOrchestrators") {
      if (!requester.manifest.permissions.includes("sessions:launch")) { fail("needs the sessions:launch permission"); continue; }
      if (requester.mayStartOrchestrators) { already(); continue; }
      rows.push({ index, item, needs: own(requester), ticked: false, subject: requester });
    } else if (item.kind === "decisionsMayAllow") {
      if (!requester.manifest.services?.some((service) => service.decide)) { fail("has no decision service"); continue; }
      if (requester.decisionsMayAllow) { already(); continue; }
      rows.push({ index, item, needs: own(requester), ticked: false, subject: requester });
    } else if (item.kind === "sharedRead") {
      const status = requester.sharedReads?.find((read) => read.plugin === item.provider && read.method === item.method);
      if (!status) { fail("not declared in this plugin's uses"); continue; }
      if (status.state === "not-shared") { fail("the other plugin does not share it"); continue; }
      if (status.state === "approved") { already(); continue; }
      rows.push({ index, item, needs: own(requester), ticked: true, subject: requester, other: find(item.provider) });
    } else {
      const owner = find(item.owner);
      if (!requester.manifest.permissions.includes("accounts:broker")) { fail("needs the accounts:broker permission"); continue; }
      if (!owner || !owner.enabled || !owner.manifest.services?.some((service) => service.brokerable) || item.owner === requesterId) {
        fail("the other plugin does not offer accounts"); continue;
      }
      let accounts: PluginBrokerAccounts | null = null;
      if (owner.nativeCodeTrusted) {
        if (!brokerCache.has(item.owner)) brokerCache.set(item.owner, broker(item.owner).catch(() => null));
        accounts = await brokerCache.get(item.owner)!;
      }
      const granted = item.account === "*"
        ? accounts?.allGrants?.some((entry) => entry.caller === requesterId && entry.state === "on")
          && !accounts.grants.some((entry) => entry.caller === requesterId && entry.state === "new-address")
        : accounts?.grants.some((entry) => entry.caller === requesterId && entry.account === item.account && entry.state === "granted");
      if (granted) { already(); continue; }
      if (item.account !== "*" && accounts?.available && !accounts.accounts.some((account) => account.id === item.account)) {
        fail("that account is not offered"); continue;
      }
      rows.push({
        index, item, needs: [requesterId, item.owner], ticked: item.account !== "*", subject: requester, other: owner,
        accounts: (accounts?.accounts ?? []).filter((account) => item.account === "*" || account.id === item.account)
      });
    }
  }
  return { requester, reason: request.reason, rows, settled };
}

/** Whether a row applies with these ticks: it is ticked and every plugin it needs is trusted or ticked here. */
export function rowApplies(plan: GrantPlan, ticks: readonly boolean[], row: GrantRow, plugins: readonly InstalledPlugin[]): boolean {
  if (!ticks[plan.rows.indexOf(row)]) return false;
  return row.needs.every((id) => plugins.find((plugin) => plugin.manifest.id === id)?.nativeCodeTrusted
    || plan.rows.some((other, position) => other.item.kind === "nativeCode" && other.item.plugin === id && ticks[position]));
}

/** The setters the dialog applies through: the same main-window-only calls Settings uses. */
export interface GrantSetters {
  setNativeCodeTrusted(pluginId: string, trusted: boolean): Promise<unknown>;
  setMayStartOrchestrators(pluginId: string, allowed: boolean): Promise<unknown>;
  setDecisionsMayAllow(pluginId: string, allowed: boolean): Promise<unknown>;
  setSharedReadApproved(pluginId: string, provider: string, method: string, approved: boolean): Promise<unknown>;
  setBrokerGrant(callerId: string, ownerId: string, accountId: string, granted: boolean): Promise<unknown>;
  setTrustUpdates(pluginId: string, trusted: boolean): Promise<unknown>;
  brokerAccounts(ownerId: string): Promise<PluginBrokerAccounts>;
  wait(ms: number): Promise<void>;
}

/**
 * Applies the ticked rows in dependency order (native code first, the requester before others; then the rest), each
 * through its own setter. A row whose needed native code was not granted is declined; a setter error fails only that
 * row. Returns one result per requested item, in the request's order.
 */
export async function applyGrants(plan: GrantPlan, ticks: readonly boolean[], plugins: readonly InstalledPlugin[], api: GrantSetters): Promise<GrantResult[]> {
  const results = new Map<number, GrantResult>();
  const trusted = new Set(plugins.filter((plugin) => plugin.nativeCodeTrusted).map((plugin) => plugin.manifest.id));
  const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "").slice(0, 200);
  const natives = plan.rows.filter((row) => row.item.kind === "nativeCode")
    .sort((left, right) => Number((right.item as { plugin: string }).plugin === plan.requester.manifest.id) - Number((left.item as { plugin: string }).plugin === plan.requester.manifest.id));
  const others = plan.rows.filter((row) => row.item.kind !== "nativeCode");
  for (const row of [...natives, ...others]) {
    const position = plan.rows.indexOf(row);
    if (!ticks[position]) { results.set(row.index, { ...row.item, result: "declined" }); continue; }
    const missing = row.needs.find((id) => !trusted.has(id));
    if (missing) { results.set(row.index, { ...row.item, result: "declined", reason: `needs ${missing}'s native code` }); continue; }
    try {
      const item = row.item;
      if (item.kind === "nativeCode") {
        await api.setNativeCodeTrusted(item.plugin, true);
        trusted.add(item.plugin);
      } else if (item.kind === "mayStartOrchestrators") await api.setMayStartOrchestrators(plan.requester.manifest.id, true);
      else if (item.kind === "decisionsMayAllow") await api.setDecisionsMayAllow(plan.requester.manifest.id, true);
      else if (item.kind === "sharedRead") await api.setSharedReadApproved(plan.requester.manifest.id, item.provider, item.method, true);
      else if (item.kind === "trustUpdates") await api.setTrustUpdates(item.plugin, true);
      else {
        // An owner trusted a moment ago starts its service first: wait (bounded) until it answers its offer.
        const until = Date.now() + GRANT_LIMITS.ownerWaitMs;
        while (!(await api.brokerAccounts(item.owner).catch(() => null))?.available) {
          if (Date.now() > until) throw new Error("the other plugin's service did not start in time; allow it in Settings later");
          await api.wait(250);
        }
        await api.setBrokerGrant(plan.requester.manifest.id, item.owner, item.account, true);
      }
      results.set(row.index, { ...item, result: "granted" });
    } catch (error) {
      results.set(row.index, { ...row.item, result: "failed", reason: message(error) });
    }
  }
  for (const { index, result } of plan.settled) results.set(index, result);
  return [...results.entries()].sort(([left], [right]) => left - right).map(([, result]) => result);
}

/** The answer when the person closed the dialog without allowing anything. */
export function declinedResults(plan: GrantPlan): GrantResult[] {
  const results = new Map<number, GrantResult>(plan.settled.map(({ index, result }) => [index, result]));
  for (const row of plan.rows) results.set(row.index, { ...row.item, result: "declined" });
  return [...results.entries()].sort(([left], [right]) => left - right).map(([, result]) => result);
}

/** Rate limits (module state: the dialog chunk stays loaded once used). */
export class GrantGate {
  private open = false;
  private readonly shown = new Map<string, number[]>();
  private readonly declined = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Takes the one dialog slot for this plugin, or says why not. */
  enter(pluginId: string): void {
    const now = this.now();
    if (this.open) throw new Error("Another consent dialog is open. Try again after the person closed it.");
    if ((this.declined.get(pluginId) ?? 0) > now) throw new Error("The person just declined this plugin's request. Ask again later, after their next action.");
    const recent = (this.shown.get(pluginId) ?? []).filter((at) => now - at < GRANT_LIMITS.windowMs);
    if (recent.length >= GRANT_LIMITS.perWindow) throw new Error(`At most ${GRANT_LIMITS.perWindow} consent dialogs per plugin in 10 minutes.`);
    recent.push(now);
    this.shown.set(pluginId, recent);
    this.open = true;
  }

  /** The dialog closed; `allDeclined` starts the pause for this plugin. */
  leave(pluginId: string, allDeclined: boolean): void {
    this.open = false;
    if (allDeclined) this.declined.set(pluginId, this.now() + GRANT_LIMITS.declinedMs);
  }
}
