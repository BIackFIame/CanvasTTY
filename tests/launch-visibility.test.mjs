/**
 * What a launch service sees of the launch it prepares or polices: `requested` (the model and effort the CLI is
 * started with and the selected plugin ids) and `peerOptions` (other selected plugins' values, only the fields their
 * owner shared with it through `visibleTo`, never free text or secrets).
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LaunchPipeline, visiblePeerOptions } from "../src/main/services/LaunchPipeline.ts";
import { validatePluginManifest } from "../src/main/services/PluginManager.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";

const exampleManifest = JSON.parse(await readFile(new URL("../examples/plugins/launch-env/canvastty.plugin.json", import.meta.url), "utf8"));
const SECRET = "account-key-value-5d1e0b77";
const cwd = process.cwd();
const at = { x: 0, y: 0 };

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
      pid: 41_000 + calls.length, process: command, write() {}, resize() {}, kill() {}, pause() {}, resume() {},
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; }
    };
  };
}

/** An accounts-like plugin: the account and a flag are shared with the router, the note (free text) and effort are not. */
const accounts = (visibleTo = ["com.example.router"]) => ({
  pluginId: "com.example.accounts",
  pluginName: "Accounts",
  serviceId: "launcher",
  secrets: true,
  launch: {
    delegable: true,
    fields: [
      { key: "account", label: "Account", kind: "select", optionsFrom: "service", default: "none",
        options: [{ value: "none", label: "Own sign-in" }], ...(visibleTo ? { visibleTo } : {}) },
      { key: "effort", label: "Effort", kind: "select", default: "default", options: [{ value: "default", label: "Default" }, { value: "high", label: "High" }] },
      { key: "trustFolder", label: "Trust", kind: "boolean", default: false, ...(visibleTo ? { visibleTo } : {}) },
      { key: "note", label: "Note", kind: "text", default: "" }
    ]
  }
});
const router = (extra = {}) => ({
  pluginId: "com.example.router",
  pluginName: "Router",
  serviceId: "svc",
  secrets: false,
  launch: { delegable: true, fields: [{ key: "route", label: "Route", kind: "select", optionsFrom: "service", default: "off", options: [{ value: "off", label: "Off" }] }] },
  ...extra
});
const bystander = {
  pluginId: "com.example.other",
  pluginName: "Other",
  serviceId: "svc",
  secrets: false,
  launch: { fields: [{ key: "on", label: "On", kind: "boolean", default: true }] }
};

