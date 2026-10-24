/**
 * A scoped launch policy (`"policy": { "scope": "own-trees" }`) is asked only for subagents whose ancestors include a
 * card its plugin was chosen for (or started). The person's launches and other trees never wait for it, so its
 * service being down refuses only launches in its own trees. `policy: true` keeps asking for every launch.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LaunchPipeline } from "../src/main/services/LaunchPipeline.ts";
import { validatePluginManifest } from "../src/main/services/PluginManager.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { MAX_TREE_PLUGINS, TerminalSessionStore, normalizePersistedTerminalSessions } from "../src/main/services/TerminalSessionStore.ts";

const exampleManifest = JSON.parse(await readFile(new URL("../examples/plugins/launch-env/canvastty.plugin.json", import.meta.url), "utf8"));
const cwd = process.cwd();
const at = { x: 0, y: 0 };
const ROUTER = "com.example.router";
const OTHER = "com.example.other";

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met in time.");
};

function registry() {
  return {
    get(provider) {
      return { state: "available", provider, executable: `/resolved/${provider}`, launcher: "native",
        environment: { PATH: "/usr/bin" }, checked: [] };
    },
    snapshot() { return {}; }
  };
}

function spawner(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return {
      pid: 43_000 + calls.length, process: command, write() {}, resize() {}, kill() {}, pause() {}, resume() {},
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; }
    };
  };
}

const router = (policy = { scope: "own-trees" }) => ({
  pluginId: ROUTER, pluginName: "Router", serviceId: "svc", secrets: false,
  launch: { delegable: true, policy, fields: [{ key: "route", label: "Route", kind: "select", default: "off", options: [{ value: "off", label: "Off" }] }] }
});
const other = {
  pluginId: OTHER, pluginName: "Other", serviceId: "svc", secrets: false,
  launch: { delegable: true, fields: [{ key: "on", label: "On", kind: "boolean", default: true }] }
};

/** A manager over a real pipeline; `state.down` makes the router's service fail every call. */
async function world(t, { policy, store } = {}) {
  const runsRoot = await mkdtemp(join(tmpdir(), "canvastty-scope-runs-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const state = { down: false, requests: [] };
  const pipeline = new LaunchPipeline({
    contributors: () => [router(policy), other],
    call: async (pluginId, _serviceId, _method, params) => {
      state.requests.push({ pluginId, sessionId: params.sessionId, chosen: params.chosen, restoring: params.restoring });
      if (pluginId === ROUTER && state.down) throw new Error("Plugin service is not running.");
      return null;
    },
    secret: async () => null,
    runsRoot,
    timeoutMs: 1_000
  });
  const calls = [];
  const manager = new TerminalManager(() => undefined, registry(), undefined, undefined, true, spawner(calls));
  t.after(() => manager.shutdown());
  manager.configureLaunchPipeline(pipeline);
  if (store) {
    manager.configureSessionPersistence(store, "continue");
    await manager.restorePersistedSessions();
  }
  return { manager, calls, state, policyCalls: (sessionId) => state.requests.filter((request) => request.pluginId === ROUTER
    && request.chosen === false && (sessionId === undefined || request.sessionId === sessionId)) };
}

const card = (manager, id) => manager.list().find((session) => session.id === id);
test("manifests: policy is true or { scope: \"own-trees\" }", () => {
  const service = exampleManifest.services[0];
  const withPolicy = (policy) => validatePluginManifest({ ...exampleManifest, services: [{ ...service, launch: { ...service.launch, policy } }] });
  assert.deepEqual(withPolicy({ scope: "own-trees" }).services[0].launch.policy, { scope: "own-trees" });
  assert.equal(withPolicy(true).services[0].launch.policy, true);
  assert.equal(withPolicy(false).services[0].launch.policy, undefined);
  assert.throws(() => withPolicy({ scope: "everything" }), /scope must be "own-trees"/u);
  assert.throws(() => withPolicy({ scope: "own-trees", extra: 1 }), /extra/u);
  assert.throws(() => withPolicy("own-trees"), /must be true or false, or/u);
});

test("a scoped policy is never asked for the person's launches or for other trees; they never wait for it", async (t) => {
  const { manager, calls, policyCalls } = await world(t);
  const plain = manager.create({ provider: "claude", profile: "normal", cwd, position: at });
  assert.equal(calls.length, 1, "a person's plain launch starts at once: no policy to wait for");
  const foreign = manager.create({ provider: "claude", profile: "normal", cwd, position: at, role: "orchestrator", launchOptions: { [OTHER]: {} } });
  await waitFor(() => calls.length === 2);
  const child = manager.create({ provider: "codex", profile: "normal", cwd, position: at, role: "subagent", parentSessionId: foreign.id });
  assert.equal(calls.length, 3, "a child in another plugin's tree starts at once");
  const grandchild = manager.create({ provider: "claude", profile: "normal", cwd, position: at, role: "subagent", parentSessionId: child.id });
  assert.equal(calls.length, 4);
  const personChild = manager.create({ provider: "codex", profile: "normal", cwd, position: at, role: "subagent", parentSessionId: plain.id });
  assert.equal(calls.length, 5);
  assert.equal(policyCalls().length, 0, "zero calls to the scoped policy");
  for (const id of [plain.id, foreign.id, child.id, grandchild.id, personChild.id]) assert.equal(card(manager, id).failureDetails, null);
});

test("a scoped policy is asked for its own tree, children and grandchildren on other CLIs, never for the root", async (t) => {
  const { manager, calls, policyCalls, state } = await world(t);
  const root = manager.create({ provider: "claude", profile: "normal", cwd, position: at, role: "orchestrator", launchOptions: { [ROUTER]: {} } });
  await waitFor(() => calls.length === 1);
  assert.equal(policyCalls().length, 0, "the root chose the plugin: a normal prepare, no policy call");
  assert.equal(state.requests.filter((request) => request.sessionId === root.id && request.chosen === true).length, 1);
  const child = manager.create({ provider: "codex", profile: "normal", cwd, position: at, role: "subagent", parentSessionId: root.id });
  await waitFor(() => calls.length === 2);
  const grandchild = manager.create({ provider: "opencode", profile: "normal", cwd, position: at, role: "subagent", parentSessionId: child.id });
  await waitFor(() => calls.length === 3);
  assert.equal(policyCalls(child.id).length, 1, "the codex child");
  assert.equal(policyCalls(grandchild.id).length, 1, "the opencode grandchild");
});

test("a card the plugin started (sessions.create) also roots its tree", async (t) => {
  const { manager, calls, policyCalls } = await world(t);
  const started = manager.create({ provider: "claude", profile: "normal", cwd, position: at, role: "orchestrator" }, { origin: "plugin", ownerPluginId: ROUTER });
  manager.setPluginOwner(started.id, ROUTER);
  await waitFor(() => calls.length === 1);
  assert.equal(policyCalls(started.id).length, 0, "the top-level card itself is not a subagent");
  const child = manager.create({ provider: "codex", profile: "normal", cwd, position: at, role: "subagent", parentSessionId: started.id });
  await waitFor(() => calls.length === 2);
  assert.equal(policyCalls(child.id).length, 1);
});

test("service down: only launches in its own tree are refused, with the existing reason", async (t) => {
  const { manager, calls, state, policyCalls } = await world(t);
  const root = manager.create({ provider: "claude", profile: "normal", cwd, position: at, role: "orchestrator", launchOptions: { [ROUTER]: {} } });
  await waitFor(() => calls.length === 1);
  state.down = true;
  const own = manager.create({ provider: "codex", profile: "normal", cwd, position: at, role: "subagent", parentSessionId: root.id });
  await waitFor(() => card(manager, own.id).status === "failed");
  assert.match(card(manager, own.id).failureDetails, /^Launch refused: Router could not prepare the launch: Plugin service is not running\./u);
  const person = manager.create({ provider: "claude", profile: "normal", cwd, position: at, role: "orchestrator" });
  const personChild = manager.create({ provider: "codex", profile: "normal", cwd, position: at, role: "subagent", parentSessionId: person.id });
  assert.equal(calls.length, 3, "the person's orchestrator and its child start, the router is not asked");
  assert.equal(card(manager, person.id).failureDetails, null);
  assert.equal(card(manager, personChild.id).failureDetails, null);
  assert.equal(policyCalls().length, 1, "only the own-tree child asked");
});

test("policy: true keeps today's semantics: every launch waits for it, and a down service refuses them all", async (t) => {
  const { manager, calls, state, policyCalls } = await world(t, { policy: true });
  state.down = true;
  const person = manager.create({ provider: "claude", profile: "normal", cwd, position: at });
  await waitFor(() => card(manager, person.id).status === "failed");
  assert.equal(calls.length, 0);
  assert.equal(policyCalls(person.id).length, 1);
});

test("restore keeps the scope: the saved tree owners still route a restored subagent through the policy", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-scope-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await world(t, { store: new TerminalSessionStore(directory) });
  const root = first.manager.create({ provider: "claude", profile: "normal", cwd, position: at, role: "orchestrator", launchOptions: { [ROUTER]: {} } });
  await waitFor(() => first.calls.length === 1);
  const child = first.manager.create({ provider: "codex", profile: "normal", cwd, position: at, role: "subagent", parentSessionId: root.id });
  const person = first.manager.create({ provider: "claude", profile: "normal", cwd, position: at });
  await waitFor(() => first.calls.length === 3);
  await first.manager.shutdown();
  const saved = await new TerminalSessionStore(directory).load();
  assert.deepEqual(saved.find((record) => record.id === child.id).treePlugins, [ROUTER]);
  assert.equal(saved.find((record) => record.id === person.id).treePlugins, undefined);
  assert.equal(saved.find((record) => record.id === root.id).treePlugins, undefined);

  const second = await world(t, { store: new TerminalSessionStore(directory) });
  await waitFor(() => second.calls.length === 3);
  const restoredPolicy = second.policyCalls(child.id);
  assert.equal(restoredPolicy.length, 1, "the restored child is policed again");
  assert.equal(restoredPolicy[0].restoring, true);
  assert.equal(second.policyCalls(person.id).length, 0);
  assert.equal(second.policyCalls(root.id).length, 0);
  await second.manager.shutdown();
});

test("owners are never dropped: a tree over the bound refuses the next child, and the policy keeps policing up to it", async (t) => {
  const runsRoot = await mkdtemp(join(tmpdir(), "canvastty-scope-cap-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  // The policy's id sorts last, so cutting a sorted list would lose it first.
  const last = "zz.router";
  const plugins = Array.from({ length: 80 }, (_, index) => `p${String(index).padStart(2, "0")}.plugin`);
  const contributor = (pluginId, policy) => ({ pluginId, pluginName: pluginId, serviceId: "svc", secrets: false,
    launch: { delegable: true, ...(policy ? { policy } : {}), fields: [{ key: "on", label: "On", kind: "boolean", default: true }] } });
  const policed = [];
  const pipeline = new LaunchPipeline({
    contributors: () => [contributor(last, { scope: "own-trees" }), ...plugins.map((pluginId) => contributor(pluginId))],
    call: async (pluginId, _serviceId, _method, params) => {
      if (pluginId === last && params.chosen === false) policed.push(params.sessionId);
      return null;
    },
    secret: async () => null,
    runsRoot,
    timeoutMs: 1_000
  });
  const calls = [];
  const manager = new TerminalManager(() => undefined, registry(), undefined, undefined, true, spawner(calls));
  t.after(() => manager.shutdown());
  manager.configureLaunchPipeline(pipeline);
  const options = (slice) => Object.fromEntries(slice.map((pluginId) => [pluginId, {}]));
  // Root: the policy's plugin and 15 others; each child chooses 16 new plugins, so each level adds 16 owners.
  let parent = manager.create({ provider: "claude", profile: "normal", cwd, position: at, role: "orchestrator",
    launchOptions: options([last, ...plugins.slice(0, 15)]) });
  const chain = [];
  for (let level = 0; level < 4; level++) {
    const child = manager.create({ provider: level % 2 ? "claude" : "codex", profile: "normal", cwd, position: at, role: "subagent",
      parentSessionId: parent.id, launchOptions: options(plugins.slice(15 + level * 16, 31 + level * 16)) });
    chain.push(child.id);
    parent = child;
  }
  await waitFor(() => calls.length === 5);
  assert.deepEqual(policed.sort(), [...chain].sort(), "every level up to the bound is policed, the last-sorting owner included");
  assert.throws(() => manager.create({ provider: "codex", profile: "normal", cwd, position: at, role: "subagent", parentSessionId: parent.id }),
    new RegExp(`involves 80 plugins \\(at most ${MAX_TREE_PLUGINS}\\).*not started`, "u"));
  assert.equal(calls.length, 5, "nothing else started");
  assert.equal(manager.list().length, 5, "no card was made for the refused child");
});

test("restore never cuts a saved owner list: over the bound the record is not restored, at the bound it is kept whole", () => {
  const base = { id: "c1", provider: "codex", profile: "normal", role: "subagent", parentSessionId: "p1", title: "T", titleCustomized: false, cwd,
    position: at, size: { width: 700, height: 430 }, lastState: "running", restore: true };
  const ids = (count) => Array.from({ length: count }, (_, index) => `p${index}.plugin`);
  const kept = normalizePersistedTerminalSessions({ version: 2, sessions: [{ ...base, treePlugins: ids(MAX_TREE_PLUGINS) }] }).sessions;
  assert.equal(kept[0].treePlugins.length, MAX_TREE_PLUGINS);
  assert.deepEqual(normalizePersistedTerminalSessions({ version: 2, sessions: [{ ...base, treePlugins: ids(MAX_TREE_PLUGINS + 1) }] }).sessions, [],
    "over the bound: not restored, never truncated");
  assert.deepEqual(normalizePersistedTerminalSessions({ version: 2, sessions: [{ ...base, treePlugins: ["Bad Id"] }] }).sessions, [],
    "unreadable: not restored");
});
