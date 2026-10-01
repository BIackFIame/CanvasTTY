import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateOrchestrationArguments, ORCHESTRATION_TOOL_DEFINITIONS } from "../src/agent-browser/orchestration-catalog.mjs";
import { AgentControlService, subagentProfile } from "../src/main/services/AgentControlService.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

test("a subagent inherits its orchestrator's profile; YOLO is never handed down", () => {
  assert.deepEqual(subagentProfile("normal", "opencode"), { profile: "normal", inherited: true });
  assert.deepEqual(subagentProfile("auto", "opencode"), { profile: "auto", inherited: true });
  assert.deepEqual(subagentProfile("auto", "qwen"), { profile: "normal", inherited: true }, "no auto mode: normal");
  assert.deepEqual(subagentProfile("yolo", "codex"), { profile: "auto", inherited: true });
  assert.deepEqual(subagentProfile("yolo", "kimi"), { profile: "normal", inherited: true });
  assert.deepEqual(subagentProfile("yolo", "claude", "normal"), { profile: "normal", inherited: false });
  assert.deepEqual(subagentProfile("normal", "opencode", "auto"), { profile: "auto", inherited: false });
  assert.match(subagentProfile("yolo", "codex", "yolo").error, /isolated environment/u);
  assert.match(subagentProfile("normal", "qwen", "auto").error, /qwen has no auto mode/u);
  assert.match(subagentProfile("normal", "codex", "fast").error, /normal or auto/u);
  const spawn = ORCHESTRATION_TOOL_DEFINITIONS.find((tool) => tool.name === "spawn_agent");
  assert.deepEqual(spawn.inputSchema.properties.profile.enum, ["normal", "auto"]);
  assert.match(spawn.description, /never YOLO/u);
  assert.match(validateOrchestrationArguments("spawn_agent", { provider: "codex", cwd: "/p", profile: "yolo" }).error, /profile is not an accepted value/u);
});

function runtime(decisions) {
  return {
    prepareLaunch: () => ({ args: [], environment: decisions ? { CANVASTTY_RUNTIME_DECISIONS: "1" } : {}, decisions, cleanup() {} }),
    currentStatus: () => null
  };
}

async function setup(t, { decisions, baseProtection, parentProfile = "auto", parentProvider = "codex" }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-subagent-profile-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, runtime(decisions), true, fakeSpawner(calls));
  terminals.configureBaseProtection(() => baseProtection);
  t.after(() => terminals.disposeAll());
  const orchestrator = terminals.create({ provider: parentProvider, cwd: root, profile: parentProfile, position: { x: 0, y: 0 }, role: "orchestrator" });
  const handler = new ScopedOrchestrationHandler(new AgentControlService(terminals));
  const spawn = (args) => handler.execute(orchestrator.id, { id: "s", tool: "spawn_agent", arguments: { cwd: root, ...args } });
  return { root, calls, terminals, spawn };
}

const buildBash = (call) => JSON.parse(call.options.env.OPENCODE_CONFIG_CONTENT).agent?.build?.permission?.bash;

test("an auto orchestrator's OpenCode subagent runs in auto: edits without asking, shell guarded by base protection", async (t) => {
  const { calls, terminals, spawn } = await setup(t, { decisions: true, baseProtection: true });
  const child = await spawn({ provider: "opencode" });
  assert.deepEqual([child.profile, child.profileInherited], ["auto", true]);
  assert.equal(terminals.getMetadata(child.sessionId).profile, "auto", "the card shows the profile it runs in");
  assert.equal(buildBash(calls.at(-1)), "allow");
  const normal = await spawn({ provider: "opencode", profile: "normal" });
  assert.equal(normal.profile, "normal");
  assert.equal(normal.profileInherited, undefined);
  const inline = calls.at(-1).options.env.OPENCODE_CONFIG_CONTENT;
  assert.ok(inline === undefined || JSON.parse(inline).agent?.build?.permission === undefined, "normal gets no auto rules");
  const qwen = await spawn({ provider: "qwen" });
  assert.equal(qwen.profile, "normal", "an auto the CLI lacks becomes normal");
  await assert.rejects(spawn({ provider: "qwen", profile: "auto" }), (error) => error.bridgeError?.code === "INVALID_REQUEST" && /no auto mode/u.test(error.message));
  await assert.rejects(spawn({ provider: "codex", profile: "yolo" }), (error) => error.bridgeError?.code === "INVALID_REQUEST" && /isolated environment/u.test(error.message));
});

test("a YOLO orchestrator's subagents run in auto or normal, never YOLO", async (t) => {
  const { calls, spawn } = await setup(t, { decisions: true, baseProtection: true, parentProfile: "yolo" });
  const codex = await spawn({ provider: "codex" });
  assert.equal(codex.profile, "auto");
  assert.ok(!calls.at(-1).args.includes("--dangerously-bypass-approvals-and-sandbox"));
  const kimi = await spawn({ provider: "kimi" });
  assert.equal(kimi.profile, "normal");
  assert.ok(!calls.at(-1).args.includes("--yolo"));
});
