import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginManager, validatePluginManifest } from "../src/main/services/PluginManager.ts";
import { PluginServiceSupervisor } from "../src/main/services/PluginServiceSupervisor.ts";
import {
  PluginSharedReads,
  SHARED_READ_MAX_RESULT_BYTES,
  SHARED_READ_PER_MINUTE,
  SHARED_READ_TIMEOUT_MS,
  SharedReadError
} from "../src/main/services/PluginSharedReads.ts";
import { PluginLimitActivity } from "../src/main/services/PluginLimitActivity.ts";
import { LimitsService } from "../src/main/services/LimitsService.ts";
import { SecretRedactionRegistry } from "../src/main/services/safety/SecretRedaction.ts";

const PROVIDER = "com.example.accounts";
const CONSUMER = "com.example.assistant";
const OTHER = "com.example.other";
const SECRET = "zz-fixture-provider-key-4f1c9a7e2b";

const providerManifest = (overrides = {}) => ({
  apiVersion: 2,
  id: PROVIDER,
  name: "Accounts",
  version: "1.0.0",
  description: "Shares routes.",
  permissions: [],
  contributions: [],
  services: [{
    id: "main",
    title: "Main",
    entry: "services/main.mjs",
    shares: [{ method: "accounts.routes", description: "Model routes and per-account quota.", dataClass: "D1" }]
  }],
  ...overrides
});

const consumerManifest = (overrides = {}) => ({
  apiVersion: 2,
  id: CONSUMER,
  name: "Assistant",
  version: "1.0.0",
  description: "Reads routes.",
  permissions: ["limits:read"],
  contributions: [],
  services: [{ id: "router", title: "Router", entry: "services/router.mjs" }],
  uses: [{ plugin: PROVIDER, method: "accounts.routes" }, { plugin: PROVIDER, method: "accounts.keys" }],
  ...overrides
});

const otherManifest = () => ({
  apiVersion: 2,
  id: OTHER,
  name: "Other",
  version: "1.0.0",
  description: "Declares nothing.",
  permissions: [],
  contributions: [],
  services: [{ id: "router", title: "Router", entry: "services/router.mjs" }]
});

/** Answers `canvastty.shares.read` by `params.mode`; `calls` lists what it was asked. */
const PROVIDER_SOURCE = `
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const calls = [];
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "calls") { send({ id: m.id, result: calls }); return; }
  if (m.method !== "canvastty.shares.read") return;
  calls.push(m.params);
  const mode = m.params.params && m.params.params.mode;
  if (mode === "secret") send({ id: m.id, result: { note: "key ${SECRET}" } });
  else if (mode === "big") send({ id: m.id, result: "x".repeat(${SHARED_READ_MAX_RESULT_BYTES + 10}) });
  else if (mode === "error") send({ id: m.id, error: { code: -32000, message: "internal detail 7731" } });
  else send({ id: m.id, result: { routes: [{ id: "glm-1", quota: { state: "ok", remainingPercent: 62 } }] } });
});
`;

/** `read` forwards its params as `plugins.request`; `activity` returns the activity notifications it got. */
const CONSUMER_SOURCE = `
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const waiting = new Map();
const activity = [];
let next = 1;
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "read") { const id = 10000 + next++; waiting.set(id, m.id); send({ id, method: "plugins.request", params: m.params }); return; }
  if (m.method === "canvastty.activity") { activity.push(m.params); return; }
  if (m.method === "activity") { send({ id: m.id, result: activity }); return; }
  if (!m.method && waiting.has(m.id)) {
    const asked = waiting.get(m.id);
    waiting.delete(m.id);
    send({ id: asked, result: m.error ? { error: m.error } : { result: m.result } });
  }
});
`;

const packages = {
  [`https://github.com/example/${PROVIDER}`]: () => ({ manifest: providerManifest(), files: { "services/main.mjs": PROVIDER_SOURCE } }),
  [`https://github.com/example/${CONSUMER}`]: () => ({ manifest: consumerManifest(), files: { "services/router.mjs": CONSUMER_SOURCE } }),
  [`https://github.com/example/${OTHER}`]: () => ({ manifest: otherManifest(), files: { "services/router.mjs": CONSUMER_SOURCE } })
};

