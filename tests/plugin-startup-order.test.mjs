/**
 * Plugin services start only after the host APIs they may call exist. The wiring mirrors src/main/index.ts: the
 * supervisor is built and synced early, PluginSessions, PluginCards and the plugin secrets are built later, and
 * saved cards are restored after that. A service that subscribes on initialize gets a valid snapshot and the
 * restored/new card events without a disable/enable cycle. No real CLI runs; HOME is the runner's fake one.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { PluginCards } from "../src/main/services/PluginCards.ts";
import { PluginServiceSupervisor } from "../src/main/services/PluginServiceSupervisor.ts";
import { PluginSessions } from "../src/main/services/PluginSessions.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { TerminalSessionStore } from "../src/main/services/TerminalSessionStore.ts";

const entryPath = new URL("./fixtures/startup-subscriber-service.mjs", import.meta.url).pathname;
const cwd = process.cwd();
const at = { x: 0, y: 0 };
const waitFor = async (predicate, timeoutMs = 8_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met in time.");
};

test("a service that subscribes on initialize gets a snapshot and restored/new events, even when the host starts slowly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-startup-order-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "terminal-sessions.json"), JSON.stringify({ version: 2, sessions: [{
    id: "saved-1", provider: "terminal", profile: "normal", role: "agent", title: "Saved", titleCustomized: false, cwd,
    position: at, size: { width: 700, height: 430 }, lastState: "running", restore: true
  }] }));

  // index.ts order: these exist only later; until then the host callbacks answer the way index.ts does.
  let sessions = null;
  let cards = null;
  let secrets = null;
  const events = [];
  const supervisor = new PluginServiceSupervisor({
    command: process.execPath, hostVersion: "9.9.9", locale: () => "en", stopGraceMs: 300, waitForHost: true,
    host: {
      storageGet: async () => null, storageSet: async () => undefined,
      emit: (_pluginId, _serviceId, event, data) => events.push({ event, data }),
      secretGet: (_pluginId, key) => {
        if (!secrets) throw new Error("Plugin secrets are not ready yet.");
        return secrets.get(key);
      },
      sessions: (pluginId, serviceId, method, params, permissions) => sessions?.handle(pluginId, serviceId, method, params, permissions),
      setBadge: (pluginId, params) => {
        if (!cards) throw new Error("Cards are not ready yet.");
        return cards.setBadge(pluginId, params);
      },
      stopped: (pluginId, serviceId) => sessions?.serviceStopped(pluginId, serviceId)
    }
  });
  t.after(() => supervisor.dispose());
  const started = supervisor.sync([{ pluginId: "p.watch", serviceId: "svc", root: dirname(entryPath), entryPath, dataDir: join(root, "data"),
    permissions: ["sessions:events", "secrets", "cards:decorate"], sha256: createHash("sha256").update(await readFile(entryPath)).digest("hex") }]);

  // A slow host start: the rest of main's startup runs before the host APIs exist.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const terminals = new TerminalManager((channel, payload) => sessions?.observe(channel, payload),
    { get: (provider) => ({ state: "available", provider, executable: "/bin/sh", launcher: "native", environment: {}, checked: [] }), snapshot: () => ({}) },
    undefined, undefined, true, () => ({ pid: 1, write() {}, resize() {}, kill() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; } }));
  t.after(() => terminals.shutdown());
  terminals.configureSessionPersistence(new TerminalSessionStore(root), "continue");
  sessions = new PluginSessions({ terminals, notify: (pluginId, serviceId, method, params) => supervisor.notify(pluginId, serviceId, method, params) });
  cards = new PluginCards({ providers: () => [], trustedPlugins: () => new Set(["p.watch"]), call: async () => null,
    session: (id) => sessions.summary(id), redact: (text) => text, changed: () => undefined });
  secrets = { get: async () => "token-value-123" };
  // index.ts: the host APIs exist now; services may start. Then saved cards are restored.
  supervisor.hostReady?.();
  await started;
  await terminals.restorePersistedSessions();

  await waitFor(() => events.some((entry) => entry.event === "startup"));
  // A card the person opens after startup.
  const created = terminals.create({ provider: "terminal", profile: "normal", cwd, position: at });
  const { data: startup } = events.find((entry) => entry.event === "startup");
  assert.equal(startup.subscribe.error, undefined, `subscribe failed: ${startup.subscribe.error}`);
  assert.ok(Array.isArray(startup.subscribe.result.sessions), "a valid snapshot");
  assert.deepEqual(startup.secret, { result: "token-value-123" });
  assert.match(startup.badge.error, /No card has that session id/u, "cards answered (not 'not ready')");
  const log = supervisor.report("p.watch").log.map((entry) => entry.message).join("\n");
  assert.doesNotMatch(log, /Unknown host method|not ready/u);

  // Every card is seen exactly once: in the snapshot or as a restored/created event, then its later events.
  await waitFor(() => events.some((entry) => entry.event === "session" && entry.data.id === created.id));
  const snapshotIds = startup.subscribe.result.sessions.map((session) => session.id);
  const firstSeen = (id) => (snapshotIds.includes(id) ? 1 : 0)
    + events.filter((entry) => entry.event === "session" && entry.data.id === id && ["restored", "created"].includes(entry.data.type)).length;
  assert.equal(firstSeen("saved-1"), 1, "the restored card");
  assert.equal(firstSeen(created.id), 1, "the new card");
  assert.ok(events.some((entry) => entry.event === "session" && entry.data.id === created.id && entry.data.type === "created"));
});

test("disposing before the host is ready ends the waiting start without spawning anything", async (t) => {
  const supervisor = new PluginServiceSupervisor({ command: process.execPath, hostVersion: "9.9.9", locale: () => "en", stopGraceMs: 300,
    waitForHost: true, host: { storageGet: async () => null, storageSet: async () => undefined, emit: () => undefined } });
  t.after(() => supervisor.dispose());
  const started = supervisor.sync([{ pluginId: "p.watch", serviceId: "svc", root: dirname(entryPath), entryPath, dataDir: join(tmpdir(), "never"),
    permissions: [], sha256: createHash("sha256").update(await readFile(entryPath)).digest("hex") }]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(supervisor.running("p.watch", "svc"), false, "not started before the host is ready");
  await supervisor.dispose();
  await started;
  assert.deepEqual(supervisor.report("p.watch").services, []);
});
