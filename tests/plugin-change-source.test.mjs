import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginManager, pluginSourceChanges, validatePluginManifest } from "../src/main/services/PluginManager.ts";
import { PluginSecretsService } from "../src/main/services/PluginSecretsService.ts";

const PLUGIN_ID = "com.example.switchable";
const MAIN = "https://github.com/example/switchable";
const DEV = "https://github.com/example/switchable-dev";
const FORK = "https://github.com/someone-else/switchable";

/** A plugin with one decision service; `variant` changes its code and, optionally, its manifest. */
async function writePackage(root, { version = "1.0.0", id = PLUGIN_ID, code = "main", permissions, extra = {} } = {}) {
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, "services"), { recursive: true });
  await mkdir(join(root, "apps"), { recursive: true });
  await writeFile(join(root, "services", "guard.mjs"), `// ${code}\nsetInterval(() => {}, 60_000);\n`);
  await writeFile(join(root, "apps", "app.html"), `<h1>${code}</h1>`);
  await writeFile(join(root, "canvastty.plugin.json"), JSON.stringify({
    apiVersion: 2,
    id,
    name: "Switchable",
    version,
    description: "Source change fixture.",
    permissions: permissions ?? ["storage", "secrets", "decision:provide"],
    services: [{
      id: "guard",
      title: "Guard",
      entry: "services/guard.mjs",
      decide: { events: ["pre-tool"], timeoutMs: 5000 }
    }],
    contributions: [{ id: "app", kind: "canvas-app", title: "App", entry: "apps/app.html", defaultSize: { width: 400, height: 300 } }],
    ...extra
  }));
}

