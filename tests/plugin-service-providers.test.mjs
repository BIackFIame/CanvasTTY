import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginManager, validatePluginManifest } from "../src/main/services/PluginManager.ts";
import { PluginServiceSupervisor } from "../src/main/services/PluginServiceSupervisor.ts";
import { listProviderDirectory, providerListForPlugin } from "../src/main/services/providerDirectory.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { AGENT_PROVIDERS } from "../src/shared/contracts.ts";

const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Condition was not met in time.");
};

// Fixture values that must never reach a plugin: a token, an e-mail, an account fingerprint and private paths.
const TOKEN = "fixture-bearer-4f2a9c0b7e1d";
const EMAIL = "person@example.invalid";
const ACCOUNT = "acct-fingerprint-91c3";
const HOME_PATH = "/Users/fixture-person";
const EXECUTABLE = `${HOME_PATH}/.local/bin/codex`;

/** The provider CLI registry as it resolves on a computer: paths and environments the directory must not pass on. */
function registry() {
  return {
    get(provider) {
      if (provider === "cursor") return { state: "unavailable", provider, checked: [`${HOME_PATH}/bin/cursor`] };
      return { state: "available", provider, executable: EXECUTABLE, launcher: "native",
        environment: { PATH: `${HOME_PATH}/bin`, OPENAI_API_KEY: TOKEN }, checked: [EXECUTABLE] };
    }
  };
}

/** Sources wired as index.ts wires them (cli state only, peeked limits and models, trusted contributors). */
function sources() {
  const clis = registry();
  return {
    cli: (provider) => clis.get(provider).state,
    limits: () => ({
      fetchedAt: 1_000,
      providers: [
        { provider: "codex", state: "available", source: "app-server", fetchedAt: 1_000, accountScope: ACCOUNT,
          windows: [{ id: "w", bucketId: "b", slot: "primary", isDefaultBucket: true, label: EMAIL, usedPercent: 40, used: null,
            limit: null, windowMinutes: 300, resetsAt: 9_000 }] },
        { provider: "claude", state: "unavailable", source: "oauth", checkedAt: 2_000, reason: "not-authenticated" },
        { provider: "grok", state: "stale", source: "oauth", fetchedAt: 500, failedAt: 2_500, reason: "session-expired",
          windows: [], accountScope: ACCOUNT }
      ]
    }),
    models: (provider) => (provider === "opencode" ? { models: ["openrouter/vendor-model"], checkedAt: 3_000 } : null),
    launchContributors: () => [{
      pluginId: "com.example.accounts",
      pluginName: "Accounts",
      launch: {
        delegable: true,
        appliesTo: ["codex", "claude"],
        fields: [{ key: "account", kind: "select", label: `Account of ${EMAIL}`, description: TOKEN,
          options: [{ value: "work", label: EMAIL }, { value: "home", label: HOME_PATH }] }]
      }
    }, {
      // Not delegable: an orchestrator does not see it, and neither does a service.
      pluginId: "com.example.private",
      pluginName: "Private",
      launch: { fields: [{ key: "secret-route", kind: "text", label: TOKEN }] }
    }],
    containment: () => false
  };
}

/** Asks the host for `method` and answers `ask` with the host's reply (result or error). */
const ASKER = `
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const waiting = new Map();
let next = 900;
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "ask") {
    const id = next++;
    waiting.set(id, m.id);
    send({ id, method: m.params.method, params: m.params.params ?? {} });
    return;
  }
  if (!m.method && waiting.has(m.id)) {
    const asked = waiting.get(m.id);
    waiting.delete(m.id);
    send({ id: asked, result: m.error ? { error: m.error } : { result: m.result } });
  }
});
`;

async function askerSpec(root, pluginId, permissions) {
  const dir = join(root, pluginId);
  await mkdir(dir, { recursive: true });
  const entryPath = join(dir, "asker.mjs");
  await writeFile(entryPath, ASKER);
  return { pluginId, serviceId: "asker", root: dir, entryPath, sha256: sha256(ASKER), dataDir: join(dir, "data"), permissions };
}

function supervisorWith(providers) {
  return new PluginServiceSupervisor({
    command: process.execPath,
    hostVersion: "9.9.9",
    locale: () => "en",
    requestTimeoutMs: 3_000,
    stopGraceMs: 300,
    host: { storageGet: async () => null, storageSet: async () => undefined, emit: () => undefined, providers }
  });
}

