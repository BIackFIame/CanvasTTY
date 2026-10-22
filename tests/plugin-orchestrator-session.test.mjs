/**
 * `sessions.create` with `role: "orchestrator"`: a plugin starts an orchestrator card only with `sessions:launch` and
 * the person's per-plugin "May start orchestrators" (kept with native code trust, revoked with it, off while the plugin
 * is disabled). The card gets the same orchestration tools as a person's orchestrator, is marked with the plugin that
 * started it (also after a restore), never runs in YOLO, and its subagents never get the person's trusted folder.
 * `role: "agent"` (the default) is unchanged.
 */
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginManager } from "../src/main/services/PluginManager.ts";
import { PluginSessions } from "../src/main/services/PluginSessions.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { TerminalSessionStore } from "../src/main/services/TerminalSessionStore.ts";
import { ORCHESTRATION_TOOL_NAMES } from "../src/agent-browser/orchestration-catalog.mjs";

const cwd = process.cwd();
const at = { x: 0, y: 0 };
const LAUNCH = ["sessions:launch", "sessions:control", "sessions:events"];
const flush = () => new Promise((resolve) => setImmediate(resolve));

function clis() {
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
      pid: 62_000 + calls.length, process: command, write() {}, resize() {}, kill() {}, pause() {}, resume() {},
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; }
    };
  };
}

/** The main process's wiring: terminal events feed PluginSessions; `allowed` stands in for the person's consent. */
function world({ allowed = () => false, store } = {}) {
  const calls = [];
  const prepared = [];
  let sessions = null;
  const terminals = new TerminalManager((channel, payload) => sessions?.observe(channel, payload), clis(),
    { prepareLaunch: (input) => { prepared.push(input); return null; } }, undefined, true, spawner(calls));
  terminals.configureOrchestration({ isEnabled: true, prepareLaunch: () => ({ environment: {}, cleanup() {} }) });
  if (store) terminals.configureSessionPersistence(store, "reopen");
  sessions = new PluginSessions({ terminals, notify: () => true, mayStartOrchestrators: (pluginId) => allowed(pluginId) });
  return { calls, prepared, terminals, sessions };
}

const create = (sessions, params, pluginId = "jev.plugin", permissions = LAUNCH) =>
  sessions.handle(pluginId, "svc", "sessions.create", { provider: "claude", cwd, ...params }, permissions);

test("an orchestrator is refused without sessions:launch, without the person's consent, and in YOLO; nothing starts", () => {
  const consent = new Set();
  const { terminals, sessions, calls } = world({ allowed: (pluginId) => consent.has(pluginId) });
  assert.throws(() => create(sessions, { role: "orchestrator" }, "jev.plugin", ["sessions:events"]), /sessions:launch permission/u);
  assert.throws(() => create(sessions, { role: "orchestrator" }), /not allowed this plugin to start orchestrators/u);
  assert.throws(() => create(sessions, { role: "subagent" }), /role must be agent or orchestrator/u);
  assert.throws(() => create(sessions, { role: "Orchestrator" }), /role must be agent or orchestrator/u);
  consent.add("other.plugin");
  assert.throws(() => create(sessions, { role: "orchestrator" }), /not allowed this plugin/u, "consent is per plugin");
  consent.add("jev.plugin");
  assert.throws(() => create(sessions, { role: "orchestrator", profile: "yolo" }), /never starts an orchestrator in YOLO/u);
  assert.equal(terminals.listMetadata().length, 0);
  assert.equal(calls.length, 0);
  // Without the dependency (an older host wiring) no plugin may.
  const bare = new PluginSessions({ terminals, notify: () => true });
  assert.throws(() => bare.handle("jev.plugin", "svc", "sessions.create", { provider: "claude", cwd, role: "orchestrator" }, LAUNCH), /not allowed/u);
  // A consent check that throws refuses too.
  const broken = new PluginSessions({ terminals, notify: () => true, mayStartOrchestrators: () => { throw new Error("registry"); } });
  assert.throws(() => broken.handle("jev.plugin", "svc", "sessions.create", { provider: "claude", cwd, role: "orchestrator" }, LAUNCH), /not allowed/u);
});