async function managerWith(userData, served = packages) {
  const manager = new PluginManager(userData, async (url, destination) => {
    const key = Object.keys(served).find((candidate) => candidate.toLowerCase() === String(url).toLowerCase().replace(/\.git$/, ""));
    if (!key) throw new Error(`No fixture for ${url}`);
    const pkg = served[key]();
    await mkdir(join(destination, "services"), { recursive: true });
    await writeFile(join(destination, "canvastty.plugin.json"), JSON.stringify(pkg.manifest));
    for (const [path, content] of Object.entries(pkg.files)) await writeFile(join(destination, path), content);
  });
  await manager.load();
  return manager;
}

const install = async (manager, id) => manager.install((await manager.previewInstall(`https://github.com/example/${id}`)).token);

test("manifest: shares on services and top-level uses are validated", () => {
  const provider = validatePluginManifest(providerManifest());
  assert.deepEqual(provider.services[0].shares, [{ method: "accounts.routes", description: "Model routes and per-account quota.", dataClass: "D1" }]);
  const consumer = validatePluginManifest(consumerManifest());
  assert.equal(consumer.uses.length, 2);
  const share = providerManifest().services[0];
  const withShares = (shares) => providerManifest({ services: [{ ...share, shares }] });
  assert.throws(() => validatePluginManifest(withShares([{ method: "Accounts.Routes", description: "x" }])), /lowercase words/);
  assert.throws(() => validatePluginManifest(withShares([{ method: "canvastty.limits", description: "x" }])), /lowercase words/);
  assert.throws(() => validatePluginManifest(withShares([{ method: "a.b", description: "" }])), /share description/);
  assert.throws(() => validatePluginManifest(withShares([{ method: "a.b", description: "x", dataClass: "secret" }])), /D0, D1, D2 or D3/);
  assert.throws(() => validatePluginManifest(withShares([{ method: "a.b", description: "x", write: true }])), /unknown field/);
  assert.throws(() => validatePluginManifest(withShares([])), /between 1 and 16/);
  assert.throws(() => validatePluginManifest(providerManifest({ services: [
    { ...share }, { ...share, id: "second", entry: "services/second.mjs" }
  ] })), /unique across its services/);
  assert.throws(() => validatePluginManifest(consumerManifest({ uses: [{ plugin: CONSUMER, method: "a.b" }] })), /its own shares/);
  assert.throws(() => validatePluginManifest(consumerManifest({ uses: [{ plugin: PROVIDER, method: "a.b" }, { plugin: PROVIDER, method: "a.b" }] })), /duplicated/);
  assert.throws(() => validatePluginManifest(consumerManifest({ uses: [{ plugin: "Not An Id", method: "a.b" }] })), /another plugin/);
  assert.throws(() => validatePluginManifest(consumerManifest({ uses: [{ plugin: PROVIDER, method: "a.b", write: true }] })), /unknown field/);
  assert.throws(() => validatePluginManifest(consumerManifest({ services: undefined, contributions: [{ id: "w", kind: "home-widget", title: "W", entry: "w.html", defaultSize: { columns: 2, rows: 2 } }] })), /need a service/);
  assert.throws(() => validatePluginManifest({ ...consumerManifest({ services: undefined }), apiVersion: 1, contributions: [{ id: "w", kind: "home-widget", title: "W", entry: "w.html", defaultSize: { columns: 2, rows: 2 } }] }), /require apiVersion 2/);
});

