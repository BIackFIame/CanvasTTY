import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rmdir, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "../../../shared/contracts.ts";
import {
  MAX_ANSWER_CHARS,
  MAX_RUNTIME_MESSAGE_BYTES,
  MAX_RESULT_CHARS,
  normalizeThreadId,
  PERMISSION_GATE,
  permissionGateTimings,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_STATES
} from "../../../agent-runtime/runtime-protocol.mjs";
import {
  WindowsPipeHostTransport,
  type AgentGatewaySocket,
  type WindowsPipeHostTransportOptions
} from "../agent-browser/WindowsPipeHostTransport.ts";

const AGENT_PROVIDERS = new Set<ProviderId>([
  "codex", "claude", "qwen", "kimi", "opencode", "hermes", "grok", "omp", "pi", "cursor", "minimax", "devin", "antigravity"
]);
const MAX_RUNTIME_SESSIONS = 32;
/** Decision checks in flight, per session and in total; over a cap the call is refused with advice to slow down. */
const MAX_DECISIONS_PER_SESSION = 8;
const MAX_DECISIONS_TOTAL = 32;
const OVERLOADED_MESSAGE = "CanvasTTY is checking too many tool calls from this session at once. Wait a few seconds and run the command again, one at a time.";

export type RuntimeLifecycleState = "idle" | "working" | "needs_approval";

export interface RuntimeLifecycleSignal {
  state: RuntimeLifecycleState;
  event: string;
  turnId: string | null;
  /** The provider's own conversation id (Codex thread, Claude or OpenCode session), as its hook reported it. */
  threadId?: string;
  result?: { text: string; truncated: boolean };
  lastAssistantMessage?: string;
  answerCaptureGrantExpiresAt?: number;
}

export interface RuntimeSessionCapability {
  address: string;
  terminalSessionId: string;
  provider: Exclude<ProviderId, "terminal">;
  capabilityToken: string;
}

interface RuntimeLease {
  terminalSessionId: string;
  provider: Exclude<ProviderId, "terminal">;
  tokenDigest: Buffer;
  activeTurnId: string | null;
  latest: RuntimeLifecycleSignal | null;
  captureResult: boolean;
  answerCaptureGrantExpiresAt: number | null;
  /** Launched with decision hooks; otherwise permission requests are refused. */
  decisions: boolean;
  /** How long a decision may take for this session (sized at launch from the decision services' budgets). */
  gatewayMs: number;
  checks: Set<AbortController>;
}

/** One decision hook call (permission-gate.mjs). The tool input is agent-influenced data, never instructions. */
export interface RuntimePermissionRequest {
  requestId: string;
  provider: Exclude<ProviderId, "terminal">;
  toolName: string;
  /** The whole tool input, or null when it was over the bound (then `truncated`, and only a preview). */
  toolInput: unknown;
  toolInputPreview: string | null;
  toolInputSha256: string;
  truncated: boolean;
  /** The agent's current folder as its CLI reported it. */
  cwd: string | null;
}

/** `none`: no opinion, the CLI goes on as it would without CanvasTTY. */
export interface RuntimePermissionDecision {
  behavior: "allow" | "deny" | "ask" | "none";
  message?: string;
}

interface ParsedLifecycleMessage {
  terminalSessionId: string;
  provider: Exclude<ProviderId, "terminal">;
  capabilityToken: string;
  state: RuntimeLifecycleState;
  event: string;
  turnId: string | null;
  threadId?: string;
  result?: { text: string; truncated: boolean };
  lastAssistantMessage?: string;
}

export interface RuntimeGatewayOptions {
  platform?: NodeJS.Platform;
  runtimeDirectory?: string;
  windowsHostPath?: string;
  windowsPipeHostFactory?: (options: WindowsPipeHostTransportOptions) => WindowsPipeHostTransport;
  onSignal?(terminalSessionId: string, signal: RuntimeLifecycleSignal): void;
  onAnswerCaptureRevoked?(terminalSessionId: string): void;
  /**
   * Decision hooks: answers one tool call. `signal` aborts when the hook's socket closes, the session is revoked or
   * the gateway's deadline passes; the answer is then `ask`.
   */
  onPermissionRequest?(terminalSessionId: string, request: RuntimePermissionRequest, signal: AbortSignal): Promise<RuntimePermissionDecision> | RuntimePermissionDecision;
  now?: () => number;
}

