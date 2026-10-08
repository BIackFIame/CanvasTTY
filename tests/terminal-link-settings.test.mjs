import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeSettings, SettingsStore } from "../src/main/services/SettingsStore.ts";

const modes = ["canvas", "external", "ask"];
const invalidModes = [undefined, null, false, true, 0, 1, "", "system", "Canvas", "external ", [], {}, ["canvas"]];

async function createStore(t) {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-terminal-links-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, "settings.json"), store: new SettingsStore(dir, "en") };
}

test("new settings default terminal links to ask and persist that default", async (t) => {
  const { path, store } = await createStore(t);
  assert.equal(store.get().terminalLinkOpenMode, "ask");
  assert.equal((await store.load()).terminalLinkOpenMode, "ask");
  assert.equal(JSON.parse(await readFile(path, "utf8")).terminalLinkOpenMode, "ask");
});

test("terminal link normalization accepts only supported modes and preserves the fallback", () => {
  const defaults = new SettingsStore("unused-settings-test-path", "en").get();
  for (const fallbackMode of modes) {
    const fallback = { ...defaults, terminalLinkOpenMode: fallbackMode };
    for (const mode of modes) {
      assert.equal(normalizeSettings({ terminalLinkOpenMode: mode }, fallback).terminalLinkOpenMode, mode);
    }
    assert.equal(normalizeSettings({}, fallback).terminalLinkOpenMode, fallbackMode);
    for (const mode of invalidModes) {
      assert.equal(
        normalizeSettings({ terminalLinkOpenMode: mode }, fallback).terminalLinkOpenMode,
        fallbackMode,
        `invalid value ${JSON.stringify(mode)} must preserve ${fallbackMode}`
      );
    }
  }
});

for (const mode of modes) {
  test(`terminal link mode ${mode} survives persistence, reload, and unrelated updates`, async (t) => {
    const { dir, path, store } = await createStore(t);
    await store.load();
    assert.equal((await store.update({ terminalLinkOpenMode: mode })).terminalLinkOpenMode, mode);
    assert.equal(JSON.parse(await readFile(path, "utf8")).terminalLinkOpenMode, mode);

    const reloaded = new SettingsStore(dir, "en");
    assert.equal((await reloaded.load()).terminalLinkOpenMode, mode);
    assert.equal((await reloaded.update({ copyOnSelect: true })).terminalLinkOpenMode, mode);
    const restored = await new SettingsStore(dir, "en").load();
    assert.equal(restored.terminalLinkOpenMode, mode);
    assert.equal(restored.copyOnSelect, true);
  });
}

test("invalid terminal link updates preserve the previous setting in memory and on disk", async (t) => {
  const { dir, path, store } = await createStore(t);
  await store.update({ terminalLinkOpenMode: "external" });
  for (const mode of invalidModes) {
    assert.equal((await store.update({ terminalLinkOpenMode: mode })).terminalLinkOpenMode, "external");
    assert.equal(store.get().terminalLinkOpenMode, "external");
    assert.equal(JSON.parse(await readFile(path, "utf8")).terminalLinkOpenMode, "external");
  }
  assert.equal((await new SettingsStore(dir, "en").load()).terminalLinkOpenMode, "external");
});

test("current-version settings missing terminalLinkOpenMode migrate and persist ask", async (t) => {
  const { dir, path, store } = await createStore(t);
  await store.update({ locale: "ru", copyOnSelect: true, terminalLinkOpenMode: "canvas" });
  const oldSettings = JSON.parse(await readFile(path, "utf8"));
  delete oldSettings.terminalLinkOpenMode;
  await writeFile(path, JSON.stringify(oldSettings), "utf8");

  const migrated = await new SettingsStore(dir, "en").load();
  assert.equal(migrated.terminalLinkOpenMode, "ask");
  assert.equal(migrated.locale, "ru");
  assert.equal(migrated.copyOnSelect, true);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { ...oldSettings, terminalLinkOpenMode: "ask" });
  assert.equal((await new SettingsStore(dir, "en").load()).terminalLinkOpenMode, "ask");
});

test("invalid terminal link values in persisted settings load as ask", async (t) => {
  const { dir, path, store } = await createStore(t);
  await store.load();
  const saved = JSON.parse(await readFile(path, "utf8"));
  for (const mode of invalidModes.filter((value) => value !== undefined)) {
    await writeFile(path, JSON.stringify({ ...saved, terminalLinkOpenMode: mode }), "utf8");
    assert.equal(
      (await new SettingsStore(dir, "en").load()).terminalLinkOpenMode,
      "ask",
      `persisted invalid value ${JSON.stringify(mode)} must fall back to ask`
    );
  }
});
