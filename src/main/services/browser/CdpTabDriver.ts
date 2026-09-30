import type { TabDriver, TabDriverListeners } from "./TabDriver.ts";

/** One text-frame connection to a local CDP endpoint. */
export interface CdpSocket {
  send(text: string): void;
  close(): void;
}

export interface CdpSocketHandlers {
  message(text: string): void;
  close(): void;
}

export type CdpSocketFactory = (url: string, handlers: CdpSocketHandlers) => Promise<CdpSocket>;

export interface CdpTabDriverOptions {
  /** The engine's CDP WebSocket for this tab, from the plugin service. Loopback only. */
  url: string;
  engine: string;
  layout: boolean;
  connect?: CdpSocketFactory;
  /** Connecting and opening the page (default 10 s). */
  openTimeoutMs?: number;
  /** One CDP command (default 30 s). */
  commandTimeoutMs?: number;
}

const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_PENDING_COMMANDS = 256;
/** A page that never reports its load event stops counting as loading after this long. */
const MAX_LOADING_MS = 45_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * The CDP WebSocket a plugin handed over must be a plain `ws://` endpoint on this computer's loopback interface with
 * an explicit port: the core never connects a tab to another host, and never sends credentials to it.
 */
export function assertLoopbackCdpUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 512) throw new Error("Browser engine endpoint is invalid.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Browser engine endpoint is invalid.");
  }
  if (url.protocol !== "ws:" || !LOOPBACK_HOSTS.has(url.hostname) || !url.port
    || url.username || url.password || url.hash) {
    throw new Error("Browser engine endpoint must be a ws:// address on 127.0.0.1, [::1] or localhost with a port.");
  }
  return url.toString();
}

/** Node's and Electron's built-in WebSocket client. */
export const connectWebSocket: CdpSocketFactory = (url, handlers) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  let opened = false;
  let closed = false;
  const decoder = new TextDecoder();
  socket.addEventListener("open", () => {
    opened = true;
    resolve({ send: (text) => socket.send(text), close: () => socket.close() });
  });
  socket.addEventListener("message", (event) => {
    const data: unknown = event.data;
    if (typeof data === "string") handlers.message(data);
    else if (data instanceof ArrayBuffer) handlers.message(decoder.decode(data));
  });
  const end = (): void => {
    if (closed) return;
    closed = true;
    if (!opened) reject(new Error("Browser engine endpoint refused the connection."));
    else handlers.close();
  };
  socket.addEventListener("close", end);
  socket.addEventListener("error", end);
});

interface PendingCommand {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class CdpCommandError extends Error {
  readonly code: number | null;

  constructor(method: string, message: string, code: number | null) {
    super(`${method}: ${message}`.slice(0, 400));
    this.name = "CdpCommandError";
    this.code = code;
  }
}

/**
 * A tab in a contributed engine, over one CDP WebSocket of its own (engines like Lightpanda serve one page per
 * connection). The driver creates the page (`Target.createTarget`), attaches a flat session to it and sends every
 * command on that session. It keeps the URL, title and loading state from page events, since `url()` and `title()`
 * are synchronous. Nothing here reads or sets cookies: the page starts empty and nothing of the person's browser
 * profile reaches it.
 */
export class CdpTabDriver implements TabDriver {
  readonly engine: string;
  readonly layout: boolean;
  private socket: CdpSocket | null = null;
  private sessionId: string | null = null;
  private targetId: string | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly listeners = new Set<TabDriverListeners>();
  private readonly commandTimeoutMs: number;
  private destroyed = false;
  private attached = false;
  private mainFrameId: string | null = null;
  private currentUrl = "about:blank";
  private currentTitle = "";
  private loadingSince: number | null = null;

