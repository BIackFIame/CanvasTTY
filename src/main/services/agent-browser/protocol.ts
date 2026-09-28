import { NdjsonDecoderBase } from "../../../agent-runtime/ndjson.mjs";
import type {
  BrowserActivityEvent,
  BrowserActor,
  BrowserCommand,
  BrowserCommandType,
  BrowserResult
} from "../../../shared/contracts.ts";
import {
  MAX_BRIDGE_PAYLOAD_BYTES,
  canonicalStringify,
  isApprovedBrowserTool,
  validateToolArguments
} from "../../../agent-browser/tool-catalog.mjs";

export const AGENT_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_EXPIRY_MS = 15_000;
export const MAX_CONNECTED_AGENTS = 16;
export const MAX_INFLIGHT_COMMANDS = 8;
export const AGENT_BROWSER_ENV = Object.freeze({
  address: "CANVASTTY_AGENT_BROWSER_ADDRESS",
  agentId: "CANVASTTY_AGENT_ID",
  connectionId: "CANVASTTY_AGENT_CONNECTION_ID",
  terminalSessionId: "CANVASTTY_TERMINAL_SESSION_ID",
  provider: "CANVASTTY_AGENT_PROVIDER",
  capabilityToken: "CANVASTTY_AGENT_CAPABILITY"
});

export interface BrowserCoreLike {
  execute(actor: BrowserActor, command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult>;
  subscribe(
    actor: BrowserActor,
    sinceSequence: number,
    listener: (event: BrowserActivityEvent) => void
  ): () => void;
  agentConnected?(actor: BrowserActor): void;
  agentHeartbeat?(actor: BrowserActor, timestamp: number): void;
  agentDisconnected?(actor: BrowserActor, reason: AgentDisconnectReason): void;
  agentCursor?(actor: BrowserActor, cursor: { tabId: string; x: number; y: number }): void;
}

export type AgentDisconnectReason = "closed" | "expired" | "revoked" | "protocol_error";

export type AgentProvider = "claude" | "codex" | "qwen" | "kimi" | "opencode" | "hermes";

export interface AgentCapability {
  agentId: string;
  connectionId: string;
  terminalSessionId: string;
  provider: AgentProvider;
  capabilityToken: string;
  address: string;
  authenticated: Promise<void>;
}

export interface AuthenticateMessage {
  v: typeof AGENT_BRIDGE_PROTOCOL_VERSION;
  type: "authenticate";
  agentId: string;
  connectionId: string;
  terminalSessionId: string;
  provider: AgentProvider;
  capabilityToken: string;
}

export interface RequestMessage {
  v: typeof AGENT_BRIDGE_PROTOCOL_VERSION;
  type: "request";
  id: string;
  tool: BrowserCommandType;
  arguments: Record<string, unknown>;
}

export interface HeartbeatMessage {
  v: typeof AGENT_BRIDGE_PROTOCOL_VERSION;
  type: "heartbeat";
  timestamp: number;
}

export interface CursorMessage {
  v: typeof AGENT_BRIDGE_PROTOCOL_VERSION;
  type: "cursor";
  tabId: string;
  x: number;
  y: number;
}

export interface CancelMessage {
  v: typeof AGENT_BRIDGE_PROTOCOL_VERSION;
  type: "cancel";
  id: string;
}

export type ClientMessage = AuthenticateMessage | RequestMessage | HeartbeatMessage | CursorMessage | CancelMessage;

export type BridgeErrorCode =
  | "AUTH_INVALID"
  | "AUTH_REPLAYED"
  | "BRIDGE_BUSY"
  | "CANCELED"
  | "INVALID_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "SESSION_EXPIRED"
  | "TIMEOUT"
  | "INTERNAL_ERROR";

export interface BridgeErrorPayload {
  code: BridgeErrorCode;
  message: string;
  retryable: boolean;
}

export type ServerMessage =
  | {
    v: typeof AGENT_BRIDGE_PROTOCOL_VERSION;
    type: "authenticated";
    heartbeatIntervalMs: number;
    heartbeatExpiryMs: number;
    reconnectToken: string;
  }
  | {
    v: typeof AGENT_BRIDGE_PROTOCOL_VERSION;
    type: "heartbeat_ack";
    timestamp: number;
  }
  | {
    v: typeof AGENT_BRIDGE_PROTOCOL_VERSION;
    type: "response";
    id: string;
    result?: BrowserResult;
    error?: BridgeErrorPayload;
  }
  | {
    v: typeof AGENT_BRIDGE_PROTOCOL_VERSION;
    type: "event";
    event: BrowserActivityEvent;
  }
  | {
    v: typeof AGENT_BRIDGE_PROTOCOL_VERSION;
    type: "error";
    error: BridgeErrorPayload;
  };

export function parseClientMessage(value: unknown, authenticated: boolean): ClientMessage {
  const object = strictObject(value, "message");
  const type = requiredString(object, "type", 32);
  if (object.v !== AGENT_BRIDGE_PROTOCOL_VERSION) throw protocolError("Unsupported bridge protocol version.");

  if (type === "authenticate") {
    assertExactKeys(object, [
      "v",
      "type",
      "agentId",
      "connectionId",
      "terminalSessionId",
      "provider",
      "capabilityToken"
    ]);
    if (authenticated) throw bridgeError("AUTH_REPLAYED", "This connection is already authenticated.", false);
    const provider = requiredString(object, "provider", 16);
    if (provider !== "claude" && provider !== "codex" && provider !== "qwen" && provider !== "kimi" && provider !== "opencode" && provider !== "hermes") {
      throw bridgeError("AUTH_INVALID", "Unknown agent provider.", false);
    }
    return {
      v: AGENT_BRIDGE_PROTOCOL_VERSION,
      type,
      agentId: requiredString(object, "agentId", 128),
      connectionId: requiredString(object, "connectionId", 128),
      terminalSessionId: requiredString(object, "terminalSessionId", 128),
      provider,
      capabilityToken: requiredString(object, "capabilityToken", 128)
    };
  }

  if (!authenticated) throw bridgeError("AUTH_INVALID", "Authenticate before sending commands.", false);

  if (type === "heartbeat") {
    assertExactKeys(object, ["v", "type", "timestamp"]);
    if (typeof object.timestamp !== "number" || !Number.isFinite(object.timestamp)) {
      throw protocolError("heartbeat.timestamp must be finite.");
    }
    return { v: AGENT_BRIDGE_PROTOCOL_VERSION, type, timestamp: object.timestamp };
  }

  if (type === "cursor") {
    assertExactKeys(object, ["v", "type", "tabId", "x", "y"]);
    const x = finiteNumber(object.x, "cursor.x", -1_000_000, 1_000_000);
    const y = finiteNumber(object.y, "cursor.y", -1_000_000, 1_000_000);
    return {
      v: AGENT_BRIDGE_PROTOCOL_VERSION,
      type,
      tabId: requiredString(object, "tabId", 128),
      x,
      y
    };
  }

  if (type === "cancel") {
    assertExactKeys(object, ["v", "type", "id"]);
    return {
      v: AGENT_BRIDGE_PROTOCOL_VERSION,
      type,
      id: requiredString(object, "id", 128)
    };
  }

  if (type === "request") {
    assertExactKeys(object, ["v", "type", "id", "tool", "arguments"]);
    const id = requiredString(object, "id", 128);
    if (!isApprovedBrowserTool(object.tool)) throw protocolError("Unsupported browser tool.");
    const validation = validateToolArguments(object.tool, object.arguments);
    if (!validation.ok) throw protocolError(validation.error);
    return {
      v: AGENT_BRIDGE_PROTOCOL_VERSION,
      type,
      id,
      tool: object.tool as BrowserCommandType,
      arguments: validation.value
    };
  }

  throw protocolError(`Unsupported bridge message type: ${type}.`);
}

export function commandFromRequest(message: RequestMessage): BrowserCommand {
  return {
    type: message.tool,
    requestId: message.id,
    ...message.arguments
  } as BrowserCommand;
}

export function encodeServerMessage(message: ServerMessage): Buffer {
  const json = canonicalStringify(message);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_BRIDGE_PAYLOAD_BYTES) {
    throw bridgeError("PAYLOAD_TOO_LARGE", "Bridge response exceeds 512KB.", false);
  }
  return Buffer.from(`${json}\n`, "utf8");
}