test("approvals: each pair is approved by the person, needs trust, is pinned to what the provider said, and ends with removal", async () => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-shared-reads-"));
  const manager = await managerWith(userData);
  try {
    await install(manager, CONSUMER);
    await manager.setNativeCodeTrusted(CONSUMER, true);
    // The provider is not installed: the pair is not shared, and cannot be approved.
    assert.deepEqual(manager.sharedReadRoute(CONSUMER, PROVIDER, "accounts.routes"), { ok: false, reason: "not_shared" });
    await assert.rejects(manager.setSharedReadApproved(CONSUMER, PROVIDER, "accounts.routes", true), /does not share/);

    await install(manager, PROVIDER);
    // Installing both grants nothing.
    assert.deepEqual(manager.sharedReadRoute(CONSUMER, PROVIDER, "accounts.routes"), { ok: false, reason: "not_approved" });
    const listed = manager.list().find((plugin) => plugin.manifest.id === CONSUMER);
    assert.deepEqual(listed.sharedReads.map((read) => [read.method, read.state]), [["accounts.routes", "needs-approval"], ["accounts.keys", "not-shared"]]);
    assert.equal(listed.sharedReads[0].providerReady, false);
    // A method the provider does not share cannot be approved or routed, even though the consumer declares it.
    await assert.rejects(manager.setSharedReadApproved(CONSUMER, PROVIDER, "accounts.keys", true), /does not share/);
    assert.deepEqual(manager.sharedReadRoute(CONSUMER, PROVIDER, "accounts.keys"), { ok: false, reason: "not_shared" });
    // A pair the consumer does not declare.
    await assert.rejects(manager.setSharedReadApproved(CONSUMER, PROVIDER, "accounts.other", true), /does not declare/);
    assert.deepEqual(manager.sharedReadRoute(CONSUMER, PROVIDER, "accounts.other"), { ok: false, reason: "not_declared" });

    const approved = await manager.setSharedReadApproved(CONSUMER, PROVIDER, "accounts.routes", true);
    assert.equal(approved.sharedReads[0].state, "approved");
    // The provider's native code is still off.
    assert.deepEqual(manager.sharedReadRoute(CONSUMER, PROVIDER, "accounts.routes"), { ok: false, reason: "provider_unavailable" });
    await manager.setNativeCodeTrusted(PROVIDER, true);
    assert.deepEqual(manager.sharedReadRoute(CONSUMER, PROVIDER, "accounts.routes"), { ok: true, serviceId: "main", providerName: "Accounts", dataClass: "D1" });

    // Survives a restart.
    const reloaded = await managerWith(userData);
    assert.deepEqual(reloaded.sharedReadRoute(CONSUMER, PROVIDER, "accounts.routes").ok, true);
    await reloaded.dispose();

    // Disabling the provider stops the pair; enabling it again needs its trust again, not a new approval.
    await manager.setEnabled(PROVIDER, false);
    assert.deepEqual(manager.sharedReadRoute(CONSUMER, PROVIDER, "accounts.routes"), { ok: false, reason: "provider_unavailable" });
    await manager.setEnabled(PROVIDER, true);
    await manager.setNativeCodeTrusted(PROVIDER, true);
    assert.equal(manager.sharedReadRoute(CONSUMER, PROVIDER, "accounts.routes").ok, true);

    // The provider changes what it says it shares (an update, here on disk before a restart): suspended.
    const manifestPath = join(userData, "plugins", PROVIDER, "canvastty.plugin.json");
    const original = await readFile(manifestPath, "utf8");
    const changed = providerManifest();
    changed.services[0].shares[0].description = "Model routes, quota and account labels.";
    await writeFile(manifestPath, JSON.stringify(changed));
    const afterChange = await managerWith(userData);
    assert.deepEqual(afterChange.sharedReadRoute(CONSUMER, PROVIDER, "accounts.routes"), { ok: false, reason: "approval_changed" });
    assert.equal(afterChange.list().find((plugin) => plugin.manifest.id === CONSUMER).sharedReads[0].state, "changed");
    await afterChange.dispose();
    await writeFile(manifestPath, original);

    // Turning the consumer's native code off (or an update, a module change, disabling it) removes its approvals.
    await manager.setNativeCodeTrusted(CONSUMER, false);
    assert.deepEqual(manager.sharedReadRoute(CONSUMER, PROVIDER, "accounts.routes"), { ok: false, reason: "consumer_unavailable" });
    await manager.setNativeCodeTrusted(CONSUMER, true);
    assert.deepEqual(manager.sharedReadRoute(CONSUMER, PROVIDER, "accounts.routes"), { ok: false, reason: "not_approved" });
    await manager.setEnabled(CONSUMER, false);
    await assert.rejects(manager.setSharedReadApproved(CONSUMER, PROVIDER, "accounts.routes", true), /disabled/);
    await manager.setEnabled(CONSUMER, true);
    await assert.rejects(manager.setSharedReadApproved(CONSUMER, PROVIDER, "accounts.routes", true), /native code first/);
    await manager.setNativeCodeTrusted(CONSUMER, true);
    await manager.setSharedReadApproved(CONSUMER, PROVIDER, "accounts.routes", true);
    assert.equal(manager.sharedReadRoute(CONSUMER, PROVIDER, "accounts.routes").ok, true);

    // Uninstalling the provider drops the approval; installing it again asks again.
    await manager.uninstall(PROVIDER);
    const registry = JSON.parse(await readFile(join(userData, "plugins.json"), "utf8"));
    assert.equal(registry[CONSUMER].approvedShares?.[`${PROVIDER} accounts.routes`], undefined);
    await install(manager, PROVIDER);
    await manager.setNativeCodeTrusted(PROVIDER, true);
    assert.deepEqual(manager.sharedReadRoute(CONSUMER, PROVIDER, "accounts.routes"), { ok: false, reason: "not_approved" });

    // A plugin that declares no use is refused.
    await install(manager, OTHER);
    await manager.setNativeCodeTrusted(OTHER, true);
    assert.deepEqual(manager.sharedReadRoute(OTHER, PROVIDER, "accounts.routes"), { ok: false, reason: "not_declared" });
  } finally {
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
  }
});

