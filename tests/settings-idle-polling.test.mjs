import assert from "node:assert/strict";
import test from "node:test";
import { importWithFakeReact } from "./helpers/fake-react.mjs";

// Settings mounts EvenG2Controls and PluginServicesSettings unconditionally (only their CSS visibility
// changes when the overlay is closed), so their polling intervals used to keep firing network/IPC calls
// while the person never opened Settings at all. Both now take an `open` prop and must not schedule (or
// must tear down) their poll timer while it is false.

const { EvenG2Controls, __render, __flush, __unmount, __reset } = await importWithFakeReact(
  "src/renderer/src/features/settings/EvenG2Controls.tsx",
  "EvenG2Controls"
);

function stubTimers() {
  const real = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  const timers = { scheduled: 0, cleared: 0, callback: null };
  globalThis.setInterval = (callback) => { timers.scheduled += 1; timers.callback = callback; return 1; };
  globalThis.clearInterval = () => { timers.cleared += 1; };
  return {
    timers,
    restore() { globalThis.setInterval = real.setInterval; globalThis.clearInterval = real.clearInterval; }
  };
}

test("EvenG2Controls does not poll device state while Settings is closed", async (t) => {
  const { timers, restore } = stubTimers();
  let stateCalls = 0;
  globalThis.window = {
    canvasTTY: {
      evenG2: {
        state() { stateCalls += 1; return Promise.resolve({ config: { enabled: false, speechExecutable: "" }, transport: { ready: false }, pairing: false }); },
        command: async () => null
      }
    }
  };
  t.after(() => { restore(); __unmount(); delete globalThis.window; });

  __reset();
  __render(EvenG2Controls, { locale: "en", open: false });

  assert.equal(stateCalls, 0, "closed Settings must not fetch device state at all");
  assert.equal(timers.scheduled, 0, "closed Settings must not schedule a poll timer");

  __flush();
  __render(EvenG2Controls, { locale: "en", open: true });
  assert.equal(stateCalls, 1, "opening Settings triggers one immediate read");
  assert.equal(timers.scheduled, 1, "opening Settings schedules exactly one poll timer");

  timers.callback();
  assert.equal(stateCalls, 2, "the scheduled timer polls while open");

  __flush();
  __render(EvenG2Controls, { locale: "en", open: false });
  assert.equal(timers.cleared, 1, "closing Settings tears down the poll timer, so a real clearInterval stops further callbacks");
});

const { PluginServicesSettings, __render: renderPlugins, __flush: flushPlugins, __unmount: unmountPlugins, __reset: resetPlugins } =
  await importWithFakeReact(
    "src/renderer/src/features/settings/PluginServicesSettings.tsx",
    "PluginServicesSettings"
  );

function servicePlugin(id) {
  return {
    manifest: { id, name: id, version: "1.0.0", services: [{ id: "svc", title: "Svc", entry: "svc.js" }] },
    sourceUrl: "", enabled: true, installedAt: 0, selectedModules: [], enabledHooks: [],
    nativeCodeTrusted: true, decisionsMayAllow: false
  };
}

test("PluginServicesSettings does not poll service reports while Settings is closed", async (t) => {
  const real = { setInterval: globalThis.window?.setInterval, clearInterval: globalThis.window?.clearInterval };
  let reportCalls = 0;
  let scheduled = 0;
  let cleared = 0;
  let callback = null;
  globalThis.window = {
    setInterval(cb) { scheduled += 1; callback = cb; return 1; },
    clearInterval() { cleared += 1; },
    canvasTTY: {
      plugins: { serviceReport: async () => { reportCalls += 1; return { services: [], log: [] }; } },
      githubAuth: { openUrl: async () => undefined }
    }
  };
  t.after(() => { unmountPlugins(); delete globalThis.window; void real; });

  resetPlugins();
  const props = { locale: "en", plugins: [servicePlugin("demo")], open: false, onSetNativeCodeTrusted: async () => undefined, onSetDecisionsMayAllow: async () => undefined };
  renderPlugins(PluginServicesSettings, props);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(reportCalls, 0, "closed Settings must not fetch service reports at all");
  assert.equal(scheduled, 0, "closed Settings must not schedule a poll timer");

  flushPlugins();
  renderPlugins(PluginServicesSettings, { ...props, open: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(scheduled, 1, "opening Settings schedules exactly one poll timer");
  assert.ok(reportCalls >= 1, "opening Settings triggers an immediate refresh");

  const callsAfterOpen = reportCalls;
  await callback();
  assert.ok(reportCalls > callsAfterOpen, "the scheduled timer polls while open");

  flushPlugins();
  renderPlugins(PluginServicesSettings, { ...props, open: false });
  assert.equal(cleared, 1, "closing Settings tears down the poll timer");
});
