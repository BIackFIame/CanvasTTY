// End to end with the real Claude Code CLI and a local Ollama model, when both are available: with the decision hook
// installed the way a CanvasTTY launch installs it, a Bash call runs while the gateway answers, and is refused, not
// run, once the gateway is gone. Claude runs under a throwaway HOME against http://127.0.0.1:11434 with the
// placeholder token Ollama ignores. Nothing is pulled: the test uses a model already on this computer
// (CANVASTTY_TEST_OLLAMA_MODEL, else qwen3.5:9b or gpt-oss:20b) and skips when there is none or no server.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { FAIL_CLOSED_MESSAGE } from "../src/agent-runtime/permission-gate.mjs";
import { AgentRuntimeBridge } from "../src/main/services/agent-runtime/AgentRuntimeBridge.ts";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";

const OLLAMA = "http://127.0.0.1:11434";

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

async function findModel() {
  try {
    const response = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2_000) });
    const names = ((await response.json()).models ?? []).filter((model) => !model.remote_host).map((model) => model.name);
    const wanted = process.env.CANVASTTY_TEST_OLLAMA_MODEL ? [process.env.CANVASTTY_TEST_OLLAMA_MODEL] : ["qwen3.5:9b", "gpt-oss:20b"];
    return wanted.find((name) => names.includes(name)) ?? null;
  } catch {
    return null;
  }
}

const claude = process.platform === "win32" ? null : findClaude();
const model = claude ? await findModel() : null;
const skip = !claude ? "Claude Code CLI not installed" : !model ? "no local Ollama server with a tool-capable model" : false;

test("real Claude Code on Ollama: a Bash call runs while CanvasTTY answers and is refused once it cannot", { skip, timeout: 600_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-real-fail-closed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const work = join(root, "work");
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(work);

  const checked = [];
  const gateway = new RuntimeGateway({
    runtimeDirectory: join(root, "rt"),
    onPermissionRequest: (_id, request) => { checked.push(request.toolInput?.command); return { behavior: "none" }; }
  });
  await gateway.start();
  let open = true;
  t.after(() => (open ? gateway.close() : undefined));
  const node = { command: process.execPath, args: [] };
  const bridge = new AgentRuntimeBridge(gateway, {
    helper: { ...node, args: [new URL("../src/agent-runtime/hook-helper.mjs", import.meta.url).pathname] },
    permissionGate: { ...node, args: [new URL("../src/agent-runtime/permission-gate.mjs", import.meta.url).pathname] },
    runtimeDirectory: join(root, "rt"),
    openCodePluginPath: join(root, "opencode.mjs"),
    coreHooksEnabled: false
  });
  const launch = bridge.prepareLaunch({ terminalSessionId: "real-claude", provider: "claude", cwd: work, decisions: true });
  t.after(() => launch.cleanup());
  assert.equal(launch.decisions, true);

  /** One `claude -p` turn asking for exactly this command; the Bash tool calls and their results from stream-json. */
  async function turn(command) {
    const child = spawn(claude.path, [
      "-p", `Use the Bash tool exactly once to run this exact command, unchanged: ${command}\nDo not run anything else. Then reply with the single word DONE.`,
      "--model", model, "--allowedTools", "Bash", "--output-format", "stream-json", "--verbose", "--max-turns", "4", ...launch.args
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
        ANTHROPIC_BASE_URL: OLLAMA,
        ANTHROPIC_AUTH_TOKEN: "ollama",
        ANTHROPIC_API_KEY: "",
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        ...launch.environment
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    await new Promise((resolve) => child.on("close", resolve));
    const events = stdout.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    const blocks = events.flatMap((event) => (Array.isArray(event.message?.content) ? event.message.content : []));
    const uses = blocks.filter((block) => block.type === "tool_use" && block.name === "Bash");
    const results = blocks.filter((block) => block.type === "tool_result" && uses.some((use) => use.id === block.tool_use_id))
      .map((block) => (typeof block.content === "string" ? block.content : JSON.stringify(block.content)));
    return { uses, results, stderr };
  }

  /** The model may paraphrase or skip the call; ask up to three times for a Bash call with the marker in it. */
  async function turnWithCall(command, marker) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await turn(command);
      if (result.uses.some((use) => String(use.input?.command).includes(marker))) return result;
    }
    return null;
  }

  // While CanvasTTY answers (no verdict), the call runs and the gate saw it.
  const allowed = await turnWithCall(`touch ${join(work, "allowed.txt")}`, "allowed.txt");
  if (!allowed) return t.skip(`${model} did not call Bash`);
  assert.equal(existsSync(join(work, "allowed.txt")), true, "the checked call ran");
  assert.ok(checked.some((command) => String(command).includes("allowed.txt")), "the decision hook checked it");

  // CanvasTTY is gone (the socket is removed): the same kind of call is refused and the model reads why.
  await gateway.close();
  open = false;
  const blocked = await turnWithCall(`touch ${join(work, "blocked.txt")}`, "blocked.txt");
  if (!blocked) return t.skip(`${model} did not call Bash the second time`);
  assert.equal(existsSync(join(work, "blocked.txt")), false, "the unchecked call did not run");
  assert.ok(blocked.results.some((text) => text.includes(FAIL_CLOSED_MESSAGE)), `the model was told why: ${JSON.stringify(blocked.results)}`);
});
