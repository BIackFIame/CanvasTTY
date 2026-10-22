import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ORCHESTRATION_TOOL_DEFINITIONS, validateOrchestrationArguments } from "../src/agent-browser/orchestration-catalog.mjs";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { EnvironmentRegistry } from "../src/main/services/EnvironmentRegistry.ts";
import { AgentIsolation } from "../src/main/services/isolation/AgentIsolation.ts";
import { validatePluginManifest } from "../src/main/services/PluginManager.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

// A stand-in for an environment plugin such as CanvasTTY Environments: no ssh, no container engine. It answers the
// host's environment calls from a list of "configured servers" and records every call.
const PLUGIN = "com.example.places";
const WRAPPER = process.execPath;
const SERVER_DETAIL = "build-7.internal.example";
const at = { x: 0, y: 0 };

const KINDS = {
  // Like ssh-host: the launch is not passed on (no hooks there), an orchestrator may pick the server only.
  server: {
    kind: "server", label: "Server", description: `Runs on ${SERVER_DETAIL}`,
    fields: [
      { key: "host", label: "Server", kind: "text", default: "", maxLength: 40 },
      { key: "persist", label: "Keep running", kind: "boolean", default: true }
    ],
    subagents: { maxParallel: 2, fields: ["host"] }
  },
  // Like remote-container: its own boundary, the launch passed on.
  box: {
    kind: "box", label: "Box",
    fields: [{ key: "network", label: "Network", kind: "boolean", default: false },
      { key: "size", label: "Size", kind: "select", options: [{ value: "s", label: "S" }, { value: "m", label: "M" }] }],
    keeps: { launch: true, isolated: true, confines: true },
    subagents: { fields: ["size"] }
  },
  // Only the person chooses it.
  private: { kind: "private", label: "Private place" }
};

async function setup(t, { isolation = false, kinds = Object.values(KINDS), choices = () => ({ choices: ["alpha", "beta", "gamma"] }) } = {}) {
  const project = await realpath(await mkdtemp(join(tmpdir(), "ctty-spawn-env-")));
  t.after(() => rm(project, { recursive: true, force: true }));
  const state = { enabled: true, servers: ["alpha", "beta"] };
  const pluginCalls = [];
  const registry = new EnvironmentRegistry({
    providers: () => state.enabled
      ? [{ pluginId: PLUGIN, pluginName: "Places", serviceId: "places", secrets: false, kinds }]
      : [],
    call: async (_pluginId, _serviceId, method, params) => {
      const step = method.replace("canvastty.environment.", "");
      pluginCalls.push({ step, params: structuredClone(params) });
      if (step === "choices") return choices(params);
      if (step === "prepare") {
        if (params.kind === "server" || params.kind === "fleet") {
          const host = params.options.host || state.servers[0];
          if (!state.servers.includes(host)) return { refuse: { reason: `No configured server is called ${host}.` } };
          return { ref: { host, address: SERVER_DETAIL }, label: `server ${host}` };
        }
        return { ref: { box: "b-1" }, label: "box b-1" };
      }
      if (step === "wrap") return { command: WRAPPER, args: ["remote", params.command, ...params.args] };
      if (step === "resume") return { ok: true };
      return {};
    },
    secret: async () => null
  });
  const spawned = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(spawned));
  t.after(() => terminals.shutdown());
  terminals.configureEnvironments(registry);
  if (isolation) {
    terminals.configureIsolation({
      containment: () => true,
      decide: (input) => new AgentIsolation({ userDataPath: "/u", enabled: () => true, platform: "darwin", exists: () => true }).decide(input),
      wrap: (launch) => ({ command: "/usr/bin/sandbox-exec", args: ["-f", "/p.sb", launch.command, ...launch.args], env: launch.env, cleanup() {} })
    });
  }
  const control = new AgentControlService(terminals, { limits: () => ({ maxDepth: 2, maxSubagents: 8 }) });
  const handler = new ScopedOrchestrationHandler(control, null, {
    cli: () => "available", limits: () => null, environments: () => terminals.delegatedEnvironments(),
    refreshEnvironments: () => terminals.refreshDelegatedEnvironments()
  });
  const orchestrator = (profile = "auto") => terminals.create({ provider: "codex", profile, cwd: project, position: at, role: "orchestrator" });
  const call = (sessionId, tool, args = {}) => handler.execute(sessionId, { id: randomUUID(), tool, arguments: args });
  const spawn = (parent, args) => call(parent.id, "spawn_agent", { provider: "opencode", cwd: project, ...args });
  const card = (id) => terminals.list().find((session) => session.id === id);
  return { project, state, pluginCalls, spawned, terminals, control, handler, orchestrator, call, spawn, card };
}

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met in time.");
};
const refused = (pattern) => (error) => error.bridgeError?.code === "INVALID_REQUEST" && error.bridgeError.retryable === false
  && pattern.test(error.message);

