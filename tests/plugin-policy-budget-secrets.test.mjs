/**
 * Small extension points a model-backed plugin needs (the CanvasTTY Assistant): launch policies (`launch.policy`,
 * asked before every launch with `chosen: false`, refusal only), and `secrets.get` for a service's own
 * secrets. HOME is whatever the test runner's fake HOME is.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LaunchPipeline } from "../src/main/services/LaunchPipeline.ts";
import { validatePluginManifest } from "../src/main/services/PluginManager.ts";
import { PluginServiceSupervisor } from "../src/main/services/PluginServiceSupervisor.ts";

const guardExample = new URL("../examples/plugins/yolo-guard/", import.meta.url);
const echoExample = new URL("../examples/plugins/service-echo/", import.meta.url);
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

test("manifests: launch.policy is a boolean; the examples validate", async () => {
  const base = (service) => ({
    apiVersion: 2, id: "com.example.points", name: "Points", version: "1.0.0", description: "Test.",
    permissions: ["launch:contribute"], contributions: [],
    services: [{ id: "svc", title: "Svc", entry: "services/svc.mjs", ...service }]
  });
  assert.equal(validatePluginManifest(base({ launch: { policy: true, fields: [] } })).services[0].launch.policy, true);
  assert.equal(validatePluginManifest(base({ launch: { policy: false, fields: [] } })).services[0].launch.policy, undefined);
  assert.throws(() => validatePluginManifest(base({ launch: { policy: "yes", fields: [] } })), /policy must be true or false/u);
  assert.equal(validatePluginManifest(await readJson(new URL("canvastty.plugin.json", guardExample))).services[0].launch.policy, true);
  assert.deepEqual(validatePluginManifest(await readJson(new URL("canvastty.plugin.json", echoExample))).permissions, ["storage", "secrets"]);
});

test("launch policies: asked with chosen false for every agent launch; they may only refuse", async (t) => {
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

  answers["a.policy"] = ({ profile }) => profile === "yolo" ? { refuse: { reason: "No YOLO here." } } : null;
  const refused = await pipeline.prepare({ ...base, options: {} });
  assert.deepEqual(refused, { ok: false, reason: "Policy: No YOLO here." });
  assert.deepEqual(requests.map((request) => [request.pluginId, request.params.chosen, request.params.options]), [["a.policy", false, {}]]);

  requests.length = 0;
  const chosen = await pipeline.prepare({ ...base, profile: "normal", options: { "b.option": { on: true } } });
  assert.equal(chosen.ok, true);
  await chosen.cleanup();
  assert.deepEqual(requests.map((request) => [request.pluginId, request.params.chosen]).sort(), [["a.policy", false], ["b.option", true]]);

  // A policy the person also chose is asked once, as chosen.
  requests.length = 0;
  (await pipeline.prepare({ ...base, profile: "normal", options: { "a.policy": {} } })).ok || assert.fail("normal launch refused");
  assert.deepEqual(requests.map((request) => [request.pluginId, request.params.chosen]), [["a.policy", true]]);

  answers["a.policy"] = () => ({ env: { SNEAKY: "1" } });
  assert.match((await pipeline.prepare({ ...base, profile: "normal", options: {} })).reason, /a policy may only refuse/u);
  answers["a.policy"] = () => new Promise(() => undefined);
  assert.match((await pipeline.prepare({ ...base, profile: "normal", options: {} })).reason, /did not answer its launch policy within 0\.3 s/u);
  answers["a.policy"] = () => { throw new Error("broken"); };
  assert.equal((await pipeline.prepare({ ...base, profile: "normal", options: {} })).ok, false, "an error refuses, never passes");
});

test("the yolo-guard example refuses YOLO launches over JSON-RPC", async (t) => {
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
  assert.match((await call({ ...context, profile: "yolo" })).refuse.reason, /YOLO launches are turned off/u);
  assert.equal(await call({ ...context, profile: "normal" }), null);
});

test("secrets.get: a service reads its own plugin's secret only with the permission", async (t) => {
  const source = await readFile(new URL("services/echo.mjs", echoExample), "utf8");
  const dir = join(root, "echo");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "echo.mjs"), source);
  const asked = [];
  const secrets = new Map([["com.example.service-echo/token", "echo-token-value-9d2f41"]]);
  const supervisor = new PluginServiceSupervisor({
    command: process.execPath, hostVersion: "9.9.9", locale: () => "en", stopGraceMs: 300,
    host: {
      storageGet: async () => null, storageSet: async () => undefined, emit: () => undefined,
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
  secrets.delete("com.example.service-echo/token");
  assert.deepEqual(await supervisor.request("com.example.service-echo", "echo", "token", null), { set: false });
});

test("a card waits for the launch policies that apply; a YOLO card is refused, terminals are not asked", async (t) => {
  const { TerminalManager } = await import("../src/main/services/TerminalManager.ts");
  const runsRoot = await mkdtemp(join(tmpdir(), "canvastty-points-manager-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const asked = [];
  const pipeline = new LaunchPipeline({
    contributors: () => [{ pluginId: "com.example.yolo-guard", pluginName: "YOLO Guard", serviceId: "guard", launch: { policy: true, fields: [] }, secrets: false }],
    call: async (_pluginId, _serviceId, _method, params) => {
      asked.push(params);
      return params.profile === "yolo" ? { refuse: { reason: "No YOLO here." } } : null;
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
  assert.match(manager.list().find((session) => session.id === yolo.id).failureDetails, /^Launch refused: YOLO Guard: No YOLO here\./u);
  assert.deepEqual({ chosen: asked[0].chosen, options: asked[0].options }, { chosen: false, options: {} });
  const normal = manager.create({ provider: "claude", profile: "normal", cwd: project, position: at });
  await waitFor(() => calls.length === 1);
  assert.equal(manager.list().find((session) => session.id === normal.id).status !== "failed", true);
  manager.create({ provider: "terminal", profile: "normal", cwd: project, position: at });
  assert.equal(calls.length, 2, "a terminal launches at once");
  assert.equal(asked.length, 2);
});