  private constructor(options: CdpTabDriverOptions) {
    this.engine = options.engine;
    this.layout = options.layout;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  /** Connects, creates the tab's page and attaches to it. Rejects (and closes) when any step fails or is too slow. */
  static async open(options: CdpTabDriverOptions): Promise<CdpTabDriver> {
    const url = assertLoopbackCdpUrl(options.url);
    const driver = new CdpTabDriver(options);
    const connect = options.connect ?? connectWebSocket;
    const opening = (async () => {
      driver.socket = await connect(url, {
        message: (text) => driver.receive(text),
        close: () => driver.closed("engine-closed")
      });
      if (driver.destroyed) throw new Error("Browser engine closed the connection.");
      const created = await driver.call("Target.createTarget", { url: "about:blank" }, null) as { targetId?: unknown };
      if (typeof created.targetId !== "string" || !created.targetId) throw new Error("Browser engine did not create a page.");
      driver.targetId = created.targetId;
      const attached = await driver.call("Target.attachToTarget", { targetId: created.targetId, flatten: true }, null) as {
        sessionId?: unknown;
      };
      if (typeof attached.sessionId !== "string" || !attached.sessionId) throw new Error("Browser engine did not attach to the page.");
      driver.sessionId = attached.sessionId;
      return driver;
    })();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        opening,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Browser engine did not open a page in time.")), options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS);
          timer.unref();
        })
      ]);
    } catch (error) {
      driver.close();
      opening.catch(() => undefined);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isAttached(): boolean {
    return this.attached && !this.destroyed;
  }

  /** The connection is the attachment: nothing more to do than to remember it. */
  attach(): void {
    if (this.destroyed) throw new Error("Browser engine tab is closed.");
    this.attached = true;
  }

  detach(): void {
    this.close();
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.sessionId) return Promise.reject(new Error("Browser engine tab is not open."));
    return this.call(method, params ?? {}, this.sessionId);
  }

  listen(listeners: TabDriverListeners): () => void {
    this.listeners.add(listeners);
    return () => this.listeners.delete(listeners);
  }

  url(): string {
    return this.currentUrl;
  }

  title(): string {
    return this.currentTitle;
  }

  isLoading(): boolean {
    return this.loadingSince !== null && Date.now() - this.loadingSince < MAX_LOADING_MS;
  }

  /** Loads a URL in the tab. Resolves once the engine accepted the navigation; a refused one rejects. */
  async navigate(url: string): Promise<void> {
    this.loadingSince = Date.now();
    try {
      const result = await this.send("Page.navigate", { url }) as { errorText?: unknown };
      if (typeof result?.errorText === "string" && result.errorText) throw new Error(result.errorText.slice(0, 200));
    } catch (error) {
      this.loadingSince = null;
      throw error;
    }
  }

  /** Back (-1) or forward (+1) in the tab's history; false when there is no such entry. */
  async history(delta: -1 | 1): Promise<boolean> {
    const history = await this.send("Page.getNavigationHistory") as {
      currentIndex?: unknown;
      entries?: Array<{ id?: unknown }>;
    };
    const index = typeof history.currentIndex === "number" ? history.currentIndex + delta : -1;
    const entry = Array.isArray(history.entries) ? history.entries[index] : undefined;
    if (!entry || typeof entry.id !== "number") return false;
    this.loadingSince = Date.now();
    await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    return true;
  }

  async canGo(delta: -1 | 1): Promise<boolean> {
    try {
      const history = await this.send("Page.getNavigationHistory") as { currentIndex?: unknown; entries?: unknown[] };
      const index = typeof history.currentIndex === "number" ? history.currentIndex + delta : -1;
      return Array.isArray(history.entries) && index >= 0 && index < history.entries.length;
    } catch {
      return false;
    }
  }

  async reload(): Promise<void> {
    this.loadingSince = Date.now();
    await this.send("Page.reload");
  }

  /** Closes the page and the connection. Safe to call more than once. */
  close(): void {
    if (this.socket && this.targetId && !this.destroyed) {
      try {
        this.socket.send(JSON.stringify({ id: this.nextId++, method: "Target.closeTarget", params: { targetId: this.targetId } }));
      } catch {
        // The connection is going away anyway.
      }
    }
    const socket = this.socket;
    this.closed("closed");
    try {
      socket?.close();
    } catch {
      // Already closed.
    }
  }

  private call(method: string, params: Record<string, unknown>, sessionId: string | null): Promise<unknown> {
    if (this.destroyed || !this.socket) return Promise.reject(new Error("Browser engine disconnected."));
    if (this.pending.size >= MAX_PENDING_COMMANDS) return Promise.reject(new Error("Browser engine is busy."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: the browser engine did not answer in time.`));
      }, this.commandTimeoutMs);
      timer.unref();
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private receive(text: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      const error = message.error as { message?: unknown; code?: unknown } | undefined;
      if (error && typeof error === "object") {
        waiter.reject(new CdpCommandError(
          waiter.method,
          typeof error.message === "string" ? error.message : "command failed",
          typeof error.code === "number" ? error.code : null
        ));
      } else {
        waiter.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method !== "string") return;
    const params = message.params;
    if (message.method === "Target.detachedFromTarget" || message.method === "Target.targetDestroyed") {
      const source = (params ?? {}) as { sessionId?: unknown; targetId?: unknown };
      if (source.sessionId === this.sessionId || source.targetId === this.targetId) this.closed("target-closed");
      return;
    }
    if (!this.sessionId || message.sessionId !== this.sessionId) return;
    this.track(message.method, params);
    for (const listener of [...this.listeners]) {
      try {
        listener.message(message.method, params);
      } catch {
        // One listener's failure must not stop the others.
      }
    }
  }

  private track(method: string, params: unknown): void {
    const source = (params ?? {}) as Record<string, unknown>;
    if (method === "Page.frameNavigated") {
      const frame = (source.frame ?? {}) as { id?: unknown; parentId?: unknown; url?: unknown };
      if (frame.parentId) return;
      if (typeof frame.id === "string") this.mainFrameId = frame.id;
      if (typeof frame.url === "string") this.currentUrl = frame.url;
      this.loadingSince ??= Date.now();
      this.refreshTitle();
    } else if (method === "Page.navigatedWithinDocument") {
      if (typeof source.url === "string" && (!this.mainFrameId || source.frameId === this.mainFrameId)) this.currentUrl = source.url;
    } else if (method === "Page.frameStartedLoading") {
      if (!this.mainFrameId || source.frameId === this.mainFrameId) this.loadingSince ??= Date.now();
    } else if (method === "Page.loadEventFired") {
      this.loadingSince = null;
      this.refreshTitle();
    } else if (method === "Page.frameStoppedLoading") {
      if (this.mainFrameId && source.frameId === this.mainFrameId) this.loadingSince = null;
    } else if (method === "Page.domContentEventFired") {
      this.refreshTitle();
    }
  }

  private refreshTitle(): void {
    void this.send("Runtime.evaluate", { expression: "document.title", returnByValue: true, silent: true }).then((value) => {
      const title = (value as { result?: { value?: unknown } }).result?.value;
      if (typeof title === "string") this.currentTitle = title.slice(0, 1_000);
    }, () => undefined);
  }

  private closed(reason: string): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.attached = false;
    this.loadingSince = null;
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Browser engine disconnected."));
      this.pending.delete(id);
    }
    for (const listener of [...this.listeners]) {
      try {
        listener.detach(reason);
      } catch {
        // Ignore listener failures while closing.
      }
    }
    this.listeners.clear();
  }
}