test("subagents is validated in the manifest: an object, a cap from 1 to 16, only its own field keys", () => {
  const manifest = (subagents, fields = [{ key: "host", label: "Host", kind: "text" }]) => validatePluginManifest({
    apiVersion: 2, id: "com.example.s", name: "S", version: "1.0.0", description: "d", author: "a", permissions: ["environment:provide"],
    services: [{ id: "s", title: "S", description: "d", entry: "s.mjs", environments: [{ kind: "box", label: "Box", fields, subagents }] }],
    contributions: []
  }).services[0].environments[0];
  assert.deepEqual(manifest({ maxParallel: 3, fields: ["host"] }).subagents, { maxParallel: 3, fields: ["host"] });
  assert.deepEqual(manifest({}).subagents, {});
  assert.equal(manifest(undefined).subagents, undefined, "undeclared: only the person chooses it");
  assert.throws(() => manifest(true), /subagents must be an object/u);
  assert.throws(() => manifest({ maxParallel: 0 }), /maxParallel must be an integer from 1 to 16/u);
  assert.throws(() => manifest({ maxParallel: 17 }), /maxParallel must be an integer from 1 to 16/u);
  assert.throws(() => manifest({ fields: ["image"] }), /must list keys of its own fields/u);
  assert.throws(() => manifest({ fields: ["host", "host"] }), /each once/u);
  assert.throws(() => manifest({ hosts: ["a"] }), /subagents/u);
});

