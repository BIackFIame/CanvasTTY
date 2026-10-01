import assert from "node:assert/strict";
import test from "node:test";
import { importWithFakeReact } from "./helpers/fake-react.mjs";

// Settings mounts EvenG2Controls and PluginServicesSettings unconditionally (only their CSS visibility
// changes when the overlay is closed), so their polling intervals used to keep firing network/IPC calls
// while the person never opened Settings at all. Both now take an `open` prop and must not schedule (or
// must tear down) their poll timer while it is false.

const { EvenG2Controls, __render, __unmount, __reset } = await importWithFakeReact(
  "src/renderer/src/features/settings/EvenG2Controls.tsx",
  "EvenG2Controls"
);

/** The poll's timer (settingsPolling.ts schedules each next read with window.setTimeout). */
function stubTimers() {
  const timers = { scheduled: 0, cleared: 0, callback: null };
  return {
    timers,
    install(target) {
      target.setTimeout = (callback) => { timers.scheduled += 1; timers.callback = callback; return timers.scheduled; };
      target.clearTimeout = () => { timers.cleared += 1; };
    }
  };
}

const settle = async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); };

test("EvenG2Controls does not poll device state while Settings is closed", async (t) => {
  const { timers, install } = stubTimers();
  let stateCalls = 0;
  globalThis.window = {
    canvasTTY: {
      evenG2: {
        state() { stateCalls += 1; return Promise.resolve({ config: { enabled: false, speechExecutable: "" }, transport: { ready: false }, pairing: false }); },
        command: async () => null
      }
    }
  };
  install(globalThis.window);
  t.after(() => { __unmount(); delete globalThis.window; });

  __reset();
  __render(EvenG2Controls, { locale: "en", open: false });
  await settle();

  assert.equal(stateCalls, 0, "closed Settings must not fetch device state at all");
  assert.equal(timers.scheduled, 0, "closed Settings must not schedule a poll timer");

  __render(EvenG2Controls, { locale: "en", open: true });
  assert.equal(stateCalls, 1, "opening Settings triggers one immediate read");
  await settle();
  assert.equal(timers.scheduled, 1, "the next read is scheduled once the first one settles");

  timers.callback();
  assert.equal(stateCalls, 2, "the scheduled timer polls while open");

  // State updates stay queued (unflushed): the fake state never needs a full device snapshot.
  __render(EvenG2Controls, { locale: "en", open: false });
  assert.equal(timers.cleared, 0, "the read in flight has no timer to cancel yet");
  const scheduled = timers.scheduled;
  await settle();
  assert.equal(timers.scheduled, scheduled, "and once it settles no next read is scheduled");
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
  const { timers, install } = stubTimers();
  let reportCalls = 0;
  globalThis.window = {
    canvasTTY: {
      plugins: { serviceReport: async () => { reportCalls += 1; return { services: [], log: [] }; } },
      githubAuth: { openUrl: async () => undefined }
    }
  };
  install(globalThis.window);
  t.after(() => { unmountPlugins(); delete globalThis.window; });

  resetPlugins();
  const props = { locale: "en", plugins: [servicePlugin("demo")], open: false, onSetNativeCodeTrusted: async () => undefined, onSetDecisionsMayAllow: async () => undefined };
  renderPlugins(PluginServicesSettings, props);
  await settle();

  assert.equal(reportCalls, 0, "closed Settings must not fetch service reports at all");
  assert.equal(timers.scheduled, 0, "closed Settings must not schedule a poll timer");

  flushPlugins();
  renderPlugins(PluginServicesSettings, { ...props, open: true });
  await settle();
  assert.equal(reportCalls, 1, "opening Settings triggers an immediate refresh");
  assert.equal(timers.scheduled, 1, "and schedules exactly one next refresh");

  timers.callback();
  await settle();
  assert.equal(reportCalls, 2, "the scheduled timer polls while open");

  flushPlugins();
  renderPlugins(PluginServicesSettings, { ...props, open: false });
  assert.equal(timers.cleared, 1, "closing Settings cancels the pending refresh");
  await settle();
  assert.equal(reportCalls, 2);
});
