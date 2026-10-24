import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeBackgroundAppearance, normalizeBackgroundOverrides, normalizeBackgroundPresets } from "../src/shared/terminalBackgroundAppearance.ts";
import { SettingsStore } from "../src/main/services/SettingsStore.ts";
import { createBackgroundOutputPause } from "../src/renderer/src/features/terminal/backgroundOutputPause.ts";

test("background overrides and presets validate fields without leaking unrelated settings", () => {
  const appearance = normalizeBackgroundAppearance({
    terminalBackground: "donut", terminalBackgroundScale: 999,
    terminalBackgroundSpeed: NaN, terminalBackgroundReadabilityStrength: -20,
    terminalBackgroundPauseOnOutput: true, terminalBackgroundFocusDimming: true, terminalBackgroundContrast: -5, terminalBackgroundSaturation: 999, palette: "bad",
  });
  assert.equal(appearance.terminalBackgroundScale, 300);
  assert.equal(appearance.terminalBackgroundSpeed, 1);
  assert.equal(appearance.terminalBackgroundReadabilityStrength, 0);
  assert.equal(appearance.terminalBackgroundPauseOnOutput, true);
  assert.equal(appearance.terminalBackgroundFocusDimming, true);
  assert.equal(appearance.terminalBackgroundContrast, 0);
  assert.equal(appearance.terminalBackgroundSaturation, 200);
  const oldPreset = normalizeBackgroundAppearance({ terminalBackground: "donut" });
  assert.equal(oldPreset.terminalBackgroundContrast, 100);
  assert.equal(oldPreset.terminalBackgroundSaturation, 100);
  const invalid = normalizeBackgroundAppearance({ terminalBackgroundContrast: NaN, terminalBackgroundSaturation: "200" });
  assert.equal(invalid.terminalBackgroundContrast, 100);
  assert.equal(invalid.terminalBackgroundSaturation, 100);
  assert(!("palette" in appearance));
  assert.deepEqual(normalizeBackgroundOverrides([]), {});
  assert.deepEqual(Object.keys(normalizeBackgroundOverrides({ a: appearance, b: null, c: [] })), ["a"]);
  const presets = normalizeBackgroundPresets([
    { id: "one", name: "  Saved  ", appearance },
    { id: "one", name: "Duplicate", appearance }, { id: "two", name: " " }, null,
  ]);
  assert.equal(presets.length, 1);
  assert.equal(presets[0].name, "Saved");
});

test("per-terminal backgrounds, presets and optional controls survive settings reload", async t => {
  const dir = await mkdtemp(join(tmpdir(), "background-appearance-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new SettingsStore(dir, "en");
  await store.load();
  assert.equal(store.get().terminalBackgroundPauseInactive, false);
  const appearance = normalizeBackgroundAppearance({ terminalBackground: "donut", terminalBackgroundPauseOnOutput: true, terminalBackgroundReadabilityStrength: 35, terminalBackgroundContrast: 150, terminalBackgroundSaturation: 0 });
  await store.update({
    terminalBackground: "none", terminalBackgroundPauseOnOutput: true,
    terminalBackgroundFocusDimming: true,
    terminalBackgroundSynchronized: true,
    terminalBackgroundPauseInactive: true,
    terminalBackgroundReadabilityStrength: 48,
    terminalBackgroundContrast: 120, terminalBackgroundSaturation: 180,
    terminalBackgroundOverrides: { first: appearance, second: { ...appearance, terminalBackground: "none" } },
    terminalBackgroundPresets: [{ id: "saved", name: "My preset", appearance }],
  });
  const restored = await new SettingsStore(dir, "en").load();
  assert.equal(restored.terminalBackground, "none");
  assert.equal(restored.terminalBackgroundPauseOnOutput, true);
  assert.equal(restored.terminalBackgroundFocusDimming, true);
  assert.equal(restored.terminalBackgroundSynchronized, true);
  assert.equal(restored.terminalBackgroundPauseInactive, true);
  assert.equal(restored.terminalBackgroundReadabilityStrength, 48);
  assert.equal(restored.terminalBackgroundContrast, 120);
  assert.equal(restored.terminalBackgroundSaturation, 180);
  assert.equal(restored.terminalBackgroundOverrides.first.terminalBackgroundContrast, 150);
  assert.equal(restored.terminalBackgroundOverrides.first.terminalBackgroundSaturation, 0);
  assert.equal(restored.terminalBackgroundOverrides.first.terminalBackground, "donut");
  assert.equal(restored.terminalBackgroundOverrides.second.terminalBackground, "none");
  assert.deepEqual(restored.terminalBackgroundPresets[0].appearance, appearance);
});

test("output pauses only when enabled, extends a single timeout and resumes after silence", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let changes = 0;
  const pause = createBackgroundOutputPause(() => changes++);
  pause.activity();
  assert.equal(pause.isPaused(), false);
  pause.setEnabled(true);
  pause.activity();
  assert.equal(pause.isPaused(), true);
  assert.equal(changes, 1);
  t.mock.timers.tick(900);
  pause.activity();
  assert.equal(changes, 1);
  t.mock.timers.tick(900);
  assert.equal(pause.isPaused(), true);
  t.mock.timers.tick(100);
  assert.equal(pause.isPaused(), false);
  assert.equal(changes, 2);
  pause.activity();
  pause.setEnabled(false);
  assert.equal(pause.isPaused(), false);
  const afterDisable = changes;
  t.mock.timers.tick(2000);
  assert.equal(changes, afterDisable);
  pause.setEnabled(true);
  pause.activity();
  pause.dispose();
  const afterDispose = changes;
  t.mock.timers.tick(2000);
  pause.activity();
  assert.equal(changes, afterDispose);
});

test("disabling all terminal backgrounds clears root background and all terminal overrides", async t => {
  const dir = await mkdtemp(join(tmpdir(), "background-disable-all-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new SettingsStore(dir, "ru");
  await store.load();
  const appearance1 = normalizeBackgroundAppearance({ terminalBackground: "blade-runner-2049" });
  const appearance2 = normalizeBackgroundAppearance({ terminalBackground: "moon-astronaut" });
  await store.update({
    terminalBackground: "kill-la-kill",
    terminalBackgroundOverrides: {
      "session-1": appearance1,
      "session-2": appearance2,
    },
  });
  let state = store.get();
  assert.equal(state.terminalBackground, "kill-la-kill");
  assert.equal(Object.keys(state.terminalBackgroundOverrides).length, 2);

  // Apply disable all action
  await store.update({
    terminalBackground: "none",
    terminalBackgroundOverrides: {},
  });
  state = store.get();
  assert.equal(state.terminalBackground, "none");
  assert.deepEqual(state.terminalBackgroundOverrides, {});
});
