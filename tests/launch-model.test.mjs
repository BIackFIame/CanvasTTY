import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  REASONING_EFFORTS,
  launchModelProblem,
  providerEffortArguments,
  providerModelArguments,
  supportsLaunchModel
} from "../src/shared/launchModel.ts";
import { ORCHESTRATION_TOOL_DEFINITIONS, REASONING_EFFORT_IDS, validateOrchestrationArguments } from "../src/agent-browser/orchestration-catalog.mjs";
import { resolveTerminalLaunch } from "../src/main/services/terminalLaunch.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { TerminalSessionStore, normalizePersistedTerminalSessions } from "../src/main/services/TerminalSessionStore.ts";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { ProviderModelCatalog } from "../src/main/services/providerModels.ts";
import { listProviderDirectory } from "../src/main/services/providerDirectory.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

test("each CLI gets its own model and effort flag, and a model it cannot take is refused with the reason", () => {
  assert.deepEqual(providerModelArguments("opencode", "zai-coding-plan/glm-5.3-flash"), ["--model", "zai-coding-plan/glm-5.3-flash"]);
  assert.match(launchModelProblem("opencode", "glm-5.3-flash"), /provider\/model/u);
  assert.deepEqual(providerModelArguments("codex", "gpt-5.5"), ["--model", "gpt-5.5"]);
  assert.deepEqual(providerModelArguments("claude", "opus"), ["--model", "opus"]);
  assert.equal(providerModelArguments("grok", undefined).length, 0);
  assert.match(launchModelProblem("hermes", "x"), /no per-launch model/u);
  assert.equal(supportsLaunchModel("minimax"), false);
  for (const bad of ["", " x", "--help", "a b", "x\ny", "m".repeat(201)]) assert.ok(launchModelProblem("codex", bad), JSON.stringify(bad));
  assert.deepEqual(providerEffortArguments("codex", "high"), ["-c", "model_reasoning_effort=\"high\""]);
  assert.deepEqual(providerEffortArguments("claude", "max"), ["--effort", "max"]);
  assert.deepEqual(providerEffortArguments("grok", "low"), ["--reasoning-effort", "low"]);
  assert.throws(() => providerEffortArguments("codex", "max"), /codex takes effort minimal, low, medium, high, xhigh/u);
  assert.throws(() => providerEffortArguments("opencode", "high"), /no per-launch reasoning effort/u);
});

test("spawn_agent's schema takes model and effort; the effort list matches the shared one", () => {
  assert.deepEqual([...REASONING_EFFORT_IDS], [...REASONING_EFFORTS]);
  const spawn = ORCHESTRATION_TOOL_DEFINITIONS.find((tool) => tool.name === "spawn_agent");
  assert.equal(spawn.inputSchema.properties.model.maxLength, 200);
  assert.deepEqual(spawn.inputSchema.properties.effort.enum, [...REASONING_EFFORTS]);
  assert.match(spawn.description, /If the person names a model, pass it as model/u);
  assert.equal(validateOrchestrationArguments("spawn_agent", { provider: "opencode", cwd: "/p", model: "zai/glm", effort: "high" }).ok, true);
  assert.match(validateOrchestrationArguments("spawn_agent", { provider: "opencode", cwd: "/p", effort: "turbo" }).error, /effort is not an accepted value/u);
});

test("the launch puts the model before a resume selection", () => {
  const providerCli = availableRegistry().get("codex");
  const launch = resolveTerminalLaunch("codex", "normal", [], { providerCli, model: "gpt-5.5", effort: "high", resumePrevious: true });
  assert.deepEqual(launch.args, ["--model", "gpt-5.5", "-c", "model_reasoning_effort=\"high\"", "resume"]);
  const opencode = resolveTerminalLaunch("opencode", "normal", [], { providerCli: availableRegistry().get("opencode"), model: "zai-coding-plan/glm-5.3-flash" });
  assert.deepEqual(opencode.args, ["--model", "zai-coding-plan/glm-5.3-flash"]);
});

