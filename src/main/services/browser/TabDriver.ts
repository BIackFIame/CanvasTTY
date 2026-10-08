import type { WebContents } from "electron";

/** CanvasTTY's own engine: the Electron WebContents behind a Browser card tab. */
export const CHROMIUM_ENGINE = "chromium";

export interface TabDriverListeners {
  message(method: string, params: unknown): void;
  detach(reason: string): void;
}

/**
 * What BrowserAutomationService needs from one tab: a CDP channel, its events, and the page's URL, title and loading
 * state. The Electron WebContents is the default driver; a plugin-contributed engine drives a tab over its own local
 * CDP endpoint (CdpTabDriver).
 */
export interface TabDriver {
  /** `chromium` or the contributed engine's id. */
  readonly engine: string;
  /**
   * The engine lays pages out for real: element boxes and viewport metrics mean something. An engine without layout
   * gets clicks by DOM (`element.click()`), and observation skips the geometry filter.
   */
  readonly layout: boolean;
  isDestroyed(): boolean;
  isAttached(): boolean;
  attach(protocolVersion: string): void;
  detach(): void;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Returns the function that removes these listeners. */
  listen(listeners: TabDriverListeners): () => void;
  url(): string;
  title(): string;
  isLoading(): boolean;
}

/** The Electron tab: every call goes to the WebContents and its debugger exactly as before drivers existed. */
export class ElectronTabDriver implements TabDriver {
  readonly engine = CHROMIUM_ENGINE;
  readonly layout = true;
  readonly contents: WebContents;

  constructor(contents: WebContents) {
    this.contents = contents;
  }

  isDestroyed(): boolean {
    return this.contents.isDestroyed();
  }

  isAttached(): boolean {
    return this.contents.debugger.isAttached();
  }

  attach(protocolVersion: string): void {
    this.contents.debugger.attach(protocolVersion);
  }

  detach(): void {
    this.contents.debugger.detach();
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.contents.debugger.sendCommand(method, params);
  }

  listen(listeners: TabDriverListeners): () => void {
    const message = (_event: unknown, method: string, params: unknown): void => listeners.message(method, params);
    const detach = (_event: unknown, reason: string): void => listeners.detach(reason);
    this.contents.debugger.on("message", message);
    this.contents.debugger.on("detach", detach);
    return () => {
      this.contents.debugger.removeListener("message", message);
      this.contents.debugger.removeListener("detach", detach);
    };
  }

  url(): string {
    return this.contents.getURL();
  }

  title(): string {
    return this.contents.getTitle();
  }

  isLoading(): boolean {
    return this.contents.isLoading();
  }
}
