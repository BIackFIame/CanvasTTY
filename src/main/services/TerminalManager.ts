import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import { isPathInside } from "../../agent-runtime/path-inside.mjs";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type {
  CreateSessionRequest,
  Point,
  ProviderId,
  SessionBounds,
  SessionEnvironmentChoice,
  SessionRole,
  SessionEvent,
  SessionMetadata,
  SessionRemovedEvent,
  SessionRestoreMode,
  SessionSnapshot,
  ShortcutBindings,
  TerminalBufferSnapshot,
  TerminalDataEvent
} from "../../shared/contracts.ts";
import {
  CANVAS_LAUNCHER_ITEMS,
  INITIAL_TERMINAL_COLS,
  INITIAL_TERMINAL_ROWS,
  IPC
} from "../../shared/contracts.ts";
import { DEFAULT_SHORTCUTS } from "../../shared/contracts.ts";
import type {
  AgentBrowserLaunchCoordinator,
  PreparedAgentBrowserPtyLaunch
} from "./agent-browser/AgentBrowserBridge.ts";
import { AGENT_BROWSER_ENV } from "./agent-browser/AgentBrowserBridge.ts";
import { ORCHESTRATION_TOOL_NAMES } from "../../agent-browser/orchestration-catalog.mjs";
import type { OrchestrationLaunchCoordinator, PreparedOrchestrationPtyLaunch } from "./agent-browser/OrchestrationBridge.ts";
import type {
  AgentRuntimeLaunchCoordinator,
  PreparedAgentRuntimePtyLaunch
} from "./agent-runtime/AgentRuntimeBridge.ts";
import {
  AGENT_RUNTIME_ENV,
  CAPTURE_ANSWER_ENV,
  CAPTURE_ANSWER_EXPIRES_AT_ENV,
  CAPTURE_RESULT_ENV,
  normalizeThreadId
} from "../../agent-runtime/runtime-protocol.mjs";
import {
  CONTROL_CLI_ENV,
  CONTROL_CONNECTION_ENV,
  controlEnvironment,
  type ControlConnection
} from "./agent-control/controlCapabilities.ts";
import { codexTrustArguments, mergeOpenCodeLaunchEnvironment } from "./agent-runtime/ProviderRuntimeLaunch.ts";
import { SecretRedactionRegistry } from "./safety/SecretRedaction.ts";
import type { DecisionSession } from "./DecisionHooks.ts";
import { tryPtyOperation } from "./ptySafety.ts";
import { terminalFailureDetails } from "./terminalFailureDetails.ts";
import { canResumeThreadById, resolveTerminalLaunch } from "./terminalLaunch.ts";
import { hasAutoMode, isLaunchProfile } from "../../shared/autoMode.ts";
import { RESERVED_ENV, type LaunchPipeline, type PreparedLaunch } from "./LaunchPipeline.ts";
import type { EnvironmentRegistry } from "./EnvironmentRegistry.ts";
import {
  persistedTerminalSession,
  type PersistedEnvironmentRef,
  type PersistedSessionExtras,
  type TerminalSessionStore
} from "./TerminalSessionStore.ts";
import { chooseResume, planSessionRestore, type ResumeRequest, type RestoreStep } from "./sessionRestorePlan.ts";
import type { ProviderCliRegistry, UnavailableProviderCli } from "./providerCliRegistry.ts";
import {
  createProviderLifecycleParser,
  initialSessionStatus,
  type ProviderLifecycleParser
} from "./providerLifecycle.ts";

const MAX_SCROLLBACK_CHARS = 240_000;
const OUTPUT_BATCH_MS = 16;
const DEFAULT_TERMINAL_SIZE = { width: 700, height: 430 };
const MIN_TERMINAL_SIZE = { width: 420, height: 260 };
const MAX_TERMINAL_SIZE = { width: 1_600, height: 1_100 };

interface ManagedSession {
  metadata: SessionMetadata;
  process: IPty | null;
  cols: number;
  rows: number;
  bufferChunks: string[];
  bufferStart: number;
  bufferLength: number;
  outputOffset: number;
  pendingOutput: string[];
  agentBrowser: PreparedAgentBrowserPtyLaunch | null;
  agentRuntime: PreparedAgentRuntimePtyLaunch | null;
  agentOrchestration: PreparedOrchestrationPtyLaunch | null;
  lifecycle: ProviderLifecycleParser | null;
  awaitingInitialResize: boolean;
  resumeOnLaunch: ResumeRequest;
  /** The provider's own conversation id, once its hook reported it (or from the saved record). */
  threadId?: string;
  captureResult: boolean;
  /**
   * Plugin options, environment ref (or, until the plugin has prepared it, the launcher's environment choice)
   * and owning plugin carried into the saved record.
   */
  extras: PersistedSessionExtras;
  /** Bumped per launch attempt, so a late plugin answer never starts a superseded launch. */
  launchToken: number;
  /** Removes the current run's plugin files; called when the process exits. */
  launchCleanup: (() => Promise<void>) | null;
  /** A restored grok card waits for its grid before launching; plugins still learn it is a restore. */
  restoringLaunch: boolean;
  /** The environment was prepared or resumed in this run of the app, so it can be wrapped now. */
  environmentReady: boolean;
  /** Bumped by every launch the person or the app asks for (create, restart, restore); input waits for one. */
  launchEpoch: number;
  /** Input waiting for this launch to start (deliverInput): woken whenever the launch moves on. */
  launchWaiters: Set<() => void>;
  /** Brought back from the saved sessions at startup (plugins see a "restored" event, not "created"). */
  restored?: boolean;
  /** What the CLI's own title last showed (Claude: spinner working, «✳» no turn running). */
  titleState?: "idle" | "working" | "needs_approval";
  /** How often the agent's lifecycle hooks reported; Claude's title defers to hooks once they have. */
  hookSignals?: number;
  /** Set after the person answered a hooked Claude prompt; see settleAnsweredPrompt. */
  answeredPromptTimer?: ReturnType<typeof setTimeout>;
}

type EnvironmentService = Pick<EnvironmentRegistry,
  "available" | "unavailableReason" | "normalizeChoice" | "prepare" | "resume" | "wrap" | "release" | "describe">;
type LaunchOutcome = "launched" | "failed" | "superseded";

interface PlannedSpawn {
  command: string;
  args: string[] | string;
  cwd: string;
  /** The full environment the PTY gets. */
  env: Record<string, string>;
  /** What CanvasTTY and launch contributors set for this launch (without the person's own environment). */
  launchEnvironment: Record<string, string>;
  agentBrowser: PreparedAgentBrowserPtyLaunch | null;
  agentRuntime: PreparedAgentRuntimePtyLaunch | null;
  agentOrchestration: PreparedOrchestrationPtyLaunch | null;
  cleanup(): void;
}
/** Quitting with saving off asks environments to stop compute, but never waits longer than this. */
const QUIT_RELEASE_TIMEOUT_MS = 3_000;
/**
 * Quitting waits this long for the PTYs it hung up to exit, then kills the rest and waits `PTY_KILL_WAIT_MS` more.
 * node-pty reports an exit through a native callback into JavaScript; one that arrives while Electron tears the
 * Node environment down cannot run there, and node-pty turns that into a C++ exception that aborts the app.
 */
export const PTY_EXIT_WAIT_MS = 2_000;
export const PTY_KILL_WAIT_MS = 1_000;
/** Longer than every plugin step of a launch together (prepare, resume, launch options, wrap). */
export const LAUNCH_INPUT_WAIT_MS = 60_000;

/** What happened to input handed to deliverInput. */
export type InputDelivery = { delivered: true } | { delivered: false; reason: string };

type LaunchContribution = Extract<PreparedLaunch, { ok: true }>;

export interface ProviderLifecycleSignal {
  kind: "lifecycle";
  state: "idle" | "working" | "needs_approval";
  event?: string;
  requestId?: string;
  threadId?: string;
}

/**
 * Why a snapshot reports a failing status, when that reason is not an ordinary
 * transition into failure: "restore" re-derived a persisted session's status
 * at launch, "user" is the outcome of a launch the user asked for in the UI.
 */
export type FailureOrigin = "restore" | "user";

type Emit = (
  channel: typeof IPC.terminalData | typeof IPC.terminalSession | typeof IPC.terminalRemoved,
  payload: TerminalDataEvent | SessionEvent | SessionRemovedEvent
) => void;

export class TerminalManager {
  private keyboardShortcuts: ShortcutBindings = { ...DEFAULT_SHORTCUTS };
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly emit: Emit;
  private readonly providerClis: ProviderCliRegistry;
  private readonly agentBrowser?: AgentBrowserLaunchCoordinator;
  private readonly agentRuntime?: AgentRuntimeLaunchCoordinator;
  private readonly spawnPty: typeof pty.spawn;
  // Renderer-reported card visibility, keyed by session and holding the
  // outputOffset at the moment it was hidden: the last offset the card saw.
  // Output keeps flowing through emit while hidden, addressed to the observers
  // only (see flushOutput), so the batch queue never holds renderer output.
  private readonly hiddenSinceOffset = new Map<string, number>();
  // Sessions with output waiting for the next batch, flushed together by one
  // timer: every session's batch leaves in the same task, so the renderer
  // transport can send them as one message (main/index.ts).
  private readonly queuedOutput = new Map<string, ManagedSession>();
  private outputTimer: ReturnType<typeof setTimeout> | null = null;
  private lifecycleHooksEnabled: boolean;
  private agentOrchestration: OrchestrationLaunchCoordinator | null = null;
  // Plugin tools a session of this role and agent gets in canvastty_agents (EP-6), read at launch.
  private pluginToolNames: (role: SessionRole, provider: ProviderId) => string[] = () => [];
  private launchPipeline: (Pick<LaunchPipeline, "normalizeOptions" | "unavailable" | "prepare" | "forgetSession"> & Partial<Pick<LaunchPipeline, "hasPolicy">>) | null = null;
  private sessionStore: TerminalSessionStore | null = null;
  private sessionRestoreMode: SessionRestoreMode = "off";
  // Without the registry a placed session can only come back stopped: it never runs locally.
  private environments: EnvironmentService | null = null;
  // Every text an agent reads from another card passes through it (EP-8).
  private redaction = new SecretRedactionRegistry();
  // Where each running card was actually started (an environment may move it) and its agent config folder.
  private readonly launchContexts = new Map<string, { cwd: string; configDir: string | null }>();
  private quitting = false;
  private readonly quitReleases: Promise<void>[] = [];
  // Every PTY started here whose exit has not been reported yet, closed cards included, with that exit.
  private readonly liveProcesses = new Map<IPty, Promise<void>>();
  private suppressPersistence = false;
  // The live agent-control descriptor, handed only to orchestrator-role sessions
  // spawned while it is set; null while the endpoint is off.
  private controlConnection: ControlConnection | null = null;
  // Set and cleared around a single synchronous session emit (see emitSession):
  // the main process reads it from its emit callback to tell a failure that is
  // merely re-derived state from one the user just caused.
  private emittingFailureOrigin: FailureOrigin | null = null;

