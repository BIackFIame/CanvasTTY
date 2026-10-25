import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginManager, validatePluginManifest } from "../src/main/services/PluginManager.ts";
import { createLauncherEntryHandler } from "../src/main/services/pluginLauncherEntry.ts";

const ID = "com.example.assistant";
const REPO = `https://github.com/example/${ID}`;
const entry = { title: "Main agent", "title.ru": "Главный агент", description: "One agent that hands work to your projects." };
const manifest = (service = {}, permissions = ["sessions:launch"]) => ({
  apiVersion: 2, id: ID, name: "Assistant", version: "1.0.0", description: "Routes.", contributions: [], permissions,
  services: [{ id: "main", title: "Main", entry: "services/main.mjs", launcherEntry: entry, ...service }]
});

test("manifest: one launcher entry per plugin, with sessions:launch, short texts and nothing else", () => {
  assert.deepEqual(validatePluginManifest(manifest()).services[0].launcherEntry, entry);
  assert.throws(() => validatePluginManifest(manifest({}, [])), /needs the sessions:launch permission/u);
  assert.throws(() => validatePluginManifest(manifest({ launcherEntry: { ...entry, provider: "claude" } })), /Plugin launcher entry/u);
  assert.throws(() => validatePluginManifest(manifest({ launcherEntry: { ...entry, cwd: "/tmp" } })), /Plugin launcher entry/u);
  assert.throws(() => validatePluginManifest(manifest({ launcherEntry: { title: "x".repeat(41) } })), /title/u);
  assert.throws(() => validatePluginManifest(manifest({ launcherEntry: { title: "ok", description: "x".repeat(161) } })), /description/u);
  assert.throws(() => validatePluginManifest(manifest({ launcherEntry: "Main agent" })), /must be an object/u);
  assert.throws(() => validatePluginManifest({
    ...manifest(), services: [manifest().services[0], { id: "second", title: "Second", entry: "services/second.mjs", launcherEntry: entry }]
  }), /Only one plugin service may declare a launcher entry/u);
});

test("the host answers an entry only for an enabled plugin whose native code is trusted", async (t) => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-launcher-entry-"));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const manager = new PluginManager(userData, async (url, destination) => {
    await mkdir(join(destination, "services"), { recursive: true });
    await writeFile(join(destination, "canvastty.plugin.json"), JSON.stringify(manifest()));
    await writeFile(join(destination, "services", "main.mjs"), "// main\n");
  });
  await manager.load();
  t.after(() => manager.dispose());
  await manager.install((await manager.previewInstall(REPO)).token);
  assert.throws(() => manager.launcherEntryService(ID), /native code/u);
  await manager.setNativeCodeTrusted(ID, true);
  assert.equal(manager.launcherEntryService(ID), "main");
  await manager.setEnabled(ID, false);
  assert.throws(() => manager.launcherEntryService(ID), /disabled/u);
  assert.throws(() => manager.launcherEntryService("com.example.missing"), /not installed/u);
});

test("choosing the entry sends canvastty.launcher.entry once; a stopped service or a refused plugin sends nothing", async () => {
  const calls = [];
  let release;
  let running = true;
  const handler = createLauncherEntryHandler({
    service: (pluginId) => { if (pluginId !== ID) throw new Error("This plugin has no launcher entry."); return "main"; },
    running: () => running,
    call: (pluginId, serviceId, method, params) => { calls.push({ pluginId, serviceId, method, params }); return new Promise((resolve) => { release = resolve; }); },
    locale: () => "ru"
  });
  await assert.rejects(handler(42), /identifier/u);
  await assert.rejects(handler("com.example.other"), /no launcher entry/u);
  running = false;
  await assert.rejects(handler(ID), /not running/u);
  running = true;
  const first = handler(ID);
  await handler(ID); // a double click while the first is answered: nothing more is sent
  release(null);
  await first;
  assert.deepEqual(calls, [{ pluginId: ID, serviceId: "main", method: "canvastty.launcher.entry", params: { locale: "ru" } }]);
});

test("HOME shows the entries first, only for trusted plugins, from a lazily loaded part", async () => {
  const home = await readFile(new URL("../src/renderer/src/features/home/HomeZone.tsx", import.meta.url), "utf8");
  const entries = await readFile(new URL("../src/renderer/src/features/home/PluginLauncherEntries.tsx", import.meta.url), "utf8");
  assert.match(home, /lazy\(\(\) => import\("\.\/PluginLauncherEntries"\)/u);
  assert.ok(home.indexOf("<PluginLauncherEntries") < home.indexOf("launcher-button--terminal"), "first in the launcher");
  assert.match(entries, /plugin\.enabled && plugin\.nativeCodeTrusted|!plugin\.enabled \|\| !plugin\.nativeCodeTrusted/u);
  assert.match(entries, /window\.canvasTTY\.plugins\.launcherEntry\(id\)/u);
  const ipc = await readFile(new URL("../src/main/ipc/registerIpc.ts", import.meta.url), "utf8");
  assert.match(ipc, /IPC\.pluginsLauncherEntry, \(event, pluginId: unknown\) => \{\n\s+assertMainRenderer\(event, getMainWindow\);/u);
});