export class RuntimeGateway {
  private readonly platform: NodeJS.Platform;
  private readonly requestedRuntimeDirectory: string | undefined;
  private readonly windowsHostPath: string | undefined;
  private readonly windowsPipeHostFactory: (options: WindowsPipeHostTransportOptions) => WindowsPipeHostTransport;
  private readonly onSignal: RuntimeGatewayOptions["onSignal"];
  private readonly onAnswerCaptureRevoked: RuntimeGatewayOptions["onAnswerCaptureRevoked"];
  private readonly onPermissionRequest: RuntimeGatewayOptions["onPermissionRequest"];
  private readonly now: () => number;
  private readonly checks = new Set<AbortController>();
  private readonly leases = new Map<string, RuntimeLease>();
  private readonly sockets = new Set<AgentGatewaySocket>();
  private server: Server | null = null;
  private windowsTransport: WindowsPipeHostTransport | null = null;
  private endpoint: string | null = null;
  private ownedRuntimeDirectory: string | null = null;

  constructor(options: RuntimeGatewayOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.requestedRuntimeDirectory = options.runtimeDirectory;
    this.windowsHostPath = options.windowsHostPath;
    this.windowsPipeHostFactory = options.windowsPipeHostFactory
      ?? ((transportOptions) => new WindowsPipeHostTransport(transportOptions));
    this.onSignal = options.onSignal;
    this.onAnswerCaptureRevoked = options.onAnswerCaptureRevoked;
    this.onPermissionRequest = options.onPermissionRequest;
    this.now = options.now ?? Date.now;
  }

  get address(): string {
    if (!this.endpoint) throw new Error("Agent runtime gateway has not started.");
    return this.endpoint;
  }

  async start(): Promise<string> {
    if (this.endpoint && (this.server || this.windowsTransport?.isRunning)) return this.address;
    if (this.platform === "win32") {
      if (!this.windowsHostPath) {
        throw new Error("Agent runtime access on Windows requires the packaged current-user-only named-pipe host.");
      }
      const transport = this.windowsPipeHostFactory({
        hostPath: this.windowsHostPath,
        platform: this.platform,
        parentPid: process.pid
      });
      this.windowsTransport = transport;
      const endpoint = await transport.start((socket) => this.accept(socket));
      this.endpoint = endpoint;
      return endpoint;
    }

    const created = await createEndpoint(this.requestedRuntimeDirectory);
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    this.endpoint = created.endpoint;
    this.ownedRuntimeDirectory = created.ownedRuntimeDirectory;
    try {
      await listen(server, created.endpoint);
      await chmod(created.endpoint, 0o600);
      return created.endpoint;
    } catch (error) {
      await closeServer(server);
      this.server = null;
      this.endpoint = null;
      this.ownedRuntimeDirectory = null;
      await cleanupEndpoint(created.endpoint, created.ownedRuntimeDirectory, this.platform);
      throw error;
    }
  }

  registerSession(
    terminalSessionId: string,
    provider: Exclude<ProviderId, "terminal">,
    captureResultOrGrantExpiresAt: boolean | number = false,
    answerCaptureGrantExpiresAt?: number,
    decisions = false,
    decisionBudgetMs?: number
  ): RuntimeSessionCapability {
    if (!this.endpoint || (!this.server && !this.windowsTransport?.isRunning)) {
      throw new Error("Agent runtime gateway must be started before launching agents.");
    }
    if (!terminalSessionId || !AGENT_PROVIDERS.has(provider)) {
      throw new Error("Agent runtime launch identity is invalid.");
    }
    if (!this.leases.has(terminalSessionId) && this.leases.size >= MAX_RUNTIME_SESSIONS) {
      throw new Error("CanvasTTY supports at most 32 runtime-observed agent sessions.");
    }
    this.revokeTerminalSession(terminalSessionId);
    const capabilityToken = randomBytes(32).toString("base64url");
    const grantExpiresAt = typeof captureResultOrGrantExpiresAt === "number"
      ? captureResultOrGrantExpiresAt : answerCaptureGrantExpiresAt;
    this.leases.set(terminalSessionId, {
      terminalSessionId,
      provider,
      tokenDigest: digest(capabilityToken),
      activeTurnId: null,
      latest: null,
      captureResult: captureResultOrGrantExpiresAt === true,
      answerCaptureGrantExpiresAt: provider === "codex"
        && typeof grantExpiresAt === "number"
        && Number.isFinite(grantExpiresAt)
        && grantExpiresAt > this.now()
        ? grantExpiresAt
        : null,
      decisions,
      gatewayMs: permissionGateTimings(decisionBudgetMs).gatewayMs,
      checks: new Set()
    });
    return { address: this.endpoint, terminalSessionId, provider, capabilityToken };
  }