test("with consent: the orchestrator gets the person's orchestration tools, is owned, and is marked as plugin-started", async () => {
  const { terminals, sessions, prepared } = world({ allowed: (pluginId) => pluginId === "jev.plugin" });
  const person = terminals.create({ provider: "claude", cwd, profile: "normal", position: at, role: "orchestrator" });
  const { sessionId } = create(sessions, { role: "orchestrator", profile: "auto", title: "Auto (Jev)" });
  await flush();
  const card = terminals.listMetadata().find((metadata) => metadata.id === sessionId);
  assert.equal(card.role, "orchestrator");
  assert.equal(card.startedByPlugin, "jev.plugin");
  assert.equal(terminals.listMetadata().find((metadata) => metadata.id === person.id).startedByPlugin, undefined, "a person's orchestrator is not marked");
  assert.deepEqual(prepared.map((input) => input.orchestrationTools), [[...ORCHESTRATION_TOOL_NAMES], [...ORCHESTRATION_TOOL_NAMES]],
    "the plugin's orchestrator gets exactly what the person's gets");
  assert.equal(terminals.pluginContext(sessionId).owner, "jev.plugin");
  assert.equal(sessions.summary(sessionId).role, "orchestrator");
  // It may send its first prompt and stop it, like any card it started.
  assert.deepEqual(await sessions.handle("jev.plugin", "svc", "sessions.send", { sessionId, text: "plan" }, LAUNCH), { sessionId, sent: true });
  assert.throws(() => sessions.handle("other.plugin", "svc", "sessions.send", { sessionId, text: "x" }, LAUNCH), /No session this plugin started/u);
});

test("role agent is unchanged: no consent needed, no orchestration tools, no plugin-started mark", async () => {
  const { terminals, sessions, prepared } = world();
  const implicit = create(sessions, {});
  const explicit = create(sessions, { role: "agent", profile: "normal" });
  await flush();
  for (const { sessionId } of [implicit, explicit]) {
    const card = terminals.listMetadata().find((metadata) => metadata.id === sessionId);
    assert.equal(card.role, "agent");
    assert.equal(card.startedByPlugin, undefined);
    assert.equal(terminals.pluginContext(sessionId).owner, "jev.plugin");
  }
  assert.deepEqual(prepared.map((input) => input.orchestrationTools ?? null), [null, null]);
});

test("the plugin-started mark survives a restore; its subagents never get the person's trusted folder", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-plugin-orch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = world({ allowed: () => true, store: new TerminalSessionStore(directory) });
  await first.terminals.restorePersistedSessions();
  const { sessionId } = create(first.sessions, { role: "orchestrator" });
  await flush();
  await first.terminals.shutdown();
  const second = world({ store: new TerminalSessionStore(directory) });
  await second.terminals.restorePersistedSessions();
  const restored = second.terminals.listMetadata().find((metadata) => metadata.id === sessionId);
  assert.equal(restored.role, "orchestrator");
  assert.equal(restored.startedByPlugin, "jev.plugin");
  await second.terminals.shutdown();

  // trustedFolder: a person's orchestrator tree vouches for its folder; a plugin's does not.
  const runs = await mkdtemp(join(tmpdir(), "canvastty-plugin-orch-runs-"));
  t.after(() => rm(runs, { recursive: true, force: true }));
  const { LaunchPipeline } = await import("../src/main/services/LaunchPipeline.ts");
  const seen = [];
  const pipeline = new LaunchPipeline({
    contributors: () => [{ pluginId: "watch.policy", pluginName: "Watch", serviceId: "svc", secrets: false, launch: { policy: true, fields: [] } }],
    call: async (_pluginId, _serviceId, _method, params) => { seen.push(params); return null; },
    secret: async () => null,
    runsRoot: runs
  });
  const third = world({ allowed: () => true });
  third.terminals.configureLaunchPipeline(pipeline);
  const person = third.terminals.create({ provider: "claude", cwd, profile: "normal", position: at, role: "orchestrator" });
  const plugin = create(third.sessions, { role: "orchestrator" });
  const personChild = third.terminals.create({ provider: "claude", cwd, profile: "normal", position: at, role: "subagent", parentSessionId: person.id });
  const pluginChild = third.terminals.create({ provider: "claude", cwd, profile: "normal", position: at, role: "subagent", parentSessionId: plugin.sessionId });
  const deadline = Date.now() + 5_000;
  while (seen.length < 4 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  const byId = Object.fromEntries(seen.map((params) => [params.sessionId, params]));
  assert.equal(typeof byId[personChild.id].trustedFolder, "string", "the person's tree: the folder they chose is vouched for");
  assert.equal(byId[pluginChild.id].trustedFolder, undefined, "the plugin's tree: the plugin chose the folder, not the person");
  await third.terminals.shutdown();
});