async function folder(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-launch-model-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a subagent spawned with a model runs its CLI with it, keeps it on restart and restore", async (t) => {
  const root = await folder(t);
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => terminals.disposeAll());
  const orchestrator = terminals.create({ provider: "opencode", cwd: root, profile: "normal", position: { x: 0, y: 0 }, role: "orchestrator" });
  const handler = new ScopedOrchestrationHandler(new AgentControlService(terminals));
  const spawned = await handler.execute(orchestrator.id, { id: "1", tool: "spawn_agent", arguments: {
    provider: "opencode", cwd: root, model: "zai-coding-plan/glm-5.3-flash" } });
  assert.equal(spawned.model, "zai-coding-plan/glm-5.3-flash");
  const args = calls.at(-1).args;
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "zai-coding-plan/glm-5.3-flash"]);
  assert.equal(terminals.getMetadata(spawned.sessionId).model, "zai-coding-plan/glm-5.3-flash");

  calls.at(-1).process.emitExit(0);
  terminals.restart(spawned.sessionId);
  assert.ok(calls.at(-1).args.includes("zai-coding-plan/glm-5.3-flash"), "a restart keeps the model");

  await assert.rejects(handler.execute(orchestrator.id, { id: "2", tool: "spawn_agent", arguments: { provider: "opencode", cwd: root, model: "glm-5.3-flash" } }),
    (error) => error.bridgeError?.code === "INVALID_REQUEST" && /provider\/model/u.test(error.message) && /list_providers/u.test(error.message));
  await assert.rejects(handler.execute(orchestrator.id, { id: "3", tool: "spawn_agent", arguments: { provider: "claude", cwd: root, effort: "minimal" } }),
    (error) => error.bridgeError?.code === "INVALID_REQUEST" && /claude takes effort/u.test(error.message));
  assert.throws(() => terminals.create({ provider: "hermes", cwd: root, profile: "normal", position: { x: 0, y: 0 }, model: "x" }), /no per-launch model/u);

  const dir = await folder(t);
  const store = new TerminalSessionStore(dir);
  const { persistedTerminalSession } = await import("../src/main/services/TerminalSessionStore.ts");
  await store.replace([persistedTerminalSession({ ...terminals.getMetadata(spawned.sessionId), parentSessionId: undefined, role: "agent" })]);
  const restoredCalls = [];
  const restored = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(restoredCalls));
  t.after(() => restored.disposeAll());
  restored.configureSessionPersistence(store, "continue");
  await restored.restorePersistedSessions();
  assert.equal(restored.getMetadata(spawned.sessionId).model, "zai-coding-plan/glm-5.3-flash");
  assert.ok(restoredCalls.at(-1).args.includes("zai-coding-plan/glm-5.3-flash"), "a restore keeps the model");
});

test("a stored model the CLI would not take is dropped instead of breaking the restore", () => {
  const base = { id: "a1b2c3d4-0000-4000-8000-000000000001", provider: "opencode", profile: "normal", role: "agent", title: "t",
    titleCustomized: false, cwd: "/p", position: { x: 0, y: 0 }, size: { width: 600, height: 400 }, lastState: "running", restore: true };
  const [kept] = normalizePersistedTerminalSessions({ version: 2, sessions: [{ ...base, model: "zai/glm", effort: "high" }] }).sessions;
  assert.equal(kept.model, "zai/glm");
  assert.equal(kept.effort, undefined, "OpenCode takes no effort");
  const [dropped] = normalizePersistedTerminalSessions({ version: 2, sessions: [{ ...base, model: "--yolo" }] }).sessions;
  assert.equal(dropped.model, undefined);
});

