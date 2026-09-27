import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type {
  LaunchProfileId,
  SessionRole,
  Point,
  ProviderId,
  SessionMetadata,
  Size
} from "../../shared/contracts.ts";
import { normalizeThreadId } from "../../agent-runtime/runtime-protocol.mjs";

export const TERMINAL_SESSION_STORE_VERSION = 2;
const MAX_PERSISTED_SESSIONS = 64;
/** Opaque plugin-owned JSON (launch options, environment refs) is capped per value. */
export const MAX_PLUGIN_SLOT_BYTES = 4_096;
const MAX_OPTION_PLUGINS = 16;
const PROVIDERS = new Set<ProviderId>([
  "terminal",
  "codex",
  "claude",
  "qwen",
  "kimi",
  "opencode",
  "hermes",
  "grok",
  "omp",
  "pi",
  "cursor",
  "minimax",
  "devin",
  "antigravity"
]);

export interface PersistedTerminalSession {
  id: string;
  provider: ProviderId;
  profile: LaunchProfileId;
  /** Records written before roles existed restore as ordinary agents. */
  role: SessionRole;
  title: string;
  titleCustomized: boolean;
  cwd: string;
  position: Point;
  size: Size;
  parentSessionId?: string;
  /** The provider's own conversation id (Codex thread, Claude or OpenCode session) its hook reported. */
  threadId?: string;
  /** State at quit or at the moment the process exited; v1 records read as "running". */
  lastState: PersistedLastState;
  exitCode?: number | null;
  /** False when the person chose "Don't restore this card". */
  restore: boolean;
  /** Plugin launch options keyed by plugin id, each opaque and at most 4 KB. */
  options?: Record<string, unknown>;
  /** Where the session runs when a plugin placed it; opaque to core, at most 4 KB. */
  environment?: PersistedEnvironmentRef;
  /** The plugin that started the card (EP-4 `sessions.create`); it keeps control after a restore. */
  ownerPluginId?: string;
}

export type PersistedLastState = "running" | "exited" | "failed";

export interface PersistedEnvironmentRef {
  pluginId: string;
  kind: string;
  ref: unknown;
  label: string;
}

interface PersistedTerminalSessionState {
  version: typeof TERMINAL_SESSION_STORE_VERSION;
  sessions: PersistedTerminalSession[];
}

const EMPTY_STATE: PersistedTerminalSessionState = {
  version: TERMINAL_SESSION_STORE_VERSION,
  sessions: []
};

export class TerminalSessionStore {
  readonly filePath: string;
  private value: PersistedTerminalSessionState = structuredClone(EMPTY_STATE);
  private writeQueue = Promise.resolve();

  constructor(userDataPath: string, fileName = "terminal-sessions.json") {
    this.filePath = join(userDataPath, fileName);
  }