/** A PluginSharedReads with an approved route and a fake provider call. */
function reads({ answer = async () => ({ routes: [] }), route, running = () => true, now } = {}) {
  const audit = [];
  const calls = [];
  const redaction = new SecretRedactionRegistry();
  redaction.add(`plugin:${PROVIDER}`, [SECRET]);
  const instance = new PluginSharedReads({
    route: route ?? (() => ({ ok: true, serviceId: "main", providerName: "Accounts", dataClass: "D1" })),
    running,
    call: async (pluginId, serviceId, params, timeoutMs) => {
      calls.push({ pluginId, serviceId, params, timeoutMs });
      return answer(params);
    },
    containsSecret: (text) => redaction.redact(text) !== text,
    audit: (pluginId, serviceId, level, message) => audit.push({ pluginId, serviceId, level, message }),
    ...(now ? { now } : {})
  });
  const ask = (params) => instance.handle(CONSUMER, "router", "plugins.request", params);
  return { instance, ask, audit, calls };
}

const reasonOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SharedReadError, String(error));
    return error.reason;
  }
  return "resolved";
};

test("routing: the answer is passed on with the provider's data class; the provider learns only the caller and params", async () => {
  const { ask, calls, audit, instance } = reads({ answer: async () => ({ routes: [{ id: "glm-1" }] }) });
  assert.equal(instance.handle(CONSUMER, "router", "plugins.write", {}), undefined, "only plugins.request is answered");
  const result = await ask({ plugin: PROVIDER, method: "accounts.routes", params: { provider: "codex" } });
  assert.deepEqual(result, { plugin: PROVIDER, method: "accounts.routes", dataClass: "D1", data: { routes: [{ id: "glm-1" }] } });
  assert.deepEqual(calls, [{
    pluginId: PROVIDER, serviceId: "main", timeoutMs: SHARED_READ_TIMEOUT_MS,
    params: { caller: { pluginId: CONSUMER }, method: "accounts.routes", params: { provider: "codex" } }
  }]);
  assert.equal(SHARED_READ_TIMEOUT_MS, 5_000);
  // Both plugins' logs get one line each, with hashes and sizes only.
  assert.equal(audit.length, 2);
  for (const line of audit) {
    assert.match(line.message, /ok · \d+ ms · params sha256:[0-9a-f]{16} · answer \d+ bytes sha256:[0-9a-f]{16}/);
    assert.doesNotMatch(line.message, /codex|glm-1/);
  }
});

