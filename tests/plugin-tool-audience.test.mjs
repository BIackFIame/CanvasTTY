import assert from "node:assert/strict";
import test from "node:test";
import { validatePluginManifest } from "../src/main/services/PluginManager.ts";
import { PluginAgentTools } from "../src/main/services/PluginAgentTools.ts";
import { PluginSessions } from "../src/main/services/PluginSessions.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { ORCHESTRATION_TOOL_NAMES } from "../src/agent-browser/orchestration-catalog.mjs";

const cwd = process.cwd();
const at = { x: 0, y: 0 };
const PLUGIN = "com.example.conductor";

const manifest = (tool) => ({
  apiVersion: 2, id: PLUGIN, name: "Conductor", version: "1.0.0", description: "Main agent.", contributions: [],
  permissions: ["tools:agents", "sessions:launch"],
  services: [{
    id: "main", title: "Main", entry: "services/main.mjs",
    tools: [{ name: "project_start", description: "Start a project lead.", inputSchema: { type: "object" }, roles: ["agent", "orchestrator"], ...tool }]
  }]
});

const provider = (audience) => ({
  pluginId: PLUGIN, pluginName: "Conductor", serviceId: "main",
  tools: [
    { name: "project_start", description: "Start", inputSchema: { type: "object" }, roles: ["agent", "orchestrator", "subagent"], ...(audience ? { audience } : {}) },
    { name: "everyone", description: "Open", inputSchema: { type: "object" }, roles: ["agent"] }
  ]
});

test("manifest: audience is all or own-cards; anything else is refused; all is the default", () => {
  assert.equal(validatePluginManifest(manifest({ audience: "own-cards" })).services[0].tools[0].audience, "own-cards");
  assert.equal(validatePluginManifest(manifest({ audience: "all" })).services[0].tools[0].audience, undefined);
  assert.equal(validatePluginManifest(manifest({})).services[0].tools[0].audience, undefined);
  for (const audience of ["owned", "own-cards ", "", null, true, ["own-cards"]]) {
    assert.throws(() => validatePluginManifest(manifest({ audience })), /audience must be/u, String(audience));
  }
});

test("own-cards tools: listed and callable only for cards the plugin started; never by owner guess", async () => {
  const owners = new Map([["mine", PLUGIN], ["other-plugin", "com.example.other"], ["person", null]]);
  const calls = [];
  const tools = new PluginAgentTools({
    providers: () => [provider("own-cards")],
    call: async (pluginId, serviceId, method, params) => { calls.push(params); return "ok"; },
    caller: (id) => ({ id }),
    owner: (id) => owners.get(id) ?? null,
    redact: (text) => text
  });
  const name = "com_example_conductor__project_start";
  assert.deepEqual(tools.names("agent", "claude", PLUGIN), [name, "com_example_conductor__everyone"]);
  assert.deepEqual(tools.names("agent", "claude", null), ["com_example_conductor__everyone"]);
  assert.deepEqual(tools.names("agent", "claude", "com.example.other"), ["com_example_conductor__everyone"]);
  // Without an owner the default is the narrow one.
  assert.deepEqual(tools.names("orchestrator", "claude"), []);
  assert.deepEqual(tools.list("agent", "claude", "mine").map((tool) => tool.name), [name, "com_example_conductor__everyone"]);
  assert.deepEqual(tools.list("agent", "claude", "person").map((tool) => tool.name), ["com_example_conductor__everyone"]);
  assert.deepEqual(tools.list("agent", "claude").map((tool) => tool.name), ["com_example_conductor__everyone"]);
  // The role filter still applies to own cards.
  assert.deepEqual(tools.names("orchestrator", "claude", PLUGIN), [name]);

  assert.deepEqual(await tools.call("mine", "agent", name, {}), { content: "ok", isError: false });
  await assert.rejects(tools.call("person", "agent", name, {}), /not available/u);
  await assert.rejects(tools.call("other-plugin", "agent", name, {}), /not available/u);
  // Ownership is read again on every call: a card that is no longer the plugin's loses the tool at once.
  owners.set("mine", null);
  await assert.rejects(tools.call("mine", "agent", name, {}), /not available/u);
  assert.equal(calls.length, 1);
});

