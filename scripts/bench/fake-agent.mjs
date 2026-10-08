// Stub provider CLI for scripts/bench/baseline.mjs. Installed as `opencode` or `claude` (a wrapper sets
// BENCH_FAKE_PROVIDER) on the benchmark's PATH, so CanvasTTY launches it exactly like the real CLI and
// attaches the same helpers. It never talks to a model or the network.
//
// - opencode: reads OPENCODE_CONFIG_CONTENT, starts every `mcp` local server (command + environment, {env:NAME}
//   substituted) and loads every `plugin` file URL in this process (the CanvasTTY lifecycle plugin), then feeds it
//   OpenCode events.
// - claude: reads --mcp-config and --settings, starts every MCP server and runs the lifecycle hooks: command hooks
//   through `/usr/bin/time -l /bin/sh -c`, HTTP hooks as POSTs with the allowed environment headers.
// Every MCP server gets initialize + tools/list, then stays connected like a real session.
//
// Terminal input drives it (one line each): `churn <seconds> <periodMs>` runs agent turns (status busy -> one
// Bash tool call -> idle) with a spinner redraw every 100 ms, `print <kbps> <seconds>` writes log lines, `quit`.
// Hook timings and max RSS are appended to .bench-agent-<pid>.jsonl in the working folder.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const provider = process.env.BENCH_FAKE_PROVIDER === "claude" ? "claude" : "opencode";
const args = process.argv.slice(2);
if (args.includes("--version") || args[0] === "-v") {
  process.stdout.write(provider === "claude" ? "2.1.281 (Claude Code)\n" : "1.14.0\n");
  process.exit(0);
}
if (args.includes("--help") || args[0] === "help") {
  process.stdout.write(`${provider} (benchmark stub)\n`);
  process.exit(0);
}
if (provider === "opencode" && args[0] === "models") {
  process.stdout.write("bench/stub-model\n");
  process.exit(0);
}

const log = join(process.cwd(), `.bench-agent-${process.pid}.jsonl`);
const record = (entry) => { try { appendFileSync(log, `${JSON.stringify({ t: Date.now(), provider, ...entry })}\n`); } catch {} };
const sessionId = `bench-${process.pid}-${Date.now().toString(36)}`;
const children = [];

function substitute(value) {
  return typeof value === "string" ? value.replace(/\{env:([A-Za-z0-9_]+)\}/gu, (_, name) => process.env[name] ?? "") : value;
}

/** Start one stdio MCP server and do the handshake a client does. */
function startMcp(name, command, commandArgs, env) {
  const started = Date.now();
  const child = spawn(command, commandArgs, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
      } catch {}
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-600); });
  child.on("error", (error) => record({ mcp: name, error: error.message }));
  child.on("exit", (code, signal) => { if (!quitting) record({ mcp: name, error: `exited ${code ?? signal}: ${stderr}` }); });
  let nextId = 1;
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => resolve({ timeout: true }), 15_000).unref();
  });
  (async () => {
    const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: `bench-${provider}`, version: "1" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const tools = await request("tools/list", {});
    record({ mcp: name, pid: child.pid, readyMs: Date.now() - started, ok: !init.timeout && !init.error, tools: tools.result?.tools?.length ?? null });
  })();
}

// ---- opencode ----
let plugins = [];
async function startOpenCode() {
  let config = {};
  try { config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}"); } catch {}
  for (const [name, entry] of Object.entries(config.mcp ?? {})) {
    if (entry?.type !== "local" || entry.enabled === false || !Array.isArray(entry.command)) continue;
    const env = Object.fromEntries(Object.entries(entry.environment ?? {}).map(([key, value]) => [key, substitute(value)]));
    startMcp(name, entry.command[0], entry.command.slice(1).map(substitute), env);
  }
  for (const url of config.plugin ?? []) {
    try {
      const module = await import(url);
      for (const factory of Object.values(module)) {
        if (typeof factory === "function") plugins.push(await factory({ client: undefined, directory: process.cwd() }));
      }
    } catch (error) {
      record({ plugin: url, error: error.message });
    }
  }
  await emit({ type: "session.created", properties: { info: { id: sessionId } } });
}
async function emit(event) {
  for (const plugin of plugins) {
    try { await plugin?.event?.({ event }); } catch (error) { record({ event: event.type, error: error.message }); }
  }
}
async function openCodeTurn() {
  await emit({ type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } });
  for (const plugin of plugins) {
    const before = plugin?.["tool.execute.before"];
    if (before) {
      const started = Date.now();
      try { await before({ tool: "bash", sessionID: sessionId, callID: `c${Date.now()}` }, { args: { command: "ls -la" } }); } catch {}
      record({ hook: "tool.execute.before", ms: Date.now() - started });
    }
  }
  await emit({ type: "session.status", properties: { sessionID: sessionId, status: { type: "idle" } } });
  await emit({ type: "session.idle", properties: { sessionID: sessionId } });
}

