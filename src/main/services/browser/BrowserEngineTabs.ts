import { randomUUID } from "node:crypto";
import type { AgentPresenceSnapshot, BrowserActor, BrowserTabSnapshot } from "../../../shared/contracts.ts";
import type { BrowserAutomationService } from "./BrowserAutomationService.ts";
import type { BrowserCoreTab } from "./BrowserCore.ts";
import type { EngineFallbackReason } from "./BrowserErrors.ts";
import { CdpTabDriver, type CdpSocketFactory } from "./CdpTabDriver.ts";
import { CHROMIUM_ENGINE } from "./TabDriver.ts";

/** A running, trusted plugin service that contributes a browser engine (`browser:engine`). */
export interface BrowserEngineProvider {
  pluginId: string;
  pluginName: string;
  serviceId: string;
  /** The id agents pass as `engine` to browser_new_tab. */
  engineId: string;
  title: string;
  /** The engine lays pages out for real (default false: clicks go through the DOM). */
  layout: boolean;
}

export interface BrowserEngineTabsHost {
  automation: BrowserAutomationService;
  /** Engines that may take tabs now: plugin enabled, native code trusted, service running. */
  providers(): BrowserEngineProvider[];
  /** `canvastty.browserEngine.openTab` `{ engineId, tabId }` → `{ webSocketUrl }`: a local CDP endpoint for this tab. */
  openEngineTab(provider: BrowserEngineProvider, tabId: string): Promise<unknown>;
  /** `canvastty.browserEngine.closeTab` `{ engineId, tabId }` (a notification). */
  closeEngineTab(provider: BrowserEngineProvider, tabId: string): void;
  /**
   * Opens a Chromium tab with this id at this document revision without showing it. `waitForLoad` resolves once its
   * page loaded (bounded by the host); otherwise at once.
   */
  openChromiumTab(tabId: string, url: string, revision: number, options: { waitForLoad: boolean }): Promise<void>;
  /** Something the person's tab list shows changed. */
  changed(): void;
  connect?: CdpSocketFactory;
  now?: () => number;
}

export interface EngineChoice {
  provider: BrowserEngineProvider | null;
  /** Said to the agent when it asked for an engine it does not get. */
  notice?: string;
}

interface EngineTab {
  id: string;
  provider: BrowserEngineProvider;
  driver: CdpTabDriver;
  revision: number;
  /** The last http(s) URL of the tab: what Chromium opens when the tab moves. */
  lastUrl: string;
  status: BrowserCoreTab["status"];
  /**
   * A navigation the core started (open, navigate, back/forward, reload) already advanced the revision; its commit
   * does not advance it again, so a command that raced the commit is not refused as stale.
   */
  pendingCommit: boolean;
  unlisten: () => void;
}

/** Sites remembered per app session, most recent last. */
const MAX_REMEMBERED_SITES = 200;
/** An engine that could not open a tab is skipped by `auto` for this long. */
const ENGINE_RETRY_AFTER_MS = 60_000;
/** Reasons that say something about the site itself: its next tabs go straight to Chromium. */
const SITE_REASONS = new Set<EngineFallbackReason>(["bot-wall", "thin-text", "unsupported-method", "engine-disconnected"]);
const ENGINE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export function isEngineRequest(value: unknown): value is string {
  return typeof value === "string" && (value === "auto" || ENGINE_ID.test(value));
}

/**
 * Tabs driven by plugin-contributed engines (EP: browser engines). Policy stays in the core: only an agent's new tab
 * may use one, never a tab the person opens; such a tab is never shown (showing it moves it to Chromium first); it
 * gets no cookies and no browser profile; and whenever the engine cannot serve it (a bot wall, thin text, a missing
 * CDP method, a screenshot, a crash) it moves to Chromium under the same tab id and the site is remembered for the
 * rest of the session.
 */
export class BrowserEngineTabs {
  private readonly host: BrowserEngineTabsHost;
  private readonly tabs = new Map<string, EngineTab>();
  private readonly moving = new Map<string, { promise: Promise<void>; url: string; revision: number }>();
  private readonly rememberedSites = new Map<string, EngineFallbackReason>();
  private readonly unavailableUntil = new Map<string, number>();
  private readonly now: () => number;

  constructor(host: BrowserEngineTabsHost) {
    this.host = host;
    this.now = host.now ?? Date.now;
  }

  get size(): number {
    return this.tabs.size + this.moving.size;
  }

  has(tabId: string): boolean {
    return this.tabs.has(tabId);
  }

  /** The contributed engine driving a tab, or null (Chromium or unknown). */
  engineOf(tabId: string): string | null {
    return this.tabs.get(tabId)?.provider.engineId ?? null;
  }