  currentStatus(terminalSessionId: string): RuntimeLifecycleState | null {
    return this.leases.get(terminalSessionId)?.latest?.state ?? null;
  }

  revokeTerminalSession(terminalSessionId: string): void {
    const lease = this.leases.get(terminalSessionId);
    if (!lease) return;
    lease.tokenDigest.fill(0);
    this.leases.delete(terminalSessionId);
    for (const check of lease.checks) check.abort();
    if (lease.answerCaptureGrantExpiresAt !== null) {
      this.onAnswerCaptureRevoked?.(terminalSessionId);
    }
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    for (const lease of this.leases.values()) {
      lease.tokenDigest.fill(0);
      for (const check of lease.checks) check.abort();
      if (lease.answerCaptureGrantExpiresAt !== null) {
        this.onAnswerCaptureRevoked?.(lease.terminalSessionId);
      }
    }
    this.leases.clear();
    const server = this.server;
    const transport = this.windowsTransport;
    const endpoint = this.endpoint;
    const ownedRuntimeDirectory = this.ownedRuntimeDirectory;
    this.server = null;
    this.windowsTransport = null;
    this.endpoint = null;
    this.ownedRuntimeDirectory = null;
    if (server) await closeServer(server);
    if (transport) await transport.close();
    if (endpoint) await cleanupEndpoint(endpoint, ownedRuntimeDirectory, this.platform);
  }