test("own-cards: an owner lookup that fails, or no owner dependency at all, hides the tool", async () => {
  const failing = new PluginAgentTools({
    providers: () => [provider("own-cards")], call: async () => "ok", caller: (id) => ({ id }),
    owner: () => { throw new Error("gone"); }, redact: (text) => text
  });
  assert.deepEqual(failing.list("agent", "claude", "x").map((tool) => tool.name), ["com_example_conductor__everyone"]);
  await assert.rejects(failing.call("x", "agent", "com_example_conductor__project_start", {}), /not available/u);
  const none = new PluginAgentTools({ providers: () => [provider("own-cards")], call: async () => "ok", caller: (id) => ({ id }), redact: (text) => text });
  await assert.rejects(none.call("x", "agent", "com_example_conductor__project_start", {}), /not available/u);
  // A tool without audience is unchanged: every card of its role.
  const open = new PluginAgentTools({ providers: () => [provider()], call: async () => "ok", caller: (id) => ({ id }), redact: (text) => text });
  assert.deepEqual(open.names("agent", "claude", null), ["com_example_conductor__project_start", "com_example_conductor__everyone"]);
});

function clis() {
  return {
    get(name) {
      return { state: "available", provider: name, executable: `/resolved/${name}`, launcher: "native", environment: { PATH: "/usr/bin" }, checked: [] };
    },
    snapshot() { return {}; }
  };
}

function spawner() {
  return () => ({
    pid: 61_000, process: "x", write() {}, resize() {}, kill() {}, pause() {}, resume() {},
    onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }
  });
}

test("terminal manager and orchestration handler: only the plugin's own card gets the bridge and the tool; its subagent and the person's card do not", async () => {
  const prepared = [];
  let sessions = null;
  const terminals = new TerminalManager((channel, payload) => sessions?.observe(channel, payload), clis(),
    { prepareLaunch: (input) => { prepared.push(input); return null; } }, undefined, true, spawner());
  terminals.configureOrchestration({ isEnabled: true, prepareLaunch: () => ({ environment: {}, cleanup() {} }) });
  sessions = new PluginSessions({ terminals, notify: () => true, mayStartOrchestrators: () => true });
  const tools = new PluginAgentTools({
    providers: () => [{ ...provider("own-cards"), tools: [provider("own-cards").tools[0]] }],
    call: async (pluginId, serviceId, method, params) => ({ content: `called by ${params.callerSessionId}` }),
    caller: (id) => sessions.summary(id),
    owner: (id) => terminals.pluginContext(id)?.owner ?? null,
    redact: (text) => text
  });
  terminals.configureAgentTools((role, name, owner) => tools.names(role, name, owner));

  const person = terminals.create({ provider: "claude", cwd, profile: "normal", position: at });
  const { sessionId: own } = sessions.handle(PLUGIN, "main", "sessions.create", { provider: "claude", cwd, role: "agent" }, ["sessions:launch"]);
  const { sessionId: lead } = sessions.handle(PLUGIN, "main", "sessions.create", { provider: "claude", cwd, role: "orchestrator" }, ["sessions:launch"]);
  const child = terminals.create({ provider: "claude", cwd, profile: "normal", position: at, role: "subagent", parentSessionId: lead });
  const name = "com_example_conductor__project_start";
  assert.deepEqual(prepared.map((input) => input.orchestrationTools ?? null), [
    null,
    [name],
    [...ORCHESTRATION_TOOL_NAMES, name],
    null
  ]);
  const handler = new ScopedOrchestrationHandler(new AgentControlService(terminals), tools);
  assert.deepEqual(handler.listTools(own).map((tool) => tool.name), [name]);
  assert.deepEqual(handler.listTools(child.id).map((tool) => tool.name), []);
  assert.deepEqual(await handler.execute(own, { id: "1", tool: name, arguments: {} }), { pluginTool: true, text: `called by ${own}`, isError: false });
  await assert.rejects(handler.execute(person.id, { id: "2", tool: name, arguments: {} }), /not available/u);
  await assert.rejects(handler.execute(child.id, { id: "3", tool: name, arguments: {} }), /not available/u);
  for (const id of [person.id, own, lead, child.id]) terminals.dispose(id);
});

test("manifest: 16 tools for every card plus up to 16 more for the plugin's own cards, per service", () => {
  const tools = (count, extra = {}, prefix = "t") => Array.from({ length: count }, (_, index) => ({
    name: `${prefix}${index}`, description: "x", inputSchema: { type: "object" }, roles: ["agent"], ...extra
  }));
  const withTools = (list) => ({ ...manifest({}), services: [{ ...manifest({}).services[0], tools: list }] });
  assert.equal(validatePluginManifest(withTools([...tools(16), ...tools(16, { audience: "own-cards" }, "o")])).services[0].tools.length, 32);
  assert.throws(() => validatePluginManifest(withTools(tools(17))), /between 1 and 16/u);
  assert.throws(() => validatePluginManifest(withTools(tools(17, { audience: "own-cards" }))), /between 1 and 16/u);
  assert.throws(() => validatePluginManifest(withTools([...tools(16), ...tools(17, { audience: "own-cards" }, "o")])), /between 1 and 16/u);
});