function fakeEncryption() {
  return {
    isAvailable: () => true,
    encrypt: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`),
    decrypt: (value) => Buffer.from(value.toString().slice("encrypted:".length), "base64").toString()
  };
}

/** userData with the plugin installed from MAIN, trusted, its decisions allowed, data in every place it keeps it. */
async function installedFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-change-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userData = join(root, "userData");
  const repos = new Map([[MAIN, join(root, "repo-main")], [DEV, join(root, "repo-dev")], [FORK, join(root, "repo-fork")]]);
  await writePackage(repos.get(MAIN));
  const downloads = [];
  const failNext = { download: false };
  const manager = new PluginManager(userData, async (url, destination) => {
    downloads.push(url);
    if (failNext.download) throw new Error("network down");
    const key = url.replace(/\.git$/, "");
    const source = repos.get(key);
    if (!source) throw new Error(`no fixture for ${url}`);
    await cp(source, destination, { recursive: true });
  });
  t.after(() => manager.dispose());
  const observed = [];
  manager.setServiceObserver(async (specs) => { observed.push(specs.map((spec) => spec.pluginId)); });
  await manager.load();
  await manager.install((await manager.previewInstall(MAIN)).token);
  await manager.setNativeCodeTrusted(PLUGIN_ID, true);
  await manager.setDecisionsMayAllow(PLUGIN_ID, true);

  await manager.storageSet(PLUGIN_ID, "accounts", [{ id: "a1", label: "First" }]);
  const dataDir = join(userData, "plugin-data", PLUGIN_ID);
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "state.db"), "account state");
  const secrets = new PluginSecretsService(userData, (pluginId, permission) => manager.assertPermission(pluginId, permission), fakeEncryption());
  await secrets.load();
  await secrets.set(PLUGIN_ID, "api-key", "fake-test-key-value");
  return { root, userData, repos, manager, secrets, dataDir, downloads, failNext, observed };
}

async function assertDataKept({ manager, secrets, dataDir }) {
  assert.deepEqual(await manager.storageGet(PLUGIN_ID, "accounts"), [{ id: "a1", label: "First" }]);
  assert.equal(await readFile(join(dataDir, "state.db"), "utf8"), "account state");
  assert.equal(await secrets.get(PLUGIN_ID, "api-key"), "fake-test-key-value");
}

async function appText(manager) {
  const response = await manager.protocolResponse(`canvastty-plugin://${PLUGIN_ID}/apps/app.html`);
  return (await response.text()).replace(/^<script[^>]*><\/script>/, "");
}

test("switching the source keeps storage, the data folder and secrets, and revokes every grant on the old code", async (t) => {
  const fixture = await installedFixture(t);
  const { manager, repos, userData } = fixture;
  await writePackage(repos.get(DEV), { version: "1.1.0-dev.1", code: "dev", extra: {} });

  const review = await manager.previewSourceChange(PLUGIN_ID, `${DEV}.git`);
  assert.equal(review.pluginId, PLUGIN_ID);
  assert.equal(review.sourceUrl, `${DEV}.git`);
  assert.equal(review.currentSourceUrl, `${MAIN}.git`);
  assert.equal(review.currentVersion, "1.0.0");
  assert.equal(review.manifest.version, "1.1.0-dev.1");
  assert.equal(review.sameOwner, true);
  assert.deepEqual(review.changes, []);
  // The review touches nothing: still the old package, trusted.
  assert.equal(manager.list()[0].nativeCodeTrusted, true);
  assert.equal(await appText(manager), "<h1>main</h1>");

  const changed = await manager.changeSource(PLUGIN_ID, DEV, review.token);
  assert.equal(changed.sourceUrl, `${DEV}.git`);
  assert.equal(changed.previousSourceUrl, `${MAIN}.git`);
  assert.equal(changed.manifest.version, "1.1.0-dev.1");
  assert.equal(changed.enabled, true);
  assert.equal(changed.nativeCodeTrusted, false);
  assert.equal(changed.decisionsMayAllow, false);
  assert.deepEqual(changed.enabledHooks, []);
  assert.deepEqual(manager.trustedServiceSpecs(), [], "the new code does not run until the person trusts it");
  assert.deepEqual(fixture.observed.at(-1), [], "the old services were stopped");
  assert.equal(await appText(manager), "<h1>dev</h1>");
  await assertDataKept(fixture);

  // Durable: a restart keeps the new source, the previous one and the revocation.
  const registry = JSON.parse(await readFile(join(userData, "plugins.json"), "utf8"))[PLUGIN_ID];
  assert.equal(registry.sourceUrl, `${DEV}.git`);
  assert.equal(registry.previousSourceUrl, `${MAIN}.git`);
  assert.equal(registry.trustedServices, undefined);
  assert.equal(registry.decisionsMayAllow, undefined);
  const reloaded = new PluginManager(userData, async () => undefined);
  t.after(() => reloaded.dispose());
  const [afterRestart] = await reloaded.load();
  assert.equal(afterRestart.sourceUrl, `${DEV}.git`);
  assert.equal(afterRestart.previousSourceUrl, `${MAIN}.git`);
  assert.equal(afterRestart.nativeCodeTrusted, false);

  const versions = JSON.parse(await readFile(join(userData, "plugin-versions.json"), "utf8"));
  assert.equal(versions[PLUGIN_ID].installedVersion, "1.1.0-dev.1");

  const audit = (await readFile(join(userData, "plugin-audit.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].event, "plugin.source-changed");
  assert.equal(audit[0].plugin, PLUGIN_ID);
  assert.equal(audit[0].from, `${MAIN}.git`);
  assert.equal(audit[0].to, `${DEV}.git`);
  assert.deepEqual(audit[0].revoked, ["native-code", "decisions-may-allow"]);
  assert.deepEqual(audit[0].kept, ["storage", "data", "secrets"]);
  assert.doesNotMatch(JSON.stringify(audit), /fake-test-key-value|account state/);

  // The person trusts the new code again; then switches back the same way.
  await manager.setNativeCodeTrusted(PLUGIN_ID, true);
  const back = await manager.previewSourceChange(PLUGIN_ID, changed.previousSourceUrl);
  assert.equal(back.sourceUrl, `${MAIN}.git`);
  const restored = await manager.changeSource(PLUGIN_ID, changed.previousSourceUrl, back.token);
  assert.equal(restored.sourceUrl, `${MAIN}.git`);
  assert.equal(restored.previousSourceUrl, `${DEV}.git`);
  assert.equal(restored.manifest.version, "1.0.0");
  assert.equal(restored.nativeCodeTrusted, false, "switching back asks for trust again too");
  assert.equal(await appText(manager), "<h1>main</h1>");
  await assertDataKept(fixture);
  const lines = (await readFile(join(userData, "plugin-audit.log"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[1]).revoked, ["native-code"]);
  // Staging holds nothing afterwards.
  assert.deepEqual(await readdir(join(userData, "plugin-staging")), []);
});

test("the review shows what the new source grants differently and whether the owner differs", async (t) => {
  const { manager, repos } = await installedFixture(t);
  await writePackage(repos.get(FORK), {
    code: "fork",
    permissions: ["storage", "decision:provide", "network"]
  });
  const review = await manager.previewSourceChange(PLUGIN_ID, FORK);
  assert.equal(review.sameOwner, false);
  assert.deepEqual(review.changes, [{ kind: "permissions", added: ["network"], removed: ["secrets"] }]);
  // A dropped review leaves the install as it was.
  assert.equal(manager.list()[0].sourceUrl, `${MAIN}.git`);
  assert.equal(manager.list()[0].nativeCodeTrusted, true);
});

test("pluginSourceChanges reports services, hooks, surfaces, decision services and launch policies", () => {
  const base = validatePluginManifest({
    apiVersion: 2, id: PLUGIN_ID, name: "S", version: "1.0.0", description: "d", permissions: ["storage", "decision:provide"],
    services: [{ id: "a", title: "A", entry: "a.mjs", decide: { events: ["pre-tool"] } }],
    contributions: [{ id: "app", kind: "canvas-app", title: "App", entry: "app.html", defaultSize: { width: 400, height: 300 } }]
  });
  const next = validatePluginManifest({
    apiVersion: 2, id: PLUGIN_ID, name: "S", version: "2.0.0", description: "d", permissions: ["storage", "decision:provide", "launch:contribute"],
    services: [{ id: "b", title: "B", entry: "b.mjs", launch: { fields: [], policy: true } }],
    contributions: []
  });
  const kinds = Object.fromEntries(pluginSourceChanges(base, next).map((change) => [change.kind, change]));
  assert.deepEqual(kinds.permissions, { kind: "permissions", added: ["launch:contribute"], removed: [] });
  assert.deepEqual(kinds.services, { kind: "services", added: ["b"], removed: ["a"] });
  assert.deepEqual(kinds.contributions, { kind: "contributions", added: [], removed: ["canvas-app:app"] });
  assert.deepEqual(kinds.decide, { kind: "decide", added: [], removed: ["a"] });
  assert.deepEqual(kinds.launchPolicy, { kind: "launchPolicy", added: ["b"], removed: [] });
  assert.deepEqual(pluginSourceChanges(base, base), []);
});

test("refuses another plugin id, a bad URL, the same repository and an invalid manifest, leaving the install alone", async (t) => {
  const fixture = await installedFixture(t);
  const { manager, repos, userData } = fixture;
  const before = JSON.stringify(manager.list());

  await writePackage(repos.get(DEV), { id: "com.example.other" });
  await assert.rejects(manager.previewSourceChange(PLUGIN_ID, DEV), /holds plugin com\.example\.other, not com\.example\.switchable/);

  for (const url of [
    "http://github.com/example/switchable-dev",
    "https://gitlab.com/example/switchable-dev",
    "https://github.com/example/switchable-dev/tree/main",
    "https://user:pass@github.com/example/switchable-dev",
    "https://github.com/example/switchable-dev?x=1",
    "file:///etc",
    "",
    42
  ]) {
    await assert.rejects(manager.previewSourceChange(PLUGIN_ID, url), undefined, String(url));
  }
  await assert.rejects(manager.previewSourceChange(PLUGIN_ID, "https://github.com/Example/Switchable.git"), /already installed from this repository/);
  await assert.rejects(manager.previewSourceChange("com.example.missing", DEV), /not installed|unknown|not found/i);

  // Invalid manifest: unknown permission; and a manifest naming a missing asset.
  await writePackage(repos.get(DEV), { permissions: ["storage", "root:everything"] });
  await assert.rejects(manager.previewSourceChange(PLUGIN_ID, DEV));
  await writePackage(repos.get(DEV));
  await rm(join(repos.get(DEV), "apps", "app.html"));
  await assert.rejects(manager.previewSourceChange(PLUGIN_ID, DEV));

  assert.equal(JSON.stringify(manager.list()), before);
  await assertDataKept(fixture);
  assert.deepEqual(await readdir(join(userData, "plugin-staging")), []);
  await assert.rejects(readFile(join(userData, "plugin-audit.log"), "utf8"), { code: "ENOENT" });
});

test("a commit needs its own review: wrong token, another URL or plugin, and a reused token are refused", async (t) => {
  const { manager, repos } = await installedFixture(t);
  await writePackage(repos.get(DEV), { code: "dev" });
  await assert.rejects(manager.changeSource(PLUGIN_ID, DEV, "not-a-token"), /expired/);

  const review = await manager.previewSourceChange(PLUGIN_ID, DEV);
  await assert.rejects(manager.changeSource(PLUGIN_ID, FORK, review.token), /does not match its review/);
  // The mismatched attempt consumed the review.
  await assert.rejects(manager.changeSource(PLUGIN_ID, DEV, review.token), /expired/);

  const second = await manager.previewSourceChange(PLUGIN_ID, DEV);
  await assert.rejects(manager.changeSource("com.example.other", DEV, second.token), /does not match its review/);
  assert.equal(manager.list()[0].sourceUrl, `${MAIN}.git`);
  assert.equal(manager.list()[0].nativeCodeTrusted, true);
});

test("an update between review and commit refuses the stale review", async (t) => {
  const { manager, repos } = await installedFixture(t);
  await writePackage(repos.get(DEV), { code: "dev" });
  const review = await manager.previewSourceChange(PLUGIN_ID, DEV);
  await writePackage(repos.get(MAIN), { version: "1.0.1", code: "main-2" });
  await manager.updatePlugin(PLUGIN_ID);
  await assert.rejects(manager.changeSource(PLUGIN_ID, DEV, review.token), /changed since the review/);
  assert.equal(manager.list()[0].sourceUrl, `${MAIN}.git`);
  assert.equal(await appText(manager), "<h1>main-2</h1>");
});

test("a failure while switching puts back the old package and source, and leaves every grant revoked", async (t) => {
  const fixture = await installedFixture(t);
  const { manager, repos, userData } = fixture;
  await writePackage(repos.get(DEV), { version: "2.0.0", code: "dev" });
  const review = await manager.previewSourceChange(PLUGIN_ID, DEV);
  // The versions write fails after the package was swapped and the registry written.
  await mkdir(join(userData, "plugin-versions.json.tmp"));
  await assert.rejects(manager.changeSource(PLUGIN_ID, DEV, review.token), (error) => {
    assert.match(error.message, /source change failed/);
    assert.match(error.message, /previous source and package are back/);
    assert.match(error.message, /stay revoked/);
    return true;
  });
  await rm(join(userData, "plugin-versions.json.tmp"), { recursive: true });

  const [plugin] = manager.list();
  assert.equal(plugin.sourceUrl, `${MAIN}.git`);
  assert.equal(plugin.previousSourceUrl, undefined);
  assert.equal(plugin.manifest.version, "1.0.0");
  // Fail closed: nothing granted before the switch comes back by itself.
  assert.equal(plugin.nativeCodeTrusted, false);
  assert.equal(plugin.decisionsMayAllow, false);
  assert.deepEqual(manager.trustedServiceSpecs(), []);
  // The old install's files are intact and serve again.
  assert.equal(await appText(manager), "<h1>main</h1>");
  assert.equal(await readFile(join(userData, "plugins", PLUGIN_ID, "services", "guard.mjs"), "utf8"), "// main\nsetInterval(() => {}, 60_000);\n");
  await assertDataKept(fixture);
  const registry = JSON.parse(await readFile(join(userData, "plugins.json"), "utf8"))[PLUGIN_ID];
  assert.equal(registry.sourceUrl, `${MAIN}.git`);
  assert.equal(registry.trustedServices, undefined);
  assert.equal(registry.decisionsMayAllow, undefined);
  // The person can grant again on the old code.
  await manager.setNativeCodeTrusted(PLUGIN_ID, true);
  assert.equal(manager.trustedServiceSpecs().length, 1);
  await assert.rejects(readFile(join(userData, "plugin-audit.log"), "utf8"), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(userData, "plugin-staging")), []);

  // A download failure during the review never reaches the install either.
  fixture.failNext.download = true;
  await assert.rejects(manager.previewSourceChange(PLUGIN_ID, DEV), /network down/);
  assert.equal(manager.list()[0].nativeCodeTrusted, true, "a failed review touches no grant");
});

test("a grant withdrawn while a switch runs and fails stays withdrawn", async (t) => {
  const fixture = await installedFixture(t);
  const { manager, repos, userData } = fixture;
  // A second trusted plugin, the person's trust in which they withdraw during the switch.
  const OTHER_ID = "com.example.bystander";
  await writePackage(repos.get(FORK), { id: OTHER_ID, code: "bystander" });
  await manager.install((await manager.previewInstall(FORK)).token);
  await manager.setNativeCodeTrusted(OTHER_ID, true);
  await writePackage(repos.get(DEV), { version: "2.0.0", code: "dev" });
  const review = await manager.previewSourceChange(PLUGIN_ID, DEV);
  const concurrent = [];
  manager.setServiceObserver(async () => {
    if (concurrent.length) return;
    concurrent.push(manager.setNativeCodeTrusted(OTHER_ID, false));
    // Re-allowing the switched plugin's decisions while it runs is refused: its trust is already revoked.
    concurrent.push(manager.setDecisionsMayAllow(PLUGIN_ID, true).then(() => "allowed", (error) => error.message));
  });
  await mkdir(join(userData, "plugin-versions.json.tmp"));
  await assert.rejects(manager.changeSource(PLUGIN_ID, DEV, review.token), /stay revoked/);
  const [, decisions] = await Promise.all(concurrent);
  manager.setServiceObserver(null);
  assert.match(decisions, /native code first/);

  const plugins = Object.fromEntries(manager.list().map((plugin) => [plugin.manifest.id, plugin]));
  assert.equal(plugins[OTHER_ID].nativeCodeTrusted, false, "the concurrent revoke is not undone");
  assert.equal(plugins[PLUGIN_ID].nativeCodeTrusted, false);
  assert.equal(plugins[PLUGIN_ID].decisionsMayAllow, false);
  assert.equal(plugins[PLUGIN_ID].sourceUrl, `${MAIN}.git`);
  assert.equal(await appText(manager), "<h1>main</h1>");
  const registry = JSON.parse(await readFile(join(userData, "plugins.json"), "utf8"));
  assert.equal(registry[OTHER_ID].trustedServices, undefined);
  assert.equal(registry[PLUGIN_ID].trustedServices, undefined);
  assert.deepEqual(manager.trustedServiceSpecs(), []);
});

test("the IPC channels check the sender, keep secrets and media, and the UI lives only in the Settings chunk", async () => {
  const ipc = await readFile(new URL("../src/main/ipc/registerIpc.ts", import.meta.url), "utf8");
  const handler = ipc.slice(ipc.indexOf("IPC.pluginsChangeSource"), ipc.indexOf("IPC.pluginsSetModules"));
  assert.match(handler, /assertMainRenderer\(event, getMainWindow\)/);
  assert.match(handler, /plugins\.changeSource\(id, url, token\)/);
  const code = handler.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /pluginSecrets|pluginMedia|revokeAll|uninstall/);
  const contracts = await readFile(new URL("../src/shared/contracts.ts", import.meta.url), "utf8");
  assert.match(contracts, /pluginsChangeSource: "plugins:change-source"/);

  const section = await readFile(new URL("../src/renderer/src/features/plugins/PluginSettingsSection.tsx", import.meta.url), "utf8");
  assert.match(section, /function PluginSourceChange\(/);
  assert.match(section, /<PluginSourceChange\b/);
  assert.match(section, /from "\.\/pluginSourceChangeText"/);
  const text = await readFile(new URL("../src/renderer/src/features/plugins/pluginSourceChangeText.ts", import.meta.url), "utf8");
  for (const phrase of ["Change source…", "Сменить источник…", "更换来源…", "will be able to read all of them"]) {
    assert.ok(text.includes(phrase), phrase);
  }
  // Nothing of it in the eager translation table or the app shell.
  const i18n = await readFile(new URL("../src/renderer/src/lib/i18n.ts", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/renderer/src/App.tsx", import.meta.url), "utf8");
  for (const source of [i18n, app]) {
    assert.doesNotMatch(source, /Change source|Сменить источник|pluginSourceChangeText|PluginSourceChange\b/);
  }
});