test("refusals: invalid requests, routes the registry refuses, a stopped provider", async () => {
  const { ask, calls } = reads();
  for (const params of [null, [], "x", { plugin: PROVIDER }, { method: "a.b" }, { plugin: PROVIDER, method: "a.b", extra: 1 },
    { plugin: PROVIDER, method: "a.b", params: { blob: "x".repeat(17 * 1024) } }]) {
    assert.equal(await reasonOf(ask(params)), "invalid_request");
  }
  for (const reason of ["consumer_unavailable", "not_declared", "not_shared", "not_approved", "approval_changed", "provider_unavailable"]) {
    const refused = reads({ route: () => ({ ok: false, reason }) });
    assert.equal(await reasonOf(refused.ask({ plugin: PROVIDER, method: "accounts.routes" })), reason);
    assert.equal(refused.calls.length, 0, `${reason}: the provider is never asked`);
  }
  const stopped = reads({ running: () => false });
  assert.equal(await reasonOf(stopped.ask({ plugin: PROVIDER, method: "accounts.routes" })), "provider_unavailable");
  assert.equal(stopped.calls.length, 0);
  assert.equal(calls.length, 0);
});

test("answers: a secret, an answer over 256 KB, a timeout and a provider error are refused without passing anything on", async () => {
  const secret = reads({ answer: async () => ({ note: `key ${SECRET}` }) });
  assert.equal(await reasonOf(secret.ask({ plugin: PROVIDER, method: "accounts.routes" })), "secret_in_response");
  assert.ok(secret.audit.every((line) => !line.message.includes(SECRET)));
  // Generic credential shapes count too, also when the provider never registered them.
  const shaped = reads({ answer: async () => ({ header: "Bearer abcdefghijklmnopqrstuvwxyz0123456789" }) });
  assert.equal(await reasonOf(shaped.ask({ plugin: PROVIDER, method: "accounts.routes" })), "secret_in_response");
  const keyed = reads({ answer: async () => ({ apiKey: "named-key" }) });
  assert.equal(await reasonOf(keyed.ask({ plugin: PROVIDER, method: "accounts.routes" })), "secret_in_response");

  const exact = reads({ answer: async () => "x".repeat(SHARED_READ_MAX_RESULT_BYTES - 2) });
  assert.equal((await exact.ask({ plugin: PROVIDER, method: "accounts.routes" })).data.length, SHARED_READ_MAX_RESULT_BYTES - 2);
  const big = reads({ answer: async () => "x".repeat(SHARED_READ_MAX_RESULT_BYTES - 1) });
  assert.equal(await reasonOf(big.ask({ plugin: PROVIDER, method: "accounts.routes" })), "too_large");

  const slow = reads({ answer: async () => { throw new Error("Plugin service request timed out."); } });
  assert.equal(await reasonOf(slow.ask({ plugin: PROVIDER, method: "accounts.routes" })), "timeout");
  const failing = reads({ answer: async () => { throw new Error("internal detail 7731"); } });
  const error = await failing.ask({ plugin: PROVIDER, method: "accounts.routes" }).catch((caught) => caught);
  assert.equal(error.reason, "provider_error");
  assert.doesNotMatch(error.message, /7731/, "the provider's error text is not handed to the consumer");
});

test("a pair revoked while the provider answers gets nothing", async () => {
  let approved = true;
  const { ask } = reads({
    route: () => approved ? { ok: true, serviceId: "main", providerName: "Accounts" } : { ok: false, reason: "not_approved" },
    answer: async () => { approved = false; return { routes: [] }; }
  });
  assert.equal(await reasonOf(ask({ plugin: PROVIDER, method: "accounts.routes" })), "not_approved");
});