  coreTab(tabId: string): BrowserCoreTab | null {
    const tab = this.tabs.get(tabId);
    if (tab) return { id: tab.id, url: this.urlOf(tab), documentRevision: tab.revision, status: tab.status };
    const moving = this.moving.get(tabId);
    return moving ? { id: tabId, url: moving.url, documentRevision: moving.revision, status: "loading" } : null;
  }

  snapshots(agents: readonly AgentPresenceSnapshot[]): BrowserTabSnapshot[] {
    return [...this.tabs.values()].map((tab) => {
      const url = this.urlOf(tab);
      return {
        id: tab.id,
        url,
        title: tab.driver.title() || hostOf(url) || url,
        loading: tab.status === "loading" || tab.driver.isLoading(),
        canGoBack: false,
        canGoForward: false,
        documentRevision: tab.revision,
        status: tab.status,
        favicon: null,
        agents: agents.filter((presence) => presence.currentTabId === tab.id).map((presence) => structuredClone(presence)),
        crashState: null,
        engine: tab.provider.engineId
      };
    });
  }

  /** Sites that needed Chromium in this session (for Settings and tests). */
  rememberedSitesList(): string[] {
    return [...this.rememberedSites.keys()];
  }

  /**
   * The engine for a new tab. A person's tab and `chromium` always get Chromium. `auto` (the default) takes the first
   * running engine unless the site needed Chromium before or the engine just failed to open a tab; a named engine
   * that is missing, or a remembered site, get Chromium with a notice.
   */
  choose(request: { engine?: string; actor: BrowserActor; url: string }): EngineChoice {
    if (request.actor.kind !== "agent") return { provider: null };
    const requested = request.engine ?? "auto";
    if (requested === CHROMIUM_ENGINE) return { provider: null };
    const providers = this.host.providers()
      .filter((provider) => ENGINE_ID.test(provider.engineId) && provider.engineId !== CHROMIUM_ENGINE)
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId) || left.engineId.localeCompare(right.engineId));
    const site = hostOf(request.url);
    if (requested === "auto") {
      if (site && this.rememberedSites.has(site)) return { provider: null };
      const now = this.now();
      return { provider: providers.find((provider) => (this.unavailableUntil.get(providerKey(provider)) ?? 0) <= now) ?? null };
    }
    const provider = providers.find((candidate) => candidate.engineId === requested);
    if (!provider) {
      return { provider: null, notice: `Browser engine "${requested}" is not installed or not running; the tab opened in Chromium.` };
    }
    if (site && this.rememberedSites.has(site)) {
      return { provider: null, notice: `${site} needed Chromium earlier in this session; the tab opened in Chromium.` };
    }
    return { provider };
  }

  /** Opens an engine tab (never shown) and starts loading the URL. Rejects when the engine cannot take it. */
  async open(provider: BrowserEngineProvider, url: string, tabId: string = randomUUID()): Promise<string> {
    let driver: CdpTabDriver | null = null;
    try {
      const endpoint = await this.host.openEngineTab(provider, tabId);
      const webSocketUrl = endpoint && typeof endpoint === "object" ? (endpoint as { webSocketUrl?: unknown }).webSocketUrl : undefined;
      if (typeof webSocketUrl !== "string") throw new Error("Browser engine did not return a CDP endpoint.");
      driver = await CdpTabDriver.open({
        url: webSocketUrl,
        engine: provider.engineId,
        layout: provider.layout,
        ...(this.host.connect ? { connect: this.host.connect } : {})
      });
      const opened = driver;
      const tab: EngineTab = {
        id: tabId,
        provider,
        driver: opened,
        revision: 0,
        lastUrl: url,
        status: "loading",
        pendingCommit: false,
        unlisten: () => undefined
      };
      tab.unlisten = opened.listen({
        message: (method, params) => this.onEvent(tab, method, params),
        detach: () => this.onDisconnect(tab)
      });
      this.tabs.set(tabId, tab);
      await this.host.automation.registerDriver(tabId, opened, tab.revision);
      this.host.changed();
      void this.load(tab, url);
      return tabId;
    } catch (error) {
      const tab = this.tabs.get(tabId);
      if (tab) {
        this.forget(tab);
      } else {
        driver?.close();
        this.host.closeEngineTab(provider, tabId);
      }
      this.unavailableUntil.set(providerKey(provider), this.now() + ENGINE_RETRY_AFTER_MS);
      throw error;
    }
  }

  async navigate(tabId: string, url: string): Promise<void> {
    const tab = this.require(tabId);
    const site = hostOf(url);
    if (site && this.rememberedSites.has(site)) {
      await this.moveToChromium(tabId, "remembered-site", { url, waitForLoad: false });
      return;
    }
    this.advance(tab);
    await this.load(tab, url);
  }

  async history(tabId: string, delta: -1 | 1): Promise<void> {
    const tab = this.require(tabId);
    if (!await tab.driver.canGo(delta)) return;
    this.advance(tab);
    tab.pendingCommit = true;
    await tab.driver.history(delta).catch(() => this.markError(tab));
  }

  async reload(tabId: string): Promise<void> {
    const tab = this.require(tabId);
    this.advance(tab);
    tab.pendingCommit = true;
    await tab.driver.reload().catch(() => this.markError(tab));
  }

  close(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.forget(tab);
    this.host.changed();
  }

  /**
   * Moves the tab to Chromium: same tab id, the next document revision, the same URL (or `url`). Sites the engine
   * failed on are remembered for the session. Runs once per tab; later calls wait for the same move.
   */
  moveToChromium(
    tabId: string,
    reason: EngineFallbackReason,
    options: { url?: string; waitForLoad?: boolean } = {}
  ): Promise<void> {
    const pending = this.moving.get(tabId);
    if (pending) return pending.promise;
    const tab = this.tabs.get(tabId);
    if (!tab) return Promise.resolve();
    const url = options.url ?? this.urlOf(tab);
    const revision = tab.revision + 1;
    const currentSite = hostOf(this.urlOf(tab));
    if (SITE_REASONS.has(reason) && currentSite) this.remember(currentSite, reason);
    this.forget(tab);
    const promise = (async () => {
      try {
        await this.host.openChromiumTab(tabId, url, revision, { waitForLoad: options.waitForLoad ?? true });
      } finally {
        this.moving.delete(tabId);
        this.host.changed();
      }
    })();
    this.moving.set(tabId, { promise, url, revision });
    return promise;
  }

  dispose(): void {
    for (const tab of [...this.tabs.values()]) this.forget(tab);
  }

  private async load(tab: EngineTab, url: string): Promise<void> {
    tab.status = "loading";
    tab.lastUrl = url;
    tab.pendingCommit = true;
    try {
      await tab.driver.navigate(url);
    } catch {
      this.markError(tab);
    }
  }

  private advance(tab: EngineTab): void {
    tab.revision += 1;
    tab.status = "loading";
    this.host.automation.updateRevision(tab.id, tab.revision);
    this.host.changed();
  }

  private markError(tab: EngineTab): void {
    if (this.tabs.get(tab.id) !== tab) return;
    tab.pendingCommit = false;
    tab.status = "error";
    this.host.changed();
  }

  private onEvent(tab: EngineTab, method: string, params: unknown): void {
    if (this.tabs.get(tab.id) !== tab) return;
    if (method === "Page.frameNavigated") {
      const frame = ((params ?? {}) as { frame?: { parentId?: unknown; url?: unknown } }).frame;
      if (!frame || frame.parentId) return;
      if (typeof frame.url === "string" && isHttpUrl(frame.url)) tab.lastUrl = frame.url;
      if (tab.pendingCommit) {
        tab.pendingCommit = false;
        this.host.changed();
      } else {
        // The page navigated by itself (a link, a script): refs from before are stale.
        this.advance(tab);
      }
    } else if (method === "Page.loadEventFired") {
      tab.status = "ready";
      this.host.changed();
    }
  }

  private onDisconnect(tab: EngineTab): void {
    if (this.tabs.get(tab.id) !== tab) return;
    // The engine went away (crash, restart, plugin stopped): the tab continues in Chromium.
    void this.moveToChromium(tab.id, "engine-disconnected", { waitForLoad: false }).catch(() => undefined);
  }

  private forget(tab: EngineTab): void {
    if (this.tabs.get(tab.id) === tab) this.tabs.delete(tab.id);
    tab.unlisten();
    this.host.automation.unregister(tab.id);
    tab.driver.close();
    this.host.closeEngineTab(tab.provider, tab.id);
  }

  private remember(site: string, reason: EngineFallbackReason): void {
    this.rememberedSites.delete(site);
    this.rememberedSites.set(site, reason);
    while (this.rememberedSites.size > MAX_REMEMBERED_SITES) {
      this.rememberedSites.delete(this.rememberedSites.keys().next().value!);
    }
  }

  private urlOf(tab: EngineTab): string {
    const current = tab.driver.url();
    return isHttpUrl(current) ? current : tab.lastUrl;
  }

  private require(tabId: string): EngineTab {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error("Browser engine tab is unavailable.");
    return tab;
  }
}

function providerKey(provider: BrowserEngineProvider): string {
  return `${provider.pluginId}\u0000${provider.serviceId}\u0000${provider.engineId}`;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** The site a URL belongs to for the fallback memory: its host name, lowercased, without `www.`. */
export function hostOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}
