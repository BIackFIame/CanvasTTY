#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { NdjsonLineReader } from "./ndjson.mjs";
import {
  AGENT_RUNTIME_ENV,
  DECISION_FAIL_CLOSED_ENV,
  MAX_HOOK_INPUT_BYTES,
  MAX_RUNTIME_MESSAGE_BYTES,
  PERMISSION_GATE,
  helperDeadlineMs,
  RUNTIME_PROTOCOL_VERSION
} from "./runtime-protocol.mjs";

/**
 * The decision hook for Claude Code, Codex and Qwen Code (PreToolUse; it fires before every matched tool call,
 * YOLO / bypass included). It sends the call to CanvasTTY over the capability-authenticated runtime socket, where
 * base protection and the plugins' decision services answer, and prints what the CLI reads:
 *
 * - deny (every CLI): the call does not run, and the reason goes to the model as what to do instead;
 * - ask (Claude Code): Claude asks the person for this call, whatever its permission mode;
 * - allow (Claude Code): the call runs without Claude's own prompt (only from plugins the person let allow);
 * - no verdict, or anything Codex and Qwen Code cannot take: nothing, and the CLI goes on as it would without us.
 *
 * Fail closed: the launch sets `CANVASTTY_RUNTIME_FAIL_CLOSED=1` in this hook's command whenever it installs it (base
 * protection on, or a decision plugin applies). Then a call the gate could not check (no socket, refused, no answer
 * within the deadline, an unreadable answer, the gateway's own failure where the CLI cannot ask, unreadable hook input)
 * is denied with FAIL_CLOSED_MESSAGE instead of left to run. Without the flag such a call gets nothing, as before.
 *
 * Every answer, the fail-closed deny included, is the CLI's documented deny JSON on stdout with exit code 0, the same
 * path base protection's own deny takes (exit 2 means something else for some CLIs). The helper answers well inside
 * the hook timeout. Only a hook that cannot start at all (a broken install) still leaves the call to the CLI.
 */

/** What the model reads when CanvasTTY could not check a call and did not let it run. */
export const FAIL_CLOSED_MESSAGE = "CanvasTTY safety check unavailable: this tool call was not run. Retry it, or ask the person how to proceed.";

if (invokedDirectly() && process.argv[2] === "pretool") {
  const failClosed = process.env[DECISION_FAIL_CLOSED_ENV] === "1";
  const output = await decide(process.env, failClosed).catch(() => (failClosed ? unavailableOutput() : null));
  if (output) await writeOut(`${JSON.stringify(output)}\n`).catch(() => undefined);
}