  private accept(socket: AgentGatewaySocket): void {
    if (this.sockets.size >= MAX_RUNTIME_SESSIONS * 2) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    let pending = Buffer.alloc(0);
    let handled = false;
    const close = () => {
      this.sockets.delete(socket);
      socket.destroy();
    };
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      if (handled) return;
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      pending = Buffer.concat([pending, bytes]);
      if (pending.length > MAX_RUNTIME_MESSAGE_BYTES) return close();
      const newline = pending.indexOf(0x0a);
      if (newline < 0) return;
      handled = true;
      try {
        const value: unknown = JSON.parse(pending.subarray(0, newline).toString("utf8"));
        // Decision hooks keep the socket open for the answer; every other message is unchanged.
        if (isPermissionRequest(value)) return this.acceptPermission(socket, value, close);
        if (isAnswerCaptureCheck(value)) {
          const answerCapture = this.answerCaptureIsActive(value);
          socket.write(Buffer.from(`${JSON.stringify({
            v: RUNTIME_PROTOCOL_VERSION,
            type: "ack",
            answerCapture
          })}\n`, "utf8"));
        } else {
          this.handleLifecycle(value);
          socket.write(Buffer.from(`${JSON.stringify({ v: RUNTIME_PROTOCOL_VERSION, type: "ack" })}\n`, "utf8"));
        }
        const timeout = setTimeout(close, 1_000);
        timeout.unref();
      } catch {
        close();
      }
    });
    socket.on("error", close);
    socket.on("close", () => this.sockets.delete(socket));
  }

  private answerCaptureIsActive(value: unknown): boolean {
    if (!isRecord(value) || Object.keys(value).sort().join(",") !== [
      "capabilityToken", "provider", "terminalSessionId", "type", "v"
    ].sort().join(",")
      || value.v !== RUNTIME_PROTOCOL_VERSION || value.type !== "answer-capture-check"
      || typeof value.terminalSessionId !== "string" || !value.terminalSessionId
      || value.terminalSessionId.length > 160 || value.provider !== "codex"
      || typeof value.capabilityToken !== "string" || value.capabilityToken.length < 32) {
      throw new Error("Answer-capture check is invalid.");
    }
    const lease = this.leases.get(value.terminalSessionId);
    if (!lease || lease.provider !== value.provider) return false;
    const supplied = digest(value.capabilityToken);
    const valid = supplied.length === lease.tokenDigest.length
      && timingSafeEqual(supplied, lease.tokenDigest);
    supplied.fill(0);
    if (!valid) return false;
    if (lease.answerCaptureGrantExpiresAt === null) return false;
    if (lease.answerCaptureGrantExpiresAt <= this.now()) {
      lease.answerCaptureGrantExpiresAt = null;
      this.onAnswerCaptureRevoked?.(value.terminalSessionId);
      return false;
    }
    return true;
  }

  private handleLifecycle(value: unknown): void {
    const message = parseLifecycleMessage(value);
    const lease = this.leases.get(message.terminalSessionId);
    if (!lease || lease.provider !== message.provider) throw new Error("Runtime capability is invalid.");
    const supplied = digest(message.capabilityToken);
    const valid = supplied.length === lease.tokenDigest.length
      && timingSafeEqual(supplied, lease.tokenDigest);
    supplied.fill(0);
    if (!valid) throw new Error("Runtime capability is invalid.");
    if (message.result && !lease.captureResult) throw new Error("Result capture is not enabled for this session.");
    if (message.lastAssistantMessage !== undefined && (
      lease.answerCaptureGrantExpiresAt === null
      || lease.answerCaptureGrantExpiresAt <= this.now()
    )) {
      lease.answerCaptureGrantExpiresAt = null;
      this.onAnswerCaptureRevoked?.(message.terminalSessionId);
      throw new Error("Answer capture is not authorized for this session.");
    }

    if (message.turnId && isTurnStart(message.event)) {
      lease.activeTurnId = message.turnId;
    } else if (
      message.turnId
      && lease.activeTurnId
      && message.turnId !== lease.activeTurnId
    ) {
      return;
    }
    const signal: RuntimeLifecycleSignal = {
      state: message.state,
      event: message.event,
      turnId: message.turnId,
      ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
      ...(message.result === undefined ? {} : { result: message.result }),
      ...(message.lastAssistantMessage === undefined ? {} : { lastAssistantMessage: message.lastAssistantMessage })
    };
    if (message.lastAssistantMessage !== undefined && lease.answerCaptureGrantExpiresAt !== null) {
      signal.answerCaptureGrantExpiresAt = lease.answerCaptureGrantExpiresAt;
    }
    // Captured text is delivered once and never stored in the lifecycle lease.
    lease.latest = {
      state: signal.state,
      event: signal.event,
      turnId: signal.turnId,
      ...(signal.threadId === undefined ? {} : { threadId: signal.threadId })
    };
    this.onSignal?.(message.terminalSessionId, signal);
  }

  /**
   * One decision hook call. Authenticated exactly like a lifecycle message, and only for a session launched with
   * decision hooks. The socket stays open until the answer; a closed socket, a revoke or the gateway deadline
   * aborts the check, and the answer is then `ask`. Checks are capped per session and in total; over a cap the
   * call is refused with a message asking the model to slow down (a flood must not slip past the rules).
   */
  private acceptPermission(socket: AgentGatewaySocket, value: Record<string, unknown>, close: () => void): void {
    let request: RuntimePermissionRequest & { terminalSessionId: string; capabilityToken: string };
    try {
      request = parsePermissionMessage(value);
    } catch {
      return close();
    }
    const lease = this.leases.get(request.terminalSessionId);
    if (!lease || lease.provider !== request.provider) return close();
    const supplied = digest(request.capabilityToken);
    const valid = supplied.length === lease.tokenDigest.length && timingSafeEqual(supplied, lease.tokenDigest);
    supplied.fill(0);
    if (!valid || !lease.decisions) return close();
    const { terminalSessionId, capabilityToken: _token, ...forwarded } = request;
    let answered = false;
    const answer = (decision: RuntimePermissionDecision): void => {
      if (answered) return;
      answered = true;
      const line = {
        v: RUNTIME_PROTOCOL_VERSION,
        type: "permission_decision",
        requestId: request.requestId,
        behavior: decision.behavior,
        ...(decision.message ? { message: decision.message } : {})
      };
      try {
        socket.write(Buffer.from(`${JSON.stringify(line)}\n`, "utf8"));
      } catch { /* the hook is gone: the CLI goes on without an answer */ }
      const timeout = setTimeout(close, 1_000);
      timeout.unref();
    };
    if (lease.checks.size >= MAX_DECISIONS_PER_SESSION || this.checks.size >= MAX_DECISIONS_TOTAL) {
      return answer({ behavior: "deny", message: OVERLOADED_MESSAGE });
    }
    const controller = new AbortController();
    lease.checks.add(controller);
    this.checks.add(controller);
    const deadline = setTimeout(() => controller.abort(), lease.gatewayMs);
    deadline.unref();
    const settle = (decision: RuntimePermissionDecision): void => {
      clearTimeout(deadline);
      lease.checks.delete(controller);
      this.checks.delete(controller);
      answer(controller.signal.aborted ? { behavior: "ask" } : enforceDecision(forwarded, decision));
    };
    controller.signal.addEventListener("abort", () => settle({ behavior: "ask" }), { once: true });
    socket.on("close", () => controller.abort());
    const handler = this.onPermissionRequest;
    if (!handler) return settle({ behavior: "none" });
    let pendingAnswer: Promise<RuntimePermissionDecision>;
    try {
      pendingAnswer = Promise.resolve(handler(terminalSessionId, forwarded, controller.signal));
    } catch {
      return settle({ behavior: "ask" });
    }
    pendingAnswer.then(settle, () => settle({ behavior: "ask" }));
  }
}