const ask = (instance, pluginId, method, params) => instance.request(pluginId, "asker", "ask", { method, params });

/** An orchestrator card, the way list_providers sees its caller. */
function orchestratorHandler(directorySources) {
  const clis = { get: (provider) => ({ state: "available", provider, executable: "/resolved", launcher: "native", environment: {}, checked: [] }), snapshot: () => ({}) };
  const spawn = () => ({ pid: 1, process: "x", write() {}, resize() {}, kill() {}, pause() {}, resume() {},
    onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; } });
  const terminals = new TerminalManager(() => undefined, clis, undefined, undefined, true, spawn);
  const orchestrator = terminals.create({ provider: "claude", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 }, role: "orchestrator" });
  return { handler: new ScopedOrchestrationHandler(new AgentControlService(terminals), null, directorySources), orchestratorId: orchestrator.id };
}

test("providers:read is a manifest permission the person sees at install review", async () => {
  const manifest = JSON.parse(await readFile(new URL("../examples/plugins/service-echo/canvastty.plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(validatePluginManifest({ ...manifest, permissions: ["providers:read"] }).permissions, ["providers:read"]);
  const schema = JSON.parse(await readFile(new URL("../docs/canvastty-plugin.schema.json", import.meta.url), "utf8"));
  assert.ok(JSON.stringify(schema).includes('"providers:read"'));
  const settings = await readFile(new URL("../src/renderer/src/features/plugins/PluginSettingsSection.tsx", import.meta.url), "utf8");
  // The label loads with Settings (PluginSettingsSection), not with the startup string table.
  const ru = /ru: \{[^}]*"providers:read": "([^"]+)"/u.exec(settings)?.[1];
  const en = /en: \{[^}]*"providers:read": "([^"]+)"/u.exec(settings)?.[1];
  assert.ok(ru && en, "ru and en labels");
  const i18n = await readFile(new URL("../src/renderer/src/lib/i18n.ts", import.meta.url), "utf8");
  assert.doesNotMatch(i18n, /permissionProvidersRead/u);
});