test("spawn_agent.environment has a checked shape in the tool catalog", () => {
  const schema = ORCHESTRATION_TOOL_DEFINITIONS.find((tool) => tool.name === "spawn_agent").inputSchema;
  assert.deepEqual(schema.properties.environment.required, ["pluginId", "kind"]);
  assert.equal(schema.required.includes("environment"), false, "optional: without it the subagent runs on this computer");
  const check = (environment) => validateOrchestrationArguments("spawn_agent", { provider: "codex", cwd: "/p", environment });
  assert.equal(check({ pluginId: PLUGIN, kind: "server", options: { host: "alpha", persist: false } }).ok, true);
  for (const bad of [null, "server", [], { pluginId: PLUGIN }, { pluginId: PLUGIN, kind: "" }, { pluginId: PLUGIN, kind: "x", host: "a" },
    { pluginId: PLUGIN, kind: "x", options: { host: 1 } }, { pluginId: PLUGIN, kind: "x", options: [] },
    { pluginId: PLUGIN, kind: "x", options: Object.fromEntries(Array.from({ length: 9 }, (_v, i) => [`k${i}`, "v"])) }]) {
    const result = check(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.match(result.error, /environment must be \{ pluginId, kind, options\? \}/u);
  }
});

test("list_providers lists the environments subagents may use: ids, names and caps, never hosts or details", async (t) => {
  const { state, orchestrator, call } = await setup(t);
  const parent = orchestrator();
  const directory = await call(parent.id, "list_providers");
  assert.deepEqual(directory.environments, [
    { pluginId: PLUGIN, plugin: "Places", kind: "server", name: "Server", options: [{ key: "host", kind: "text" }],
      maxParallel: 2, running: 0, profiles: ["normal"], localProtection: false },
    { pluginId: PLUGIN, plugin: "Places", kind: "box", name: "Box", options: [{ key: "size", kind: "select", choices: ["s", "m"] }],
      maxParallel: 1, running: 0, localProtection: true }
  ], "the person-only kind is not listed; fields an orchestrator may not set are not listed");
  assert.match(directory.note, /spawn_agent\.environment/u);
  const text = JSON.stringify(directory);
  for (const secret of [SERVER_DETAIL, "alpha", "beta", "persist", "network", "Private place"]) {
    assert.equal(text.includes(secret), false, `${secret} is not shown to the agent`);
  }
  // A disabled or untrusted plugin offers nothing (the registry's providers are the launcher's).
  state.enabled = false;
  const without = await call(parent.id, "list_providers");
  assert.equal(without.environments, undefined);
  assert.doesNotMatch(without.note, /spawn_agent\.environment/u);
});

test("an allowed environment starts the subagent through its plugin, with defaults for what the orchestrator may not set", async (t) => {
  const { pluginCalls, spawned, orchestrator, spawn, card, terminals } = await setup(t);
  const parent = orchestrator("auto");
  const before = spawned.length;
  const answer = await spawn(parent, { environment: { pluginId: PLUGIN, kind: "server", options: { host: "beta" } } });
  assert.deepEqual(answer.environment, { pluginId: PLUGIN, kind: "server" });
  assert.equal(answer.profile, "normal", "the launch is not passed on there, so the inherited auto is lowered to normal");
  await waitFor(() => spawned.length === before + 1);
  const prepare = pluginCalls.find((entry) => entry.step === "prepare");
  assert.deepEqual(prepare.params.options, { host: "beta", persist: true }, "persist keeps its declared default");
  assert.equal(prepare.params.provider, "opencode");
  const launch = spawned.at(-1);
  assert.equal(launch.command, WRAPPER, "it runs through the plugin's wrap, not locally");
  assert.equal(launch.args[0], "remote");
  const child = card(answer.sessionId);
  assert.equal(child.role, "subagent");
  assert.equal(child.parentSessionId, parent.id);
  assert.equal(child.environment.label, "server beta");
  assert.match(child.isolation.reason, /Base protection and CanvasTTY's hooks do not reach the agent in server beta/u);
  // The plugin sees the launch's own variables, never CanvasTTY's reserved ones (as for the person's launch).
  const wrap = pluginCalls.find((entry) => entry.step === "wrap");
  assert.deepEqual(Object.keys(wrap.params.env).filter((key) => /^(?:CANVASTTY_|ELECTRON_|NODE_OPTIONS$|PATH$)/u.test(key)), []);
  assert.deepEqual(wrap.params.secretEnvNames, []);
  assert.equal(terminals.subagentsInEnvironment(PLUGIN, "server"), 1);
});

test("an environment with its own boundary keeps the subagent's profile and is not wrapped in this computer's layer again", async (t) => {
  const { spawned, orchestrator, spawn, card } = await setup(t, { isolation: true });
  const parent = orchestrator("auto");
  const before = spawned.length;
  const answer = await spawn(parent, { environment: { pluginId: PLUGIN, kind: "box", options: { size: "m" } } });
  assert.equal(answer.profile, "auto");
  await waitFor(() => spawned.length === before + 1);
  assert.equal(spawned.at(-1).command, WRAPPER, "no second sandbox around the box");
  assert.equal(card(answer.sessionId).isolation.state, "environment");
  // A local subagent of the same orchestrator still runs inside the layer.
  const local = await spawn(parent, {});
  await waitFor(() => spawned.length === before + 2);
  assert.equal(spawned.at(-1).command, "/usr/bin/sandbox-exec");
  assert.equal(card(local.sessionId).environment, undefined);
});

test("unknown, person-only, disabled, foreign-option and wrong-profile environments are refused with the reason", async (t) => {
  const { state, orchestrator, spawn, card, terminals } = await setup(t);
  const parent = orchestrator("auto");
  const children = () => terminals.list().filter((session) => session.parentSessionId === parent.id);
  await assert.rejects(spawn(parent, { environment: { pluginId: PLUGIN, kind: "moon" } }),
    refused(/Environment moon from plugin com\.example\.places is not available: .*Call list_providers/u));
  await assert.rejects(spawn(parent, { environment: { pluginId: "com.example.other", kind: "server" } }), refused(/is not available/u));
  await assert.rejects(spawn(parent, { environment: { pluginId: PLUGIN, kind: "private" } }),
    refused(/Places has not declared Private place safe for an orchestrator to choose; only the person starts agents there/u));
  await assert.rejects(spawn(parent, { environment: { pluginId: PLUGIN, kind: "server", options: { persist: false } } }),
    refused(/Server: an orchestrator may not set persist; only the person sets it, in the launcher\. Options it may set: host\./u));
  await assert.rejects(spawn(parent, { environment: { pluginId: PLUGIN, kind: "box", options: { network: true } } }),
    refused(/Box: an orchestrator may not set network/u));
  await assert.rejects(spawn(parent, { environment: { pluginId: PLUGIN, kind: "box", options: { size: "xl" } } }),
    refused(/Box option Size is invalid/u));
  await assert.rejects(spawn(parent, { profile: "auto", environment: { pluginId: PLUGIN, kind: "server" } }),
    refused(/Server does not pass the launch on, so CanvasTTY's hooks and the auto profile would not reach the agent there; only normal/u));
  const planner = orchestrator("plan");
  await assert.rejects(spawn(planner, { environment: { pluginId: PLUGIN, kind: "server" } }),
    refused(/plan \(read-only\) cannot be kept there/u));
  state.enabled = false;
  await assert.rejects(spawn(parent, { environment: { pluginId: PLUGIN, kind: "server" } }), refused(/is not available: its plugin is disabled/u));
  assert.deepEqual(children(), [], "a refusal makes no card");
  // A server the person did not configure: the plugin refuses when it prepares, on the card and to the orchestrator.
  state.enabled = true;
  const unconfigured = await spawn(parent, { environment: { pluginId: PLUGIN, kind: "server", options: { host: "gamma" } } });
  await waitFor(() => card(unconfigured.sessionId).status === "failed");
  assert.match(card(unconfigured.sessionId).failureDetails, /^Launch refused: Places: No configured server is called gamma\./u);
  await assert.rejects(spawn(parent, { prompt: "go", environment: { pluginId: PLUGIN, kind: "server", options: { host: "gamma" } } }),
    refused(/No configured server is called gamma/u));
});

test("each environment caps its parallel subagents across orchestrations; finished or refused ones free a place", async (t) => {
  const { orchestrator, spawn, call, terminals, card } = await setup(t);
  const first = orchestrator("normal");
  const second = orchestrator("normal");
  const server = { pluginId: PLUGIN, kind: "server" };
  const a = await spawn(first, { environment: server });
  // Still being prepared counts: the place is taken from the moment the card exists.
  await spawn(second, { environment: { ...server, options: { host: "beta" } } });
  await assert.rejects(spawn(first, { environment: server }),
    refused(/Server already runs 2 subagents, the most Places allows there at once\. Wait for one to finish or cancel_agent one first/u));
  assert.equal((await call(first.id, "list_providers")).environments[0].running, 2);
  // Another environment and this computer are separate.
  await spawn(first, { environment: { pluginId: PLUGIN, kind: "box" } });
  await assert.rejects(spawn(second, { environment: { pluginId: PLUGIN, kind: "box" } }), refused(/Box already runs 1 subagent,/u));
  await spawn(first, {});
  await waitFor(() => card(a.sessionId).environment !== undefined);
  terminals.dispose(a.sessionId);
  const again = await spawn(first, { environment: server });
  terminals.dispose(again.sessionId);
  // A launch the plugin refused does not hold a place.
  const failed = await spawn(first, { environment: { ...server, options: { host: "gamma" } } });
  await waitFor(() => card(failed.sessionId).status === "failed");
  assert.equal(terminals.subagentsInEnvironment(PLUGIN, "server"), 1);
  await spawn(first, { environment: server });
  await assert.rejects(spawn(first, { environment: server }), refused(/Server already runs 2 subagents/u));
});

test("without plugin environments configured, an environment is refused and nothing starts", async (t) => {
  const project = await realpath(await mkdtemp(join(tmpdir(), "ctty-spawn-env-")));
  t.after(() => rm(project, { recursive: true, force: true }));
  const spawned = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(spawned));
  t.after(() => terminals.shutdown());
  const handler = new ScopedOrchestrationHandler(new AgentControlService(terminals));
  const parent = terminals.create({ provider: "codex", profile: "normal", cwd: project, position: at, role: "orchestrator" });
  const before = spawned.length;
  await assert.rejects(handler.execute(parent.id, { id: randomUUID(), tool: "spawn_agent",
    arguments: { provider: "opencode", cwd: project, environment: { pluginId: PLUGIN, kind: "server" } } }),
  refused(/Plugin environments are not available/u));
  assert.equal(spawned.length, before);
  assert.deepEqual(terminals.delegatedEnvironments(), []);
});

// Like ssh-host with servers: an orchestrator names one of the person's servers by its label; each has its own cap.
const FLEET = {
  kind: "fleet", label: "Fleet", description: `Servers such as ${SERVER_DETAIL}`,
  fields: [
    { key: "host", label: "Server", kind: "text", default: "", maxLength: 40 },
    { key: "persist", label: "Keep running", kind: "boolean", default: true }
  ],
  subagents: { maxParallel: 1, fields: ["host"], capBy: "host", maxParallelTotal: 2 }
};

test("capBy and maxParallelTotal are validated in the manifest", () => {
  const manifest = (subagents) => validatePluginManifest({
    apiVersion: 2, id: "com.example.s", name: "S", version: "1.0.0", description: "d", author: "a", permissions: ["environment:provide"],
    services: [{ id: "s", title: "S", description: "d", entry: "s.mjs", environments: [{ kind: "box", label: "Box",
      fields: [{ key: "host", label: "Host", kind: "text" }, { key: "x", label: "X", kind: "text" }], subagents }] }],
    contributions: []
  }).services[0].environments[0].subagents;
  assert.deepEqual(manifest({ maxParallel: 2, fields: ["host"], capBy: "host", maxParallelTotal: 5 }),
    { maxParallel: 2, fields: ["host"], capBy: "host", maxParallelTotal: 5 });
  assert.throws(() => manifest({ fields: ["host"], capBy: "x" }), /capBy must be one of its subagents\.fields/u);
  assert.throws(() => manifest({ capBy: "host" }), /capBy must be one of its subagents\.fields/u);
  assert.throws(() => manifest({ fields: ["host"], maxParallelTotal: 2 }), /maxParallelTotal needs capBy/u);
  assert.throws(() => manifest({ fields: ["host"], capBy: "host", maxParallelTotal: 65 }), /from 1 to 64/u);
});

test("list_providers shows a per-server kind's servers by label with counts; the plugin is asked at most every 30 s", async (t) => {
  const { pluginCalls, orchestrator, call, spawn } = await setup(t, { kinds: [FLEET] });
  const parent = orchestrator("normal");
  const listed = (await call(parent.id, "list_providers")).environments;
  assert.deepEqual(listed, [{ pluginId: PLUGIN, plugin: "Places", kind: "fleet", name: "Fleet", options: [{ key: "host", kind: "text" }],
    maxParallel: 1, running: 0, capBy: "host", servers: [{ name: "alpha", running: 0 }, { name: "beta", running: 0 }, { name: "gamma", running: 0 }],
    maxParallelTotal: 2, profiles: ["normal"], localProtection: false }]);
  assert.deepEqual(pluginCalls.filter((entry) => entry.step === "choices").map((entry) => entry.params), [{ kind: "fleet", field: "host" }]);
  await spawn(parent, { environment: { pluginId: PLUGIN, kind: "fleet", options: { host: "beta" } } });
  const again = (await call(parent.id, "list_providers")).environments[0];
  assert.deepEqual(again.servers.map((server) => [server.name, server.running]), [["alpha", 0], ["beta", 1], ["gamma", 0]]);
  assert.equal(again.running, 1);
  assert.equal(pluginCalls.filter((entry) => entry.step === "choices").length, 1, "cached");
  const text = JSON.stringify(again);
  for (const secret of [SERVER_DETAIL, "persist"]) assert.equal(text.includes(secret), false, secret);
});

test("a per-server cap counts each server on its own, and the kind-wide total over all of them", async (t) => {
  const { state, orchestrator, spawn, terminals, card } = await setup(t, { kinds: [FLEET] });
  state.servers = ["alpha", "beta", "gamma"];
  const first = orchestrator("normal");
  const second = orchestrator("normal");
  const on = (host) => ({ environment: { pluginId: PLUGIN, kind: "fleet", options: { host } } });
  await assert.rejects(spawn(first, { environment: { pluginId: PLUGIN, kind: "fleet" } }), refused(/Fleet: pass options\.host \(Server\), one of the servers list_providers lists/u));
  // The plugin itself would also take a server's address or another spelling: only the listed labels count.
  for (const other of ["Alpha", "alpha.internal", SERVER_DETAIL, " alpha"]) {
    await assert.rejects(spawn(first, on(other)), refused(/is not one of the servers the person set up for subagents \(alpha, beta, gamma\)/u), other);
  }
  const a = await spawn(first, on("alpha"));
  await assert.rejects(spawn(second, on("alpha")), refused(/alpha \(Fleet\) already runs 1 subagent, the most Places allows on one server at once/u));
  const b = await spawn(second, on("beta"));
  await assert.rejects(spawn(first, on("gamma")), refused(/Fleet already runs 2 subagents on all servers together/u));
  terminals.dispose(a.sessionId);
  await spawn(first, on("gamma"));
  await assert.rejects(spawn(first, on("alpha")), refused(/on all servers together/u));
  // A card whose options are not known (as after a restore) counts against every server.
  await waitFor(() => card(b.sessionId).environment !== undefined);
  terminals.sessions.get(b.sessionId).environmentOptions = undefined;
  assert.equal(terminals.subagentsInEnvironment(PLUGIN, "fleet", { field: "host", value: "alpha" }), 1);
  assert.equal(terminals.subagentsInEnvironment(PLUGIN, "fleet", { field: "host", value: "gamma" }), 2);
});

test("without an answer from the plugin no server can be chosen; invalid labels are dropped", async (t) => {
  const failing = await setup(t, { kinds: [FLEET], choices: () => { throw new Error("not supported"); } });
  const parent = failing.orchestrator("normal");
  assert.deepEqual((await failing.call(parent.id, "list_providers")).environments[0].servers, []);
  await assert.rejects(failing.spawn(parent, { environment: { pluginId: PLUGIN, kind: "fleet", options: { host: "alpha" } } }),
    refused(/Places did not list the servers for Fleet, so none can be chosen now/u));
  const extra = await setup(t, { kinds: [FLEET], choices: () => ({ choices: ["alpha"], hosts: [SERVER_DETAIL] }) });
  assert.deepEqual((await extra.call(extra.orchestrator("normal").id, "list_providers")).environments[0].servers, [], "an answer with other keys is no answer");
  const messy = await setup(t, { kinds: [FLEET], choices: () => ({ choices: ["alpha", "alpha", "x".repeat(41), "bad\nline", 5, " pad", "", "beta"] }) });
  assert.deepEqual((await messy.call(messy.orchestrator("normal").id, "list_providers")).environments[0].servers.map((server) => server.name), ["alpha", "beta"]);
});

test("a select field can name the servers itself: its declared values are the servers, no plugin call", async (t) => {
  const SELECT = { kind: "pool", label: "Pool", fields: [{ key: "site", label: "Site", kind: "select", options: [{ value: "east", label: "East" }, { value: "west", label: "West" }] }],
    keeps: { launch: true, isolated: true }, subagents: { maxParallel: 1, fields: ["site"], capBy: "site" } };
  const { pluginCalls, orchestrator, call, spawn } = await setup(t, { kinds: [SELECT] });
  const parent = orchestrator("normal");
  assert.deepEqual((await call(parent.id, "list_providers")).environments[0].servers, [{ name: "east", running: 0 }, { name: "west", running: 0 }]);
  await spawn(parent, { environment: { pluginId: PLUGIN, kind: "pool", options: { site: "west" } } });
  await assert.rejects(spawn(parent, { environment: { pluginId: PLUGIN, kind: "pool", options: { site: "west" } } }), refused(/west \(Pool\) already runs 1 subagent/u));
  await spawn(parent, { environment: { pluginId: PLUGIN, kind: "pool", options: { site: "east" } } });
  assert.equal(pluginCalls.some((entry) => entry.step === "choices"), false);
});