async function fixture(t, contributors, answers = {}) {
  const runsRoot = await mkdtemp(join(tmpdir(), "canvastty-visibility-runs-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const requests = [];
  const pipeline = new LaunchPipeline({
    contributors: () => contributors,
    call: async (pluginId, _serviceId, method, params) => {
      requests.push({ pluginId, method, params: structuredClone(params) });
      const answer = answers[pluginId];
      return typeof answer === "function" ? answer(params) : answer ?? null;
    },
    secret: async (pluginId, key) => (pluginId === "com.example.accounts" && key === "glm" ? SECRET : null),
    runsRoot,
    timeoutMs: 1_000
  });
  return { pipeline, requests };
}

const sessionContext = (options, extra = {}) => ({
  sessionId: "s-1", provider: "claude", profile: "normal", role: "subagent", cwd, parentSessionId: "p-1",
  restoring: false, resume: false, options, environment: null, ...extra
});
const of = (requests, pluginId) => requests.find((request) => request.pluginId === pluginId)?.params;

test("manifests: visibleTo is opt-in per field, on choices only, never on free text or environment fields", () => {
  const service = exampleManifest.services[0];
  const withFields = (fields) => validatePluginManifest({ ...exampleManifest, services: [{ ...service, launch: { ...service.launch, fields } }] });
  const parsed = withFields([
    { key: "account", label: "Account", kind: "select", options: [{ value: "a", label: "A" }], visibleTo: ["canvastty-assistant"] },
    { key: "flag", label: "Flag", kind: "boolean", visibleTo: ["canvastty-assistant", "com.example.router"] },
    { key: "plain", label: "Plain", kind: "select", options: [{ value: "a", label: "A" }] }
  ]);
  assert.deepEqual(parsed.services[0].launch.fields.map((field) => field.visibleTo), [["canvastty-assistant"], ["canvastty-assistant", "com.example.router"], undefined]);
  assert.throws(() => withFields([{ key: "note", label: "Note", kind: "text", visibleTo: ["canvastty-assistant"] }]), /only for select and boolean/u);
  assert.throws(() => withFields([{ key: "flag", label: "Flag", kind: "boolean", visibleTo: [] }]), /1 to 8 distinct plugin ids/u);
  assert.throws(() => withFields([{ key: "flag", label: "Flag", kind: "boolean", visibleTo: ["a.b", "a.b"] }]), /distinct plugin ids/u);
  assert.throws(() => withFields([{ key: "flag", label: "Flag", kind: "boolean", visibleTo: ["Not An Id"] }]), /distinct plugin ids/u);
  assert.throws(() => withFields([{ key: "flag", label: "Flag", kind: "boolean", visibleTo: "canvastty-assistant" }]), /distinct plugin ids/u);
  assert.throws(() => withFields([{ key: "flag", label: "Flag", kind: "boolean", visibleTo: Array.from({ length: 9 }, (_, index) => `p${index}.x`) }]), /1 to 8/u);
  assert.throws(() => validatePluginManifest({
    ...exampleManifest,
    permissions: ["environment:provide"],
    services: [{ id: "env", title: "Env", entry: service.entry,
      environments: [{ kind: "box", label: "Box", fields: [{ key: "flag", label: "Flag", kind: "boolean", visibleTo: ["a.b.c"] }] }] }]
  }), /cannot declare visibleTo/u);
});

test("peer options are invisible without visibleTo, and visible field by field with it", async (t) => {
  const options = {
    "com.example.accounts": { account: "glm-plan-2", effort: "high", trustFolder: true, note: "free text" },
    "com.example.router": { route: "r:abc:plan:glm" }
  };
  {
    const { pipeline, requests } = await fixture(t, [accounts(null), router()]);
    const prepared = await pipeline.prepare(sessionContext(options));
    assert.equal(prepared.ok, true);
    assert.deepEqual(of(requests, "com.example.router").peerOptions, {}, "no opt-in, nothing shared");
    assert.deepEqual(of(requests, "com.example.accounts").peerOptions, {});
  }
  {
    const { pipeline, requests } = await fixture(t, [accounts(), router(), bystander]);
    const prepared = await pipeline.prepare(sessionContext({ ...options, "com.example.other": { on: true } }));
    assert.equal(prepared.ok, true);
    const seen = of(requests, "com.example.router");
    assert.deepEqual(seen.options, { route: "r:abc:plan:glm" }, "its own options are unchanged");
    assert.deepEqual(seen.peerOptions, { "com.example.accounts": { account: "glm-plan-2", trustFolder: true } },
      "only the shared choices; not effort (no opt-in), not the free-text note, nothing from a plugin that shares nothing");
    assert.deepEqual(of(requests, "com.example.other").peerOptions, {}, "a plugin not named in visibleTo sees nothing");
    assert.deepEqual(of(requests, "com.example.accounts").peerOptions, {}, "sharing is one way: the owner sees no peer it was not given");
  }
});

test("secrets never reach a peer: secretEnv stays in the host, and free text is not shared even if a record says so", async (t) => {
  const { pipeline, requests } = await fixture(t, [accounts(), router()], {
    "com.example.accounts": { secretEnv: { ZAI_API_KEY: "glm" }, env: { ZAI_BASE: "https://api.example.test" } }
  });
  const prepared = await pipeline.prepare(sessionContext({
    "com.example.accounts": { account: "glm-plan-2", effort: "default", trustFolder: false, note: "" },
    "com.example.router": { route: "off" }
  }));
  assert.equal(prepared.ok, true);
  assert.equal(prepared.env.ZAI_API_KEY, SECRET, "the launch itself still gets the secret");
  for (const request of requests) {
    assert.equal(JSON.stringify(request.params).includes(SECRET), false, `${request.pluginId} never sees the secret value`);
    assert.equal(JSON.stringify(request.params).includes("ZAI_"), false, `${request.pluginId} never sees another plugin's contribution`);
  }
  // Defense in depth: a contributor record that skipped manifest validation still never shares text.
  const forged = accounts();
  forged.launch.fields.find((field) => field.key === "note").visibleTo = ["com.example.router"];
  assert.deepEqual(visiblePeerOptions("com.example.router",
    { "com.example.accounts": { account: "a", note: "typed by a person", trustFolder: false } },
    new Map([[forged.pluginId, forged]])), { "com.example.accounts": { account: "a", trustFolder: false } });
});

test("requested carries the model, effort and selected plugins, and a launch policy sees the same", async (t) => {
  const policy = router({ pluginId: "com.example.router", launch: { policy: true, fields: [] } });
  const { pipeline, requests } = await fixture(t, [accounts(), policy]);
  const prepared = await pipeline.prepare(sessionContext(
    { "com.example.accounts": { account: "glm-plan-2", effort: "default", trustFolder: false, note: "" } },
    { model: "glm-4.6", effort: "high" }
  ));
  assert.equal(prepared.ok, true);
  const chosen = of(requests, "com.example.accounts");
  const policed = of(requests, "com.example.router");
  assert.equal(policed.chosen, false);
  assert.deepEqual(policed.options, {});
  assert.deepEqual(policed.requested, { model: "glm-4.6", effort: "high", plugins: ["com.example.accounts"] });
  assert.deepEqual(chosen.requested, policed.requested, "the chosen plugin and the policy see one request");
  assert.deepEqual(policed.peerOptions, { "com.example.accounts": { account: "glm-plan-2", trustFolder: false } });
  assert.equal("model" in policed, false, "model and effort travel only inside requested");
  assert.equal("effort" in policed, false);

  requests.length = 0;
  await pipeline.prepare(sessionContext({}));
  assert.deepEqual(of(requests, "com.example.router").requested, { plugins: [] }, "no model or effort: the CLI's default");
  assert.deepEqual(of(requests, "com.example.router").peerOptions, {});
});

test("end to end: a card's model and effort reach prepare and the policy, also for a subagent", async (t) => {
  const policy = router({ launch: { policy: true, fields: [] } });
  const { pipeline, requests } = await fixture(t, [accounts(), policy], {
    "com.example.router": (context) => context.requested.model === "opus" ? null : { refuse: { reason: `model ${context.requested.model ?? "default"} is not the decision` } }
  });
  const calls = [];
  const manager = new TerminalManager(() => undefined, registry(), undefined, undefined, true, spawner(calls));
  t.after(() => manager.shutdown());
  manager.configureLaunchPipeline(pipeline);

  const parent = manager.create({ provider: "claude", profile: "normal", cwd, position: at, role: "orchestrator", model: "opus", effort: "high",
    launchOptions: { "com.example.accounts": { account: "none" } } });
  await waitFor(() => calls.length === 1);
  const first = requests.filter((request) => request.params.sessionId === parent.id);
  assert.deepEqual(first.map((request) => [request.pluginId, request.params.chosen]).sort(), [["com.example.accounts", true], ["com.example.router", false]]);
  for (const request of first) {
    assert.deepEqual(request.params.requested, { model: "opus", effort: "high", plugins: ["com.example.accounts"] });
  }

  const child = manager.create({ provider: "claude", profile: "normal", cwd, position: at, role: "subagent", parentSessionId: parent.id, model: "sonnet" });
  await waitFor(() => manager.list().find((session) => session.id === child.id)?.status === "failed");
  assert.equal(calls.length, 1, "the policy refused the subagent's model, so nothing ran");
  assert.deepEqual(of(requests.filter((request) => request.params.sessionId === child.id), "com.example.router").requested, { model: "sonnet", plugins: [] });
  assert.match(manager.list().find((session) => session.id === child.id).failureDetails, /model sonnet is not the decision/u);
});