  constructor(
    emit: Emit,
    providerClis: ProviderCliRegistry,
    agentBrowser?: AgentBrowserLaunchCoordinator,
    agentRuntime?: AgentRuntimeLaunchCoordinator,
    lifecycleHooksEnabled = true,
    spawnPty: typeof pty.spawn = pty.spawn
  ) {
    this.emit = emit;
    this.providerClis = providerClis;
    this.agentBrowser = agentBrowser;
    this.agentRuntime = agentRuntime;
    this.spawnPty = spawnPty;
    this.lifecycleHooksEnabled = lifecycleHooksEnabled;
  }

  configureOrchestration(coordinator: OrchestrationLaunchCoordinator | null): void {
    this.agentOrchestration = coordinator;
  }

  setKeyboardShortcuts(shortcuts: ShortcutBindings): void {
    this.keyboardShortcuts = { ...shortcuts };
  }

  /** Plugin agent tools: a session any of them applies to gets the canvastty_agents bridge. */
  configureAgentTools(names: ((role: SessionRole, provider: ProviderId) => string[]) | null): void {
    this.pluginToolNames = names ?? (() => []);
  }

  /** Plugin launch contributors; without them a session with launch options is never launched. */
  configureLaunchPipeline(pipeline: (Pick<LaunchPipeline, "normalizeOptions" | "unavailable" | "prepare" | "forgetSession"> & Partial<Pick<LaunchPipeline, "hasPolicy">>) | null): void {
    this.launchPipeline = pipeline;
  }

  /** Plugin session environments; without them a placed session is never launched. */
  configureEnvironments(registry: EnvironmentService | null): void {
    this.environments = registry;
  }

  /** The app-wide redaction registry (vault keys, plugin secrets); cards add their launch secrets to it. */
  configureRedaction(registry: SecretRedactionRegistry): void {
    this.redaction = registry;
  }

  /** Masks known secrets and key shapes in text another agent reads (observe, result, control screen, failures). */
  redactSecrets<T extends string | null>(text: T): T {
    return (text === null ? text : this.redaction.redact(text)) as T;
  }

  /** `redactSecrets(text)` cut to its last `maxChars` characters, masking only a window around that tail. */
  redactSecretsTail(text: string, maxChars: number): string {
    return this.redaction.redactTail(text, maxChars);
  }

  /** What decision hooks need to know about a running agent card; null for terminals and unknown ids. */
  decisionContext(id: string): DecisionSession | null {
    const session = this.sessions.get(id);
    if (!session || session.metadata.provider === "terminal") return null;
    const launched = this.launchContexts.get(id);
    return {
      provider: session.metadata.provider,
      role: session.metadata.role ?? "agent",
      cwd: launched?.cwd ?? session.metadata.cwd,
      configDirs: launched?.configDir ? [launched.configDir] : []
    };
  }