test("OpenCode's models come from a cached `opencode models` listing that never blocks list_providers", async () => {
  const runs = [];
  let now = 1_000;
  let output = "zai-coding-plan/glm-5.3\nzai-coding-plan/glm-5.3-flash\n\u001b[2mnot a model\u001b[0m\nopencode/gpt-5-nano\n";
  const catalog = new ProviderModelCatalog(availableRegistry(), {
    now: () => now,
    run: async (launch, timeoutMs) => { runs.push({ launch, timeoutMs }); return output; }
  });
  assert.equal(catalog.peek("opencode"), null, "the first read answers at once");
  await catalog.refresh("opencode");
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].launch.args, ["models"]);
  assert.equal(runs[0].launch.command, "/resolved/opencode");
  assert.ok(runs[0].timeoutMs <= 5_000);
  assert.deepEqual(catalog.peek("opencode").models, ["zai-coding-plan/glm-5.3", "zai-coding-plan/glm-5.3-flash", "opencode/gpt-5-nano"]);
  assert.equal(runs.length, 1, "a fresh listing is not run again");
  assert.equal(catalog.peek("codex"), null);
  assert.equal(runs.length, 1, "providers without a local listing are never run");
  now += 11 * 60_000;
  output = "";
  catalog.peek("opencode");
  await catalog.refresh("opencode");
  assert.equal(runs.length, 2, "an old listing is refreshed in the background");
  assert.equal(catalog.peek("opencode").models.length, 3, "an empty answer keeps the last listing");

  const directory = listProviderDirectory({ cli: () => "available", limits: () => null, models: (provider) => catalog.peek(provider) });
  const by = Object.fromEntries(directory.providers.map((entry) => [entry.id, entry]));
  assert.deepEqual(by.opencode.model.known.slice(0, 2), ["zai-coding-plan/glm-5.3", "zai-coding-plan/glm-5.3-flash"]);
  assert.match(by.opencode.model.format, /provider\/model/u);
  assert.equal(by.codex.model.known, undefined);
  assert.deepEqual(by.codex.efforts, ["minimal", "low", "medium", "high", "xhigh"]);
  assert.equal(by.hermes.model.supported, false);
  assert.match(directory.note, /If the person names a model, pass it as spawn_agent\.model/u);

  const missing = new ProviderModelCatalog({ get: (provider) => ({ state: "unavailable", provider, reason: "cli-not-found", checked: [], diagnostic: "" }) },
    { run: async () => { throw new Error("must not run"); } });
  await missing.refresh("opencode");
  assert.equal(missing.peek("opencode"), null);
  const failing = new ProviderModelCatalog(availableRegistry(), { run: async () => { throw new Error("timeout"); } });
  await failing.refresh("opencode");
  assert.equal(failing.peek("opencode"), null);
});

const LISTED = ["zai-coding-plan/glm-5.3", "zai-coding-plan/glm-5.3-flash", "zai-coding-plan/glm-4.6", "opencode/gpt-5-nano", "anthropic/claude-sonnet-5"];

test("a model OpenCode does not list is refused with the closest listed ids; no listing allows it", async () => {
  const { closestModels } = await import("../src/main/services/providerModels.ts");
  assert.deepEqual(closestModels("zai-coding-plan/glm-nonexistent", LISTED).slice(0, 3),
    ["zai-coding-plan/glm-4.6", "zai-coding-plan/glm-5.3", "zai-coding-plan/glm-5.3-flash"]);
  assert.deepEqual(closestModels("zai/glm-5.3-flash", LISTED)[0], "zai-coding-plan/glm-5.3-flash");
  assert.deepEqual(closestModels("nosuch/model", LISTED), []);
  let runs = 0;
  const catalog = new ProviderModelCatalog(availableRegistry(), { run: async () => { runs += 1; return LISTED.join("\n"); } });
  assert.equal(catalog.unknownModelCached("opencode", "nosuch/model"), null, "nothing cached yet: allowed");
  const refused = await catalog.unknownModel("opencode", "zai-coding-plan/glm-nonexistent", { fresh: true });
  assert.equal(runs, 1, "a first check waits for the listing");
  assert.match(refused, /opencode does not list the model "zai-coding-plan\/glm-nonexistent"/u);
  assert.match(refused, /Closest: zai-coding-plan\/glm-4\.6, zai-coding-plan\/glm-5\.3, zai-coding-plan\/glm-5\.3-flash/u);
  assert.match(refused, /Call list_providers/u);
  assert.equal(await catalog.unknownModel("opencode", "zai-coding-plan/glm-5.3-flash", { fresh: true }), null);
  assert.equal(await catalog.unknownModel("codex", "anything"), null, "providers without a listing are not judged");
  const broken = new ProviderModelCatalog(availableRegistry(), { run: async () => { throw new Error("timeout"); } });
  assert.equal(await broken.unknownModel("opencode", "nosuch/model", { fresh: true }), null, "an unreadable listing allows it");
});