test("providers.list through a real service: refused without providers:read, the list_providers directory with it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-providers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directorySources = sources();
  const asked = [];
  const instance = supervisorWith((pluginId) => {
    asked.push(pluginId);
    return providerListForPlugin(pluginId, { allowed: () => true, sources: () => directorySources });
  });
  t.after(() => instance.dispose());
  await instance.sync([await askerSpec(root, "p.without", ["storage", "limits:read", "sessions:events"]), await askerSpec(root, "p.with", ["providers:read"])]);
  await waitFor(() => instance.running("p.without", "asker") && instance.running("p.with", "asker"));

  const refused = await ask(instance, "p.without", "providers.list");
  assert.equal(refused.error.code, -32000);
  assert.match(refused.error.message, /providers:read/u);
  assert.deepEqual(asked, [], "the host is not asked for a plugin without the permission");

  const answer = await ask(instance, "p.with", "providers.list");
  assert.deepEqual(asked, ["p.with"], "the host gets the plugin id from its own record");
  // Exactly what list_providers answers an orchestrator (with no plugin tools) from the same sources.
  const { handler, orchestratorId } = orchestratorHandler(directorySources);
  const listed = await handler.execute(orchestratorId, { id: "1", tool: "list_providers", arguments: {} });
  assert.deepEqual(answer.result, listed);
  assert.deepEqual(answer.result, JSON.parse(JSON.stringify(listProviderDirectory(directorySources))));
  assert.deepEqual(answer.result.providers.map((entry) => entry.id), [...AGENT_PROVIDERS]);

  const byId = Object.fromEntries(answer.result.providers.map((entry) => [entry.id, entry]));
  assert.equal(byId.codex.installed, true);
  assert.equal(byId.codex.signIn, "ok");
  assert.equal(byId.claude.signIn, "signed_out");
  assert.equal(byId.grok.signIn, "expired");
  assert.equal(byId.cursor.installed, false);
  assert.equal(byId.cursor.available, false);
  assert.deepEqual(byId.opencode.model.known, ["openrouter/vendor-model"]);
  assert.deepEqual(byId.codex.launchOptions, [{ pluginId: "com.example.accounts", plugin: "Accounts", fields: [{ key: "account", kind: "select", choices: ["work", "home"] }] }]);
  const allowedKeys = new Set(["id", "name", "installed", "available", "signIn", "signInCheckedAt", "subagent", "orchestrator",
    "model", "efforts", "profiles", "launchOptions"]);
  for (const entry of answer.result.providers) for (const key of Object.keys(entry)) assert.ok(allowedKeys.has(key), key);

  // Secret and path scan of the whole answer.
  const text = JSON.stringify(answer.result);
  for (const value of [TOKEN, EMAIL, ACCOUNT, HOME_PATH, EXECUTABLE, "secret-route", "com.example.private"]) {
    assert.equal(text.includes(value), false, `the answer contains ${value}`);
  }
  assert.doesNotMatch(text, /accountScope|token|e-?mail|password|apiKey|api_key|executable|environment|"checked"|"windows"|"usedPercent"/iu);
  assert.doesNotMatch(text, /(?:^|["\s])(?:\/Users\/|\/home\/|[A-Z]:\\\\)/u);
});

test("providers.list is refused for a disabled plugin and when the host has no provider hook", async (t) => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-providers-registry-"));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const source = join(userData, "source");
  await cp(new URL("../examples/plugins/service-echo/", import.meta.url), source, { recursive: true });
  const manifestPath = join(source, "canvastty.plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, permissions: [...manifest.permissions, "providers:read"] }));
  const manager = new PluginManager(userData, async (_url, destination) => { await cp(source, destination, { recursive: true }); });
  await manager.load();
  const installed = await manager.install((await manager.previewInstall("https://github.com/example/service-echo")).token);
  const pluginId = installed.manifest.id;
  const deps = { allowed: (id) => manager.hasPermission(id, "providers:read"), sources };
  assert.equal(providerListForPlugin(pluginId, deps).providers.length, AGENT_PROVIDERS.length);
  // Disabled: the registry refuses, even if an old process still had the permission in its manifest.
  await manager.setEnabled(pluginId, false);
  assert.throws(() => providerListForPlugin(pluginId, deps), /providers:read/u);
  assert.throws(() => providerListForPlugin("com.example.unknown", deps), /providers:read/u);
  // A plugin without the permission in the registry.
  assert.throws(() => providerListForPlugin(pluginId, { allowed: () => false, sources }), /providers:read/u);

  // A host without the hook answers as for any unknown method.
  const root = join(userData, "services");
  const bare = supervisorWith(undefined);
  t.after(() => bare.dispose());
  await bare.sync([await askerSpec(root, "p.bare", ["providers:read"])]);
  await waitFor(() => bare.running("p.bare", "asker"));
  const unknown = await ask(bare, "p.bare", "providers.list");
  assert.equal(unknown.error.code, -32601);
});

test("providers.list reads only caches: no CLI, limits or model read is awaited", () => {
  let limitsReads = 0;
  let modelReads = 0;
  const base = sources();
  const counted = {
    ...base,
    limits: () => { limitsReads += 1; return base.limits(); },
    models: (provider) => { modelReads += 1; return base.models(provider); },
    checkModel: () => { throw new Error("providers.list must not check a model"); }
  };
  const result = providerListForPlugin("p", { allowed: () => true, sources: () => counted });
  assert.equal(result instanceof Promise, false);
  assert.equal(limitsReads, 1);
  assert.ok(modelReads <= AGENT_PROVIDERS.length);
});

test("the main process answers providers.list from the list_providers sources, gated by the registry", async () => {
  const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
  assert.match(source, /providers: \(pluginId\) => providerListForPlugin\(pluginId, \{\s*allowed: \(id\) => pluginManager!\.hasPermission\(id, "providers:read"\),/u);
  assert.match(source, /pluginProviderSources = providerDirectorySources;/u);
  // The CLI source passes the registry state only, never the resolved executable or its environment.
  assert.match(source, /cli: \(provider\) => providerClis\?\.get\(provider\)\.state \?\? null,/u);
  assert.match(source, /limits: \(\) => limitsService\?\.peek\(\) \?\? null,/u);
  assert.match(source, /models: \(provider\) => providerModels\.peek\(provider\),/u);
});