// ---- claude ----
let hooks = {};
function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
function startClaude() {
  try {
    const mcp = JSON.parse(argValue("--mcp-config") ?? "{}");
    for (const [name, entry] of Object.entries(mcp.mcpServers ?? {})) {
      if (entry?.command) startMcp(name, entry.command, entry.args ?? [], entry.env ?? {});
    }
  } catch (error) { record({ error: `mcp-config: ${error.message}` }); }
  try { hooks = JSON.parse(argValue("--settings") ?? "{}").hooks ?? {}; } catch (error) { record({ error: `settings: ${error.message}` }); }
  return runHooks("SessionStart", {});
}
function runCommandHook(command, payload, timeoutSeconds) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("/usr/bin/time", ["-l", "/bin/sh", "-c", command], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), (timeoutSeconds ?? 60) * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const number = (pattern) => Number(pattern.exec(stderr)?.[1] ?? NaN);
      resolve({
        kind: "command", ms: Date.now() - started, code,
        maxRssKb: Math.round(number(/(\d+)\s+maximum resident set size/u) / 1024),
        userS: number(/([\d.]+) user/u), sysS: number(/([\d.]+) sys/u),
        helper: /([\w-]+)\.mjs/u.exec(command)?.[1] ?? (/canvastty-helper'? '([\w-]+)'/u.exec(command)?.[1] ? `native:${/canvastty-helper'? '([\w-]+)'/u.exec(command)[1]}` : "command"), decision: stdout.slice(0, 80)
      });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
async function runHttpHook(hook, payload) {
  const started = Date.now();
  const headers = { "content-type": "application/json" };
  for (const [key, value] of Object.entries(hook.headers ?? {})) {
    headers[key] = String(value).replace(/\$\{([A-Za-z0-9_]+)\}/gu, (_, name) => (hook.allowedEnvVars ?? []).includes(name) ? process.env[name] ?? "" : "");
  }
  try {
    const response = await fetch(hook.url, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout((hook.timeout ?? 30) * 1000) });
    await response.text();
    return { kind: "http", ms: Date.now() - started, code: response.status };
  } catch (error) {
    return { kind: "http", ms: Date.now() - started, error: error.message };
  }
}
async function runHooks(event, extra, toolName) {
  const payload = { session_id: sessionId, transcript_path: join(process.cwd(), ".bench-transcript.jsonl"), cwd: process.cwd(), hook_event_name: event, ...extra };
  for (const group of hooks[event] ?? []) {
    if (group.matcher && toolName && !new RegExp(`^(?:${group.matcher})$`, "u").test(toolName)) continue;
    if (group.matcher && !toolName && event !== "Notification") continue;
    for (const hook of group.hooks ?? []) {
      const result = hook.type === "http" ? await runHttpHook(hook, payload) : await runCommandHook(hook.command, payload, hook.timeout);
      record({ hook: event, ...result });
    }
  }
}
async function claudeTurn() {
  await runHooks("UserPromptSubmit", { prompt: "benchmark turn" });
  const tool = { tool_name: "Bash", tool_input: { command: "ls -la", description: "list" }, tool_use_id: `t${Date.now()}` };
  await runHooks("PreToolUse", tool, "Bash");
  await runHooks("PostToolUse", { ...tool, tool_response: { stdout: "ok", stderr: "", interrupted: false } }, "Bash");
  await runHooks("Stop", { stop_hook_active: false, last_assistant_message: "done" });
}

// ---- terminal ----
const write = (text) => process.stdout.write(text);
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
let quitting = false;
async function churn(seconds, periodMs) {
  const end = Date.now() + seconds * 1000;
  let turn = 0;
  while (Date.now() < end && !quitting) {
    const started = Date.now();
    let frame = 0;
    const spinner = setInterval(() => write(`\r\x1b[2K\x1b[33m${SPIN[frame++ % SPIN.length]}\x1b[0m Working… turn ${turn} (${((Date.now() - started) / 1000).toFixed(1)}s)`), 100);
    await (provider === "claude" ? claudeTurn() : openCodeTurn());
    clearInterval(spinner);
    record({ turn: turn, ms: Date.now() - started });
    write(`\r\x1b[2K\x1b[32m●\x1b[0m Bash(ls -la) turn ${turn++} done in ${Date.now() - started} ms\r\n`);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, periodMs - (Date.now() - started))));
  }
}
function print(kbps, seconds) {
  return new Promise((resolve) => {
    const perTick = Math.round((kbps * 1024) / 20);
    const end = Date.now() + seconds * 1000;
    let n = 0;
    const timer = setInterval(() => {
      let chunk = "";
      while (chunk.length < perTick) chunk += `\x1b[36m${String(n++).padStart(8, "0")}\x1b[0m agent output line ${n % 997}\r\n`;
      write(chunk);
      if (Date.now() >= end) { clearInterval(timer); resolve(); }
    }, 50);
  });
}

async function main() {
  write(`\x1b[1m${provider}\x1b[0m benchmark stub · session ${sessionId}\r\n`);
  if (provider === "claude") await startClaude();
  else await startOpenCode();
  record({ started: true, mcp: children.length, plugins: plugins.length, hookEvents: Object.keys(hooks) });
  write("> ");
  const lines = createInterface({ input: process.stdin });
  let busy = Promise.resolve();
  lines.on("line", (line) => {
    const [command, a, b] = line.trim().split(/\s+/u);
    busy = busy.then(async () => {
      if (command === "churn") await churn(Number(a) || 30, Number(b) || 3000);
      else if (command === "print") await print(Number(a) || 256, Number(b) || 10);
      else if (command === "quit") shutdown();
      write("> ");
    });
  });
  lines.on("close", shutdown);
}
function shutdown() {
  if (quitting) return;
  quitting = true;
  const finish = () => {
    for (const child of children) try { child.kill(); } catch {}
    setTimeout(() => process.exit(0), 200);
  };
  if (provider === "claude") runHooks("SessionEnd", { reason: "exit" }).finally(finish);
  else finish();
}
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
main().catch((error) => { record({ error: error.stack ?? String(error) }); });