test("rate limits: 60 reads per minute per pair, 4 open per pair, 8 open per provider", async () => {
  let clock = 1_000_000;
  const limited = reads({ now: () => clock });
  for (let index = 0; index < SHARED_READ_PER_MINUTE; index += 1) await limited.ask({ plugin: PROVIDER, method: "accounts.routes" });
  assert.equal(await reasonOf(limited.ask({ plugin: PROVIDER, method: "accounts.routes" })), "rate_limited");
  assert.equal(await reasonOf(limited.ask({ plugin: PROVIDER, method: "accounts.routes" })), "rate_limited");
  assert.equal(limited.calls.length, SHARED_READ_PER_MINUTE);
  assert.equal(limited.audit.filter((line) => /rate_limited/.test(line.message)).length, 1, "one log line per minute, not one per refusal");
  clock += 60_001;
  await limited.ask({ plugin: PROVIDER, method: "accounts.routes" });

  const releases = [];
  const open = reads({ answer: () => new Promise((resolve) => releases.push(() => resolve({}))) });
  const pending = [1, 2, 3, 4].map(() => open.ask({ plugin: PROVIDER, method: "accounts.routes" }));
  assert.equal(await reasonOf(open.ask({ plugin: PROVIDER, method: "accounts.routes" })), "busy");
  // Another pair to the same provider still has room up to the provider's 8.
  const other = (method) => open.instance.handle(OTHER, "router", "plugins.request", { plugin: PROVIDER, method });
  const more = [other("a.one"), other("a.one"), other("a.two"), other("a.two")];
  assert.equal(await reasonOf(other("a.three")), "busy");
  while (releases.length) releases.shift()();
  await Promise.all([...pending, ...more]);
  // All released: the pair has room again.
  const again = open.ask({ plugin: PROVIDER, method: "accounts.routes" });
  releases.shift()();
  await again;
});