  /**
   * What plugins may know about a card (EP-4): its metadata, the folder it actually runs in (an environment may
   * move it) and its environment ref. No screen text.
   */
  pluginContext(id: string): {
    metadata: SessionMetadata; workingDirectory: string; environment: PersistedEnvironmentRef | null; restored: boolean; owner: string | null;
  } | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    return {
      metadata: publicSessionMetadata(session),
      workingDirectory: this.launchContexts.get(id)?.cwd ?? session.metadata.cwd,
      environment: session.extras.environment ? structuredClone(session.extras.environment) : null,
      restored: session.restored === true,
      owner: session.extras.ownerPluginId ?? null
    };
  }

  /** Records the plugin that started a card (EP-4); saved with the card so control survives a restore. */
  setPluginOwner(id: string, pluginId: string): void {
    const session = this.sessions.get(id);
    if (!session || session.extras.ownerPluginId === pluginId) return;
    session.extras.ownerPluginId = pluginId;
    this.schedulePersistence();
  }

  configureSessionPersistence(store: TerminalSessionStore, mode: SessionRestoreMode): void {
    this.sessionStore = store;
    this.sessionRestoreMode = mode;
  }

  async restorePersistedSessions(): Promise<void> {
    const store = this.sessionStore;
    if (!store) return;
    const persisted = await store.load();
    if (this.sessionRestoreMode === "off") {
      if (persisted.length > 0) await store.clear();
      return;
    }

    // Environments resume first; a card whose environment stopped comes back
    // stopped with the plugin's reason and never runs locally instead.
    const resumed = new Map<string, { ok: true } | { ok: false; reason: string }>();
    const environments = this.environments;
    if (environments) {
      await Promise.all(persisted.map(async (record) => {
        if (!record.environment || !record.restore || record.lastState !== "running") return;
        if (!environments.available(record.environment)) return;
        resumed.set(record.id, await environments.resume(record.environment, record.id));
      }));
    }
    // Then parents come first; a subagent whose owning session is gone restores
    // as nothing, since its parent's runtime state no longer exists.
    const steps = planSessionRestore(persisted, this.sessionRestoreMode, {
      isLiveSession: (id) => this.sessions.has(id),
      environmentAvailable: (environment, record) => resumed.get(record.id)?.ok ?? this.environmentUsable(environment),
      launchOptionsAvailable: (options) => this.unavailableLaunchPlugins(options).length === 0
    });
    for (const step of steps) this.restorePersistedSession(step, resumed.get(step.record.id));
    await this.persistSessions();
  }

  async setSessionRestoreMode(mode: SessionRestoreMode): Promise<void> {
    if (this.sessionRestoreMode === mode) return;
    this.sessionRestoreMode = mode;
    if (mode === "off") await this.sessionStore?.clear();
    else await this.persistSessions();
  }

  /** The per-card "Don't restore this card" choice. */
  setRestore(id: string, restore: boolean): SessionMetadata {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Terminal session does not exist.");
    if (typeof restore !== "boolean") throw new Error("Restore choice is invalid.");
    if (restore) delete session.metadata.skipRestore;
    else session.metadata.skipRestore = true;
    this.emitSession(session.metadata);
    this.schedulePersistence();
    return publicSessionMetadata(session);
  }

  async shutdown(): Promise<void> {
    await this.persistSessions().catch((error) => {
      console.warn("CanvasTTY terminal window state could not be saved during shutdown.", error);
    });
    this.suppressPersistence = true;
    // Quitting keeps every environment for the next start; nothing is released as "closed".
    this.quitting = true;
    this.disposeAll();
    await Promise.allSettled(this.quitReleases.splice(0));
    if (this.sessionStore) await this.sessionStore.flush().catch(() => undefined);
  }

  /**
   * Resolves once every PTY this manager started has exited, so the app never finishes quitting while a native
   * exit watcher is still pending. Called after `shutdown()` (which hung every card up): a process still running
   * after `exitWaitMs` is killed, and after `killWaitMs` more the wait gives up. Returns how many never exited.
   */
  async waitForProcessExits(exitWaitMs = PTY_EXIT_WAIT_MS, killWaitMs = PTY_KILL_WAIT_MS): Promise<number> {
    if (this.liveProcesses.size === 0) return 0;
    if (!await this.allProcessesExited(exitWaitMs)) {
      for (const process of this.liveProcesses.keys()) {
        try {
          // Windows PTYs take no signal.
          if (globalThis.process.platform === "win32") process.kill();
          else process.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
      await this.allProcessesExited(killWaitMs);
    }
    return this.liveProcesses.size;
  }

  private allProcessesExited(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const exited = Promise.all(this.liveProcesses.values()).then(() => true as const);
    return Promise.race([exited, timedOut]).finally(() => clearTimeout(timer));
  }

  list(): SessionSnapshot[] {
    return [...this.sessions.values()].map((session) => snapshot(session));
  }

  /**
   * Takes the failure origin of the session event being emitted right now, or
   * null for an ordinary snapshot. Only meaningful inside the emit callback:
   * the value is one-shot, so one failure can never be announced twice.
   */
  consumeFailureOrigin(): FailureOrigin | null {
    const origin = this.emittingFailureOrigin;
    this.emittingFailureOrigin = null;
    return origin;
  }

  listMetadata(): SessionMetadata[] {
    return [...this.sessions.values()].map(publicSessionMetadata);
  }

  /** One session's metadata by id, or null. Unlike list(), a lookup never copies any scrollback. */
  getMetadata(id: string): SessionMetadata | null {
    const session = this.sessions.get(id);
    return session ? publicSessionMetadata(session) : null;
  }

  geometry(id: string): { cols: number; rows: number } {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Terminal session does not exist.");
    return { cols: session.cols, rows: session.rows };
  }

  readBuffer(id: string): TerminalBufferSnapshot {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Terminal session does not exist.");
    return {
      buffer: session.bufferChunks.slice(session.bufferStart).join(""),
      outputOffset: session.outputOffset
    };
  }

  /**
   * Sessions launched with the orchestrator role while a connection is set get
   * it in their environment; ordinary sessions never do. Existing sessions are
   * not re-spawned, so their environment stays as it was at launch.
   */
  setControlConnection(connection: ControlConnection | null): void {
    this.controlConnection = connection ? { ...connection } : null;
  }

  create(
    request: CreateSessionRequest,
    control: { captureResult?: boolean; answerCaptureGrantExpiresAt?: number } = {}
  ): SessionSnapshot {
    assertCreateRequest(request);
    const threadId = request.resumeThreadId === undefined ? undefined : normalizeThreadId(request.provider, request.resumeThreadId);
    if (request.resumeThreadId !== undefined && (!threadId || !canResumeThreadById(request.provider) || request.environment)) {
      throw new Error("Invalid local conversation resume request.");
    }
    const resume: ResumeRequest = threadId ? { threadId } : null;
    if (control.captureResult && request.provider !== "codex") {
      throw new Error("Result capture requires a Codex session.");
    }
    assertDirectory(request.cwd);

    const role = request.role ?? "agent";
    if (request.parentSessionId !== undefined && !this.sessions.has(request.parentSessionId)) {
      throw new Error("Parent terminal session does not exist.");
    }

    const launchOptions = this.launchPipeline
      ? this.launchPipeline.normalizeOptions(request.provider, request.launchOptions)
      : request.launchOptions === undefined ? undefined : failWith("Plugin launch options are not available.");
    const environmentChoice = this.environments
      ? this.environments.normalizeChoice(request.provider, request.environment) ?? null
      : request.environment === undefined ? null : failWith("Plugin environments are not available.");

    const id = randomUUID();
    const metadata: SessionMetadata = {
      id,
      revision: 0,
      provider: request.provider,
      profile: request.profile,
      title: request.title?.trim() || defaultTitle(request.provider, request.cwd),
      titleCustomized: Boolean(request.title?.trim()),
      cwd: request.cwd,
      position: request.position,
      size: DEFAULT_TERMINAL_SIZE,
      role,
      ...(request.parentSessionId !== undefined ? { parentSessionId: request.parentSessionId } : {}),
      status: initialSessionStatus(request.provider),
      startedAt: Date.now(),
      exitCode: null,
      failureDetails: null
    };
    const awaitMeasuredGrid = request.provider === "grok"
      && this.providerClis.get(request.provider).state === "available";
    // With launch options, an environment or a launch policy the plugins answer first; the card waits and launches when they do.
    const contributed = (Boolean(launchOptions) || Boolean(environmentChoice) || this.policyApplies(request.provider)) && !awaitMeasuredGrid;
    const launched = awaitMeasuredGrid || contributed
      ? { process: null, agentBrowser: null, agentRuntime: null, agentOrchestration: null, failure: null }
      : this.spawnProcess(id, request.provider, request.profile, request.cwd,
        INITIAL_TERMINAL_COLS, INITIAL_TERMINAL_ROWS, resume, control.captureResult, role,
        control.answerCaptureGrantExpiresAt, null, request.parentSessionId);
    if (launched.failure) applyLaunchFailure(metadata, launched.failure);

    const session: ManagedSession = {
      metadata,
      process: launched.process,
      cols: INITIAL_TERMINAL_COLS,
      rows: INITIAL_TERMINAL_ROWS,
      bufferChunks: [],
      bufferStart: 0,
      bufferLength: 0,
      outputOffset: 0,
      pendingOutput: [],
      agentBrowser: launched.agentBrowser,
      agentRuntime: launched.agentRuntime,
      agentOrchestration: launched.agentOrchestration,
      lifecycle: this.lifecycleHooksEnabled
        ? createProviderLifecycleParser(request.provider, request.cwd)
        : null,
      awaitingInitialResize: awaitMeasuredGrid,
      resumeOnLaunch: resume,
      ...(threadId ? { threadId } : {}),
      captureResult: control.captureResult === true,
      extras: {
        ...(launchOptions ? { options: launchOptions } : {}),
        ...(environmentChoice ? { environmentChoice } : {})
      },
      launchToken: 0,
      launchCleanup: null,
      restoringLaunch: false,
      environmentReady: false,
      launchEpoch: 0,
      launchWaiters: new Set()
    };
    this.sessions.set(id, session);
    if (launched.process) this.bindProcess(id, session, launched.process);
    if (contributed) this.launchContributed(id, session, resume, null, control.answerCaptureGrantExpiresAt);
    const runtimeStatus = this.agentRuntime?.currentStatus(id);
    if (runtimeStatus) session.metadata.status = runtimeStatus;

    this.emitSession(metadata);
    this.schedulePersistence();
    return snapshot(session);
  }

  /** History belongs to this computer; a plugin environment's same id is a different conversation. */
  findLocalConversation(provider: ProviderId, threadId: string): SessionSnapshot | null {
    const matches = [...this.sessions.values()].filter((candidate) => candidate.metadata.provider === provider
      && candidate.threadId === threadId && !candidate.extras.environment && !candidate.extras.environmentChoice);
    const session = matches.find((candidate) => candidate.metadata.exitCode === null) ?? matches[0];
    return session ? snapshot(session) : null;
  }

  restart(id: string, options: { resume?: boolean } = {}): SessionSnapshot {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Terminal session does not exist.");
    if (session.metadata.exitCode === null) throw new Error("Terminal session is still running.");
    const environment = session.extras.environment;
    if (environment && !this.environmentUsable(environment)) {
      // Never run a placed session locally instead of where it belongs.
      throw new Error(`This card runs in ${environment.label} from plugin ${environment.pluginId}, which is not available. It was not started locally.`);
    }
    const pendingChoice = session.extras.environment ? undefined : session.extras.environmentChoice;
    if (pendingChoice && !this.environments?.available(pendingChoice)) {
      throw new Error(`${this.pendingEnvironmentReason(pendingChoice)} It was not started locally.`);
    }
    const missingPlugins = this.unavailableLaunchPlugins(session.extras.options);
    if (missingPlugins.length > 0) throw new Error(`Launch refused: ${missingLaunchPlugins(missingPlugins)}`);
    delete session.extras.heldState;
    delete session.metadata.restoreNote;
    // Input queued for the launch that ended never reaches this one.
    session.launchEpoch += 1;
    this.wakeLaunchWaiters(session);
    let resume: ResumeRequest = null;
    if (options.resume === true && session.metadata.provider !== "terminal") {
      const peers = [...this.sessions.values()].filter((candidate) => (
        candidate.metadata.provider === session.metadata.provider && candidate.metadata.cwd === session.metadata.cwd
      )).length;
      const chosen = chooseResume(session.metadata.provider, session.threadId, peers);
      resume = chosen.resume;
      if (chosen.note) session.metadata.restoreNote = chosen.note;
    } else {
      // A plain restart is a new conversation, so the old id must not be resumed later.
      delete session.threadId;
    }

    if (session.metadata.provider === "grok") {
      session.agentBrowser?.cleanup();
      session.agentRuntime?.cleanup();
      session.agentOrchestration?.cleanup();
      session.process = null;
      session.agentBrowser = null;
      session.agentRuntime = null;
      session.lifecycle = this.lifecycleHooksEnabled
        ? createProviderLifecycleParser(session.metadata.provider, session.metadata.cwd)
        : null;
      session.awaitingInitialResize = true;
      session.resumeOnLaunch = resume;
      session.metadata.startedAt = Date.now();
      session.metadata.status = initialSessionStatus(session.metadata.provider);
      session.metadata.turnCompleted = false;
      session.metadata.exitCode = null;
      session.metadata.failureDetails = null;
      this.emitSession(session.metadata);
      this.schedulePersistence();
      return snapshot(session);
    }

    session.agentOrchestration?.cleanup();
    if (this.contributed(session)) {
      session.process = null;
      session.agentBrowser = null;
      session.agentRuntime = null;
      session.agentOrchestration = null;
      session.awaitingInitialResize = false;
      session.lifecycle = this.lifecycleHooksEnabled
        ? createProviderLifecycleParser(session.metadata.provider, session.metadata.cwd)
        : null;
      session.metadata.startedAt = Date.now();
      session.metadata.status = initialSessionStatus(session.metadata.provider);
      session.metadata.exitCode = null;
      session.metadata.failureDetails = null;
      this.emitSession(session.metadata);
      this.launchContributed(id, session, resume, "user");
      return snapshot(session);
    }
    const launched = this.spawnProcess(
      id,
      session.metadata.provider,
      session.metadata.profile,
      session.metadata.cwd,
      session.cols,
      session.rows,
      resume,
      session.captureResult,
      session.metadata.role,
      undefined,
      null,
      session.metadata.parentSessionId
    );
    session.process = launched.process;
    session.agentBrowser = launched.agentBrowser;
    session.agentRuntime = launched.agentRuntime;
    session.agentOrchestration = launched.agentOrchestration;
    session.awaitingInitialResize = false;
    session.lifecycle = this.lifecycleHooksEnabled
      ? createProviderLifecycleParser(session.metadata.provider, session.metadata.cwd)
      : null;
    session.metadata.startedAt = Date.now();
    // A restart is a launch the user asked for, so its failure is news even
    // though the card already showed "failed" before they clicked.
    let failureOrigin: FailureOrigin | null = null;
    if (launched.failure) {
      applyLaunchFailure(session.metadata, launched.failure);
      failureOrigin = "user";
    } else {
      session.metadata.status = initialSessionStatus(session.metadata.provider);
      session.metadata.turnCompleted = false;
      session.metadata.exitCode = null;
      session.metadata.failureDetails = null;
      if (launched.process) this.bindProcess(id, session, launched.process);
      const runtimeStatus = this.agentRuntime?.currentStatus(id);
      if (runtimeStatus) session.metadata.status = runtimeStatus;
    }
    this.emitSession(session.metadata, failureOrigin);
    this.schedulePersistence();
    return snapshot(session);
  }

  input(id: string, data: string): void {
    this.inputChecked(id, data);
  }

  /** The card's launch waits for its plugins (or its measured grid): nothing can be written to it yet. */
  launchPending(id: string): boolean {
    const session = this.sessions.get(id);
    return Boolean(session && session.metadata.exitCode === null && !session.process);
  }

  /**
   * The one delivery rule for text another agent, a plugin or a controller sends to a card (spawn_agent's first
   * prompt, send_to_agent, plugin sessions.send). A running card gets it at once. A card whose launch plugins are
   * still preparing (launch options, a launch policy, an environment) or that waits for its grid gets it exactly
   * once, when that launch has started. A launch that is refused, fails, is cancelled or superseded (closed,
   * restarted), or does not start within LAUNCH_INPUT_WAIT_MS delivers nothing, says why, and drops the text:
   * it never reaches a later launch of the card.
   */
  async deliverInput(id: string, data: string, waitMs = LAUNCH_INPUT_WAIT_MS): Promise<InputDelivery> {
    const session = this.sessions.get(id);
    if (!session) return { delivered: false, reason: "The session does not exist." };
    const epoch = session.launchEpoch;
    const deadline = Date.now() + waitMs;
    const waiting = (): boolean => this.sessions.get(id) === session && session.launchEpoch === epoch
      && session.metadata.exitCode === null && !session.process;
    while (waiting()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { delivered: false, reason: `The session did not start within ${Math.round(waitMs / 1000)} s.` };
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(wake, remaining);
        function wake(): void {
          clearTimeout(timer);
          session!.launchWaiters.delete(wake);
          resolve();
        }
        session.launchWaiters.add(wake);
      });
    }
    if (this.sessions.get(id) !== session) return { delivered: false, reason: "The session was closed before it started." };
    if (session.launchEpoch !== epoch) return { delivered: false, reason: "The session was restarted before it started." };
    if (session.metadata.exitCode !== null) {
      return { delivered: false, reason: session.metadata.failureDetails
        ? `The session did not start: ${this.redactSecrets(session.metadata.failureDetails)}`
        : "The session has already exited." };
    }
    return this.inputChecked(id, data)
      ? { delivered: true }
      : { delivered: false, reason: "The terminal no longer accepts input." };
  }

  private wakeLaunchWaiters(session: ManagedSession): void {
    for (const wake of [...session.launchWaiters]) wake();
  }

  inputChecked(id: string, data: string): boolean {
    if (typeof data !== "string" || data.length === 0) return false;
    const session = this.sessions.get(id);
    if (!session || session.metadata.exitCode !== null || !session.process) return false;
    const process = session.process;
    const written = tryPtyOperation(() => process.write(data));
    if (written && ANSWERS_PROMPT.test(data)) this.settleAnsweredPrompt(id, session);
    return written;
  }

  /**
   * A hooked Claude card waits at its permission prompt (needs_approval) and the person answered it. When they declined
   * (Esc, or "No"), Claude interrupts the turn and runs no Stop hook, and its «✳» title defers to the hooks, so the card
   * would stay needs_approval while Claude waits at its prompt line. If, a moment later, no hook moved the card on (an
   * allowed tool reports PostToolUse, a new prompt PermissionRequest) and the title still shows no turn running, the
   * turn ended: idle.
   */
  private settleAnsweredPrompt(id: string, session: ManagedSession): void {
    if (session.metadata.status !== "needs_approval" || !titleDefersToHooks(session, "idle")) return;
    if (session.answeredPromptTimer) clearTimeout(session.answeredPromptTimer);
    const hooksBefore = session.hookSignals ?? 0;
    session.answeredPromptTimer = setTimeout(() => {
      session.answeredPromptTimer = undefined;
      if (this.sessions.get(id) !== session || session.metadata.exitCode !== null) return;
      if (session.metadata.status !== "needs_approval" || session.titleState === "working") return;
      if ((session.hookSignals ?? 0) !== hooksBefore) return;
      this.applyProviderSignal(id, { kind: "lifecycle", state: "idle" }, "title");
    }, ANSWERED_PROMPT_SETTLE_MS);
    session.answeredPromptTimer.unref?.();
  }

  resize(id: string, cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    const session = this.sessions.get(id);
    if (!session) return;
    const safeCols = Math.max(20, Math.min(400, Math.floor(cols)));
    const safeRows = Math.max(5, Math.min(200, Math.floor(rows)));
    session.cols = safeCols;
    session.rows = safeRows;
    if (session.awaitingInitialResize) {
      this.launchAwaitingSession(id, session);
      return;
    }
    if (session.metadata.exitCode !== null || !session.process) return;
    const process = session.process;
    tryPtyOperation(() => process.resize(safeCols, safeRows));
  }

  setBounds(id: string, bounds: SessionBounds): void {
    if (!isSessionBounds(bounds)) return;
    const session = this.sessions.get(id);
    if (!session) return;

    session.metadata.position = bounds.position;
    session.metadata.size = {
      width: clamp(bounds.size.width, MIN_TERMINAL_SIZE.width, MAX_TERMINAL_SIZE.width),
      height: clamp(bounds.size.height, MIN_TERMINAL_SIZE.height, MAX_TERMINAL_SIZE.height)
    };
    this.emitSession(session.metadata);
    this.schedulePersistence();
  }

  rename(id: string, title: string): SessionMetadata {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Terminal session does not exist.");
    if (typeof title !== "string") throw new Error("Window title is invalid.");

    const nextTitle = title.trim();
    if (nextTitle.length === 0) throw new Error("Window title cannot be empty.");
    session.metadata.title = nextTitle.slice(0, 80);
    session.metadata.titleCustomized = true;
    this.emitSession(session.metadata);
    this.schedulePersistence();
    return publicSessionMetadata(session);
  }

  /** `source` "hook" is the agent's own lifecycle hook (through the runtime gateway); "title" is its terminal title. */
  applyProviderSignal(id: string, signal: ProviderLifecycleSignal, source: "hook" | "title" = "hook"): void {
    const session = this.sessions.get(id);
    if (!this.lifecycleHooksEnabled || !session || session.metadata.status === "done" || session.metadata.status === "failed") return;
    if (source === "hook") session.hookSignals = (session.hookSignals ?? 0) + 1;

    const threadId = normalizeThreadId(session.metadata.provider, signal.threadId);
    const threadChanged = Boolean(threadId && threadId !== session.threadId);
    if (threadChanged) {
      session.threadId = threadId;
      this.schedulePersistence();
    }

    const nextStatus = signal.state;
    const completed = nextStatus === "idle" && ["Stop", "StopFailure", "StopCancelled"].includes(signal.event ?? "");
    const nextTurnCompleted = nextStatus === "working" ? false : completed || Boolean(session.metadata.turnCompleted);
    if (!threadChanged && session.metadata.status === nextStatus && Boolean(session.metadata.turnCompleted) === nextTurnCompleted) return;
    session.metadata.status = nextStatus;
    session.metadata.turnCompleted = nextTurnCompleted;
    this.emitSession(session.metadata);
  }

  setLifecycleHooksEnabled(enabled: boolean): void {
    const next = Boolean(enabled);
    if (this.lifecycleHooksEnabled === next) return;
    this.lifecycleHooksEnabled = next;
    if (next) return;
    for (const session of this.sessions.values()) {
      session.lifecycle = null;
      if (
        session.metadata.provider === "terminal"
        || session.metadata.status === "done"
        || session.metadata.status === "failed"
        || session.metadata.status === "unavailable"
      ) continue;
      session.metadata.status = "unavailable";
      this.emitSession(session.metadata);
    }
  }

  /**
   * Reports whether the session's card renders live output. A hidden session
   * keeps appending to its scrollback and advancing outputOffset, so history
   * stays canonical, and keeps emitting terminalData for the in-process
   * observers; only the renderer's delivery of that stream is gated.
   */
  setVisible(id: string, visible: boolean): void {
    if (typeof id !== "string" || typeof visible !== "boolean") return;
    const session = this.sessions.get(id);
    if (!session) return;
    const hiddenSince = this.hiddenSinceOffset.get(id);
    if (visible === (hiddenSince === undefined)) return;

    if (!visible) {
      // Visible -> hidden: flush the batch queued while the card was still
      // live instead of dropping it. It was produced while visible, so it goes
      // to every consumer; from here on flushOutput addresses the observers
      // only. Nothing is lost, and nothing is duplicated because the renderer
      // dedups by absolute offset.
      this.flushOutput(id, session);
      this.hiddenSinceOffset.set(id, session.outputOffset);
      return;
    }

    // Hidden -> visible: first hand the observers whatever is still batched
    // (still addressed to them alone, since the card has not seen it and the
    // replay below covers it), then replay the output produced since
    // hiddenSince, ending at the current outputOffset, to the renderer alone.
    // The card already wrote everything up to hiddenSince (the batch pending at
    // hide time was flushed to it), and it drops anything it already wrote (its
    // offset is absolute; features/terminal/terminalOutput.ts), so the missed
    // suffix arrives — once — without resending the history before it. The
    // observers get no replay: they already received every chunk.
    //
    // The window is bounded by MAX_SCROLLBACK_CHARS: when the hidden stretch
    // was longer than the ring, the buffer no longer reaches back to
    // hiddenSince and the head of that stretch is gone for good. There is no
    // field on TerminalDataEvent to say so, so the consumer derives the hole
    // from the offset arithmetic (the event starts after the offset it already
    // wrote) and marks it in the card instead of stitching it as continuous
    // output. Never widen the ring to hide this: the truncation must stay
    // visible.
    this.flushOutput(id, session);
    this.hiddenSinceOffset.delete(id);
    if (hiddenSince === undefined || session.outputOffset === hiddenSince) return;
    const data = scrollbackTail(session, session.outputOffset - hiddenSince);
    if (data.length > 0) {
      this.emit(IPC.terminalData, { id, data, outputOffset: session.outputOffset, audience: "renderer" });
    }
  }

  /**
   * Closes a card. A card in a plugin environment releases it: `keepEnvironmentData` is the person's
   * answer to "Keep environment data?" (kept unless they said no). Quitting releases nothing.
   */
  dispose(id: string, options: { keepEnvironmentData?: boolean } = {}): void {
    const session = this.sessions.get(id);
    if (!session) return;

    this.flushOutput(id, session);
    this.sessions.delete(id);
    this.wakeLaunchWaiters(session);
    this.hiddenSinceOffset.delete(id);
    this.launchContexts.delete(id);
    this.redaction.clear(`session:${id}`);
    session.launchToken += 1;
    void session.launchCleanup?.().catch(() => undefined);
    session.launchCleanup = null;
    if (session.extras.options) void this.launchPipeline?.forgetSession(id).catch(() => undefined);
    session.agentBrowser?.cleanup();
    session.agentRuntime?.cleanup();
    session.agentOrchestration?.cleanup();
    if (session.process) {
      try {
        session.process.kill();
      } catch (error) {
        console.warn(`PTY ${id} could not be killed cleanly.`, error);
      }
    }
    const environment = session.extras.environment;
    if (environment && this.environments) {
      if (!this.quitting) {
        void this.environments.release(environment, id, { keepData: options.keepEnvironmentData !== false, reason: "closed" });
      } else if (this.sessionRestoreMode === "off") {
        // Nothing is saved, so the environment will not come back: stop its compute, keep its data.
        this.quitReleases.push(this.environments.release(environment, id, {
          keepData: true, reason: "quit", timeoutMs: QUIT_RELEASE_TIMEOUT_MS
        }));
      }
    }
    this.emit(IPC.terminalRemoved, { id });
    this.schedulePersistence();
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.dispose(id);
    }
  }

  private restorePersistedSession(step: RestoreStep, resumed?: { ok: true } | { ok: false; reason: string }): void {
    const descriptor = step.record;
    if (this.sessions.has(descriptor.id)) return;
    const metadata: SessionMetadata = {
      id: descriptor.id,
      revision: 0,
      provider: descriptor.provider,
      profile: descriptor.profile,
      title: descriptor.title,
      titleCustomized: descriptor.titleCustomized,
      cwd: descriptor.cwd,
      position: descriptor.position,
      size: descriptor.size,
      role: descriptor.role,
      ...(descriptor.parentSessionId !== undefined ? { parentSessionId: descriptor.parentSessionId } : {}),
      status: initialSessionStatus(descriptor.provider),
      startedAt: Date.now(),
      exitCode: null,
      failureDetails: null,
      ...(step.note ? { restoreNote: step.note } : {}),
      ...(descriptor.environment ? { environment: environmentBadge(descriptor.environment) } : {})
    };
    const extras: PersistedSessionExtras = {
      ...(descriptor.options ? { options: descriptor.options } : {}),
      ...(descriptor.environment ? { environment: descriptor.environment } : {}),
      ...(descriptor.environmentChoice && !descriptor.environment ? { environmentChoice: descriptor.environmentChoice } : {}),
      ...(descriptor.ownerPluginId ? { ownerPluginId: descriptor.ownerPluginId } : {})
    };

    let process: IPty | null = null;
    let agentBrowser: PreparedAgentBrowserPtyLaunch | null = null;
    let agentRuntime: PreparedAgentRuntimePtyLaunch | null = null;
    let agentOrchestration: PreparedOrchestrationPtyLaunch | null = null;
    let directoryReady = step.launch !== "stopped";
    if (step.launch === "stopped") {
      // A finished card comes back as it ended; a placed card whose environment
      // is unavailable is held with its reason and keeps its saved state.
      if (step.note === "environment-unavailable" && descriptor.environment) {
        extras.heldState = descriptor.lastState;
        metadata.status = "failed";
        metadata.exitCode = descriptor.exitCode ?? 1;
        metadata.failureDetails = resumed && !resumed.ok
          ? `Environment stopped: ${resumed.reason}`
          : this.environments?.unavailableReason(descriptor.environment)
            ?? `Needs plugin ${descriptor.environment.pluginId} (${descriptor.environment.label}). It was not started locally.`;
      } else if (step.note === "environment-pending" && extras.environmentChoice) {
        // The app quit while the plugin prepared it: whatever it prepared then is unknown, so nothing runs
        // until the person restarts it, which prepares again with the saved options.
        extras.heldState = descriptor.lastState;
        metadata.status = "failed";
        metadata.exitCode = descriptor.exitCode ?? 1;
        const choice = extras.environmentChoice;
        metadata.failureDetails = this.environments?.available(choice)
          ? `Its environment (${choice.kind} from plugin ${choice.pluginId}) was being prepared when CanvasTTY closed. It was not started locally; Restart prepares it again.`
          : `${this.pendingEnvironmentReason(choice)} It was not started locally.`;
      } else if (step.note === "plugin-unavailable" && descriptor.options) {
        extras.heldState = descriptor.lastState;
        metadata.status = "failed";
        metadata.exitCode = descriptor.exitCode ?? 1;
        metadata.failureDetails = `Launch refused: ${missingLaunchPlugins(this.unavailableLaunchPlugins(descriptor.options))}`;
      } else {
        metadata.exitCode = descriptor.exitCode ?? (descriptor.lastState === "exited" ? 0 : 1);
        metadata.status = metadata.exitCode === 0 ? "done" : "failed";
        if (extras.environmentChoice && metadata.status === "failed") {
          metadata.failureDetails = "Its environment was not prepared, so it was not started locally; Restart prepares it again.";
        }
      }
    }
    if (directoryReady) {
      try {
        assertDirectory(descriptor.cwd);
      } catch (error) {
        directoryReady = false;
        metadata.status = "failed";
        metadata.exitCode = 1;
        metadata.failureDetails = error instanceof Error ? error.message : String(error);
      }
    }
    const resume: ResumeRequest = step.launch === "stopped" ? null : step.launch;
    const awaitMeasuredGrid = directoryReady
      && descriptor.provider === "grok"
      && this.providerClis.get(descriptor.provider).state === "available";

    const contributed = directoryReady && !awaitMeasuredGrid
      && (Boolean(extras.options) || Boolean(extras.environment) || this.policyApplies(descriptor.provider));
    if (directoryReady && !awaitMeasuredGrid && !contributed) {
      try {
        const launched = this.spawnProcess(
          descriptor.id,
          descriptor.provider,
          descriptor.profile,
          descriptor.cwd,
          INITIAL_TERMINAL_COLS,
          INITIAL_TERMINAL_ROWS,
          resume,
          false,
          descriptor.role,
          undefined,
          null,
          descriptor.parentSessionId
        );
        process = launched.process;
        agentBrowser = launched.agentBrowser;
        agentRuntime = launched.agentRuntime;
        agentOrchestration = launched.agentOrchestration;
        if (launched.failure) applyLaunchFailure(metadata, launched.failure);
      } catch (error) {
        metadata.status = "failed";
        metadata.exitCode = 1;
        metadata.failureDetails = error instanceof Error ? error.message : String(error);
      }
    }

    // A card that started (or whose plugins are preparing its launch) comes back tied to
    // the conversation the plan chose (none for a fresh start); one that did not start
    // keeps its recorded id for Continue.
    const started = process !== null || awaitMeasuredGrid || contributed;
    const threadId = started ? step.threadId : descriptor.threadId;
    const session: ManagedSession = {
      metadata,
      process,
      cols: INITIAL_TERMINAL_COLS,
      rows: INITIAL_TERMINAL_ROWS,
      bufferChunks: [],
      bufferStart: 0,
      bufferLength: 0,
      outputOffset: 0,
      pendingOutput: [],
      agentBrowser,
      agentRuntime,
      agentOrchestration,
      lifecycle: this.lifecycleHooksEnabled
        ? createProviderLifecycleParser(descriptor.provider, descriptor.cwd)
        : null,
      awaitingInitialResize: awaitMeasuredGrid,
      resumeOnLaunch: awaitMeasuredGrid ? resume : null,
      ...(threadId ? { threadId } : {}),
      captureResult: false,
      extras,
      launchToken: 0,
      launchCleanup: null,
      restoringLaunch: awaitMeasuredGrid,
      environmentReady: resumed?.ok === true,
      restored: true,
      launchEpoch: 0,
      launchWaiters: new Set()
    };
    this.sessions.set(descriptor.id, session);
    if (process) this.bindProcess(descriptor.id, session, process);
    if (contributed) this.launchContributed(descriptor.id, session, resume, "restore", undefined, true);
    const runtimeStatus = this.agentRuntime?.currentStatus(descriptor.id);
    if (runtimeStatus) session.metadata.status = runtimeStatus;
    // Restoring re-derives a persisted session's status, so a failure here is
    // state this launch found (a folder that vanished between runs), not
    // something that happened under the user — announcing it every launch
    // would notify about the same silent state again and again.
    this.emitSession(metadata, metadata.status === "failed" ? "restore" : null);
  }

  private persistSessions(): Promise<void> {
    if (this.sessionRestoreMode === "off" || this.suppressPersistence || !this.sessionStore) {
      return Promise.resolve();
    }
    return this.sessionStore.replace(
      [...this.sessions.values()].map((session) => persistedTerminalSession(session.metadata, session.threadId, session.extras))
    );
  }

  private schedulePersistence(): void {
    void this.persistSessions().catch((error) => {
      console.warn("CanvasTTY terminal window state could not be saved.", error);
    });
  }

  private emitSession(metadata: SessionMetadata, failureOrigin: FailureOrigin | null = null): void {
    metadata.revision += 1;
    this.emittingFailureOrigin = failureOrigin;
    const session = this.sessions.get(metadata.id);
    this.emit(IPC.terminalSession, { session: session ? publicSessionMetadata(session) : structuredClone(metadata) });
    // The emit callback is the only legitimate reader and has already run.
    this.emittingFailureOrigin = null;
  }

  private launchAwaitingSession(id: string, session: ManagedSession): void {
    if (!session.awaitingInitialResize) return;
    session.awaitingInitialResize = false;
    const resume = session.resumeOnLaunch;
    session.resumeOnLaunch = null;
    if (this.contributed(session)) {
      this.launchContributed(id, session, resume, null, undefined, session.restoringLaunch);
      session.restoringLaunch = false;
      return;
    }
    try {
      const launched = this.spawnProcess(
        id,
        session.metadata.provider,
        session.metadata.profile,
        session.metadata.cwd,
        session.cols,
        session.rows,
        resume,
        session.captureResult,
        session.metadata.role,
        undefined,
        null,
        session.metadata.parentSessionId
      );
      session.process = launched.process;
      session.agentBrowser = launched.agentBrowser;
      session.agentRuntime = launched.agentRuntime;
      session.agentOrchestration = launched.agentOrchestration;
      if (launched.failure) {
        applyLaunchFailure(session.metadata, launched.failure);
      } else {
        session.metadata.status = initialSessionStatus(session.metadata.provider);
        session.metadata.exitCode = null;
        session.metadata.failureDetails = null;
        if (launched.process) this.bindProcess(id, session, launched.process);
        const runtimeStatus = this.agentRuntime?.currentStatus(id);
        if (runtimeStatus) session.metadata.status = runtimeStatus;
      }
    } catch (error) {
      session.process = null;
      session.agentBrowser = null;
      session.agentRuntime = null;
      session.metadata.status = "failed";
      session.metadata.exitCode = 1;
      session.metadata.failureDetails = error instanceof Error ? error.message : String(error);
    }
    this.emitSession(session.metadata);
    this.wakeLaunchWaiters(session);
  }

  private spawnProcess(
    id: string,
    provider: ProviderId,
    profile: CreateSessionRequest["profile"],
    cwd: string,
    cols = INITIAL_TERMINAL_COLS,
    rows = INITIAL_TERMINAL_ROWS,
    resume: ResumeRequest = null,
    captureResult = false,
    role: SessionRole = "agent",
    answerCaptureGrantExpiresAt?: number,
    contribution: LaunchContribution | null = null,
    parentSessionId?: string
  ): {
    process: IPty | null;
    agentBrowser: PreparedAgentBrowserPtyLaunch | null;
    agentRuntime: PreparedAgentRuntimePtyLaunch | null;
    agentOrchestration: PreparedOrchestrationPtyLaunch | null;
    failure: UnavailableProviderCli | null;
  } {
    const planned = this.planSpawn(id, provider, profile, cwd, resume, captureResult, role, answerCaptureGrantExpiresAt, contribution,
      this.personTrustedFolder(parentSessionId, cwd));
    if ("failure" in planned) {
      return { process: null, agentBrowser: null, agentRuntime: null, agentOrchestration: null, failure: planned.failure };
    }
    try {
      const process = this.spawnPty(planned.command, planned.args, {
        name: "xterm-256color", cols, rows, cwd: planned.cwd, env: planned.env
      });
      this.launchContexts.set(id, { cwd: planned.cwd, configDir: planned.env.CLAUDE_CONFIG_DIR ?? null });
      return {
        process,
        agentBrowser: planned.agentBrowser,
        agentRuntime: planned.agentRuntime,
        agentOrchestration: planned.agentOrchestration,
        failure: null
      };
    } catch (error) {
      planned.cleanup();
      throw error;
    }
  }

  /** Everything a launch needs short of the PTY, so an environment can wrap it first. */
  private planSpawn(
    id: string,
    provider: ProviderId,
    profile: CreateSessionRequest["profile"],
    cwd: string,
    resume: ResumeRequest,
    captureResult: boolean,
    role: SessionRole,
    answerCaptureGrantExpiresAt: number | undefined,
    contribution: LaunchContribution | null,
    trustedFolder?: string,
    environmentWrapped = false
  ): PlannedSpawn | { failure: UnavailableProviderCli } {
    const providerCli = provider === "terminal" ? undefined : this.providerClis.get(provider);
    if (providerCli?.state === "unavailable") return { failure: providerCli };
    // What decides whether Claude's lifecycle hooks may go over HTTP (ClaudeHttpHooks.ts): where and how it runs.
    const claudeHttp = provider === "claude" && providerCli?.state === "available" ? {
      executable: providerCli.executable,
      profile,
      environmentWrapped,
      env: { ...terminalEnvironment(), ...providerCli.environment, ...(contribution?.env ?? {}) },
      args: contribution?.args ?? [],
      cwd
    } : undefined;
    const agentRuntime = provider === "terminal"
      ? null
      : this.agentRuntime?.prepareLaunch({ terminalSessionId: id, provider, cwd,
        ...(captureResult ? { captureResult: true } : {}),
        ...(claudeHttp ? { claudeHttp } : {}),
        ...(answerCaptureGrantExpiresAt === undefined ? {} : { answerCaptureGrantExpiresAt }) }) ?? null;
    let pluginTools: string[] = [];
    try {
      pluginTools = provider === "terminal" ? [] : this.pluginToolNames(role, provider);
    } catch {
      // Plugins never block a launch; the session simply gets no plugin tools.
    }
    const bridged = role === "orchestrator" || pluginTools.length > 0;
    const agentOrchestration = bridged && this.agentOrchestration?.isEnabled
      ? this.agentOrchestration.prepareLaunch({ terminalSessionId: id })
      : null;
    let agentBrowser: PreparedAgentBrowserPtyLaunch | null = null;
    const cleanup = (): void => {
      agentBrowser?.cleanup();
      agentRuntime?.cleanup();
      agentOrchestration?.cleanup();
    };
    try {
      // omp and pi take no browser bridge, exactly like grok: the adapter chain below
      // ends in the Kimi MCP configuration, which would hand them foreign launch flags.
      // cursor stays out too until its CLI grows a measured browser adapter,
      // and minimax until its MCP configuration is wired (plain PTY for now).
      // devin is cloud-session oriented and takes no browser adapter yet,
      // and antigravity keeps plain PTY integration for the same reason.
      agentBrowser = provider === "terminal" || provider === "grok" || provider === "omp" || provider === "pi" || provider === "cursor" || provider === "minimax" || provider === "devin" || provider === "antigravity"
        ? null
        : this.agentBrowser?.prepareLaunch({
          terminalSessionId: id,
          provider,
          cwd,
          ...(bridged ? {
            includeOrchestration: true,
            orchestrationTools: [...(role === "orchestrator" ? ORCHESTRATION_TOOL_NAMES : []), ...pluginTools]
          } : {})
        }) ?? null;
      const baseEnvironment = terminalEnvironment();
      const browserEnvironment = agentBrowser?.environment ?? {};
      const runtimeEnvironment = agentRuntime?.environment ?? {};
      const orchestrationEnvironment = agentOrchestration?.environment ?? {};
      const providerEnvironment = {
        ...(provider === "opencode"
          ? mergeOpenCodeLaunchEnvironment(browserEnvironment, runtimeEnvironment)
          : { ...browserEnvironment, ...runtimeEnvironment }),
        ...orchestrationEnvironment,
        // Orchestrators alone learn where the control descriptor and CLI are.
        ...controlEnvironment(role, this.controlConnection)
      };
      const providerArgs = [...(agentRuntime?.args ?? []), ...(agentBrowser?.args ?? [])];
      // Stable terminal observations for the CLI controller; leave ordinary launches unchanged.
      if (captureResult && provider === "codex") providerArgs.push("-c", "tui.animations=false");
      // A Codex subagent in the person's folder is not asked to trust it again (this run only, never ~/.codex).
      if (provider === "codex" && trustedFolder) providerArgs.push(...codexTrustArguments([trustedFolder]));
      // Plugin arguments follow the core's own and precede the resume selection.
      if (contribution) providerArgs.push(...contribution.args);
      const launch = resolveTerminalLaunch(provider, profile, providerArgs, {
        shortcuts: this.keyboardShortcuts,
        environment: { ...baseEnvironment, ...providerEnvironment },
        ...(providerCli ? { providerCli } : {}),
        resumePrevious: resume !== null,
        ...(resume && typeof resume === "object" ? { resumeThreadId: resume.threadId } : {}),
        ...(contribution?.thirdPartyModel ? { thirdPartyModel: true } : {})
      });
      const session = this.sessions.get(id);
      if (session) setAutoDowngraded(session.metadata, profile === "auto" && contribution?.thirdPartyModel === true);
      // A plugin may add to the person's environment, never replace what the core sets for this launch.
      const contributedEnvironment = contribution?.env ?? {};
      const collision = Object.keys(contributedEnvironment)
        .find((key) => key in providerEnvironment || key in (launch.environment ?? {}));
      if (collision) {
        throw new Error(`Launch refused: ${contribution!.envSources[collision]} sets ${collision}, which CanvasTTY sets for this launch.`);
      }
      const launchEnvironment = { ...contributedEnvironment, ...providerEnvironment, ...launch.environment };
      return {
        command: launch.command,
        args: launch.args,
        cwd,
        env: { ...baseEnvironment, ...launchEnvironment },
        launchEnvironment,
        agentBrowser,
        agentRuntime,
        agentOrchestration,
        cleanup
      };
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  /**
   * For a subagent: the folder the person chose for the top-level agent it descends from, when that agent runs on this
   * computer, and this subagent's folder is it or inside it. The subagent's own real folder then needs no trust answer
   * of the person again; unreadable counts as outside.
   */
  private personTrustedFolder(parentSessionId: string | undefined, cwd: string): string | undefined {
    let root: ManagedSession | undefined;
    for (let depth = 0, next = parentSessionId; next !== undefined && depth < 64; depth++) {
      root = this.sessions.get(next);
      if (!root) return undefined;
      next = root.metadata.parentSessionId;
    }
    if (!root || root.extras.environment) return undefined;
    try {
      const folder = realpathSync(cwd);
      return isPathInside(realpathSync(root.metadata.cwd), folder) ? folder : undefined;
    } catch {
      return undefined;
    }
  }

  private contributed(session: ManagedSession): boolean {
    return Boolean(session.extras.options) || Boolean(session.extras.environment) || Boolean(session.extras.environmentChoice)
      || this.policyApplies(session.metadata.provider);
  }

  /** A trusted plugin's launch policy applies to this agent: its launches wait for the policy's answer. */
  private policyApplies(provider: ProviderId): boolean {
    try { return this.launchPipeline?.hasPolicy?.(provider) === true; } catch { return false; }
  }

  private pendingEnvironmentReason(choice: SessionEnvironmentChoice): string {
    return `Needs plugin ${choice.pluginId} (${choice.kind}) to prepare its environment; it is disabled, removed, or its native code is not trusted.`;
  }

  private environmentUsable(environment: PersistedEnvironmentRef): boolean {
    return this.environments?.available(environment) ?? false;
  }

  private unavailableLaunchPlugins(options: Record<string, unknown> | undefined): string[] {
    if (!options) return [];
    return this.launchPipeline ? this.launchPipeline.unavailable(options) : Object.keys(options).sort();
  }

  /**
   * Launches through plugins: the environment is prepared (or resumed), the chosen launch services
   * contribute, and the environment wraps the command. The card waits until they answer; a refusal,
   * timeout, error or conflict leaves it failed with the reason, and nothing runs locally instead.
   */
  private launchContributed(
    id: string,
    session: ManagedSession,
    resume: ResumeRequest,
    failureOrigin: FailureOrigin | null,
    answerCaptureGrantExpiresAt?: number,
    restoring = false
  ): void {
    const token = ++session.launchToken;
    const { metadata } = session;
    void this.runContributedLaunch(id, session, token, resume, restoring, answerCaptureGrantExpiresAt)
      .catch((error: unknown): LaunchOutcome => {
        metadata.failureDetails = this.redactSecrets(`Launch refused: ${error instanceof Error ? error.message : String(error)}`);
        return "failed";
      })
      .then((outcome) => {
        if (outcome === "superseded" || this.sessions.get(id) !== session || session.launchToken !== token) return;
        if (outcome === "failed" && metadata.status !== "failed") {
          metadata.status = "failed";
          metadata.exitCode = 1;
        }
        this.emitSession(metadata, outcome === "failed" ? failureOrigin : null);
        this.schedulePersistence();
      })
      .finally(() => this.wakeLaunchWaiters(session));
  }

  private async runContributedLaunch(
    id: string,
    session: ManagedSession,
    token: number,
    resume: ResumeRequest,
    restoring: boolean,
    answerCaptureGrantExpiresAt: number | undefined
  ): Promise<LaunchOutcome> {
    const { metadata } = session;
    const live = (): boolean => this.sessions.get(id) === session && session.launchToken === token && !session.process;
    const refuse = (reason: string): LaunchOutcome => {
      // "Launch refused" leads, so the failure summary quotes the reason as the cause.
      metadata.failureDetails = this.redactSecrets(`Launch refused: ${reason}`);
      return "failed";
    };
    const environments = this.environments;

    // 1. Place a new session where the person chose. The choice stays saved with the card until the plugin has
    // prepared it, so a card whose preparation was cut short (quit, crash) or failed never restores locally.
    const choice = session.extras.environmentChoice;
    if (choice && !session.extras.environment) {
      if (!environments) return refuse("plugin environments are not available.");
      const placed = await environments.prepare({ sessionId: id, provider: metadata.provider, cwd: metadata.cwd, choice });
      if (!live()) {
        // An answer for a launch that no longer exists (the card was closed or restarted, or the app is quitting)
        // is never adopted or saved: nobody used it, so it is released at once and nothing is kept.
        if (placed.ok) void environments.release(placed.environment, id, { keepData: false, reason: "closed" });
        return "superseded";
      }
      if (!placed.ok) return refuse(placed.reason);
      delete session.extras.environmentChoice;
      session.environmentReady = true;
      session.extras.environment = placed.environment;
      metadata.environment = environmentBadge(placed.environment);
      if (placed.cwd && placed.cwd !== metadata.cwd) {
        metadata.cwd = placed.cwd;
        session.lifecycle = this.lifecycleHooksEnabled
          ? createProviderLifecycleParser(metadata.provider, metadata.cwd)
          : null;
      }
      this.schedulePersistence();
    }

    // 2. A saved environment resumes before its first launch in this run.
    const environment = session.extras.environment;
    if (environment && !session.environmentReady) {
      if (!environments?.available(environment)) {
        return refuse(environments?.unavailableReason(environment) ?? `needs plugin ${environment.pluginId}; it was not started locally.`);
      }
      const resumed = await environments.resume(environment, id);
      if (!live()) return "superseded";
      if (!resumed.ok) return refuse(`environment stopped: ${resumed.reason}`);
      session.environmentReady = true;
    }

    // 3. Chosen launch contributors, and the launch policies that apply.
    let contribution: LaunchContribution | null = null;
    const trustedFolder = session.extras.environment ? undefined : this.personTrustedFolder(metadata.parentSessionId, metadata.cwd);
    if (session.extras.options || this.policyApplies(metadata.provider)) {
      const pipeline = this.launchPipeline;
      if (!pipeline) return refuse(missingLaunchPlugins(Object.keys(session.extras.options ?? {})));
      const placedIn = session.extras.environment;
      const prepared = await pipeline.prepare({
        sessionId: id,
        provider: metadata.provider,
        profile: metadata.profile,
        role: metadata.role,
        cwd: metadata.cwd,
        ...(metadata.parentSessionId !== undefined ? { parentSessionId: metadata.parentSessionId } : {}),
        restoring,
        resume: resume !== null,
        options: structuredClone(session.extras.options ?? {}) as Record<string, Record<string, boolean | string>>,
        environment: placedIn ? { pluginId: placedIn.pluginId, kind: placedIn.kind } : null,
        ...(trustedFolder ? { trustedFolder } : {})
      });
      if (!live()) {
        if (prepared.ok) void prepared.cleanup().catch(() => undefined);
        return "superseded";
      }
      if (!prepared.ok) return refuse(prepared.reason);
      contribution = prepared;
      this.addLaunchSecrets(session, prepared.secrets);
    }
    const dropContribution = (): void => {
      void contribution?.cleanup().catch(() => undefined);
    };

    // 4. The host spawns the PTY; an environment only rewrites what is spawned.
    let planned: PlannedSpawn | { failure: UnavailableProviderCli };
    try {
      planned = this.planSpawn(id, metadata.provider, metadata.profile, metadata.cwd, resume,
        session.captureResult, metadata.role, answerCaptureGrantExpiresAt, contribution, trustedFolder, Boolean(environment));
    } catch (error) {
      dropContribution();
      metadata.failureDetails = this.redactSecrets(error instanceof Error ? error.message : String(error));
      return "failed";
    }
    if ("failure" in planned) {
      dropContribution();
      applyLaunchFailure(metadata, planned.failure);
      return "failed";
    }
    const abandon = (): void => {
      planned.cleanup();
      dropContribution();
    };
    let spawn: { command: string; args: string[] | string; cwd: string; env: Record<string, string> } = planned;
    if (environment && environments) {
      if (typeof planned.args === "string") {
        abandon();
        return refuse("this provider's Windows batch launcher cannot run in a plugin environment.");
      }
      const secretValues = new Set(contribution?.secrets ?? []);
      const secretEnvNames = Object.keys(contribution?.env ?? {}).filter((key) => secretValues.has(contribution!.env[key]!));
      // The environment sees the launch's own variables, never CanvasTTY's reserved ones or secret values.
      const visible = Object.fromEntries(Object.entries(planned.launchEnvironment)
        .filter(([key]) => !RESERVED_ENV.test(key) && !secretEnvNames.includes(key)));
      const wrapped = await environments.wrap(environment, {
        sessionId: id,
        provider: metadata.provider,
        launch: { command: planned.command, args: planned.args, env: visible, cwd: planned.cwd },
        secretEnvNames,
        takenEnv: new Set(Object.keys(planned.launchEnvironment)),
        path: launchSearchPath(planned.env)
      });
      if (!live()) {
        abandon();
        return "superseded";
      }
      if (!wrapped.ok) {
        abandon();
        return refuse(wrapped.reason);
      }
      this.addLaunchSecrets(session, wrapped.secrets);
      spawn = { command: wrapped.command, args: wrapped.args, cwd: wrapped.cwd, env: { ...planned.env, ...wrapped.env } };
    }
    let process: IPty;
    try {
      process = this.spawnPty(spawn.command, spawn.args, {
        name: "xterm-256color", cols: session.cols, rows: session.rows, cwd: spawn.cwd, env: spawn.env
      });
    } catch (error) {
      abandon();
      metadata.failureDetails = this.redactSecrets(error instanceof Error ? error.message : String(error));
      return "failed";
    }
    session.process = process;
    if (planned.launchEnvironment.CANVASTTY_CODEX_KEYBOARD) {
      metadata.nativeEditor = JSON.parse(planned.launchEnvironment.CANVASTTY_CODEX_KEYBOARD);
    } else {
      delete metadata.nativeEditor;
    }
    this.launchContexts.set(id, { cwd: spawn.cwd, configDir: spawn.env.CLAUDE_CONFIG_DIR ?? null });
    session.agentBrowser = planned.agentBrowser;
    session.agentRuntime = planned.agentRuntime;
    session.agentOrchestration = planned.agentOrchestration;
    session.launchCleanup = contribution?.cleanup ?? null;
    metadata.status = initialSessionStatus(metadata.provider);
    metadata.exitCode = null;
    metadata.failureDetails = null;
    this.bindProcess(id, session, process);
    const runtimeStatus = this.agentRuntime?.currentStatus(id);
    if (runtimeStatus) metadata.status = runtimeStatus;
    if (environment) this.describeEnvironment(id, session, environment);
    return "launched";
  }

  private addLaunchSecrets(session: ManagedSession, secrets: readonly string[]): void {
    this.redaction.add(`session:${session.metadata.id}`, secrets);
  }

  /** Refreshes the card badge from the plugin (for example the worktree's current branch). */
  private describeEnvironment(id: string, session: ManagedSession, environment: PersistedEnvironmentRef): void {
    void this.environments?.describe(environment, id).then((described) => {
      if (!described || this.sessions.get(id) !== session || session.extras.environment !== environment) return;
      environment.label = described.label;
      session.metadata.environment = { ...environmentBadge(environment), ...(described.detail ? { detail: described.detail } : {}) };
      this.emitSession(session.metadata);
      this.schedulePersistence();
    }).catch(() => undefined);
  }

  private bindProcess(id: string, session: ManagedSession, process: IPty): void {
    session.agentBrowser?.retainUntilExit?.();
    process.onData((data) => {
      const current = this.sessions.get(id);
      if (!current || current !== session || current.process !== process) return;

      const lifecycleState = current.lifecycle?.push(data);
      if (lifecycleState) current.titleState = lifecycleState;
      if (lifecycleState && !titleDefersToHooks(current, lifecycleState)) {
        this.applyProviderSignal(id, { kind: "lifecycle", state: lifecycleState }, "title");
      }
      appendScrollback(current, data);
      this.queueOutput(id, current, data);
    });

    let exited!: () => void;
    this.liveProcesses.set(process, new Promise<void>((resolve) => { exited = resolve; }));
    process.onExit(({ exitCode }) => {
      this.liveProcesses.delete(process);
      exited();
      const current = this.sessions.get(id);
      if (!current || current !== session || current.process !== process) return;
      // node-pty calls this from a native callback that aborts the whole app when JavaScript throws in it.
      try {
        this.recordExit(id, current, exitCode);
      } catch (error) {
        console.warn(`PTY ${id} exit could not be recorded.`, error);
      }
    });
  }

  private recordExit(id: string, current: ManagedSession, exitCode: number): void {
    this.flushOutput(id, current);
    current.metadata.exitCode = exitCode;
    current.metadata.status = exitCode === 0 ? "done" : "failed";
    current.metadata.failureDetails = exitCode === 0
      ? null
      : terminalFailureDetails(this.redactSecrets(current.bufferChunks.slice(current.bufferStart).join("")));
    current.agentBrowser?.cleanup();
    current.agentBrowser = null;
    current.agentRuntime?.cleanup();
    current.agentRuntime = null;
    current.agentOrchestration?.cleanup();
    current.agentOrchestration = null;
    void current.launchCleanup?.().catch(() => undefined);
    current.launchCleanup = null;
    this.emitSession(current.metadata);
    // Recorded at the moment of exit, so a finished agent is never relaunched.
    this.schedulePersistence();
  }

  private queueOutput(id: string, session: ManagedSession, data: string): void {
    session.pendingOutput.push(data);
    this.queuedOutput.set(id, session);
    if (this.outputTimer !== null) return;
    // Keep a TUI's clear-and-redraw sequence in one renderer update whenever possible.
    this.outputTimer = setTimeout(() => this.flushQueuedOutput(), OUTPUT_BATCH_MS);
  }

  /** Flushes every session with queued output, in the order its output first arrived. */
  private flushQueuedOutput(): void {
    this.outputTimer = null;
    for (const [id, session] of [...this.queuedOutput]) this.flushOutput(id, session);
  }

  private flushOutput(id: string, session: ManagedSession): void {
    if (this.queuedOutput.get(id) === session) {
      this.queuedOutput.delete(id);
      if (this.queuedOutput.size === 0 && this.outputTimer !== null) {
        clearTimeout(this.outputTimer);
        this.outputTimer = null;
      }
    }
    if (session.pendingOutput.length === 0) return;

    const data = session.pendingOutput.join("");
    session.pendingOutput.length = 0;
    // While the card is hidden the batch is for the observers only: the
    // renderer catches up through the replay in setVisible.
    this.emit(IPC.terminalData, {
      id,
      data,
      outputOffset: session.outputOffset,
      ...(this.hiddenSinceOffset.has(id) ? { audience: "observers" as const } : {})
    });
  }
}

/** A manager event the main process forwards to its in-process observers. */
export function reachesObservers(payload: TerminalDataEvent | SessionEvent | SessionRemovedEvent): boolean {
  return !("audience" in payload) || payload.audience !== "renderer";
}

/** A manager event the main process forwards to the renderer. */
export function reachesRenderer(payload: TerminalDataEvent | SessionEvent | SessionRemovedEvent): boolean {
  return !("audience" in payload) || payload.audience !== "observers";
}

function environmentBadge(environment: PersistedEnvironmentRef): NonNullable<SessionMetadata["environment"]> {
  return { pluginId: environment.pluginId, kind: environment.kind, label: environment.label };
}

/**
 * Claude's title shows the same «✳» when its turn ended and while its permission prompt waits, and it can reach main
 * before or after the hook that tells them apart (Stop, PermissionRequest). Once Claude's hooks have reported for this
 * card they alone end a turn; the title only reports one starting. Without them (hooks off, or a remote run without a
 * bridge) the title's idle stands.
 */
function titleDefersToHooks(session: ManagedSession, state: "idle" | "working" | "needs_approval"): boolean {
  return state !== "working" && session.metadata.provider === "claude" && session.hookSignals !== undefined;
}

/** Keys that answer a prompt: Enter, a lone Esc, or a choice digit. */
const ANSWERS_PROMPT = /\r|^\u001b$|^[1-9]$/;
const ANSWERED_PROMPT_SETTLE_MS = 3_000;

/** "auto" ran as accept-edits because a launch contributor marked a third-party model; shown on the card. */
function setAutoDowngraded(metadata: SessionMetadata, downgraded: boolean): void {
  if (downgraded) metadata.autoDowngraded = true;
  else delete metadata.autoDowngraded;
}

function missingLaunchPlugins(pluginIds: readonly string[]): string {
  return `needs plugin ${pluginIds.join(", ")} for its launch options; it is disabled, removed, or its native code is not trusted.`;
}

function failWith(message: string): never {
  throw new Error(message);
}

function applyLaunchFailure(metadata: SessionMetadata, failure: UnavailableProviderCli): void {
  metadata.status = "failed";
  metadata.exitCode = 127;
  metadata.failureDetails = failure.diagnostic;
}

/**
 * The launch's program search path. The environment is a plain copy of
 * process.env, which on Windows is case-insensitive but keeps the spelling it
 * was given ("Path"), so env.PATH alone finds nothing there.
 */
export function launchSearchPath(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (platform !== "win32") return environment.PATH;
  if (environment.PATH !== undefined) return environment.PATH;
  const key = Object.keys(environment).find((name) => name.toUpperCase() === "PATH");
  return key === undefined ? undefined : environment[key];
}

export function terminalEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const reserved = new Set<string>([
    ...Object.values(AGENT_BROWSER_ENV),
    ...Object.values(AGENT_RUNTIME_ENV),
    CAPTURE_RESULT_ENV,
    CAPTURE_ANSWER_ENV,
    CAPTURE_ANSWER_EXPIRES_AT_ENV,
    // An orchestrator that launches the app must not leak its own control grant.
    CONTROL_CONNECTION_ENV,
    CONTROL_CLI_ENV
  ]);
  const environment = Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => (
      typeof entry[1] === "string"
      && !reserved.has(entry[0])
      && !entry[0].startsWith("CANVASTTY_PLUGIN_HOOK_")
      && entry[0] !== "CANVASTTY_LIFECYCLE_HOOKS_ENABLED"
      && entry[0] !== "ELECTRON_RUN_AS_NODE"
    ))
  );
  return { ...environment, TERM: "xterm-256color", COLORTERM: "truecolor" };
}

