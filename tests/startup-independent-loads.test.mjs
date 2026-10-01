/**
 * initializeServices() (src/main/index.ts) starts four persistence loads that read no state from
 * one another: SettingsStore, SkinRegistry, PixelSkinPackRegistry and PluginManager, each rooted
 * in its own subfolder of userDataPath. Awaiting them one after another only adds their latencies
 * together before the renderer's application surface can load; they belong in one Promise.all.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginManager } from "../src/main/services/PluginManager.ts";
import { PixelSkinPackRegistry } from "../src/main/services/PixelSkinPackRegistry.ts";
import { SettingsStore } from "../src/main/services/SettingsStore.ts";
import { SkinRegistry } from "../src/main/services/SkinRegistry.ts";

const mainPath = new URL("../src/main/index.ts", import.meta.url);

test("initializeServices awaits the four independent persistence loads together, not one after another", async () => {
  const source = await readFile(mainPath, "utf8");
  const start = source.indexOf("async function initializeServices");
  const end = source.indexOf("// Secrets this app knows are masked", start);
  assert.ok(start !== -1 && end !== -1 && end > start, "the initializeServices boundaries must still exist");
  const body = source.slice(start, end);

  // Each independent load must appear inside one Promise.all(...) call, not behind its own await.
  const combined = body.match(/Promise\.all\(\s*\[([^\]]*)\]/su);
  assert.ok(combined, "the four independent loads must be combined in one Promise.all([...])");
  const group = combined[1];
  for (const call of ["settings.load()", "terminalBorderSkins.initialize()", "pixelSkinPacks.initialize()", "pluginManager.load()"]) {
    assert.ok(group.includes(call), `${call} must be inside the Promise.all group`);
  }
  // None of the four may still be awaited on its own line outside that group (the old, serial form).
  for (const call of ["settings.load()", "terminalBorderSkins.initialize()", "pixelSkinPacks.initialize()", "pluginManager.load()"]) {
    const soloAwaits = body.split("\n").filter((line) => line.trim().startsWith("await") && line.includes(call));
    assert.equal(soloAwaits.length, 0, `${call} must not also be awaited by itself`);
  }
});

test("before/after: awaiting the same four real loads together instead of serially cuts the wall time roughly to the slowest one", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-startup-overlap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  // A small, deliberate delay stands in for real disk latency (a cold SSD, an antivirus scanner, a
  // network home directory): enough to measure, small enough this test stays fast.
  const DELAY_MS = 40;
  const slowly = async (fn) => {
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    return fn();
  };

  const registries = [];
  const loaders = () => {
    const settings = new SettingsStore(directory, "en");
    const terminalBorderSkins = new SkinRegistry(directory);
    const pixelSkinPacks = new PixelSkinPackRegistry(directory);
    const pluginManager = new PluginManager(directory);
    registries.push(terminalBorderSkins); // installs a directory watcher; disposed in t.after below
    return [
      () => slowly(() => settings.load()),
      () => slowly(() => terminalBorderSkins.initialize()),
      () => slowly(() => pixelSkinPacks.initialize()),
      () => slowly(() => pluginManager.load())
    ];
  };
  t.after(() => { for (const registry of registries) registry.dispose(); });

  const serialStart = Date.now();
  for (const load of loaders()) await load();
  const serialMs = Date.now() - serialStart;

  const parallelStart = Date.now();
  await Promise.all(loaders().map((load) => load()));
  const parallelMs = Date.now() - parallelStart;

  assert.ok(serialMs >= DELAY_MS * 4 * 0.8, `serial loads should take on the order of ${DELAY_MS * 4}ms, took ${serialMs}ms`);
  assert.ok(parallelMs < serialMs * 0.6, `overlapped loads (${parallelMs}ms) should be well under serial loads (${serialMs}ms)`);
});