function invokedDirectly() {
  try {
    return typeof process.argv[1] === "string" && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

/** What to print for this call, or null to print nothing. Anything that stops the check is `unavailable()`. */
async function decide(env, failClosed) {
  const unavailable = () => (failClosed ? unavailableOutput() : null);
  const identity = identityFrom(env);
  const raw = await readInput();
  if (!identity || raw === null) return unavailable();
  let input;
  try { input = JSON.parse(raw); } catch { return unavailable(); }
  const message = buildRequest(input, identity);
  if (!message) return unavailable();
  const decision = await exchange(identity.address, message, helperDeadlineMs(env));
  if (!decision) return unavailable();
  // The gateway itself failed and asks the person: Claude Code can ask, Codex and Qwen Code cannot.
  if (decision.unavailable && decision.behavior === "ask" && identity.provider !== "claude") return unavailable();
  return hookOutput(identity.provider, decision);
}

/** The deny for a call CanvasTTY could not check. */
export function unavailableOutput() {
  return hookOutput("claude", { behavior: "deny", message: FAIL_CLOSED_MESSAGE });
}

export function identityFrom(env) {
  const identity = {
    address: env[AGENT_RUNTIME_ENV.address],
    terminalSessionId: env[AGENT_RUNTIME_ENV.terminalSessionId],
    provider: env[AGENT_RUNTIME_ENV.provider],
    capabilityToken: env[AGENT_RUNTIME_ENV.capabilityToken]
  };
  return identity.address && identity.terminalSessionId && identity.provider && identity.capabilityToken ? identity : null;
}

/** Reads the whole hook input; null when it is over the bound (the CLI then goes on as usual). */
async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    size += bytes.length;
    if (size > MAX_HOOK_INPUT_BYTES) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The permission_request line. The tool input goes whole when its JSON fits the bound; otherwise only a bounded
 * preview and the sha256 of the whole input go, marked truncated, and main never allows it.
 */
export function buildRequest(input, identity) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const toolName = typeof input.tool_name === "string" && input.tool_name.length > 0
    ? input.tool_name.slice(0, PERMISSION_GATE.toolNameChars) : null;
  if (!toolName) return null;
  const toolInput = input.tool_input === undefined ? null : input.tool_input;
  const json = JSON.stringify(toolInput) ?? "null";
  const base = {
    v: RUNTIME_PROTOCOL_VERSION,
    type: "permission_request",
    terminalSessionId: identity.terminalSessionId,
    provider: identity.provider,
    capabilityToken: identity.capabilityToken,
    requestId: randomUUID(),
    toolName,
    toolInputSha256: createHash("sha256").update(json, "utf8").digest("hex"),
    // The agent's current folder, as the CLI reports it: relative paths in the call are resolved against it.
    cwd: typeof input.cwd === "string" && input.cwd.length > 0 && input.cwd.length <= 4_096 ? input.cwd : null
  };
  const message = Buffer.byteLength(json, "utf8") <= PERMISSION_GATE.toolInputBytes
    ? { ...base, toolInput, toolInputPreview: null, truncated: false }
    : { ...base, toolInput: null, toolInputPreview: boundedText(json, PERMISSION_GATE.toolInputPreviewChars), truncated: true };
  if (Buffer.byteLength(`${JSON.stringify(message)}\n`, "utf8") <= MAX_RUNTIME_MESSAGE_BYTES) return message;
  // Multi-byte text can outgrow the wire cap: send the smaller, truncated form.
  return { ...base, toolInput: null, toolInputPreview: boundedText(json, 2_048), truncated: true };
}

/**
 * Sends one line and waits for the matching decision; null on anything else (no socket, refused, close, timeout,
 * garbage), which a fail-closed gate turns into a deny.
 */
export function exchange(address, message, deadlineMs) {
  return new Promise((resolve) => {
    const payload = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    const socket = createConnection(address);
    let settled = false;
    const lines = new NdjsonLineReader({ maxLineBytes: MAX_RUNTIME_MESSAGE_BYTES });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), deadlineMs);
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      try {
        const [line] = lines.push(chunk);
        if (!line) return;
        finish(parseDecision(JSON.parse(line.toString("utf8")), message.requestId));
      } catch {
        finish(null);
      }
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

export function parseDecision(value, requestId) {
  if (!value || typeof value !== "object" || value.v !== RUNTIME_PROTOCOL_VERSION
    || value.type !== "permission_decision" || value.requestId !== requestId) return null;
  if (!["allow", "deny", "ask", "none"].includes(value.behavior)) return null;
  const message = typeof value.message === "string" ? cleanMessage(value.message) : "";
  // `unavailable`: the gateway could not get an answer (its handler failed or ran out of time) and says ask.
  return { behavior: value.behavior, message, unavailable: value.unavailable === true };
}

/** What the CLI reads on stdout, or null to print nothing. Only Claude Code takes ask and allow from a hook. */
export function hookOutput(provider, decision) {
  if (!decision || decision.behavior === "none") return null;
  if (decision.behavior === "deny") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.message || "CanvasTTY blocked this tool call. Ask the person how to proceed."
      }
    };
  }
  if (provider !== "claude") return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.behavior,
      permissionDecisionReason: decision.message || (decision.behavior === "ask"
        ? "CanvasTTY asks the person about this tool call."
        : "Allowed by a CanvasTTY plugin the person trusts to allow.")
    }
  };
}

function cleanMessage(value) {
  // eslint-disable-next-line no-control-regex
  return boundedText(value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, " "), PERMISSION_GATE.messageChars);
}

function boundedText(value, limit) {
  const text = value.slice(0, limit);
  return /[\uD800-\uDBFF]$/u.test(text) ? text.slice(0, -1) : text;
}

function writeOut(text) {
  return new Promise((resolve) => {
    process.stdout.write(text, () => resolve());
  });
}