function defaultTitle(provider: ProviderId, cwd: string): string {
  const project = basename(cwd) || cwd;
  if (provider === "terminal") return `Terminal · ${project}`;
  if (provider === "opencode") return `${project} · OpenCode`;
  if (provider === "hermes") return `${project} · Hermes`;
  if (provider === "qwen") return `${project} · Qwen Code`;
  if (provider === "grok") return `${project} · Grok Build`;
  if (provider === "omp") return `${project} · OMP`;
  if (provider === "pi") return `${project} · Pi`;
  return `${project} · ${provider[0].toUpperCase()}${provider.slice(1)}`;
}

function assertDirectory(cwd: string): void {
  try {
    if (!statSync(cwd).isDirectory()) throw new Error("Not a directory");
  } catch {
    throw new Error(`Project folder does not exist: ${cwd}`);
  }
}

const SESSION_PROVIDERS = new Set<ProviderId>(CANVAS_LAUNCHER_ITEMS);
const SESSION_ROLES = new Set<SessionRole>(["agent", "orchestrator", "subagent"]);

function assertCreateRequest(request: CreateSessionRequest): void {
  if (!request || !SESSION_PROVIDERS.has(request.provider)) throw new Error("Unknown terminal provider.");
  if (!isLaunchProfile(request.profile)) throw new Error("Unknown launch profile.");
  if (request.profile === "auto" && !hasAutoMode(request.provider)) throw new Error(`${request.provider} has no auto mode; use the normal profile.`);
  if (request.role === "orchestrator" && request.provider === "terminal") throw new Error("A plain terminal cannot be an orchestrator.");
  if (typeof request.cwd !== "string" || request.cwd.length === 0) throw new Error("Project folder is required.");
  if (!isPoint(request.position)) throw new Error("Session position is invalid.");
  const role = request.role ?? "agent";
  if (!SESSION_ROLES.has(role)) throw new Error("Unknown session role.");
  if (role === "subagent" && typeof request.parentSessionId !== "string") {
    throw new Error("A subagent session requires a parent session.");
  }
  if (request.parentSessionId !== undefined && typeof request.parentSessionId !== "string") {
    throw new Error("Session parent id must be a string.");
  }
}