  async load(): Promise<PersistedTerminalSession[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      this.value = normalizePersistedTerminalSessions(parsed);
      if (JSON.stringify(parsed) !== JSON.stringify(this.value)) await this.persist();
    } catch (error) {
      if (!isMissingFile(error)) {
        console.warn("CanvasTTY terminal window state could not be loaded; an empty state is used.", error);
      }
    }
    return this.get();
  }

  get(): PersistedTerminalSession[] {
    return structuredClone(this.value.sessions);
  }

  async replace(sessions: readonly PersistedTerminalSession[]): Promise<void> {
    this.value = normalizePersistedTerminalSessions({
      version: TERMINAL_SESSION_STORE_VERSION,
      sessions
    });
    await this.persist();
  }

  clear(): Promise<void> {
    return this.replace([]);
  }

  flush(): Promise<void> {
    return this.writeQueue;
  }

  private persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.value, null, 2)}\n`;
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
  }
}

function normalizeStoredThreadId(provider: ProviderId, candidate: unknown): string | undefined {
  return typeof candidate === "string" ? normalizeThreadId(provider, candidate.trim()) : undefined;
}

/** What core keeps beside the live metadata: nothing here is scrollback, prompts or secrets. */
export type PersistedSessionExtras = Pick<PersistedTerminalSession, "options" | "environment" | "ownerPluginId"> & {
  /** Overrides the derived state while a card is held stopped (its environment is unavailable). */
  heldState?: PersistedLastState;
};

export function persistedTerminalSession(
  metadata: SessionMetadata,
  threadId?: unknown,
  extras: PersistedSessionExtras = {}
): PersistedTerminalSession {
  const normalizedThreadId = normalizeStoredThreadId(metadata.provider, threadId);
  const lastState: PersistedLastState = extras.heldState
    ?? (metadata.exitCode === null ? "running" : metadata.exitCode === 0 ? "exited" : "failed");
  return {
    id: metadata.id,
    provider: metadata.provider,
    profile: metadata.profile,
    role: metadata.role,
    title: metadata.title,
    titleCustomized: metadata.titleCustomized,
    cwd: metadata.cwd,
    position: { ...metadata.position },
    size: { ...metadata.size },
    ...(metadata.parentSessionId !== undefined ? { parentSessionId: metadata.parentSessionId } : {}),
    ...(normalizedThreadId !== undefined ? { threadId: normalizedThreadId } : {}),
    lastState,
    ...(lastState !== "running" ? { exitCode: metadata.exitCode } : {}),
    restore: metadata.skipRestore !== true,
    ...(extras.options ? { options: structuredClone(extras.options) } : {}),
    ...(extras.environment ? { environment: structuredClone(extras.environment) } : {}),
    ...(extras.ownerPluginId ? { ownerPluginId: extras.ownerPluginId } : {})
  };
}

export function normalizePersistedTerminalSessions(candidate: unknown): PersistedTerminalSessionState {
  if (!candidate || typeof candidate !== "object") return structuredClone(EMPTY_STATE);
  const source = candidate as { version?: unknown; sessions?: unknown };
  // v1 is read-compatible: missing v2 fields mean unknown conversation, no environment, running.
  if ((source.version !== 1 && source.version !== TERMINAL_SESSION_STORE_VERSION) || !Array.isArray(source.sessions)) {
    return structuredClone(EMPTY_STATE);
  }

  const sessions: PersistedTerminalSession[] = [];
  const ids = new Set<string>();
  for (const value of source.sessions.slice(0, MAX_PERSISTED_SESSIONS)) {
    if (!value || typeof value !== "object") continue;
    // codexThreadId: the v1 name of threadId (Codex only).
    const session = value as Partial<PersistedTerminalSession> & { codexThreadId?: unknown };
    if (!isSessionId(session.id) || ids.has(session.id)) continue;
    if (!PROVIDERS.has(session.provider as ProviderId)) continue;
    if (session.profile !== "normal" && session.profile !== "yolo") continue;
    if (typeof session.title !== "string" || session.title.trim().length === 0) continue;
    if (typeof session.titleCustomized !== "boolean") continue;
    if (typeof session.cwd !== "string" || session.cwd.length === 0 || session.cwd.length > 4_096) continue;
    if (!isFinitePoint(session.position) || !isFiniteSize(session.size)) continue;
    const rawRole: unknown = session.role;
    const roleKnown = rawRole === undefined || rawRole === "agent" || rawRole === "interactive"
      || rawRole === "orchestrator" || rawRole === "subagent";
    if (!roleKnown) continue;
    const role: SessionRole = rawRole === "orchestrator" || rawRole === "subagent" ? rawRole : "agent";
    const parentSessionId = typeof session.parentSessionId === "string"
      ? session.parentSessionId
      : undefined;
    if (session.parentSessionId !== undefined && parentSessionId === undefined) continue;
    if (role === "subagent" && parentSessionId === undefined) continue;
    // A damaged or obsolete conversation ID must not make the whole card disappear.
    // It can still restore with Codex's interactive resume picker.
    const threadId = normalizeStoredThreadId(
      session.provider as ProviderId,
      session.threadId ?? (session.provider === "codex" ? session.codexThreadId : undefined)
    );
    const lastState: PersistedLastState = session.lastState === "exited" || session.lastState === "failed"
      ? session.lastState
      : "running";
    const exitCode = Number.isInteger(session.exitCode) ? session.exitCode as number : null;
    const options = normalizeOptions(session.options);
    const environment = normalizeEnvironment(session.environment);
    // A placed session whose ref is unreadable must not come back as a local one.
    if (session.environment !== undefined && !environment) continue;
    sessions.push({
      id: session.id,
      provider: session.provider as ProviderId,
      profile: session.profile,
      role: session.provider === "terminal" ? "agent" : role,
      title: session.title.trim().slice(0, 80),
      titleCustomized: session.titleCustomized,
      cwd: session.cwd,
      position: { ...session.position },
      size: {
        width: clamp(session.size.width, 420, 1_600),
        height: clamp(session.size.height, 260, 1_100)
      },
      ...(parentSessionId !== undefined ? { parentSessionId } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      lastState,
      ...(lastState !== "running" ? { exitCode } : {}),
      restore: session.restore !== false,
      ...(options ? { options } : {}),
      ...(environment ? { environment } : {}),
      ...(isPluginId(session.ownerPluginId) ? { ownerPluginId: session.ownerPluginId } : {})
    });
    ids.add(session.id);
  }
  return { version: TERMINAL_SESSION_STORE_VERSION, sessions };
}

function normalizeOptions(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const options: Record<string, unknown> = {};
  for (const [pluginId, entry] of Object.entries(value).slice(0, MAX_OPTION_PLUGINS)) {
    if (!isPluginId(pluginId) || !fitsPluginSlot(entry)) continue;
    options[pluginId] = structuredClone(entry);
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

function normalizeEnvironment(value: unknown): PersistedEnvironmentRef | undefined {
  if (!isRecord(value) || !isPluginId(value.pluginId)) return undefined;
  if (typeof value.kind !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(value.kind)) return undefined;
  if (typeof value.label !== "string" || value.label.trim().length === 0) return undefined;
  if (value.ref === undefined || !fitsPluginSlot(value.ref)) return undefined;
  return {
    pluginId: value.pluginId,
    kind: value.kind,
    ref: structuredClone(value.ref),
    label: value.label.trim().slice(0, 80)
  };
}

/** Same shape PluginManager accepts for plugin ids. */
function isPluginId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= 80
    && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) && !value.includes("..");
}

function fitsPluginSlot(value: unknown): boolean {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" && Buffer.byteLength(json, "utf8") <= MAX_PLUGIN_SLOT_BYTES;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(value);
}

function isFinitePoint(value: unknown): value is Point {
  return Boolean(value && typeof value === "object"
    && "x" in value && "y" in value
    && Number.isFinite(value.x) && Number.isFinite(value.y));
}

function isFiniteSize(value: unknown): value is Size {
  return Boolean(value && typeof value === "object"
    && "width" in value && "height" in value
    && Number.isFinite(value.width) && Number.isFinite(value.height));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
