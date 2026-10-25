import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginManager, pluginTrustWidening, validatePluginManifest } from "../src/main/services/PluginManager.ts";

const ID = "com.example.assistant";
const PROVIDER = "com.example.accounts";
const REPO = `https://github.com/example/${ID}`;
const OTHER_REPO = `https://github.com/someone/${ID}`;
const PROVIDER_REPO = `https://github.com/example/${PROVIDER}`;

const assistant = (overrides = {}) => ({
  apiVersion: 2, id: ID, name: "Assistant", version: "1.0.0", description: "Routes.", contributions: [],
  permissions: ["sessions:launch", "decision:provide", "accounts:broker", "tools:agents"],
  uses: [{ plugin: PROVIDER, method: "accounts.routes" }],
  services: [{
    id: "main", title: "Main", entry: "services/main.mjs", decide: { events: ["pre-tool"] },
    tools: [{ name: "route", description: "Route", inputSchema: { type: "object" }, roles: ["orchestrator"] }]
  }],
  ...overrides
});
const provider = () => ({
  apiVersion: 2, id: PROVIDER, name: "Accounts", version: "1.0.0", description: "Accounts.", contributions: [], permissions: ["secrets"],
  services: [{ id: "accounts", title: "Accounts", entry: "services/accounts.mjs", brokerable: true,
    shares: [{ method: "accounts.routes", description: "Routes.", dataClass: "D1" }] }]
});

