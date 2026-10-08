import { dirname, join } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isSafeBrowserUrl, MAX_BROWSER_TABS } from "./BrowserPolicyService.ts";

export const BROWSER_STORE_VERSION = 1;

export interface PersistedBrowserTab {
  id: string;
  url: string;
}

export interface PersistedBrowserState {
  version: typeof BROWSER_STORE_VERSION;
  tabs: PersistedBrowserTab[];
  activeTabId: string | null;
}

const EMPTY_STATE: PersistedBrowserState = {
  version: BROWSER_STORE_VERSION,
  tabs: [],
  activeTabId: null
};

export class BrowserStore {
  readonly filePath: string;
  private value: PersistedBrowserState = structuredClone(EMPTY_STATE);
  private writeQueue = Promise.resolve();

  constructor(userDataPath: string, fileName = "browser-state.json") {
    this.filePath = join(userDataPath, fileName);
  }

  async load(): Promise<PersistedBrowserState> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      this.value = normalizePersistedBrowserState(parsed);
      if (JSON.stringify(parsed) !== JSON.stringify(this.value)) await this.persist();
    } catch (error) {
      if (isMissingFile(error)) await this.persist();
      else console.warn("CanvasTTY browser state could not be loaded; an empty session is used.", error);
    }
    return this.get();
  }

  get(): PersistedBrowserState {
    return structuredClone(this.value);
  }

  async replace(tabs: readonly PersistedBrowserTab[], activeTabId: string | null): Promise<PersistedBrowserState> {
    this.value = normalizePersistedBrowserState({
      version: BROWSER_STORE_VERSION,
      tabs,
      activeTabId
    });
    await this.persist();
    return this.get();
  }

  async clear(): Promise<void> {
    this.value = structuredClone(EMPTY_STATE);
    await this.persist();
  }

  private persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.value, null, 2)}\n`;
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    // A failed write must not poison the queue: every later save would reject
    // with the same error. Each save still reports its own failure.
    const write = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      try {
        await writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
        await rename(temporaryPath, this.filePath);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write;
    return write;
  }
}

export function normalizePersistedBrowserState(candidate: unknown): PersistedBrowserState {
  if (!candidate || typeof candidate !== "object") return structuredClone(EMPTY_STATE);
  const source = candidate as Partial<PersistedBrowserState>;
  if (source.version !== BROWSER_STORE_VERSION || !Array.isArray(source.tabs)) {
    return structuredClone(EMPTY_STATE);
  }

  const tabs: PersistedBrowserTab[] = [];
  const ids = new Set<string>();
  for (const value of source.tabs.slice(0, MAX_BROWSER_TABS)) {
    if (!value || typeof value !== "object") continue;
    const tab = value as Partial<PersistedBrowserTab>;
    if (!isTabId(tab.id) || ids.has(tab.id) || typeof tab.url !== "string" || !isSafeBrowserUrl(tab.url)) {
      continue;
    }
    tabs.push({ id: tab.id, url: restorableUrl(tab.url) });
    ids.add(tab.id);
  }
  const activeTabId = typeof source.activeTabId === "string" && ids.has(source.activeTabId)
    ? source.activeTabId
    : tabs[0]?.id ?? null;
  return { version: BROWSER_STORE_VERSION, tabs, activeTabId };
}

function isTabId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(value);
}

function restorableUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

/** The active tab once tabs were removed: unchanged while it is still open, else the first open tab (or none). */
export function activeTabAmong(tabs: ReadonlyMap<string, unknown>, activeTabId: string | null): string | null {
  if (activeTabId === null || tabs.has(activeTabId)) return activeTabId;
  return tabs.keys().next().value ?? null;
}
