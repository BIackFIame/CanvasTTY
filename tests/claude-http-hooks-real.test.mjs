// End to end with the real Claude Code CLI, when it is installed and new enough: its HTTP lifecycle hooks reach the
// gateway, SessionStart and the decision hook still run as commands, and base-protection-style denies still hold.
// Claude runs against a local mock of the Messages API, under a throwaway HOME, with a dummy key.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { CLAUDE_HTTP_HOOK } from "../src/agent-runtime/runtime-protocol.mjs";
import { AgentRuntimeBridge } from "../src/main/services/agent-runtime/AgentRuntimeBridge.ts";
import { compareVersions } from "../src/main/services/agent-runtime/ClaudeHttpHooks.ts";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";
import { startMockAnthropicApi } from "./fixtures/mock-anthropic-api.mjs";

function findClaude() {
  for (const candidate of (process.env.PATH ?? "").split(delimiter).map((folder) => join(folder, "claude"))) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      const version = /(\d+\.\d+\.\d+)/u.exec(execFileSync(candidate, ["--version"], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH, HOME: tmpdir() } }))?.[1];
      if (version) return { path: candidate, version };
    } catch { /* not runnable */ }
  }
  return null;
}

const claude = process.platform === "win32" ? null : findClaude();
const skip = !claude ? "Claude Code CLI not installed"
  : compareVersions(claude.version, CLAUDE_HTTP_HOOK.minimumVersion) < 0 ? `Claude ${claude.version} is older than ${CLAUDE_HTTP_HOOK.minimumVersion}`
    : false;

test("real Claude Code: lifecycle over HTTP, SessionStart and decisions through the helper, denies still hold", { skip, timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-real-claude-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const work = join(root, "work");
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(work);

  const signals = [];
  const decisions = [];
  const gateway = new RuntimeGateway({
    runtimeDirectory: join(root, "rt"),
    httpHooks: true,
    onSignal: (id, signal) => signals.push({ id, ...signal }),
    onPermissionRequest: (_id, request) => {
      decisions.push(request.toolInput?.command);
      return String(request.toolInput?.command).includes("forbidden")
        ? { behavior: "deny", message: "blocked by the test gate" }
        : { behavior: "none" };
    }
  });
  await gateway.start();
  t.after(() => gateway.close());
  const node = { command: process.execPath, args: [] };
  const bridge = new AgentRuntimeBridge(gateway, {
    helper: { ...node, args: [new URL("../src/agent-runtime/hook-helper.mjs", import.meta.url).pathname] },
    permissionGate: { ...node, args: [new URL("../src/agent-runtime/permission-gate.mjs", import.meta.url).pathname] },
    runtimeDirectory: join(root, "rt"),
    openCodePluginPath: join(root, "opencode.mjs"),
    claudeHttpHooks: () => ({ ok: true })
  });
  const launch = bridge.prepareLaunch({
    terminalSessionId: "real-claude", provider: "claude", cwd: work, captureResult: true, decisions: true,
    claudeHttp: { executable: claude.path, profile: "default", environmentWrapped: false, env: {}, args: [], cwd: work }
  });
  t.after(() => launch.cleanup());
  assert.equal(launch.httpHooks, true);
  assert.equal(launch.decisions, true);

  const api = await startMockAnthropicApi([`echo one > ${join(work, "allowed.txt")}`, `echo forbidden > ${join(work, "denied.txt")}`]);
  t.after(() => api.close());
  const debugFile = join(root, "claude-debug.log");
  const child = spawn(claude.path, [
    "-p", "run the steps", "--allowedTools", "Bash", "--model", "claude-sonnet-4-5", "--debug-file", debugFile, ...launch.args
  ], {
    cwd: work,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: `${root}/`,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: "placeholder",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ...launch.environment
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(existsSync(join(work, "allowed.txt")), true, "the allowed step ran");
  assert.equal(existsSync(join(work, "denied.txt")), false, "the denied step did not run");
  assert.equal(decisions.length, 2, "both Bash calls went through the decision hook");

  const debug = readFileSync(debugFile, "utf8");
  const base = gateway.httpHookBase;
  for (const route of ["working/UserPromptSubmit", "working/PostToolUse", "idle/Stop", "idle/SessionEnd"]) {
    assert.ok(debug.includes(`HTTP hook POST to ${base}${CLAUDE_HTTP_HOOK.pathPrefix}${route}`), route);
  }
  assert.equal(debug.includes(`${base}${CLAUDE_HTTP_HOOK.pathPrefix}idle/SessionStart`), false);
  assert.equal(debug.includes(launch.environment.CANVASTTY_RUNTIME_CAPABILITY), false, "the capability is never logged");

  const events = signals.map((signal) => signal.event);
  assert.equal(events[0], "SessionStart");
  for (const event of ["UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]) assert.ok(events.includes(event), event);
  const stop = signals.find((signal) => signal.event === "Stop");
  assert.deepEqual(stop.result, { text: "DONE", truncated: false });
  assert.match(stop.threadId, /^[0-9a-f-]{36}$/u);
  assert.ok(stop.turnId);
});