test("end to end: two real services, routed only for the approved pair", async (t) => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-shared-reads-e2e-"));
  const manager = await managerWith(userData);
  const redaction = new SecretRedactionRegistry();
  let supervisor = null;
  const shared = new PluginSharedReads({
    route: (consumer, provider, method) => manager.sharedReadRoute(consumer, provider, method),
    running: (pluginId, serviceId) => supervisor.running(pluginId, serviceId),
    call: (pluginId, serviceId, params, timeoutMs) => supervisor.hostCall(pluginId, serviceId, "canvastty.shares.read", params, timeoutMs),
    containsSecret: (text) => redaction.redact(text) !== text,
    audit: (pluginId, serviceId, level, message) => supervisor.audit(pluginId, serviceId, level, message)
  });
  supervisor = new PluginServiceSupervisor({
    command: process.execPath,
    hostVersion: "9.9.9",
    locale: () => "en",
    requestTimeoutMs: 8_000,
    stopGraceMs: 300,
    host: {
      storageGet: async () => null,
      storageSet: async () => undefined,
      emit: () => undefined,
      registerSecrets: (pluginId, values) => redaction.add(`plugin:${pluginId}`, values),
      plugins: (pluginId, serviceId, method, params) => shared.handle(pluginId, serviceId, method, params)
    }
  });
  manager.setServiceObserver((specs) => supervisor.sync(specs));
  t.after(async () => {
    await supervisor.dispose();
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
  });
  await install(manager, PROVIDER);
  await install(manager, CONSUMER);
  await install(manager, OTHER);
  await manager.setNativeCodeTrusted(PROVIDER, true);
  await manager.setNativeCodeTrusted(CONSUMER, true);
  await manager.setNativeCodeTrusted(OTHER, true);
  const read = (pluginId, params) => supervisor.request(pluginId, "router", "read", params);
  const routes = { plugin: PROVIDER, method: "accounts.routes", params: { mode: "ok" } };

  // Not approved yet; never declared; a method the provider does not share.
  assert.equal((await read(CONSUMER, routes)).error.data.reason, "not_approved");
  assert.equal((await read(OTHER, routes)).error.data.reason, "not_declared");
  assert.equal((await read(CONSUMER, { plugin: PROVIDER, method: "accounts.keys" })).error.data.reason, "not_shared");
  assert.deepEqual(await supervisor.request(PROVIDER, "main", "calls", {}), [], "the provider was never asked");
  // A surface (or anyone outside the host) cannot send the host-only method.
  await assert.rejects(supervisor.request(PROVIDER, "main", "canvastty.shares.read", {}), /invalid/);

  await manager.setSharedReadApproved(CONSUMER, PROVIDER, "accounts.routes", true);
  const ok = await read(CONSUMER, routes);
  assert.deepEqual(ok.result, {
    plugin: PROVIDER, method: "accounts.routes", dataClass: "D1",
    data: { routes: [{ id: "glm-1", quota: { state: "ok", remainingPercent: 62 } }] }
  });
  assert.deepEqual(await supervisor.request(PROVIDER, "main", "calls", {}), [
    { caller: { pluginId: CONSUMER }, method: "accounts.routes", params: { mode: "ok" } }
  ]);
  // OTHER is still refused although CONSUMER is approved: approvals are per pair.
  assert.equal((await read(OTHER, routes)).error.data.reason, "not_declared");

  // The provider's own secret (as registered when it read it) is never passed on.
  redaction.add(`plugin:${PROVIDER}`, [SECRET]);
  const secret = await read(CONSUMER, { ...routes, params: { mode: "secret" } });
  assert.equal(secret.error.data.reason, "secret_in_response");
  assert.doesNotMatch(JSON.stringify(secret), new RegExp(SECRET));
  assert.equal((await read(CONSUMER, { ...routes, params: { mode: "big" } })).error.data.reason, "too_large");
  const failed = await read(CONSUMER, { ...routes, params: { mode: "error" } });
  assert.equal(failed.error.data.reason, "provider_error");
  assert.doesNotMatch(JSON.stringify(failed), /7731/);

  // The logs of both plugins hold hashes, never the data or the secret.
  for (const id of [PROVIDER, CONSUMER]) {
    const lines = supervisor.report(id).log.filter((entry) => /Shared read/.test(entry.message)).map((entry) => entry.message);
    assert.ok(lines.length >= 4, id);
    assert.ok(lines.every((line) => !line.includes(SECRET) && !line.includes("glm-1") && !line.includes("mode")), id);
  }

  // limit.exhausted goes to the services of plugins with limits:read only (CONSUMER has it, OTHER does not).
  const activity = new PluginLimitActivity({
    services: () => manager.trustedServiceSpecs(),
    allowed: (pluginId) => manager.hasPermission(pluginId, "limits:read"),
    notify: (pluginId, serviceId, method, params) => supervisor.notify(pluginId, serviceId, method, params)
  });
  activity.observe({ provider: "codex", state: "available", source: "app-server", fetchedAt: 1, windows: [{
    id: "codex:primary", bucketId: "codex", slot: "primary", isDefaultBucket: true, label: null,
    usedPercent: 100, used: null, limit: null, windowMinutes: 300, resetsAt: 1_900_000_000_000
  }] });
  const consumerActivity = await supervisor.request(CONSUMER, "router", "activity", {});
  assert.deepEqual(consumerActivity.map((event) => [event.type, event.provider, event.resetAt]), [["limit.exhausted", "codex", 1_900_000_000_000]]);
  assert.deepEqual(await supervisor.request(OTHER, "router", "activity", {}), []);

  // Disabling the provider stops the pair at once; so does revoking the consumer's approval.
  await manager.setEnabled(PROVIDER, false);
  assert.equal((await read(CONSUMER, routes)).error.data.reason, "provider_unavailable");
  await manager.setEnabled(PROVIDER, true);
  await manager.setNativeCodeTrusted(PROVIDER, true);
  assert.ok((await read(CONSUMER, routes)).result);
  await manager.setSharedReadApproved(CONSUMER, PROVIDER, "accounts.routes", false);
  assert.equal((await read(CONSUMER, routes)).error.data.reason, "not_approved");
});

const window = (overrides = {}) => ({
  id: "claude:five_hour", bucketId: "claude", slot: "primary", isDefaultBucket: true, label: "5 h",
  usedPercent: 100, used: null, limit: null, windowMinutes: 300, resetsAt: 1_900_000_000_000, ...overrides
});
const snapshot = (windows, provider = "claude") => ({ provider, state: "available", source: "oauth", fetchedAt: 1, windows });