/** What leaves the gateway, whatever the handler said: never an allow of cut input. */
function enforceDecision(request: RuntimePermissionRequest, decision: RuntimePermissionDecision): RuntimePermissionDecision {
  if (!decision || !["allow", "deny", "ask", "none"].includes(decision.behavior)) return { behavior: "ask" };
  if (decision.behavior === "allow" && request.truncated) return { behavior: "ask" };
  const message = typeof decision.message === "string" ? decision.message.slice(0, PERMISSION_GATE.messageChars) : "";
  return { behavior: decision.behavior, ...(message ? { message } : {}) };
}

function isPermissionRequest(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === "permission_request";
}

const PERMISSION_KEYS = [
  "capabilityToken", "cwd", "provider", "requestId", "terminalSessionId", "toolInput",
  "toolInputPreview", "toolInputSha256", "toolName", "truncated", "type", "v"
].sort().join(",");

function parsePermissionMessage(value: Record<string, unknown>): RuntimePermissionRequest & { terminalSessionId: string; capabilityToken: string } {
  if (Object.keys(value).sort().join(",") !== PERMISSION_KEYS) throw new Error("Permission request has an invalid schema.");
  if (value.v !== RUNTIME_PROTOCOL_VERSION || value.type !== "permission_request") throw new Error("Permission request version is unsupported.");
  if (
    typeof value.terminalSessionId !== "string" || !value.terminalSessionId || value.terminalSessionId.length > 160
    || typeof value.provider !== "string" || !AGENT_PROVIDERS.has(value.provider as ProviderId)
    || typeof value.capabilityToken !== "string" || value.capabilityToken.length < 32
    || typeof value.requestId !== "string" || !/^[A-Za-z0-9-]{8,80}$/u.test(value.requestId)
    || typeof value.toolName !== "string" || !value.toolName || value.toolName.length > PERMISSION_GATE.toolNameChars
    || typeof value.toolInputSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.toolInputSha256)
    || typeof value.truncated !== "boolean"
    || (value.cwd !== null && (typeof value.cwd !== "string" || !value.cwd || value.cwd.length > 4_096))
    || (value.toolInputPreview !== null && (typeof value.toolInputPreview !== "string" || value.toolInputPreview.length > PERMISSION_GATE.toolInputPreviewChars))
  ) throw new Error("Permission request fields are invalid.");
  // Cut input carries only its preview; whole input carries no preview and must match its hash.
  if (value.truncated ? value.toolInput !== null || value.toolInputPreview === null : value.toolInputPreview !== null) {
    throw new Error("Permission request input is inconsistent.");
  }
  if (!value.truncated && createHash("sha256").update(JSON.stringify(value.toolInput), "utf8").digest("hex") !== value.toolInputSha256) {
    throw new Error("Permission request input does not match its hash.");
  }
  return value as unknown as RuntimePermissionRequest & { terminalSessionId: string; capabilityToken: string };
}