function isPoint(value: unknown): value is Point {
  return Boolean(
    value
    && typeof value === "object"
    && "x" in value
    && "y" in value
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
  );
}

function isSessionBounds(value: unknown): value is SessionBounds {
  if (!value || typeof value !== "object" || !("position" in value) || !("size" in value)) return false;
  const size = value.size;
  return isPoint(value.position)
    && Boolean(
      size
      && typeof size === "object"
      && "width" in size
      && "height" in size
      && Number.isFinite(size.width)
      && Number.isFinite(size.height)
    );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function publicSessionMetadata(session: ManagedSession): SessionMetadata {
  const metadata = structuredClone(session.metadata);
  if (session.threadId) metadata.threadId = session.threadId;
  else delete metadata.threadId;
  return metadata;
}

function snapshot(session: ManagedSession): SessionSnapshot {
  return {
    ...publicSessionMetadata(session),
    buffer: session.bufferChunks.slice(session.bufferStart).join("")
  };
}

/** The last `chars` characters of the scrollback (all of it when it holds fewer), joined from the end. */
function scrollbackTail(session: ManagedSession, chars: number): string {
  if (chars >= session.bufferLength) return session.bufferChunks.slice(session.bufferStart).join("");
  const parts: string[] = [];
  let needed = chars;
  for (let index = session.bufferChunks.length - 1; index >= session.bufferStart && needed > 0; index--) {
    const chunk = session.bufferChunks[index]!;
    parts.push(chunk.length <= needed ? chunk : chunk.slice(chunk.length - needed));
    needed -= chunk.length;
  }
  return parts.reverse().join("");
}

function appendScrollback(session: ManagedSession, data: string): void {
  session.outputOffset += data.length;
  session.bufferChunks.push(data);
  session.bufferLength += data.length;

  while (session.bufferLength > MAX_SCROLLBACK_CHARS) {
    const first = session.bufferChunks[session.bufferStart];
    if (first === undefined) {
      session.bufferChunks.length = 0;
      session.bufferStart = 0;
      session.bufferLength = 0;
      return;
    }
    const overflow = session.bufferLength - MAX_SCROLLBACK_CHARS;
    if (first.length <= overflow) {
      // Release the dropped chunk now: the slot stays until the array is compacted, the text must not.
      session.bufferChunks[session.bufferStart] = "";
      session.bufferStart += 1;
      session.bufferLength -= first.length;
      continue;
    }
    session.bufferChunks[session.bufferStart] = first.slice(overflow);
    session.bufferLength -= overflow;
  }

  if (session.bufferStart > 256 && session.bufferStart * 2 >= session.bufferChunks.length) {
    session.bufferChunks = session.bufferChunks.slice(session.bufferStart);
    session.bufferStart = 0;
  }
}
