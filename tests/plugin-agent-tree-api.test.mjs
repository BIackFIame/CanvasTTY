// The two read-only host additions an agent tree in a plugin needs: the model a card was launched with in session
// summaries (sessions:events), and sessions.focus for plugin pages (sessions:read, on the person's action only).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PluginSessions } from "../src/main/services/PluginSessions.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { sessionToFocus } from "../src/renderer/src/features/plugins/sessionFocus.ts";

const cwd = process.cwd();
const at = { x: 0, y: 0 };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function world() {
  const notices = [];
  let sessions = null;
  const clis = {
    get: (provider) => ({ state: "available", provider, executable: `/resolved/${provider}`, launcher: "native", environment: { PATH: "/usr/bin" }, checked: [] }),
    snapshot: () => ({})
  };
  const spawn = () => ({
    pid: 61_000, process: "x", write() {}, resize() {}, kill() {}, pause() {}, resume() {},
    onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }
  });
  const terminals = new TerminalManager((channel, payload) => sessions?.observe(channel, payload), clis, undefined, undefined, true, spawn);
  sessions = new PluginSessions({ terminals, notify: (pluginId, serviceId, method, params) => { notices.push(structuredClone(params)); return true; } });
  return { notices, terminals, sessions };
}

test("session summaries name the model and effort a card was launched with, and nothing when it named none", async () => {
  const { notices, terminals, sessions } = world();
  sessions.handle("p1", "svc", "sessions.subscribe", {}, ["sessions:events"]);
  const orchestrator = terminals.create({ provider: "claude", cwd, profile: "normal", position: at, role: "orchestrator", title: "Lead", model: "opus", effort: "high" });
  const child = terminals.create({ provider: "codex", cwd, profile: "normal", position: at, role: "subagent", parentSessionId: orchestrator.id, title: "Worker" });
  await flush();
  const lead = sessions.summary(orchestrator.id);
  assert.equal(lead.model, "opus");
  assert.equal(lead.effort, "high");
  const worker = sessions.summary(child.id);
  assert.equal(worker.parentSessionId, orchestrator.id);
  assert.equal("model" in worker, false, "a card on the CLI's own default has no model key");
  assert.equal("effort" in worker, false);
  const created = notices.filter((event) => event.type === "created");
  assert.deepEqual(created.map((event) => [event.session.title, event.session.model ?? null]), [["Lead", "opus"], ["Worker", null]]);
  // The summary still carries no screen text and no launch secrets.
  assert.ok(created.every((event) => !("screen" in event) && !("secretEnv" in event.session) && !("launchOptions" in event.session)));
  const listed = sessions.handle("p1", "svc", "sessions.list", {}, ["sessions:events"]).sessions;
  assert.equal(listed.find((entry) => entry.id === orchestrator.id).model, "opus");
});

test("sessions.focus needs sessions:read, a surface that can focus, the person in the frame and an open card", () => {
  const cards = [{ id: "a" }, { id: "b" }];
  const base = { permissions: ["sessions:read"], sessions: cards, sessionId: "b", personInFrame: true, available: true };
  assert.equal(sessionToFocus(base), cards[1]);
  assert.throws(() => sessionToFocus({ ...base, permissions: ["sessions:events"] }), /sessions:read/u);
  assert.throws(() => sessionToFocus({ ...base, available: false }), /cannot focus/u);
  assert.throws(() => sessionToFocus({ ...base, personInFrame: false }), /action of the person/u);
  assert.throws(() => sessionToFocus({ ...base, sessionId: "gone" }), /No open card/u);
  for (const sessionId of [undefined, "", 7, "x".repeat(201)]) assert.throws(() => sessionToFocus({ ...base, sessionId }), /requires sessionId/u);
});

test("PluginFrame routes sessions.focus through sessionToFocus with the frame's focus state; only canvas cards and HOME widgets offer it", async () => {
  const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const [frame, card, workspace, home, ipc, sdk] = await Promise.all([
    read("src/renderer/src/features/plugins/PluginFrame.tsx"), read("src/renderer/src/features/plugins/PluginCanvasCard.tsx"),
    read("src/renderer/src/features/workspace/WorkspaceCanvas.tsx"), read("src/renderer/src/features/home/HomeZone.tsx"),
    read("src/main/ipc/registerIpc.ts"), read("src/main/services/PluginManager.ts")
  ]);
  assert.match(frame, /method === "sessions\.focus"[\s\S]{0,300}await import\("\.\/sessionFocus"\)[\s\S]{0,100}sessionToFocus\(\{/u);
  assert.doesNotMatch(frame, /^import .*sessionFocus/mu, "the rules load on the first request, not at startup");
  assert.match(frame, /personInFrame = frame\.current !== null && document\.activeElement === frame\.current/u);
  assert.match(card, /onFocusSession=\{onFocusSession\}/u);
  assert.match(workspace, /onFocusSession=\{focusSessionFromHome\}/u);
  assert.match(home, /onFocusSession=\{onFocusSession\}/u);
  // Separate windows have no canvas to move: the main-process route does not know the method.
  assert.doesNotMatch(ipc, /sessions\.focus/u);
  assert.match(sdk, /focusSession: \(sessionId\) => request\("sessions\.focus", \{ sessionId \}\)/u);
});
