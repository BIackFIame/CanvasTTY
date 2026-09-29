import type {
  AgentProviderId,
  CreateSessionRequest,
  LaunchProfileId,
  SessionMetadata,
  SessionSnapshot
} from "../../shared/contracts.ts";
import { PROVIDER_CAPABILITIES } from "../../shared/contracts.ts";
import type { TerminalManager } from "./TerminalManager.ts";
import { terminalFailureDetails } from "./terminalFailureDetails.ts";

// Roadmap F1 preview: a programmatic parent must not be able to fan out
// without bound. The real budgets setting arrives with resource management;
// until then this hard cap is the only backstop.
const MAX_CHILDREN_PER_PARENT = 16;
const MAX_OBSERVE_CHARS = 8_192;
// An exited agent's reason is in its last screen lines (OpenCode: "Error: Unexpected server error" for an unknown model).
const MAX_EXIT_WINDOW_CHARS = 16_384;
const MAX_EXIT_LINES = 20;
const CHILD_POSITION_STEP = { x: 60, y: 60 };

export interface SpawnAgentRequest {
  parentSessionId: string;
  provider: AgentProviderId;
  cwd: string;
  profile?: LaunchProfileId;
  title?: string;
  /** Prompt written into the new agent's PTY once its launch has started (after its plugins prepared it). */
  initialPrompt?: string;
  /** Plugin launch options, checked by the launch exactly like the launcher's. */
  launchOptions?: CreateSessionRequest["launchOptions"];
  /** The CLI's --model and reasoning effort for this subagent (checked by the launch for its CLI). */
  model?: string;
  effort?: CreateSessionRequest["effort"];
}

export interface AgentObservation {
  sessionId: string;
  status: SessionSnapshot["status"];
  /** Raw terminal tail, capped; capabilities with result \"none\" see nothing. */
  output: string;
  /** Once the process exited: its exit code and the last lines of its screen as plain text, masked. */
  exitCode?: number | null;
  exitLines?: string;
}

/** Why waitFor returned. "done"/"failed": the process exited (exit code 0 or not); "quiet": the provider reports no
 *  status and its screen stopped changing; "closed": its card is gone. */
export type AgentWaitReason = "idle" | "needs_approval" | "done" | "failed" | "quiet" | "closed" | "timeout";

export interface AgentWaitResult {
  sessionId: string;
  reason: AgentWaitReason;
  /** The session's status as the wait ended; absent once its card is gone. */
  status?: SessionSnapshot["status"];
  exitCode: number | null;
  waitedMs: number;
  /** Masked terminal tail (masked before the cut). */
  output: string;
  /** Once the process exited: the last lines of its screen as plain text, masked (why it stopped, e.g. a bad model). */
  exitLines?: string;
}

export interface AgentWaitTiming {
  /** How often a waiting call reads the session again. */
  checkMs: number;
  /** How long the screen must stay the same before an idle status counts (a CLI may still be drawing its answer). */
  settleMs: number;
  /** How long a session without status must show the same screen before it counts as "quiet". */
  quietMs: number;
}

export interface AgentControlOptions {
  /** waitFor timing; tests shorten it. */
  waitTiming?: AgentWaitTiming;
}

/** The longest wait one call may ask for (wait_for_agent's timeoutSeconds maximum). */
export const MAX_AGENT_WAIT_MS = 600_000;
const AGENT_WAIT_TIMING: AgentWaitTiming = { checkMs: 500, settleMs: 1_000, quietMs: 10_000 };

export interface AgentResult {
  sessionId: string;
  state: "running" | "done" | "failed";
  exitCode: number | null;
  output: string;
  /** Once the process exited: the last lines of its screen as plain text, masked. */
  exitLines?: string;
}

/** The agent's launch did not start, so text meant for it was dropped (never queued for a later launch). */
export class PromptNotDeliveredError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string, message: string) {
    super(message);
    this.name = "PromptNotDeliveredError";
    this.sessionId = sessionId;
  }
}

export class AgentControlService {
  private readonly terminals: TerminalManager;
  private readonly options: AgentControlOptions;

  constructor(terminals: TerminalManager, options: AgentControlOptions = {}) {
    this.terminals = terminals;
    this.options = options;
  }