test("spawn_agent, the launcher path and control create refuse an unlisted OpenCode model before launching", async (t) => {
  const root = await folder(t);
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => terminals.disposeAll());
  const catalog = new ProviderModelCatalog(availableRegistry(), { run: async () => LISTED.join("\n") });
  terminals.configureModelCheck((provider, model) => catalog.unknownModelCached(provider, model));
  const orchestrator = terminals.create({ provider: "codex", cwd: root, profile: "normal", position: { x: 0, y: 0 }, role: "orchestrator" });
  const handler = new ScopedOrchestrationHandler(new AgentControlService(terminals), null, {
    cli: () => "available", limits: () => null, checkModel: (provider, model) => catalog.unknownModel(provider, model, { fresh: true })
  });
  const before = calls.length;
  await assert.rejects(handler.execute(orchestrator.id, { id: "1", tool: "spawn_agent", arguments: { provider: "opencode", cwd: root, model: "nosuch/model" } }),
    (error) => error.bridgeError?.code === "INVALID_REQUEST" && error.bridgeError.retryable === false && /does not list the model "nosuch\/model"/u.test(error.message));
  await assert.rejects(handler.execute(orchestrator.id, { id: "2", tool: "spawn_agent", arguments: { provider: "opencode", cwd: root, model: "zai-coding-plan/glm-nonexistent" } }),
    (error) => /Closest: zai-coding-plan\/glm-4\.6/u.test(error.message));
  assert.equal(calls.length, before, "nothing was launched");
  // The launcher (and plugin) path: TerminalManager.create.
  assert.throws(() => terminals.create({ provider: "opencode", cwd: root, profile: "normal", position: { x: 0, y: 0 }, model: "nosuch/model" }), /does not list the model/u);
  const ok = await handler.execute(orchestrator.id, { id: "3", tool: "spawn_agent", arguments: { provider: "opencode", cwd: root, model: "zai-coding-plan/glm-5.3-flash" } });
  assert.equal(ok.model, "zai-coding-plan/glm-5.3-flash");
});

test("a subagent that exits right after start reports why: the last screen lines, masked", async (t) => {
  const root = await folder(t);
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => terminals.disposeAll());
  const orchestrator = terminals.create({ provider: "codex", cwd: root, profile: "normal", position: { x: 0, y: 0 }, role: "orchestrator" });
  const handler = new ScopedOrchestrationHandler(new AgentControlService(terminals, { waitTiming: { checkMs: 5, settleMs: 10, quietMs: 60_000 } }));
  const child = await handler.execute(orchestrator.id, { id: "1", tool: "spawn_agent", arguments: { provider: "opencode", cwd: root, model: "zai-coding-plan/glm-nonexistent" } });
  const fakeKey = ["sk", "ant", "api03", "Wv4".repeat(14)].join("-");
  const waiting = handler.execute(orchestrator.id, { id: "w", tool: "wait_for_agent", arguments: { sessionId: child.sessionId, timeoutSeconds: 10 } });
  setTimeout(() => {
    const pty = calls.at(-1).process;
    pty.emitData(`\u001b[2J\u001b[H\u001b[31mError: Unexpected server error. Check server logs for details.\u001b[0m\r\nkey ${fakeKey}\r\n`);
    pty.emitExit(1);
  }, 20);
  const waited = await waiting;
  assert.deepEqual([waited.reason, waited.exitCode], ["failed", 1]);
  assert.match(waited.exitLines, /^Error: Unexpected server error\. Check server logs for details\.$/mu);
  assert.ok(!waited.exitLines.includes(fakeKey), "masked");
  assert.ok(!waited.exitLines.includes("\u001b"), "plain text");
  const observed = await handler.execute(orchestrator.id, { id: "o", tool: "observe_agent", arguments: { sessionId: child.sessionId } });
  assert.equal(observed.exitCode, 1);
  assert.equal(observed.exitLines, waited.exitLines);
  const result = await handler.execute(orchestrator.id, { id: "r", tool: "get_agent_result", arguments: { sessionId: child.sessionId } });
  assert.equal(result.state, "failed");
  assert.equal(result.exitLines, waited.exitLines);
  // A running subagent has no exitLines.
  const running = await handler.execute(orchestrator.id, { id: "2", tool: "spawn_agent", arguments: { provider: "opencode", cwd: root } });
  const live = await handler.execute(orchestrator.id, { id: "o2", tool: "observe_agent", arguments: { sessionId: running.sessionId } });
  assert.equal(live.exitLines, undefined);
});