test("consent lives in the plugin registry: needs trust and sessions:launch, survives a restart, is revoked by disable and update", async (t) => {
  const source = await mkdtemp(join(tmpdir(), "canvastty-orch-plugin-src-"));
  const userData = await mkdtemp(join(tmpdir(), "canvastty-orch-plugin-data-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const example = new URL("../examples/plugins/collect-demo/", import.meta.url);
  await cp(example, source, { recursive: true });
  const manifestPath = join(source, "canvastty.plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const withLaunch = { ...manifest, permissions: [...manifest.permissions, "sessions:launch", "sessions:control"] };
  await writeFile(manifestPath, JSON.stringify(withLaunch, null, 2));
  const download = async (_url, destination) => { await cp(source, destination, { recursive: true }); };

  const manager = new PluginManager(userData, download);
  t.after(() => manager.dispose());
  await manager.load();
  const { manifest: installed } = await manager.install((await manager.previewInstall("https://github.com/example/collect-demo")).token);
  const id = installed.id;
  assert.equal(manager.list()[0].mayStartOrchestrators, false, "install never grants it");
  assert.equal(manager.canStartOrchestrators(id), false);
  await assert.rejects(manager.setMayStartOrchestrators(id, true), /native code first/u);
  await manager.setNativeCodeTrusted(id, true);
  assert.equal(manager.canStartOrchestrators(id), false, "trust alone is not consent");
  await manager.setMayStartOrchestrators(id, true);
  assert.equal(manager.canStartOrchestrators(id), true);
  assert.equal(manager.list()[0].mayStartOrchestrators, true);

  // Kept across a restart with the trust it depends on.
  const again = new PluginManager(userData, download);
  t.after(() => again.dispose());
  await again.load();
  assert.equal(again.canStartOrchestrators(id), true);
  await again.dispose();

  // The person turns it off; then on again; disabling the plugin revokes it (and the trust).
  await manager.setMayStartOrchestrators(id, false);
  assert.equal(manager.canStartOrchestrators(id), false);
  await manager.setMayStartOrchestrators(id, true);
  await manager.setEnabled(id, false);
  assert.equal(manager.canStartOrchestrators(id), false, "a disabled plugin is refused");
  await manager.setEnabled(id, true);
  assert.equal(manager.canStartOrchestrators(id), false, "re-enabling does not bring it back");
  assert.equal(manager.list()[0].mayStartOrchestrators, false);

  // A plugin's sessions.create sees the live answer.
  const { sessions, terminals } = world({ allowed: (pluginId) => manager.canStartOrchestrators(pluginId) });
  assert.throws(() => create(sessions, { role: "orchestrator" }, id), /not allowed this plugin/u);
  await manager.setNativeCodeTrusted(id, true);
  await manager.setMayStartOrchestrators(id, true);
  assert.equal(typeof create(sessions, { role: "orchestrator" }, id).sessionId, "string");
  await manager.setNativeCodeTrusted(id, false);
  assert.throws(() => create(sessions, { role: "orchestrator" }, id), /not allowed this plugin/u, "revoking trust revokes it at once");
  await terminals.shutdown();

  // Without sessions:launch the consent cannot be given.
  const plainData = await mkdtemp(join(tmpdir(), "canvastty-orch-plugin-plain-"));
  t.after(() => rm(plainData, { recursive: true, force: true }));
  const plain = new PluginManager(plainData, async (_url, destination) => { await cp(example, destination, { recursive: true }); });
  t.after(() => plain.dispose());
  await plain.load();
  const plainId = (await plain.install((await plain.previewInstall("https://github.com/example/collect-demo")).token)).manifest.id;
  await plain.setNativeCodeTrusted(plainId, true);
  await assert.rejects(plain.setMayStartOrchestrators(plainId, true), /sessions:launch permission/u);
});

test("\"Started by\" shows the plugin's display name (localized when its manifest has one), with its id in the tooltip", async () => {
  const { setPluginNames, pluginDisplayName, pluginNamesSnapshot, usePluginName } = await import("../src/renderer/src/features/plugins/pluginNames.ts");
  assert.equal(typeof usePluginName, "function");
  const plugin = (manifest) => ({ manifest: { apiVersion: 1, version: "1.0.0", description: "", ...manifest }, sourceUrl: "", enabled: true, installedAt: 0, selectedModules: [], enabledHooks: [], nativeCodeTrusted: true, decisionsMayAllow: false, mayStartOrchestrators: true });
  const names = [
    plugin({ id: "canvastty-assistant", name: "CanvasTTY Assistant", "name.ru": "Помощник CanvasTTY" }),
    plugin({ id: "jev.plugin", name: "Jev" })
  ];
  assert.equal(pluginDisplayName(names, "canvastty-assistant", "en"), "CanvasTTY Assistant");
  assert.equal(pluginDisplayName(names, "canvastty-assistant", "ru"), "Помощник CanvasTTY");
  assert.equal(pluginDisplayName(names, "jev.plugin", "ru"), "Jev", "no localized name: the manifest's");
  assert.equal(pluginDisplayName(names, "removed.plugin", "en"), null, "not installed: the caller shows the id");
  assert.equal(pluginDisplayName(names, undefined, "en"), null);
  // The store the app fills from its plugin list (a manifest's own name.<locale> where the core keeps one).
  setPluginNames([plugin({ id: "canvastty-assistant", name: "CanvasTTY Assistant", "name.ru": "Помощник CanvasTTY" }), plugin({ id: "jev.plugin", name: "Jev" })]);
  assert.equal(pluginDisplayName(pluginNamesSnapshot(), "canvastty-assistant", "ru"), "Помощник CanvasTTY");
  assert.equal(pluginDisplayName(pluginNamesSnapshot(), "canvastty-assistant", "en"), "CanvasTTY Assistant");
  assert.equal(pluginDisplayName(pluginNamesSnapshot(), "jev.plugin", "ru"), "Jev");
  const card = await readFile(new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url), "utf8");
  assert.match(card, /usePluginName\(session\.startedByPlugin, locale\)/u);
  // The label shows the name and shrinks with an ellipsis; the tooltip keeps the full text with the plugin id.
  assert.match(card, /title=\{`\$\{t\(locale, "startedByPlugin"\)\}: \$\{session\.startedByPlugin\}`\}>/u);
  assert.match(card, /\{t\(locale, "startedByPlugin"\)\}: <span>\{startedByName \?\? session\.startedByPlugin\}<\/span>/u);
  const app = await readFile(new URL("../src/renderer/src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /useEffect\(\(\) => \{ setPluginNames\(plugins\); \}, \[plugins\]\);/u);
});
