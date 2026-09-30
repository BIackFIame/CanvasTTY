import { connectionFromCode, localFetcher, readLocalConnection } from "../../even-g2/src/local-fetch.mjs";
import { localOrigin, randomLocalHex, type LocalConnection } from "../../../src/shared/localLink.ts";
import type { CompanionAction, CompanionOverview, CompanionOverviewSession, CompanionOutput } from "../../../src/shared/companion.ts";

export type Session = CompanionOverviewSession;
export type Overview = CompanionOverview;
export type Output = CompanionOutput;
export type Action = Exclude<CompanionAction, { type: "sessions.list" | "browser.open" | "limits.read" }>;
type Stored = { state: "pending" | "approved"; token: string; connection: LocalConnection };
type EncryptedTransport = ((input: string, options?: RequestInit) => Promise<Response>) & {
  connection(): LocalConnection;
};
const STORAGE_KEY = "canvastty.mobile.pairing.v1";

// The web companion may only talk to the host that served this page.
export function exactOrigin(value: string): string {
  const origin = localOrigin(value.trim());
  const url = new URL(origin);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".ts.net") || origin !== location.origin)
    throw new Error("Enter this page's exact HTTPS Tailscale address (*.ts.net).");
  return origin;
}

export function loadSaved(): Stored | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Stored;
    if (parsed.state !== "pending" && parsed.state !== "approved") throw new Error("invalid-state");
    const saved = readLocalConnection(JSON.stringify(parsed));
    const origin = exactOrigin(location.origin);
    if (!saved.connection.origins.includes(origin)) throw new Error("different-host");
    return { ...saved, connection: { ...saved.connection, origins: [origin] }, state: parsed.state };
  } catch {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* Storage may be disabled. */ }
    return null;
  }
}
export function savePairing(value: Stored): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}
export function forgetPairing(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export class CompanionClient {
  private send: EncryptedTransport;
  constructor(private readonly stored: Stored) {
    this.send = localFetcher(stored.connection);
  }
  get state(): Stored["state"] {
    return this.stored.state;
  }
  snapshot(): Stored {
    return { ...this.stored, connection: this.send.connection() };
  }
  async raw(path: string, options: RequestInit = {}): Promise<unknown> {
    const response = await this.send(path, {
      ...options,
      headers: { ...(options.headers as Record<string, string> || {}), Authorization: "Bearer " + this.stored.token },
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const message = typeof body === "object" && body && "error" in body ? String(body.error) : `HTTP ${response.status}`;
      throw new Error(message);
    }
    return body;
  }
  async action<T>(action: Action, signal?: AbortSignal): Promise<T> {
    const response = await this.raw("/g2/api/mobile", {
      method: "POST",
      body: JSON.stringify({ version: 1, id: randomLocalHex(16), sentAt: Date.now(), action }),
      headers: { "Content-Type": "application/json" },
      signal,
    });
    return response as T;
  }
  async approval(signal?: AbortSignal): Promise<"pending" | "approved" | "rejected"> {
    const response = await this.raw("/g2/api/pair-status", { signal }) as { state: "pending" | "approved" | "rejected" };
    return response.state;
  }
}

export async function startPairing(originInput: string, code: string, signal: AbortSignal): Promise<CompanionClient> {
  if (!globalThis.isSecureContext || !crypto.subtle)
    throw new Error("A secure HTTPS browser context is required for pairing.");
  const origin = exactOrigin(originInput);
  if (!/^\d{6}$/.test(code)) throw new Error("Enter the six-digit code shown by CanvasTTY.");
  let connection: LocalConnection;
  try {
    ({ connection } = await connectionFromCode(code, { origins: [origin], signal }));
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("Cannot reach CanvasTTY to pair. Check the desktop pairing code and Tailscale Serve address.");
  }
  if (!connection.origins.includes(origin)) throw new Error("Pairing host changed.");
  const send = localFetcher({ ...connection, origins: [origin] });
  const response = await send("/g2/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name: "CanvasTTY Web Companion" }),
    signal,
  });
  if (response.status !== 202) throw new Error("Pairing was not accepted. Request a new code on the desktop.");
  const pending = await response.json() as { token: string; state: string };
  if (pending.state !== "pending" || !/^[a-f0-9]{64}$/.test(pending.token))
    throw new Error("Invalid pairing response.");
  const stored: Stored = { state: "pending", token: pending.token, connection: { ...send.connection(), origins: [origin] } };
  savePairing(stored); // A refresh while desktop approval is pending must not start another pairing attempt.
  return new CompanionClient(stored);
}

export function markApproved(client: CompanionClient): CompanionClient {
  const stored: Stored = { ...client.snapshot(), state: "approved" };
  savePairing(stored);
  return new CompanionClient(stored);
}