  /**
   * Creates the subagent card. With an initial prompt it resolves only once the prompt reached the agent's PTY
   * (after an asynchronous launch has started) and rejects with PromptNotDeliveredError when that launch did not
   * start; the card stays, so the caller can inspect or cancel it.
   */
  spawn(request: SpawnAgentRequest): Promise<SessionMetadata> {
    if (!request || typeof request.parentSessionId !== "string") {
      throw new Error("A parent session id is required.");
    }
    const parent = this.requireSession(request.parentSessionId);
    const capabilities = PROVIDER_CAPABILITIES[request.provider];
    if (!capabilities) throw new Error("Unknown agent provider.");
    if (!capabilities.send) throw new Error(`${request.provider} cannot receive prompts.`);

    const children = this.children(parent.id);
    if (children.length >= MAX_CHILDREN_PER_PARENT) {
      throw new Error(`Session ${parent.id} already has ${MAX_CHILDREN_PER_PARENT} subagents.`);
    }

    const cascade = children.length;
    const created = this.terminals.create({
      provider: request.provider,
      cwd: request.cwd,
      profile: request.profile ?? "normal",
      position: {
        x: parent.position.x + CHILD_POSITION_STEP.x * (cascade + 1),
        y: parent.position.y + CHILD_POSITION_STEP.y * (cascade + 1)
      },
      ...(request.title !== undefined ? { title: request.title } : {}),
      role: "subagent",
      parentSessionId: parent.id,
      ...(request.launchOptions !== undefined ? { launchOptions: request.launchOptions } : {}),
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.effort !== undefined ? { effort: request.effort } : {})
    });
    if (request.initialPrompt === undefined || request.initialPrompt.length === 0) return Promise.resolve(created);
    return this.deliver(created.id, `${request.initialPrompt}\r`, "prompt")
      .then(() => this.terminals.getMetadata(created.id) ?? created);
  }

  /** Validates at once (throws); resolves once the text reached the agent, and rejects when it did not. */
  send(sessionId: string, text: string, submit = true): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.provider === "terminal") throw new Error("Plain terminals are not agents.");
    const capabilities = PROVIDER_CAPABILITIES[session.provider as AgentProviderId];
    if (!capabilities.send) throw new Error(`${session.provider} cannot receive prompts.`);
    if (typeof text !== "string" || text.length === 0) throw new Error("Prompt text is required.");
    if (session.exitCode !== null) throw new Error("Agent session has already exited.");
    return this.deliver(sessionId, submit ? `${text}\r` : text, "text");
  }

  status(sessionId: string): SessionMetadata {
    return this.requireSession(sessionId);
  }

  children(parentSessionId: string): SessionMetadata[] {
    this.requireSession(parentSessionId);
    return this.terminals.listMetadata()
      .filter((session) => session.parentSessionId === parentSessionId)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /** True when sessionId is parentSessionId itself or any of its descendants. */
  isInSubtree(parentSessionId: string, sessionId: string): boolean {
    if (typeof parentSessionId !== "string" || typeof sessionId !== "string") return false;
    const snapshots = new Map(this.terminals.listMetadata().map((session) => [session.id, session]));
    let current: string | undefined = sessionId;
    const seen = new Set<string>();
    while (current !== undefined) {
      if (current === parentSessionId) return true;
      if (seen.has(current)) return false;
      seen.add(current);
      current = snapshots.get(current)?.parentSessionId;
    }
    return false;
  }

  observe(sessionId: string, maxChars = MAX_OBSERVE_CHARS): AgentObservation {
    const session = this.requireSession(sessionId);
    if (session.provider === "terminal") throw new Error("Plain terminals are not agents.");
    const capabilities = PROVIDER_CAPABILITIES[session.provider as AgentProviderId];
    if (!capabilities.observe) throw new Error(`${session.provider} cannot be observed.`);
    const buffer = this.terminals.readBuffer(sessionId).buffer;
    const exitLines = session.exitCode === null ? null : this.exitLines(buffer);
    return {
      sessionId: session.id,
      status: session.status,
      // Masked before the cut (a cut inside a secret would leave a tail no pattern recognizes), over a window
      // wider than any match rather than the whole scrollback.
      output: this.redactTail(buffer, maxChars),
      ...(session.exitCode === null ? {} : { exitCode: session.exitCode }),
      ...(exitLines ? { exitLines } : {})
    };
  }

  result(sessionId: string): AgentResult {
    const session = this.requireSession(sessionId);
    if (session.provider === "terminal") throw new Error("Plain terminals are not agents.");
    const capabilities = PROVIDER_CAPABILITIES[session.provider as AgentProviderId];
    if (capabilities.result === "none") {
      return { sessionId: session.id, state: "running", exitCode: session.exitCode, output: "" };
    }
    const buffer = capabilities.result === "terminal"
      ? this.terminals.readBuffer(sessionId).buffer
      : "";
    return {
      sessionId: session.id,
      state: session.exitCode === null
        ? "running"
        : session.exitCode === 0 ? "done" : "failed",
      exitCode: session.exitCode,
      output: this.redactTail(buffer, MAX_OBSERVE_CHARS),
      ...(session.exitCode !== null && this.exitLines(buffer) ? { exitLines: this.exitLines(buffer)! } : {})
    };
  }

  /**
   * Waits until the agent is at rest (idle, needs_approval, exited, or quiet when it reports no status), its card
   * closed, or the timeout passed. Only reads metadata and the output offset while it waits; the tail is read and
   * masked once, as it returns. Rejects with an AbortError once `signal` aborts.
   */
  async waitFor(sessionId: string, request: { timeoutMs: number; signal?: AbortSignal }): Promise<AgentWaitResult> {
    const { signal } = request;
    signal?.throwIfAborted();
    const first = this.requireSession(sessionId);
    if (first.provider === "terminal") throw new Error("Plain terminals are not agents.");
    if (typeof request.timeoutMs !== "number" || !Number.isFinite(request.timeoutMs)) throw new Error("A wait timeout is required.");
    const timing = this.options.waitTiming ?? AGENT_WAIT_TIMING;
    const timeoutMs = Math.min(MAX_AGENT_WAIT_MS, Math.max(0, request.timeoutMs));
    const started = Date.now();
    const answer = (session: SessionMetadata | null, reason: AgentWaitReason): AgentWaitResult => {
      const waitedMs = Date.now() - started;
      if (!session) return { sessionId, reason, exitCode: null, waitedMs, output: "" };
      let observation: AgentObservation | null = null;
      try { observation = this.observe(sessionId); } catch { observation = null; }
      return { sessionId, reason, status: session.status, exitCode: session.exitCode, waitedMs, output: observation?.output ?? "",
        ...(observation?.exitLines ? { exitLines: observation.exitLines } : {}) };
    };
    let offset = this.outputOffset(sessionId);
    let changedAt = started;
    for (;;) {
      const session = this.terminals.getMetadata(sessionId);
      if (!session) return answer(null, "closed");
      const now = Date.now();
      const current = this.outputOffset(sessionId);
      if (current !== offset) { offset = current; changedAt = now; }
      const quietFor = now - changedAt;
      if (session.exitCode !== null) return answer(session, session.exitCode === 0 ? "done" : "failed");
      if (session.status === "needs_approval") return answer(session, "needs_approval");
      // After a prompt, an idle that no turn followed (the CLI's startup idle, or one reported before the turn began)
      // is not the answer: only an idle after a turn that started since that prompt is. A CLI that never reports its
      // turns still ends as "quiet" once its screen stops changing.
      const progress = this.turnProgress(sessionId);
      const awaitingTurn = progress !== null && progress.promptSent && !progress.turnStartedSincePrompt;
      if (!awaitingTurn && (session.status === "idle" || session.status === "done" || session.status === "failed") && quietFor >= timing.settleMs) {
        return answer(session, session.status);
      }
      if ((session.status === "unavailable" || awaitingTurn) && quietFor >= timing.quietMs) return answer(session, "quiet");
      const waited = now - started;
      if (waited >= timeoutMs) return answer(session, "timeout");
      await pause(Math.min(timing.checkMs, timeoutMs - waited), signal);
    }
  }

  cancel(sessionId: string): void {
    this.requireSession(sessionId);
    this.terminals.dispose(sessionId);
  }

  /** Through the terminal manager's one delivery rule: exactly once, into the launch that is starting now. */
  private async deliver(sessionId: string, data: string, what: "prompt" | "text"): Promise<void> {
    const delivery = await this.terminals.deliverInput(sessionId, data);
    if (!delivery.delivered) {
      throw new PromptNotDeliveredError(sessionId, `The ${what} for agent ${sessionId} was not delivered: ${delivery.reason}`);
    }
  }

  /** The last lines of an exited agent's screen as plain text: masked over the whole tail window before it is cut. */
  private exitLines(buffer: string): string | null {
    const text = terminalFailureDetails(this.redactTail(buffer, MAX_EXIT_WINDOW_CHARS));
    if (!text) return null;
    return text.split("\n").slice(-MAX_EXIT_LINES).join("\n");
  }

  /** Plugin launch secrets never reach another agent through observed output: the tail as masking the whole text leaves it. */
  private redactTail(text: string, maxChars: number): string {
    if (typeof this.terminals.redactSecretsTail === "function") return this.terminals.redactSecretsTail(text, maxChars);
    return tail(typeof this.terminals.redactSecrets === "function" ? this.terminals.redactSecrets(text) : text, maxChars);
  }

  private turnProgress(sessionId: string): { promptSent: boolean; turnStartedSincePrompt: boolean } | null {
    try { return typeof this.terminals.turnProgress === "function" ? this.terminals.turnProgress(sessionId) : null; } catch { return null; }
  }

  /** How much output the session produced so far; changes whenever its screen does. */
  private outputOffset(sessionId: string): number {
    try {
      if (typeof this.terminals.outputOffset === "function") return this.terminals.outputOffset(sessionId) ?? -1;
      return this.terminals.readBuffer(sessionId).outputOffset;
    } catch { return -1; }
  }

  /** A lookup by id: metadata only, so no other session's scrollback is copied. */
  private requireSession(sessionId: string): SessionMetadata {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("A session id is required.");
    }
    const session = this.terminals.getMetadata(sessionId);
    if (!session) throw new Error("Terminal session does not exist.");
    return session;
  }
}

/** Sleeps, or rejects with an AbortError as soon as `signal` aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = (): void => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("The wait was canceled.");
  error.name = "AbortError";
  return error;
}

function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}