async function world(t) {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-trust-updates-"));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const packages = {
    [REPO]: { manifest: assistant(), code: "// v1\n" },
    [OTHER_REPO]: { manifest: assistant({ version: "9.0.0" }), code: "// fork\n" },
    [PROVIDER_REPO]: { manifest: provider(), code: "// accounts\n" }
  };
  const make = async () => {
    const manager = new PluginManager(userData, async (url, destination) => {
      const key = Object.keys(packages).find((candidate) => candidate.toLowerCase() === String(url).toLowerCase().replace(/\.git$/u, ""));
      if (!key) throw new Error(`No fixture for ${url}`);
      const pkg = packages[key];
      await mkdir(join(destination, "services"), { recursive: true });
      await writeFile(join(destination, "canvastty.plugin.json"), JSON.stringify(pkg.manifest));
      for (const service of pkg.manifest.services) await writeFile(join(destination, service.entry), pkg.code);
    });
    await manager.load();
    t.after(() => manager.dispose());
    return manager;
  };
  const manager = await make();
  await manager.install((await manager.previewInstall(PROVIDER_REPO)).token);
  await manager.install((await manager.previewInstall(REPO)).token);
  await manager.setNativeCodeTrusted(PROVIDER, true);
  await manager.setNativeCodeTrusted(ID, true);
  await manager.setMayStartOrchestrators(ID, true);
  await manager.setDecisionsMayAllow(ID, true);
  await manager.setSharedReadApproved(ID, PROVIDER, "accounts.routes", true);
  await manager.setBrokerGrant(ID, PROVIDER, "glm-1", "a".repeat(64));
  const audit = async () => (await readFile(join(userData, "plugin-audit.log"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const registry = async () => JSON.parse(await readFile(join(userData, "plugins.json"), "utf8"));
  return { manager, packages, make, audit, registry, view: () => manager.list().find((plugin) => plugin.manifest.id === ID) };
}

test("off by default: an update revokes native code trust and every confirmation, as before", async (t) => {
  const { manager, packages, view } = await world(t);
  assert.equal(view().trustUpdates, undefined);
  packages[REPO] = { manifest: assistant({ version: "1.1.0" }), code: "// v1.1\n" };
  const updated = await manager.updatePlugin(ID);
  assert.equal(updated.nativeCodeTrusted, false);
  assert.equal(updated.mayStartOrchestrators, false);
  assert.equal(updated.decisionsMayAllow, false);
  assert.equal(updated.trustKeptOnUpdate, undefined);
  assert.equal(manager.brokerGrant(ID, PROVIDER, "glm-1"), undefined);
  assert.equal(updated.sharedReads[0].state, "needs-approval");
});

test("opt-in needs native code trust and goes with it; trusting again does not bring it back", async (t) => {
  const { manager, view, registry } = await world(t);
  await manager.setNativeCodeTrusted(ID, false);
  await assert.rejects(manager.setTrustUpdates(ID, true), /native code first/u);
  await manager.setNativeCodeTrusted(ID, true);
  await manager.setTrustUpdates(ID, true);
  assert.equal(view().trustUpdates, true);
  assert.equal((await registry())[ID].trustUpdatesFrom, `${REPO}.git`);
  await manager.setNativeCodeTrusted(ID, false);
  await manager.setNativeCodeTrusted(ID, true);
  assert.equal(view().trustUpdates, undefined);
  assert.equal((await registry())[ID].trustUpdatesFrom, undefined);
});

test("on: an update from the same repository asking for nothing new keeps trust and confirmations, re-pinned to the new code", async (t) => {
  const { manager, packages, make, audit, view, registry } = await world(t);
  await manager.setTrustUpdates(ID, true);
  // New code, new texts, a narrower decision service, the same permissions and services.
  packages[REPO] = {
    manifest: assistant({
      version: "1.1.0", description: "Routes better.",
      services: [{ ...assistant().services[0], title: "Main service", decide: { events: ["pre-tool"], appliesTo: ["claude"] } }]
    }),
    code: "// v1.1 new code\n"
  };
  const updated = await manager.updatePlugin(ID);
  assert.equal(updated.manifest.version, "1.1.0");
  assert.equal(updated.nativeCodeTrusted, true);
  assert.equal(updated.mayStartOrchestrators, true);
  assert.equal(updated.decisionsMayAllow, true);
  assert.equal(updated.trustUpdates, true);
  assert.deepEqual({ from: updated.trustKeptOnUpdate.fromVersion, to: updated.trustKeptOnUpdate.toVersion }, { from: "1.0.0", to: "1.1.0" });
  assert.equal(manager.brokerGrant(ID, PROVIDER, "glm-1"), "a".repeat(64));
  assert.equal(updated.sharedReads[0].state, "approved");
  const line = (await audit()).find((entry) => entry.event === "plugin.update-trust-kept");
  assert.equal(line.plugin, ID);
  assert.equal(line.source, `${REPO}.git`);
  assert.equal(line.fromVersion, "1.0.0");
  assert.equal(line.toVersion, "1.1.0");
  assert.match(line.fromDigest, /^[a-f0-9]{64}$/u);
  assert.ok(line.kept.includes("native-code") && line.kept.includes("may-start-orchestrators"));
  // Pinned to the new entry: a restart keeps it; a changed file afterwards revokes it as always.
  assert.equal((await registry())[ID].trustUpdatesFrom, `${REPO}.git`);
  await manager.dispose();
  const again = await make();
  assert.equal(again.list().find((plugin) => plugin.manifest.id === ID).nativeCodeTrusted, true);
  assert.equal(again.list().find((plugin) => plugin.manifest.id === ID).trustUpdates, true);
  assert.equal(view().trustKeptOnUpdate !== undefined, true);
});

test("on: an update that asks for more (a permission, a tool for every card, a share, a hook) revokes everything and says what", async (t) => {
  const cases = [
    ["permission", assistant({ version: "2.0.0", permissions: [...assistant().permissions, "sessions:control"] }), /permission:sessions:control/u],
    ["service", assistant({ version: "2.0.0", services: [...assistant().services, { id: "extra", title: "Extra", entry: "services/extra.mjs" }] }), /service:extra/u],
    ["use", assistant({ version: "2.0.0", uses: [...assistant().uses, { plugin: PROVIDER, method: "accounts.quota" }] }), /use:/u]
  ];
  for (const [label, manifest, widened] of cases) {
    const { manager, packages, audit } = await world(t);
    await manager.setTrustUpdates(ID, true);
    packages[REPO] = { manifest, code: `// ${label}\n` };
    const updated = await manager.updatePlugin(ID);
    assert.equal(updated.nativeCodeTrusted, false, label);
    assert.equal(updated.mayStartOrchestrators, false, label);
    assert.equal(updated.trustUpdates, undefined, label);
    assert.equal(manager.brokerGrant(ID, PROVIDER, "glm-1"), undefined, label);
    const line = (await audit()).find((entry) => entry.event === "plugin.update-trust-revoked");
    assert.ok(line, label);
    assert.match(line.widened.join(" "), widened, label);
  }
});

test("a source change never carries the trust over, and drops the opt-in", async (t) => {
  const { manager, view } = await world(t);
  await manager.setTrustUpdates(ID, true);
  const preview = await manager.previewSourceChange(ID, OTHER_REPO);
  const changed = await manager.changeSource(ID, OTHER_REPO, preview.token);
  assert.equal(changed.nativeCodeTrusted, false);
  assert.equal(changed.trustUpdates, undefined);
  await manager.setNativeCodeTrusted(ID, true);
  assert.equal(view().trustUpdates, undefined, "trusting the new source starts with it off");
});

test("widening: added or changed grants count, removals and display text do not", () => {
  const base = validatePluginManifest(assistant());
  const next = (overrides) => validatePluginManifest(assistant(overrides));
  const tool = (extra) => ({ ...assistant().services[0], tools: [{ ...assistant().services[0].tools[0], ...extra }] });
  assert.deepEqual(pluginTrustWidening(base, next({ description: "Other text.", name: "Assistant 2" })), []);
  assert.deepEqual(pluginTrustWidening(base, next({ permissions: ["sessions:launch", "decision:provide", "accounts:broker", "tools:agents"].slice(0, 3), services: [{ ...assistant().services[0], tools: undefined }] })), []);
  assert.deepEqual(pluginTrustWidening(base, next({ services: [tool({ description: "New words" })] })), []);
  assert.deepEqual(pluginTrustWidening(base, next({ services: [tool({ roles: ["orchestrator", "agent"] })] })), [
    "tool:main:route:agent:all", "tool:main:route:agent:own-cards"
  ]);
  // own-cards is narrower than all: going to own-cards asks nothing new; going back does.
  const own = next({ services: [tool({ audience: "own-cards" })] });
  assert.deepEqual(pluginTrustWidening(base, own), []);
  assert.deepEqual(pluginTrustWidening(own, base), ["tool:main:route:orchestrator:all"]);
  // A decision service for all agents is wider than one for Claude only.
  const claudeOnly = next({ services: [{ ...assistant().services[0], decide: { events: ["pre-tool"], appliesTo: ["claude"] } }] });
  assert.deepEqual(pluginTrustWidening(base, claudeOnly), []);
  assert.ok(pluginTrustWidening(claudeOnly, base).includes("decide:main:pre-tool:codex"));
  assert.ok(pluginTrustWidening(base, next({ contributions: [{ kind: "canvas-app", id: "setup", title: "Setup", entry: "apps/setup.html", defaultSize: { width: 480, height: 360 } }] }))
    .includes("contribution:canvas-app:setup"));
});