function isAnswerCaptureCheck(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === "answer-capture-check";
}

function parseLifecycleMessage(value: unknown): ParsedLifecycleMessage {
  if (!isRecord(value)) throw new Error("Runtime message must be an object.");
  const keys = Object.keys(value).filter((key) => key !== "lastAssistantMessage").sort();
  const expected = [
    "capabilityToken", "event", "provider", "state", "terminalSessionId", "turnId", "type", "v"
  ];
  if (value.result !== undefined) expected.push("result");
  if (value.threadId !== undefined) expected.push("threadId");
  expected.sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Runtime message has an invalid schema.");
  }
  if (value.v !== RUNTIME_PROTOCOL_VERSION || value.type !== "lifecycle") {
    throw new Error("Runtime message version is unsupported.");
  }
  if (
    typeof value.terminalSessionId !== "string"
    || value.terminalSessionId.length === 0
    || value.terminalSessionId.length > 160
    || typeof value.provider !== "string"
    || !AGENT_PROVIDERS.has(value.provider as ProviderId)
    || typeof value.capabilityToken !== "string"
    || value.capabilityToken.length < 32
    || typeof value.state !== "string"
    || !(RUNTIME_STATES as readonly string[]).includes(value.state)
    || typeof value.event !== "string"
    || value.event.length === 0
    || value.event.length > 80
    || (value.turnId !== null && (typeof value.turnId !== "string" || value.turnId.length > 160))
  ) throw new Error("Runtime message fields are invalid.");
  // Only the provider's own id shape, already in its stored form, is accepted.
  if (value.threadId !== undefined && normalizeThreadId(String(value.provider), value.threadId) !== value.threadId) {
    throw new Error("Runtime threadId is invalid.");
  }
  if (value.result !== undefined && (
    value.state !== "idle" || value.event !== "Stop" || !isRecord(value.result)
    || Object.keys(value.result).sort().join(",") !== "text,truncated"
    || typeof value.result.text !== "string" || value.result.text.length > MAX_RESULT_CHARS
    || typeof value.result.truncated !== "boolean"
  )) throw new Error("Runtime result is invalid.");
  if (value.lastAssistantMessage !== undefined && (
    value.provider !== "codex" || value.event !== "Stop" || value.state !== "idle"
    || typeof value.lastAssistantMessage !== "string" || value.lastAssistantMessage.length > MAX_ANSWER_CHARS
  )) throw new Error("Runtime lastAssistantMessage is invalid.");
  return value as unknown as ParsedLifecycleMessage;
}

function isTurnStart(event: string): boolean {
  return event === "UserPromptSubmit"
    || event === "TurnStarted"
    || event === "pre_llm_call"
    || event === "session.status:busy";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

async function createEndpoint(requestedRuntimeDirectory?: string): Promise<{
  endpoint: string;
  ownedRuntimeDirectory: string | null;
}> {
  const suffix = randomBytes(8).toString("hex");
  const runtimeDirectory = requestedRuntimeDirectory
    ?? join(tmpdir(), `ctty-runtime-${process.getuid?.() ?? "user"}-${suffix}`);
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  await chmod(runtimeDirectory, 0o700);
  const endpoint = join(runtimeDirectory, `r-${randomBytes(2).toString("hex")}.sock`);
  if (Buffer.byteLength(endpoint, "utf8") > 100) {
    throw new Error("Agent runtime directory is too long for a Unix domain socket.");
  }
  return {
    endpoint,
    ownedRuntimeDirectory: requestedRuntimeDirectory ? null : runtimeDirectory
  };
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

async function cleanupEndpoint(
  endpoint: string,
  ownedRuntimeDirectory: string | null,
  platform: NodeJS.Platform
): Promise<void> {
  if (platform !== "win32") await unlink(endpoint).catch(() => undefined);
  if (ownedRuntimeDirectory) await rmdir(ownedRuntimeDirectory).catch(() => undefined);
}
