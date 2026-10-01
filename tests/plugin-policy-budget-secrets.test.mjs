/**
 * Three small extension points a model-backed plugin needs (the CanvasTTY Assistant): a decision service's own
 * budget (`decide.timeoutMs`, with the session's gate sized at launch), launch policies (`launch.policy`, asked
 * before every launch with `chosen: false` and the card's environment, refusal only), and `secrets.get` for a
 * service's own secrets (masked for agents from then on). HOME is whatever the test runner's fake HOME is.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGENT_RUNTIME_ENV, DECISION_BUDGET_ENV, OPENCODE_DECISIONS_ENV, PERMISSION_GATE, helperDeadlineMs, permissionGateTimings
} from "../src/agent-runtime/runtime-protocol.mjs";
import { DecisionHooks } from "../src/main/services/DecisionHooks.ts";
import { LaunchPipeline } from "../src/main/services/LaunchPipeline.ts";
import { validatePluginManifest } from "../src/main/services/PluginManager.ts";
import { PluginServiceSupervisor } from "../src/main/services/PluginServiceSupervisor.ts";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";
import { AgentRuntimeBridge } from "../src/main/services/agent-runtime/AgentRuntimeBridge.ts";
import { ProviderRuntimeLaunchAdapters } from "../src/main/services/agent-runtime/ProviderRuntimeLaunch.ts";
import { SecretRedactionRegistry } from "../src/main/services/safety/SecretRedaction.ts";

const POSIX = { skip: process.platform === "win32" ? "Unix sockets and POSIX paths." : false };
const GATE = fileURLToPath(new URL("../src/agent-runtime/permission-gate.mjs", import.meta.url));
const guardExample = new URL("../examples/plugins/yolo-guard/", import.meta.url);
const echoExample = new URL("../examples/plugins/service-echo/", import.meta.url);
const denyExample = new URL("../examples/plugins/deny-rm/", import.meta.url);
const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));
const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-points-")));
const project = join(root, "project");
await mkdir(project, { recursive: true });
process.on("exit", () => { void rm(root, { recursive: true, force: true }); });

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Condition was not met in time.");
};

test("manifests: decide.timeoutMs is 1-60 s, launch.policy is a boolean; the examples validate", async () => {
  const base = (service) => ({
    apiVersion: 2, id: "com.example.points", name: "Points", version: "1.0.0", description: "Test.",
    permissions: ["decision:provide", "launch:contribute"], contributions: [],
    services: [{ id: "svc", title: "Svc", entry: "services/svc.mjs", ...service }]
  });
  const decide = (timeoutMs) => validatePluginManifest(base({ decide: { events: ["pre-tool"], timeoutMs } })).services[0].decide;
  assert.equal(decide(45_000).timeoutMs, 45_000);
  assert.equal(validatePluginManifest(base({ decide: { events: ["pre-tool"] } })).services[0].decide.timeoutMs, undefined);
  for (const bad of [999, 60_001, 2.5, "10000"]) assert.throws(() => decide(bad), /timeoutMs must be 1000 to 60000/u);
  assert.equal(validatePluginManifest(base({ launch: { policy: true, fields: [] } })).services[0].launch.policy, true);
  assert.equal(validatePluginManifest(base({ launch: { policy: false, fields: [] } })).services[0].launch.policy, undefined);
  assert.throws(() => validatePluginManifest(base({ launch: { policy: "yes", fields: [] } })), /policy must be true or false/u);
  assert.equal(validatePluginManifest(await readJson(new URL("canvastty.plugin.json", guardExample))).services[0].launch.policy, true);
  assert.deepEqual(validatePluginManifest(await readJson(new URL("canvastty.plugin.json", echoExample))).permissions, ["storage", "secrets"]);
  assert.equal(validatePluginManifest(await readJson(new URL("canvastty.plugin.json", denyExample))).services[0].decide.timeoutMs, 5_000);
});

test("gate timings: the default budget keeps today's deadlines; a longer one lengthens hook, helper and gateway", () => {
  assert.deepEqual(permissionGateTimings(), { budgetMs: 3_000, gatewayMs: PERMISSION_GATE.gatewayMs, helperMs: PERMISSION_GATE.helperMs, hookSeconds: PERMISSION_GATE.hookSeconds });
  assert.deepEqual(permissionGateTimings(45_000), { budgetMs: 45_000, gatewayMs: 47_000, helperMs: 49_000, hookSeconds: 52 });
  assert.equal(permissionGateTimings(600_000).budgetMs, 60_000, "capped at 60 s");
  assert.equal(helperDeadlineMs({}), PERMISSION_GATE.helperMs);
  assert.equal(helperDeadlineMs({ [DECISION_BUDGET_ENV]: "45000" }), 49_000);
  assert.equal(helperDeadlineMs({ [DECISION_BUDGET_ENV]: "1e9" }), PERMISSION_GATE.helperMs, "garbage is the default");
});

test("decision services: each gets its own budget and is told it; the session's budget is the longest", async () => {
  const seen = [];
  const services = [
    { pluginId: "slow", pluginName: "Slow", serviceId: "s", mayAllow: false, timeoutMs: 1_500 },
    { pluginId: "fast", pluginName: "Fast", serviceId: "s", mayAllow: false, appliesTo: ["codex"] }
  ];
  const hooks = new DecisionHooks({
    baseProtection: () => false,
    services: () => services,
    call: async (pluginId, _serviceId, _method, params, timeoutMs) => {
      seen.push({ pluginId, budgetMs: params.budgetMs, timeoutMs });
      // 400 ms: inside this service's own 1.5 s budget.
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { verdict: "deny", reason: "Too slow for the default, fine for its own budget." };
    },
    session: () => ({ provider: "claude", role: "agent", cwd: project, configDirs: [] })
  });
  assert.equal(hooks.budgetMs("claude"), 3_000, "never below the default");
  services[0].timeoutMs = 45_000;
  assert.equal(hooks.budgetMs("claude"), 45_000);
  assert.equal(hooks.budgetMs("codex"), 45_000);
  services[0].appliesTo = ["opencode"];
  assert.equal(hooks.budgetMs("claude"), 3_000);
  delete services[0].appliesTo;
  services[0].timeoutMs = 1_500;
  const decision = await hooks.decide("s1", { requestId: "r", provider: "claude", toolName: "Bash", toolInput: { command: "ls" }, toolInputPreview: null, toolInputSha256: "x", truncated: false, cwd: null }, new AbortController().signal);
  assert.equal(decision.behavior, "deny");
  assert.deepEqual(seen, [{ pluginId: "slow", budgetMs: 1_500, timeoutMs: 1_500 }]);
});

test("launch: the hook, the helper's environment and the gateway follow the session's decision budget", async (t) => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "canvastty-points-launch-"));
  t.after(() => rm(runtimeDirectory, { recursive: true, force: true }));
  const helper = { command: "/opt/CanvasTTY", args: ["/opt/CanvasTTY/hook-helper.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } };
  const permissionGate = { command: "/opt/CanvasTTY", args: ["/opt/CanvasTTY/permission-gate.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } };
  const options = { helper, runtimeDirectory, openCodePluginPath: "/opt/CanvasTTY/opencode-plugin.mjs", permissionGate,
    kimiHomeDirectory: join(runtimeDirectory, "kimi"), hermesHomeDirectory: join(runtimeDirectory, "hermes"), grokHomeDirectory: join(runtimeDirectory, "grok") };
  const adapters = new ProviderRuntimeLaunchAdapters(options);
  const plain = JSON.parse(adapters.prepare("claude", "t1", false, true).args[1]).hooks.PreToolUse[0].hooks[0];
  assert.equal(plain.timeout, PERMISSION_GATE.hookSeconds);
  assert.doesNotMatch(plain.command, new RegExp(DECISION_BUDGET_ENV, "u"), "the default budget changes nothing");
  const long = JSON.parse(adapters.prepare("claude", "t1", false, true, 45_000).args[1]).hooks.PreToolUse[0].hooks[0];
  assert.equal(long.timeout, 52);
  assert.match(long.command, new RegExp(process.platform === "win32" ? `set "${DECISION_BUDGET_ENV}=45000"` : `${DECISION_BUDGET_ENV}='45000'`, "u"));
  const qwen = adapters.prepare("qwen", "t2", false, true, 45_000);
  assert.equal(JSON.parse(await readFile(qwen.environment.QWEN_CODE_SYSTEM_SETTINGS_PATH, "utf8")).hooks.PreToolUse[0].hooks[0].timeout, 52_000);
  qwen.releaseConfiguration();
  const opencode = adapters.prepare("opencode", "t3", false, true, 45_000).environment;
  assert.equal(opencode[OPENCODE_DECISIONS_ENV], "1");
  assert.equal(opencode[DECISION_BUDGET_ENV], "45000");

  const registered = [];
  const gateway = {
    registerSession: (...args) => { registered.push(args); return { address: "/tmp/x.sock", terminalSessionId: args[0], provider: args[1], capabilityToken: "c".repeat(40) }; },
    revokeTerminalSession: () => undefined,
    currentStatus: () => null
  };
  const bridge = new AgentRuntimeBridge(gateway, { ...options, coreHooksEnabled: false, wantsDecisions: () => true, decisionBudgetMs: () => 45_000 });
  bridge.prepareLaunch({ terminalSessionId: "a", provider: "claude", cwd: project });
  assert.equal(registered[0][5], 45_000, "the gateway learns the session's budget");
});

function runGate(capability, input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GATE, "pretool"], {
      env: {
        PATH: process.env.PATH, HOME: root, ...env,
        [AGENT_RUNTIME_ENV.address]: capability.address,
        [AGENT_RUNTIME_ENV.terminalSessionId]: capability.terminalSessionId,
        [AGENT_RUNTIME_ENV.provider]: "claude",
        [AGENT_RUNTIME_ENV.capabilityToken]: capability.capabilityToken
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", () => resolve(stdout.trim() ? JSON.parse(stdout) : null));
    child.stdin.end(JSON.stringify(input));
  });
}

test("end to end: a session sized for a longer budget waits past the default deadlines for its answer", { ...POSIX, timeout: 30_000 }, async (t) => {
  const runtime = await mkdtemp(join(tmpdir(), "canvastty-points-gw-"));
  const gateway = new RuntimeGateway({
    runtimeDirectory: runtime,
    // Answers after 11 s: past the default gateway (10 s) and within a 15 s budget's (17 s) and helper's (19 s).
    onPermissionRequest: async () => { await new Promise((resolve) => setTimeout(resolve, 11_000)); return { behavior: "deny", message: "Declined after a long look." }; }
  });
  await gateway.start();
  t.after(async () => { await gateway.close(); await rm(runtime, { recursive: true, force: true }); });
  const call = { tool_name: "Bash", tool_input: { command: "ls" } };
  const sized = gateway.registerSession("sized", "claude", false, undefined, true, 15_000);
  const plain = gateway.registerSession("plain", "claude", false, undefined, true);
  const [long, short] = await Promise.all([
    runGate(sized, call, { [DECISION_BUDGET_ENV]: "15000" }),
    runGate(plain, call)
  ]);
  assert.equal(long.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(long.hookSpecificOutput.permissionDecisionReason, "Declined after a long look.");
  assert.equal(short.hookSpecificOutput.permissionDecision, "ask", "the default gate asks when the answer is late");
});

test("launch policies: asked with chosen false and the environment for every agent launch; they may only refuse", async (t) => {
  const runsRoot = await mkdtemp(join(tmpdir(), "canvastty-points-runs-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const requests = [];
  const answers = {};
  const contributors = [
    { pluginId: "a.policy", pluginName: "Policy", serviceId: "p", launch: { policy: true, fields: [] }, secrets: false },
    { pluginId: "b.option", pluginName: "Option", serviceId: "o", launch: { fields: [{ key: "on", label: "On", kind: "boolean", default: true }] }, secrets: false },
    { pluginId: "c.codex", pluginName: "Codex only", serviceId: "c", launch: { policy: true, appliesTo: ["codex"], fields: [] }, secrets: false }
  ];
  const pipeline = new LaunchPipeline({
    contributors: () => contributors,
    call: async (pluginId, _serviceId, _method, params) => {
      requests.push({ pluginId, params });
      const answer = answers[pluginId];
      return typeof answer === "function" ? answer(params) : answer ?? null;
    },
    secret: async () => null,
    runsRoot,
    timeoutMs: 300
  });
  const base = { sessionId: "s1", provider: "claude", profile: "yolo", role: "agent", cwd: project, restoring: false, resume: false };
  assert.equal(pipeline.hasPolicy("claude"), true);
  assert.equal(pipeline.hasPolicy("terminal"), false, "a plain terminal has no launch policy");

  answers["a.policy"] = ({ profile, environment }) => profile === "yolo" && !environment ? { refuse: { reason: "YOLO only in an environment." } } : null;
  const refused = await pipeline.prepare({ ...base, options: {}, environment: null });
  assert.deepEqual(refused, { ok: false, reason: "Policy: YOLO only in an environment." });
  assert.deepEqual(requests.map((request) => [request.pluginId, request.params.chosen, request.params.options]), [["a.policy", false, {}]]);

  requests.length = 0;
  const placed = await pipeline.prepare({ ...base, options: { "b.option": { on: true } }, environment: { pluginId: "env", kind: "worktree" } });
  assert.equal(placed.ok, true);
  await placed.cleanup();
  assert.deepEqual(requests.map((request) => [request.pluginId, request.params.chosen]).sort(), [["a.policy", false], ["b.option", true]]);
  assert.deepEqual(requests.find((request) => request.pluginId === "a.policy").params.environment, { pluginId: "env", kind: "worktree" });

  // A policy the person also chose is asked once, as chosen.
  requests.length = 0;
  (await pipeline.prepare({ ...base, profile: "normal", options: { "a.policy": {} }, environment: null })).ok || assert.fail("normal launch refused");
  assert.deepEqual(requests.map((request) => [request.pluginId, request.params.chosen]), [["a.policy", true]]);

  answers["a.policy"] = () => ({ env: { SNEAKY: "1" } });
  assert.match((await pipeline.prepare({ ...base, profile: "normal", options: {}, environment: null })).reason, /a policy may only refuse/u);
  answers["a.policy"] = () => new Promise(() => undefined);
  assert.match((await pipeline.prepare({ ...base, profile: "normal", options: {}, environment: null })).reason, /did not answer its launch policy within 0\.3 s/u);
  answers["a.policy"] = () => { throw new Error("broken"); };
  assert.equal((await pipeline.prepare({ ...base, profile: "normal", options: {}, environment: null })).ok, false, "an error refuses, never passes");
});

test("the yolo-guard example refuses YOLO outside an environment over JSON-RPC", async (t) => {
  const source = await readFile(new URL("services/guard.mjs", guardExample), "utf8");
  const dir = join(root, "guard");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "guard.mjs"), source);
  const supervisor = new PluginServiceSupervisor({
    command: process.execPath, hostVersion: "9.9.9", locale: () => "en", stopGraceMs: 300,
    host: { storageGet: async () => null, storageSet: async () => undefined, emit: () => undefined }
  });
  t.after(() => supervisor.dispose());
  await supervisor.sync([{ pluginId: "com.example.yolo-guard", serviceId: "guard", root: dir, entryPath: join(dir, "guard.mjs"), sha256: sha256(source), dataDir: join(dir, "data"), permissions: ["launch:contribute"] }]);
  const call = (params) => supervisor.hostCall("com.example.yolo-guard", "guard", "canvastty.launch.prepare", params, 2_000);
  const context = { sessionId: "s", provider: "claude", role: "agent", cwd: project, restoring: false, resume: false, options: {}, chosen: false };
  assert.match((await call({ ...context, profile: "yolo", environment: null })).refuse.reason, /isolated environment/u);
  assert.equal(await call({ ...context, profile: "yolo", environment: { pluginId: "e", kind: "worktree" } }), null);
  assert.equal(await call({ ...context, profile: "normal", environment: null }), null);
});

test("secrets.get: a service reads its own plugin's secret with the permission; the value is masked for agents", async (t) => {
  const source = await readFile(new URL("services/echo.mjs", echoExample), "utf8");
  const dir = join(root, "echo");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "echo.mjs"), source);
  const redaction = new SecretRedactionRegistry();
  const asked = [];
  const secrets = new Map([["com.example.service-echo/token", "echo-token-value-9d2f41"]]);
  const supervisor = new PluginServiceSupervisor({
    command: process.execPath, hostVersion: "9.9.9", locale: () => "en", stopGraceMs: 300,
    host: {
      storageGet: async () => null, storageSet: async () => undefined, emit: () => undefined,
      registerSecrets: (pluginId, values) => redaction.add(`plugin:${pluginId}`, values),
      secretGet: async (pluginId, key) => { asked.push(`${pluginId}/${key}`); return secrets.get(`${pluginId}/${key}`) ?? null; }
    }
  });
  t.after(() => supervisor.dispose());
  const spec = (permissions) => ({ pluginId: "com.example.service-echo", serviceId: "echo", root: dir, entryPath: join(dir, "echo.mjs"), sha256: sha256(source), dataDir: join(dir, "data"), permissions });
  await supervisor.sync([spec(["storage"])]);
  await assert.rejects(supervisor.request("com.example.service-echo", "echo", "token", null), /secrets permission/u);
  assert.deepEqual(asked, [], "nothing is read without the permission");
  await supervisor.sync([spec(["storage", "secrets"])]);
  await waitFor(() => supervisor.report("com.example.service-echo").services[0]?.state === "running");
  assert.deepEqual(await supervisor.request("com.example.service-echo", "echo", "token", null), { set: true });
  assert.deepEqual(asked, ["com.example.service-echo/token"], "bound to the service's own plugin");
  assert.equal(redaction.redact("agent printed echo-token-value-9d2f41"), "agent printed <redacted:secret>");
  secrets.delete("com.example.service-echo/token");
  assert.deepEqual(await supervisor.request("com.example.service-echo", "echo", "token", null), { set: false });
});

test("a card waits for the launch policies that apply; a YOLO card outside an environment is refused, terminals are not asked", async (t) => {
  const { TerminalManager } = await import("../src/main/services/TerminalManager.ts");
  const runsRoot = await mkdtemp(join(tmpdir(), "canvastty-points-manager-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const asked = [];
  const pipeline = new LaunchPipeline({
    contributors: () => [{ pluginId: "com.example.yolo-guard", pluginName: "YOLO Guard", serviceId: "guard", launch: { policy: true, fields: [] }, secrets: false }],
    call: async (_pluginId, _serviceId, _method, params) => {
      asked.push(params);
      return params.profile === "yolo" && !params.environment ? { refuse: { reason: "YOLO only in an environment." } } : null;
    },
    secret: async () => null,
    runsRoot,
    timeoutMs: 1_000
  });
  const calls = [];
  const spawnPty = (command, args, options) => {
    calls.push({ command, args, options });
    return { pid: 1, process: command, write() {}, resize() {}, kill() {}, pause() {}, resume() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; } };
  };
  const providers = {
    get: (provider) => ({ state: "available", provider, executable: `/resolved/${provider}`, launcher: "native", environment: { PATH: "/usr/bin" }, checked: [] }),
    snapshot: () => ({})
  };
  const manager = new TerminalManager(() => undefined, providers, undefined, undefined, true, spawnPty);
  t.after(() => manager.shutdown());
  manager.configureLaunchPipeline(pipeline);
  const at = { x: 0, y: 0 };
  const yolo = manager.create({ provider: "claude", profile: "yolo", cwd: project, position: at });
  assert.equal(calls.length, 0, "the card waits for the policy");
  await waitFor(() => manager.list().find((session) => session.id === yolo.id)?.status === "failed");
  assert.match(manager.list().find((session) => session.id === yolo.id).failureDetails, /^Launch refused: YOLO Guard: YOLO only in an environment\./u);
  assert.deepEqual({ chosen: asked[0].chosen, options: asked[0].options, environment: asked[0].environment }, { chosen: false, options: {}, environment: null });
  const normal = manager.create({ provider: "claude", profile: "normal", cwd: project, position: at });
  await waitFor(() => calls.length === 1);
  assert.equal(manager.list().find((session) => session.id === normal.id).status !== "failed", true);
  manager.create({ provider: "terminal", profile: "normal", cwd: project, position: at });
  assert.equal(calls.length, 2, "a terminal launches at once");
  assert.equal(asked.length, 2);
});

test("a decide budget above the supervisor's 15 s request default is honored through the real supervisor, and still ends at the budget", { ...POSIX, timeout: 40_000 }, async (t) => {
  const { createHash } = await import("node:crypto");
  const { readFile: read } = await import("node:fs/promises");
  const { PluginServiceSupervisor, MAX_HOST_CALL_TIMEOUT_MS } = await import("../src/main/services/PluginServiceSupervisor.ts");
  const { DecisionHooks } = await import("../src/main/services/DecisionHooks.ts");
  const { MAX_DECIDE_TIMEOUT_MS, permissionGateTimings } = await import("../src/agent-runtime/runtime-protocol.mjs");
  const entryPath = fileURLToPath(new URL("./fixtures/slow-decide-service.mjs", import.meta.url));
  const dataDir = await mkdtemp(join(tmpdir(), "canvastty-slow-decide-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  // Production construction: no requestTimeoutMs, so surface requests keep the 15 s default.
  const supervisor = new PluginServiceSupervisor({ command: process.execPath, hostVersion: "9.9.9", locale: () => "en", stopGraceMs: 300,
    host: { storageGet: async () => null, storageSet: async () => undefined, emit: () => undefined } });
  t.after(() => supervisor.dispose());
  await supervisor.sync([{ pluginId: "p.slow", serviceId: "svc", root: dirname(entryPath), entryPath, dataDir, permissions: ["decision:provide"],
    sha256: createHash("sha256").update(await read(entryPath)).digest("hex") }]);
  const hooks = new DecisionHooks({
    baseProtection: () => false,
    services: () => [
      { pluginId: "p.slow", pluginName: "Slow", serviceId: "svc", mayAllow: false, timeoutMs: 18_000, appliesTo: ["claude"] },
      { pluginId: "p.slow", pluginName: "Slow", serviceId: "svc", mayAllow: false, timeoutMs: 16_000, appliesTo: ["codex"] }
    ],
    call: (pluginId, serviceId, method, params, timeoutMs) => supervisor.hostCall(pluginId, serviceId, method, params, timeoutMs),
    session: (sessionId) => ({ provider: sessionId === "wait-16000" ? "claude" : "codex", role: "agent", cwd: project, configDirs: [] })
  });
  const request = { toolName: "Bash", toolInput: { command: "ls" }, toolInputPreview: null, cwd: project, truncated: false };
  const [withinBudget, pastBudget] = await Promise.all([
    hooks.decide("wait-16000", request, new AbortController().signal),
    hooks.decide("wait-17000", request, new AbortController().signal)
  ]);
  assert.equal(withinBudget.behavior, "deny", "an answer after 16 s within an 18 s budget is kept");
  assert.match(withinBudget.message, /denied after 16000 ms/u);
  // A timeout is an ask; Codex cannot ask from its hook, so for it that ask is a deny with the reason, never a run.
  assert.equal(pastBudget.behavior, "deny", "an answer after its 16 s budget is a timeout's ask, and Codex cannot ask");
  assert.match(pastBudget.message, /(did not answer in time|could not answer).*codex cannot ask the person from here/su);
  // The supervisor's bound is the manifest's maximum, and the session gate's deadlines stay longer than it.
  assert.equal(MAX_HOST_CALL_TIMEOUT_MS, MAX_DECIDE_TIMEOUT_MS);
  const gate = permissionGateTimings(MAX_DECIDE_TIMEOUT_MS);
  assert.ok(gate.gatewayMs > MAX_HOST_CALL_TIMEOUT_MS && gate.helperMs > gate.gatewayMs);
});