/** Decodes the bridge's NDJSON stream: lines over 512KB and lines that are not JSON are protocol errors. */
export class NdjsonDecoder extends NdjsonDecoderBase {
  constructor() {
    super({
      maxLineBytes: MAX_BRIDGE_PAYLOAD_BYTES,
      tooLarge: payloadError,
      invalid: () => protocolError("Bridge message is not valid JSON.")
    });
  }
}

export function bridgeError(
  code: BridgeErrorCode,
  message: string,
  retryable: boolean
): Error & { bridgeError: BridgeErrorPayload } {
  return Object.assign(new Error(message), { bridgeError: { code, message, retryable } });
}

export function asBridgeError(error: unknown): BridgeErrorPayload {
  if (
    error
    && typeof error === "object"
    && "bridgeError" in error
    && error.bridgeError
    && typeof error.bridgeError === "object"
  ) return error.bridgeError as BridgeErrorPayload;
  if (error instanceof Error && error.name === "AbortError") {
    return { code: "CANCELED", message: "Browser command was canceled.", retryable: true };
  }
  return { code: "INTERNAL_ERROR", message: "Agent browser bridge failed.", retryable: true };
}

function protocolError(message: string): Error & { bridgeError: BridgeErrorPayload } {
  return bridgeError("INVALID_REQUEST", message, false);
}

function payloadError(): Error & { bridgeError: BridgeErrorPayload } {
  return bridgeError("PAYLOAD_TOO_LARGE", "Bridge message exceeds 512KB.", false);
}

function strictObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError(`${name} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw protocolError(`${name} must be plain JSON.`);
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const allowlist = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowlist.has(key)) throw protocolError(`message.${key} is not allowed.`);
  }
}

function requiredString(value: Record<string, unknown>, key: string, maximum: number): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > maximum) {
    throw protocolError(`message.${key} must be a non-empty string of at most ${maximum} characters.`);
  }
  return candidate;
}

function finiteNumber(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw protocolError(`${name} must be a finite number between ${minimum} and ${maximum}.`);
  }
  return value;
}
