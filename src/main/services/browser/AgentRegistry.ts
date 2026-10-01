import type {
  AgentCursorSnapshot,
  AgentPresenceSnapshot,
  BrowserActor
} from "../../../shared/contracts.ts";
import { BROWSER_PROVIDER_COLORS } from "../../../shared/contracts.ts";

const STALE_AFTER_MS = 10_000;
const EXPIRE_AFTER_MS = 15_000;
const EXPIRY_CHECK_MS = 1_000;

interface ExpiryTimers {
  setInterval(callback: () => void, ms: number): { unref?(): unknown };
  clearInterval(timer: unknown): void;
}

export interface AgentRegistryOptions {
  /** Called when presence expired on its own (no heartbeat for 15 s). */
  onExpired?: () => void;
  timers?: ExpiryTimers;
}

export class AgentRegistry {
  private readonly values = new Map<string, AgentPresenceSnapshot>();
  private readonly now: () => number;
  private readonly onExpired: (() => void) | undefined;
  private readonly timers: ExpiryTimers;
  /** Runs only while an agent is present: a browser nobody's agent uses never wakes up for it. */
  private expiryTimer: { unref?(): unknown } | null = null;
  private disposed = false;

  constructor(now: () => number = Date.now, options: AgentRegistryOptions = {}) {
    this.now = now;
    this.onExpired = options.onExpired;
    this.timers = options.timers ?? { setInterval: (callback, ms) => setInterval(callback, ms), clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout) };
  }

  dispose(): void {
    this.disposed = true;
    this.syncExpiry();
  }

  private syncExpiry(): void {
    const wanted = Boolean(this.onExpired) && !this.disposed && this.values.size > 0;
    if (wanted && !this.expiryTimer) {
      this.expiryTimer = this.timers.setInterval(() => {
        if (this.prune()) this.onExpired?.();
      }, EXPIRY_CHECK_MS);
      this.expiryTimer.unref?.();
    } else if (!wanted && this.expiryTimer) {
      this.timers.clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  touch(
    actor: BrowserActor,
    tabId: string | null,
    cursor?: { x: number; y: number }
  ): boolean {
    if (actor.kind !== "agent") return false;
    const timestamp = this.now();
    const current = this.values.get(actor.connectionId);
    const nextCursor: AgentCursorSnapshot = cursor
      ? {
        x: clamp(cursor.x, -10_000, 10_000),
        y: clamp(cursor.y, -10_000, 10_000),
        updatedAt: timestamp
      }
      : current?.cursor ?? { x: 0, y: 0, updatedAt: 0 };
    this.values.set(actor.connectionId, {
      agentId: actor.agentId,
      connectionId: actor.connectionId,
      provider: actor.provider,
      label: current?.label ?? providerLabel(actor.provider),
      brandColor: BROWSER_PROVIDER_COLORS[actor.provider],
      terminalSessionId: actor.terminalSessionId,
      currentTabId: tabId ?? current?.currentTabId ?? null,
      cursor: nextCursor,
      connectionState: "connected",
      connectedAt: current?.connectedAt ?? timestamp,
      lastHeartbeatAt: timestamp
    });
    this.syncExpiry();
    return true;
  }

  heartbeat(actor: BrowserActor, timestamp = this.now()): boolean {
    if (actor.kind !== "agent") return false;
    const current = this.values.get(actor.connectionId);
    if (!current) return false;
    current.lastHeartbeatAt = Number.isFinite(timestamp) ? timestamp : this.now();
    current.connectionState = "connected";
    return true;
  }

  disconnect(actor: BrowserActor): boolean {
    const removed = actor.kind === "agent" && this.values.delete(actor.connectionId);
    this.syncExpiry();
    return removed;
  }

  replace(values: readonly AgentPresenceSnapshot[]): void {
    this.values.clear();
    for (const value of values.slice(0, 24)) {
      if (!value.connectionId || this.values.has(value.connectionId)) continue;
      this.values.set(value.connectionId, structuredClone(value));
    }
    this.syncExpiry();
  }

  snapshot(): AgentPresenceSnapshot[] {
    this.prune();
    const timestamp = this.now();
    return [...this.values.values()].map((value) => ({
      ...structuredClone(value),
      connectionState: timestamp - value.lastHeartbeatAt > STALE_AFTER_MS ? "stale" : "connected"
    }));
  }

  forTab(tabId: string): AgentPresenceSnapshot[] {
    return this.snapshot().filter((presence) => presence.currentTabId === tabId);
  }

  prune(): boolean {
    const cutoff = this.now() - EXPIRE_AFTER_MS;
    let changed = false;
    for (const [connectionId, value] of this.values) {
      if (value.lastHeartbeatAt >= cutoff) continue;
      this.values.delete(connectionId);
      changed = true;
    }
    if (changed) this.syncExpiry();
    return changed;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : 0;
}

function providerLabel(provider: AgentPresenceSnapshot["provider"]): string {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude";
  if (provider === "kimi") return "Kimi";
  if (provider === "opencode") return "OpenCode";
  if (provider === "hermes") return "Hermes";
  return "Agent";
}
