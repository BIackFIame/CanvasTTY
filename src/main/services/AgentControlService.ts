import type {
  AgentProviderId,
  CreateSessionRequest,
  LaunchProfileId,
  SessionMetadata,
  SessionSnapshot
} from "../../shared/contracts.ts";
import { PROVIDER_CAPABILITIES } from "../../shared/contracts.ts";
import type { TerminalManager } from "./TerminalManager.ts";

// Roadmap F1 preview: a programmatic parent must not be able to fan out
// without bound. The real budgets setting arrives with resource management;
// until then this hard cap is the only backstop.
const MAX_CHILDREN_PER_PARENT = 16;
const MAX_OBSERVE_CHARS = 8_192;
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
}

export interface AgentObservation {
  sessionId: string;
  status: SessionSnapshot["status"];
  /** Raw terminal tail, capped; capabilities with result \"none\" see nothing. */
  output: string;
}

export interface AgentResult {
  sessionId: string;
  state: "running" | "done" | "failed";
  exitCode: number | null;
  output: string;
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

  constructor(terminals: TerminalManager) {
    this.terminals = terminals;
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
      ...(request.launchOptions !== undefined ? { launchOptions: request.launchOptions } : {})
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
    return {
      sessionId: session.id,
      status: session.status,
      // The whole buffer is masked first: a cut inside a secret would leave a tail no pattern recognizes.
      output: tail(this.redact(this.terminals.readBuffer(sessionId).buffer), maxChars)
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
      output: tail(this.redact(buffer), MAX_OBSERVE_CHARS)
    };
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

  /** Plugin launch secrets never reach another agent through observed output. */
  private redact(text: string): string {
    return typeof this.terminals.redactSecrets === "function" ? this.terminals.redactSecrets(text) : text;
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

function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}
