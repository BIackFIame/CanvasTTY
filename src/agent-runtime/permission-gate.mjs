#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  AGENT_RUNTIME_ENV,
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
 * Exit code is always 0 (exit 2 means something else for some CLIs). A CLI runs the call when this hook crashes or
 * times out, so this is a guard, not a sandbox.
 */

if (invokedDirectly() && process.argv[2] === "pretool") {
  await run().catch(() => undefined);
}

function invokedDirectly() {
  try {
    return typeof process.argv[1] === "string" && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

async function run() {
  const identity = identityFrom(process.env);
  const raw = await readInput();
  if (!identity || raw === null) return;
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  const message = buildRequest(input, identity);
  if (!message) return;
  const decision = await exchange(identity.address, message, helperDeadlineMs(process.env));
  const output = hookOutput(identity.provider, decision);
  if (output) await writeOut(`${JSON.stringify(output)}\n`);
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

/** Sends one line and waits for the matching decision; null on anything else (close, timeout, garbage). */
export function exchange(address, message, deadlineMs) {
  return new Promise((resolve) => {
    const payload = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    const socket = createConnection(address);
    let settled = false;
    let response = Buffer.alloc(0);
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
      response = Buffer.concat([response, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk]);
      if (response.length > MAX_RUNTIME_MESSAGE_BYTES) return finish(null);
      const newline = response.indexOf(0x0a);
      if (newline < 0) return;
      try {
        finish(parseDecision(JSON.parse(response.subarray(0, newline).toString("utf8")), message.requestId));
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
  if (value.behavior !== "allow" && value.behavior !== "deny" && value.behavior !== "ask") return null;
  const message = typeof value.message === "string" ? cleanMessage(value.message) : "";
  return { behavior: value.behavior, message };
}

/** What the CLI reads on stdout, or null to print nothing. Only Claude Code takes ask and allow from a hook. */
export function hookOutput(provider, decision) {
  if (!decision) return null;
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