test("limit.exhausted reaches only services of plugins that hold limits:read, once per exhaustion", () => {
  const sent = [];
  // `blind` passes the registry check but its running service's manifest has no limits:read; `stale` the reverse.
  let allowed = new Set(["com.example.reader", "com.example.blind"]);
  const activity = new PluginLimitActivity({
    services: () => [
      { pluginId: "com.example.reader", serviceId: "a", permissions: ["limits:read"] },
      { pluginId: "com.example.reader", serviceId: "b", permissions: ["limits:read", "storage"] },
      { pluginId: "com.example.blind", serviceId: "a", permissions: ["storage"] },
      { pluginId: "com.example.stale", serviceId: "a", permissions: ["limits:read"] }
    ],
    allowed: (pluginId) => allowed.has(pluginId),
    notify: (pluginId, serviceId, method, params) => { sent.push({ pluginId, serviceId, method, params }); return true; },
    now: () => 42
  });
  activity.observe(snapshot([window({ usedPercent: 80 })]));
  assert.equal(sent.length, 0);
  activity.observe(snapshot([window(), window({ id: "claude:extra", isDefaultBucket: false })]));
  assert.deepEqual(sent.map(({ pluginId, serviceId }) => `${pluginId}/${serviceId}`), ["com.example.reader/a", "com.example.reader/b"]);
  assert.deepEqual(sent[0], {
    pluginId: "com.example.reader", serviceId: "a", method: "canvastty.activity",
    params: { type: "limit.exhausted", at: 42, provider: "claude", accountId: "default",
      window: { id: "claude:five_hour", label: "5 h", windowMinutes: 300 }, resetAt: 1_900_000_000_000 }
  });
  // Still used up on the next read: no new event. Another provider's read does not clear it.
  activity.observe(snapshot([window()]));
  activity.observe(snapshot([], "codex"));
  activity.observe({ provider: "claude", state: "stale", reason: "x" });
  assert.equal(sent.length, 2);
  // Room again, then used up again: a new event, and a plugin that lost the permission no longer gets it.
  activity.observe(snapshot([window({ usedPercent: 10 })]));
  allowed = new Set();
  activity.observe(snapshot([window({ resetsAt: null })]));
  assert.equal(sent.length, 2);
  activity.observe(snapshot([window({ usedPercent: 10 })]));
  allowed = new Set(["com.example.reader", "com.example.blind"]);
  activity.observe(snapshot([window({ resetsAt: null })]));
  assert.equal(sent.length, 4);
  assert.equal("resetAt" in sent[3].params, false);
});

test("limit.exhausted follows a real LimitsService read and carries nothing about the account", async () => {
  const grokHome = await mkdtemp(join(tmpdir(), "canvastty-grok-exhausted-"));
  const originalFetch = globalThis.fetch;
  const previousGrokHome = process.env.GROK_HOME;
  const service = new LimitsService({
    get(provider) {
      if (provider === "grok") return { state: "available", provider, executable: "/resolved/grok", launcher: "native", environment: {}, checked: [] };
      return { state: "unavailable", provider, reason: "cli-not-found", checked: [], diagnostic: "" };
    }
  }, "test");
  const sent = [];
  const activity = new PluginLimitActivity({
    services: () => [{ pluginId: "com.example.reader", serviceId: "a", permissions: ["limits:read"] }],
    allowed: () => true,
    notify: (pluginId, serviceId, method, params) => { sent.push(params); return true; }
  });
  const stop = service.onProviderRead((value) => activity.observe(value));
  try {
    await writeFile(join(grokHome, "auth.json"), JSON.stringify({ "https://auth.x.ai::client": { key: "fixture-grok-token", auth_mode: "oidc", refresh_token: "fixture-refresh", email: "fixture@example.invalid" } }), "utf8");
    process.env.GROK_HOME = grokHome;
    globalThis.fetch = async () => Response.json({
      config: { creditUsagePercent: 100, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-21T06:16:11Z", end: "2026-09-28T06:16:11Z" } }
    });
    const grok = (await service.get()).providers.find(({ provider }) => provider === "grok");
    assert.equal(grok.state, "available");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "limit.exhausted");
    assert.equal(sent[0].provider, "grok");
    assert.equal(sent[0].accountId, "default");
    assert.doesNotMatch(JSON.stringify(sent), /fixture-grok-token|fixture-refresh|fixture@example/);
    // A cached answer is not a read: no second event.
    await service.get();
    assert.equal(sent.length, 1);
  } finally {
    stop();
    service.dispose();
    globalThis.fetch = originalFetch;
    if (previousGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousGrokHome;
    await rm(grokHome, { recursive: true, force: true });
  }
});

