import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { controlRequest, parseArguments, runCli } from "../scripts/canvastty-control.mjs";
import xterm from "@xterm/headless";
import { AgentControlGateway, codexComposerReady } from "../src/main/services/agent-control/AgentControlGateway.ts";
import { TerminalManager, terminalEnvironment } from "../src/main/services/TerminalManager.ts";
import { TerminalSessionStore } from "../src/main/services/TerminalSessionStore.ts";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";
import {
  AGENT_RUNTIME_ENV,
  CAPTURE_ANSWER_ENV,
  CAPTURE_ANSWER_EXPIRES_AT_ENV,
  CAPTURE_RESULT_ENV,
  MAX_ANSWER_CHARS,
  MAX_RESULT_CHARS,
  MAX_RUNTIME_MESSAGE_BYTES
} from "../src/agent-runtime/runtime-protocol.mjs";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const localSocket = { skip: process.platform === "win32" ? "Unix socket tests; native Windows pipe relay has its own suite." : false };
const PROMPT = "\x1b[2J\x1b[H>_ OpenAI Codex\r\nmodel: test\r\npermissions: YOLO mode\r\n\r\n› Ask Codex to do anything";

function registry() {
  return { get: (provider) => ({ state: "available", provider, executable: "/resolved/codex", launcher: "native",
    environment: {}, checked: [] }), snapshot: () => ({}) };
}

async function fixture(t, gatewayOptions = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-control-test-")));
  const calls = [];
  let gateway;
  const terminals = new TerminalManager((channel, payload) => gateway?.observe(channel, payload), registry(), undefined, undefined, true,
    (command, args, options) => {
      let onData = () => {};
      let onExit = () => {};
      const pty = { write(text) { this.writes.push(text); }, writes: [], resize() {}, kill() {},
        onData(fn) { onData = fn; }, onExit(fn) { onExit = fn; },
        data(text) { onData(text); }, exit(code) { onExit({ exitCode: code }); } };
      calls.push({ command, args, options, pty });
      return pty;
    });
  let lifecycleEnabled = true;
  gateway = new AgentControlGateway({ userDataPath: root, terminals, lifecycleEnabled: () => lifecycleEnabled, ...gatewayOptions });
  const connectionPath = await gateway.start();
  const clientPath = join(root, "client-a.json");
  t.after(async () => { await gateway.close(); await terminals.shutdown(); });
  const request = (method, params = {}, requestId = randomUUID(), client = clientPath) =>
    controlRequest({ connectionPath, clientPath: client, method, params, requestId });
  const create = (requestId) => request("create", { provider: "codex", profile: "yolo", cwd: root, title: "Owned worker" }, requestId);
  const signal = (id, state, turnId = "provider-turn", result) => {
    terminals.applyProviderSignal(id, { kind: "lifecycle", state });
    gateway.onSignal(id, { state, event: state === "working" ? "UserPromptSubmit" : "Stop", turnId,
      ...(result === undefined ? {} : { result }) });
  };
  const ready = async (id, pty = calls.at(-1).pty) => {
    pty.data(PROMPT);
    for (let i = 0; i < 30; i++) {
      if (codexComposerReady((await request("screen", { sessionId: id })).text)) return;
      await delay(5);
    }
    assert.fail("fixture composer not ready");
  };
  return { root, gateway, terminals, calls, connectionPath, clientPath, request, create, signal, ready,
    disableLifecycle() { lifecycleEnabled = false; } };
}

test("CLI creates native YOLO with requested directory/title, including concurrent replay", localSocket, async (t) => {
  const f = await fixture(t);
  const args = ["--connection", f.connectionPath, "--client-file", f.clientPath, "--request-id", "same-create",
    "create", "--cwd", f.root, "--title", "API worker", "--yolo"];
  const [a, b] = await Promise.all([runCli(args), runCli(args)]);
  assert.equal(a.result.session.id, b.result.session.id);
  assert.equal(f.calls.length, 1);
  assert.equal(a.result.session.provider, "codex");
  assert.equal(a.result.session.profile, "yolo");
  assert.equal(a.result.session.cwd, f.root);
  assert.equal(a.result.session.title, "API worker");
  assert.ok(f.calls[0].args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!f.calls[0].args.includes("read-only"));
  assert.equal(f.calls[0].options.cwd, f.root);
  const descriptor = JSON.parse(await readFile(f.connectionPath, "utf8"));
  assert.equal((await stat(descriptor.endpoint)).mode & 0o777, 0o600);
  assert.equal((await stat(descriptor.tokenFile)).mode & 0o777, 0o600);
  await assert.rejects(runCli([...args.slice(0, 6), "create", "--cwd", f.root, "--title", "Different"]),
    (e) => e.code === "REQUEST_CONFLICT");
  assert.equal(f.calls.length, 1);
});

test("request receipts are bounded without locking the gateway, and a refused request can be retried", localSocket, async (t) => {
  const f = await fixture(t, { maxReceipts: 3 });
  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(f.request("interrupt", { sessionId: `missing-${index}` }, `missing-${index}`), (e) => e.code === "SESSION_NOT_FOUND");
  }
  // Before: the fourth mutating request (successful or not) got LIMIT_REACHED until restart.
  const { session } = await f.create("create-after-limit");
  assert.equal((await f.create("create-after-limit")).session.id, session.id, "a recent receipt still replays");
  await f.ready(session.id);
  await f.request("send", { sessionId: session.id, text: "first" }, "send-first");
  f.signal(session.id, "working", "turn-one");
  await assert.rejects(f.request("send", { sessionId: session.id, text: "second" }, "send-second"), (e) => e.code === "BUSY");
  f.signal(session.id, "idle", "turn-one", { text: "done", truncated: false });
  // BUSY wrote nothing, so the same request id is performed on retry instead of replaying BUSY.
  const retried = await f.request("send", { sessionId: session.id, text: "second" }, "send-second");
  assert.equal(retried.sessionId, session.id);
  assert.equal(f.calls[0].pty.writes.length, 2);
});

test("a failed start leaves nothing listening, so the same gateway can start again", localSocket, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-control-start-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userDataPath = join(root, "user-data");
  await writeFile(userDataPath, "a file where the folder should be");
  const gateway = new AgentControlGateway({ userDataPath, terminals: {}, lifecycleEnabled: () => true });
  t.after(() => gateway.close());
  await assert.rejects(gateway.start());
  await rm(userDataPath);
  const connection = await gateway.start();
  const descriptor = JSON.parse(await readFile(connection, "utf8"));
  assert.equal((await stat(descriptor.endpoint)).isSocket(), true);
});

test("agent control brings the Windows pipe host back after it fails and republishes the endpoint", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-control-win-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transports = [];
  let restarted;
  const republished = new Promise((resolve) => { restarted = resolve; });
  const gateway = new AgentControlGateway({
    userDataPath: root, terminals: {}, lifecycleEnabled: () => true, platform: "win32", windowsHostPath: "C:\\fake\\host.exe",
    onTransportRestarted: (path) => restarted(path),
    windowsPipeHostFactory: () => {
      const transport = new EventEmitter();
      const index = transports.length;
      transport.start = async () => `\\\\.\\pipe\\canvastty-agent-${index}`;
      transport.close = async () => undefined;
      transports.push(transport);
      return transport;
    }
  });
  t.after(() => gateway.close());
  const connection = await gateway.start();
  assert.match(JSON.parse(await readFile(connection, "utf8")).endpoint, /agent-0$/);
  transports[0].emit("fatal", new Error("host exited"));
  t.mock.timers.tick(500);
  assert.equal(await republished, connection);
  assert.match(JSON.parse(await readFile(connection, "utf8")).endpoint, /agent-1$/);
  await gateway.close();
  transports[1].emit("fatal", new Error("late"));
  t.mock.timers.tick(10_000);
  assert.equal(transports.length, 2);
});

test("controller cannot list, read, interrupt or send to other controllers or UI sessions", localSocket, async (t) => {
  const f = await fixture(t);
  const { session } = await f.create();
  const clientB = join(f.root, "client-b.json");
  assert.deepEqual((await f.request("list", {}, undefined, clientB)).sessions, []);
  for (const method of ["status", "screen", "result", "interrupt", "send", "choose", "dismiss"]) {
    await assert.rejects(f.request(method, { sessionId: session.id, ...(method === "send" ? { text: "task" } : {}) }, undefined, clientB),
      (e) => e.code === "SESSION_NOT_FOUND");
  }
  const ui = f.terminals.create({ provider: "codex", profile: "normal", cwd: f.root, position: { x: 0, y: 0 } });
  await assert.rejects(f.request("status", { sessionId: ui.id }), (e) => e.code === "SESSION_NOT_FOUND");
});

test("literal prompt delivery, busy guard, result revisions and stale-result separation", localSocket, async (t) => {
  const f = await fixture(t);
  const { session } = await f.create();
  await f.ready(session.id);
  const text = 'Check "$1" and $(literal text)\nsecond line';
  const first = await f.request("send", { sessionId: session.id, text }, "send-one");
  await f.request("send", { sessionId: session.id, text }, "send-one");
  assert.deepEqual(f.calls[0].pty.writes, [`\x1b[200~${text}\x1b[201~\r`]);
  assert.equal(first.resultRevisionBefore, 0);
  assert.equal((await f.request("result", { sessionId: session.id })).fresh, false);
  f.signal(session.id, "idle", "old-turn", { text: "stale", truncated: false });
  assert.equal((await f.request("result", { sessionId: session.id })).fresh, false);
  f.signal(session.id, "working", "native-one");
  await assert.rejects(f.request("send", { sessionId: session.id, text: "another" }), (e) => e.code === "BUSY");
  f.signal(session.id, "idle", "old-turn", { text: "stale", truncated: false });
  assert.equal((await f.request("result", { sessionId: session.id })).fresh, false);
  f.signal(session.id, "idle", "native-one", { text: "done-one", truncated: false });
  const result = await f.request("result", { sessionId: session.id, after: 0 });
  assert.equal(result.resultRevision, 1);
  assert.equal(result.turn.result.text, "done-one");
  assert.equal((await f.request("result", { sessionId: session.id, after: 1 })).fresh, false);
  await f.request("send", { sessionId: session.id, text: "next" }, "send-two");
  const old = await f.request("result", { sessionId: session.id, after: 0 });
  assert.equal(old.turn.id, "send-one");
  assert.equal(old.turn.state, "completed");
  assert.equal((await f.request("result", { sessionId: session.id, after: 1 })).fresh, false);
});

test("interrupt affects one owned turn and reports completion only after lifecycle confirmation", localSocket, async (t) => {
  const f = await fixture(t);
  const { session } = await f.create();
  await f.ready(session.id);
  await f.request("send", { sessionId: session.id, text: "work" });
  f.signal(session.id, "working");
  const result = await f.request("interrupt", { sessionId: session.id }, "interrupt-one");
  await f.request("interrupt", { sessionId: session.id }, "interrupt-one");
  assert.equal(result.stopped, false);
  assert.equal(f.calls[0].pty.writes.filter((x) => x === "\x03").length, 1);
  assert.equal((await f.request("result", { sessionId: session.id })).fresh, false);
  f.signal(session.id, "idle");
  assert.equal((await f.request("result", { sessionId: session.id })).turn.state, "interrupted");
});

test("startup/trust/permission menus, slash commands and terminal escape input are not task submission", localSocket, async (t) => {
  const f = await fixture(t);
  const { session } = await f.create();
  await assert.rejects(f.request("send", { sessionId: session.id, text: "task" }), (e) => e.code === "NOT_READY");
  await f.ready(session.id);
  for (const text of ["/permissions", "\x1b[2J", "abc\rdef", "\0", "x".repeat(16001)]) {
    await assert.rejects(f.request("send", { sessionId: session.id, text }), (e) => e.code === "INVALID_PARAMS");
  }
  assert.equal(f.calls[0].pty.writes.length, 0);
  assert.equal(codexComposerReady("Do you trust the contents\n› Ask Codex to do anything"), false);
  assert.equal(codexComposerReady("model: loading\n› Ask Codex to do anything"), false);
  assert.equal(codexComposerReady("› 1. Yes, continue\nPress enter to confirm"), false);
  assert.equal(codexComposerReady("› partially typed human text"), false);
});

test("explicit menu choices use the observed revision and deduplicate PTY input", localSocket, async (t) => {
  const f = await fixture(t);
  const { session } = await f.create();
  const pty = f.calls[0].pty;
  const observe = async (text, expected) => {
    pty.data(text);
    for (let i = 0; i < 30; i++) {
      const current = await f.request("screen", { sessionId: session.id });
      if (current.text.includes(expected)) return current;
      await delay(5);
    }
    assert.fail("batched PTY output did not arrive");
  };
  const screen = await observe("\x1b[2J\x1b[HHooks need review\r\n› 1. Review hooks\r\n  2. Trust all and continue\r\n  3. Continue without hooks\r\nPress enter to confirm or esc to cancel", "Press enter");
  assert.equal(screen.interaction.selected, 1);
  assert.equal(screen.interaction.options[1].label, "Trust all and continue");
  await assert.rejects(f.request("send", { sessionId: session.id, text: "task" }), (e) => e.code === "NOT_READY");
  await assert.rejects(f.request("choose", { sessionId: session.id, choice: 2, revision: "old" }), (e) => e.code === "STALE_MENU");
  await assert.rejects(f.request("choose", { sessionId: session.id, choice: 4, revision: screen.revision }), (e) => e.code === "INVALID_PARAMS");
  const params = { sessionId: session.id, choice: 2, revision: screen.revision };
  await f.request("choose", params, "choose-once");
  await f.request("choose", params, "choose-once");
  assert.deepEqual(pty.writes, ["\x1b[B\r"]);
  const detail = await observe("\x1b[2J\x1b[HHooks\r\n6 hooks reviewed\r\nPress esc to close", "Press esc");
  await assert.rejects(f.request("dismiss", { sessionId: session.id, revision: screen.revision }), (e) => e.code === "STALE_MENU");
  await f.request("dismiss", { sessionId: session.id, revision: detail.revision }, "dismiss-once");
  await f.request("dismiss", { sessionId: session.id, revision: detail.revision }, "dismiss-once");
  assert.deepEqual(pty.writes, ["\x1b[B\r", "\x1b"]);
  await f.ready(session.id);
  const ready = await f.request("screen", { sessionId: session.id });
  await assert.rejects(f.request("dismiss", { sessionId: session.id, revision: ready.revision }), (e) => e.code === "NOT_MENU");
  await assert.rejects(f.request("choose", { sessionId: session.id, choice: 1, revision: ready.revision }), (e) => e.code === "STALE_MENU");
  assert.equal(pty.writes.length, 2);
});

test("invalid socket credentials cannot launch a native session", localSocket, async (t) => {
  const f = await fixture(t);
  const descriptor = JSON.parse(await readFile(f.connectionPath, "utf8"));
  const reply = await new Promise((resolveReply, reject) => {
    const socket = createConnection(descriptor.endpoint);
    socket.on("error", reject);
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("missing rejection")); });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\n")) { socket.destroy(); resolveReply(JSON.parse(buffer.trim())); }
    });
    socket.on("connect", () => socket.write(JSON.stringify({ v: 1, id: "unauthorized-create", instanceId: descriptor.instanceId,
      token: "0".repeat(64), controller: "1".repeat(64), method: "create",
      params: { provider: "codex", profile: "yolo", cwd: f.root } }) + "\n"));
  });
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, "INVALID_REQUEST");
  assert.equal(f.calls.length, 0);
});

test("a control write waiting on terminal replay cannot reach a restarted session", localSocket, async (t) => {
  const held = [];
  const original = xterm.Terminal.prototype.write;
  xterm.Terminal.prototype.write = function(data, callback) {
    return original.call(this, data, () => { if (typeof callback === "function") held.push(callback); });
  };
  t.after(() => { xterm.Terminal.prototype.write = original; for (const callback of held) callback(); });
  const f = await fixture(t);
  const { session } = await f.create();
  const pending = f.request("send", { sessionId: session.id, text: "must not reach the new pty" });
  await delay(20);
  f.calls[0].pty.exit(1);
  f.terminals.restart(session.id);
  for (const callback of held.splice(0)) callback();
  await assert.rejects(pending, (error) => error.code === "STALE_SESSION");
  assert.equal(f.calls.at(-1).pty.writes.filter((text) => text.includes("must not reach")).length, 0);
});

test("YOLO persists across native restart/restore while stale control grants fail", localSocket, async (t) => {
  const f = await fixture(t);
  f.terminals.configureSessionPersistence(new TerminalSessionStore(f.root), "continue");
  const { session } = await f.create();
  f.calls[0].pty.exit(1);
  await delay(2);
  f.terminals.restart(session.id);
  assert.ok(f.calls[1].args.includes("--dangerously-bypass-approvals-and-sandbox"));
  await assert.rejects(f.request("status", { sessionId: session.id }), (e) => e.code === "STALE_SESSION");
  await f.terminals.shutdown();
  const restoredCalls = [];
  const restored = new TerminalManager(() => {}, registry(), undefined, undefined, true,
    (_command, args) => { restoredCalls.push(args); return { onData() {}, onExit() {}, kill() {}, write() {}, resize() {} }; });
  restored.configureSessionPersistence(new TerminalSessionStore(f.root), "continue");
  await restored.restorePersistedSessions();
  t.after(() => restored.shutdown());
  assert.ok(restoredCalls[0].includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.equal(restored.listMetadata()[0].profile, "yolo");
});

test("disabled lifecycle and invalid parameters fail before launching a process", localSocket, async (t) => {
  const f = await fixture(t);
  for (const extra of [{ provider: "terminal" }, { profile: "read-only" }, { cwd: "relative" }, { title: "x".repeat(81) }, { unexpected: true }]) {
    await assert.rejects(f.request("create", { provider: "codex", profile: "yolo", cwd: f.root, ...extra }), (e) => e.code === "INVALID_PARAMS");
  }
  f.disableLifecycle();
  await assert.rejects(f.create(), (e) => e.code === "LIFECYCLE_DISABLED");
  assert.equal(f.calls.length, 0);
});

test("every agent provider can be a worker, with Codex-only result capture and menus declared honestly", localSocket, async (t) => {
  const f = await fixture(t);
  const codex = await f.create();
  assert.deepEqual(codex.capabilities, { result: true, menus: true });
  assert.ok(f.calls.at(-1).args.includes("tui.animations=false"));

  const claude = await f.request("create", { provider: "claude", profile: "yolo", cwd: f.root, title: "Claude worker" });
  assert.deepEqual(claude.capabilities, { result: false, menus: false });
  assert.equal(claude.session.provider, "claude");
  assert.equal(claude.session.profile, "yolo");
  assert.equal(claude.session.role, "agent");
  assert.ok(!f.calls.at(-1).args.includes("tui.animations=false"));
  assert.equal(CAPTURE_RESULT_ENV in f.calls.at(-1).options.env, false);

  const listed = (await f.request("list")).sessions;
  assert.deepEqual(listed.map((s) => [s.provider, s.capabilities]),
    [["codex", { result: true, menus: true }], ["claude", { result: false, menus: false }]]);

  const pty = f.calls.at(-1).pty;
  pty.data("\x1b[2J\x1b[H› 1. Yes, proceed\r\n  2. No\r\nPress enter to confirm");
  let screen;
  for (let i = 0; i < 30 && !screen?.text.includes("Yes, proceed"); i++) {
    await delay(5);
    screen = await f.request("screen", { sessionId: claude.session.id });
  }
  assert.ok(screen.text.includes("Yes, proceed"), "fixture screen reached the observer");
  assert.equal(screen.interaction, null, "non-Codex menus are never parsed");
  await assert.rejects(f.request("choose", { sessionId: claude.session.id, choice: 1, revision: screen.revision }), (e) => e.code === "NOT_SUPPORTED");
  await assert.rejects(f.request("dismiss", { sessionId: claude.session.id, revision: screen.revision }), (e) => e.code === "NOT_SUPPORTED");

  // send needs only an idle/unavailable status without an active turn; the screen is the sole evidence.
  const sent = await f.request("send", { sessionId: claude.session.id, text: "summarise the repository" });
  assert.equal(sent.delivery, "written-to-pty");
  assert.ok(pty.writes.at(-1).includes("summarise the repository"));
  await assert.rejects(f.request("send", { sessionId: claude.session.id, text: "again" }), (e) => e.code === "BUSY");
  f.signal(claude.session.id, "working");
  f.signal(claude.session.id, "idle");
  const result = await f.request("result", { sessionId: claude.session.id });
  assert.equal(result.fresh, true);
  assert.equal(result.turn.state, "no_result");

  for (const provider of ["terminal", "shell", ""]) {
    await assert.rejects(f.request("create", { provider, profile: "yolo", cwd: f.root }), (e) => e.code === "INVALID_PARAMS");
  }
});

test("CLI rejects inapplicable flags and never sends malformed result revisions", async () => {
  assert.deepEqual(parseArguments(["create", "--cwd", "folder with spaces", "--yolo"]).options, { cwd: "folder with spaces", yolo: true });
  await assert.rejects(runCli(["status", "session", "--profile", "yolo"]), /does not apply/);
  await assert.rejects(runCli(["result", "session", "--after", "NaN"]), /non-negative integer/);
  await assert.rejects(runCli(["create", "--cwd", ".", "--profile", "normal", "--yolo"]), /Conflicting/);
  await assert.rejects(runCli(["send", "session", "--text", "one", "--prompt-file", "two"]), /exactly one/);
});

test("opt-in hook result capture is authenticated, bounded and absent for ordinary sessions", localSocket, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ctty-control-result-"));
  const signals = [];
  const gateway = new RuntimeGateway({ runtimeDirectory: root, onSignal: (id, signal) => signals.push({ id, signal }) });
  await gateway.start();
  t.after(() => gateway.close());
  async function hook(id, capture, leaseCapture, text, answer = false, leaseAnswer = false) {
    const grantExpiresAt = Date.now() + 60_000;
    const cap = gateway.registerSession(id, "codex", leaseCapture, leaseAnswer ? grantExpiresAt : undefined);
    const env = { ...process.env, [AGENT_RUNTIME_ENV.address]: cap.address,
      [AGENT_RUNTIME_ENV.terminalSessionId]: cap.terminalSessionId, [AGENT_RUNTIME_ENV.provider]: cap.provider,
      [AGENT_RUNTIME_ENV.capabilityToken]: cap.capabilityToken, [CAPTURE_RESULT_ENV]: capture ? "1" : "0",
      [CAPTURE_ANSWER_ENV]: answer ? "1" : "0",
      [CAPTURE_ANSWER_EXPIRES_AT_ENV]: answer ? String(grantExpiresAt) : "" };
    const child = spawn(process.execPath, [resolve("src/agent-runtime/hook-helper.mjs"), "idle", "Stop"], { env, stdio: ["pipe", "ignore", "pipe"] });
    child.stdin.end(JSON.stringify({ turn_id: "turn", last_assistant_message: text }));
    await new Promise((done, reject) => { child.on("error", reject); child.on("exit", (code) => code === 0 ? done() : reject(new Error("Hook failed"))); });
  }
  await hook("normal", false, false, "private ordinary response");
  assert.equal(signals[0].signal.result, undefined);
  assert.equal(signals[0].signal.lastAssistantMessage, undefined);
  assert.equal(JSON.stringify(signals).includes("private ordinary response"), false);
  await hook("controlled", true, true, "x".repeat(MAX_RESULT_CHARS + 100));
  assert.equal(signals[1].signal.result.text.length, MAX_RESULT_CHARS);
  assert.equal(signals[1].signal.result.truncated, true);
  await hook("not-authorized", true, false, "must not arrive");
  assert.equal(signals.length, 2);
  assert.equal(terminalEnvironment({ [CAPTURE_RESULT_ENV]: "1", PATH: "/bin" })[CAPTURE_RESULT_ENV], undefined);
  assert.equal(terminalEnvironment({ [CAPTURE_ANSWER_ENV]: "1", PATH: "/bin" })[CAPTURE_ANSWER_ENV], undefined);

  // A Stop payload larger than the wire cap still reports the turn for an ordinary session.
  await hook("large", false, false, "z".repeat(MAX_RUNTIME_MESSAGE_BYTES + 1024));
  assert.equal(signals[2].signal.turnId, "turn");
  assert.equal(signals[2].signal.result, undefined);
  assert.equal(signals[2].signal.lastAssistantMessage, undefined);

  // Companion answer capture is a separate opt-in: bounded, and refused without its lease grant.
  await hook("companion", false, false, "y".repeat(MAX_ANSWER_CHARS + 5), true, true);
  assert.equal(signals[3].signal.result, undefined);
  assert.equal(signals[3].signal.lastAssistantMessage.length, MAX_ANSWER_CHARS);
  assert.equal(gateway.currentStatus("companion"), "idle");
  await hook("companion-unauthorized", false, false, "must not arrive either", true, false);
  assert.equal(signals.length, 5);
  assert.equal(signals[4].signal.lastAssistantMessage, undefined);
  assert.equal(JSON.stringify(signals[4]).includes("must not arrive either"), false);
});

const writes = new Map();

function serviceFixture() {
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls, { onWrite: (data, options) => writes.set(options?.name ?? calls.length, [...(writes.get(options?.name ?? calls.length) ?? []), data]) }));
  const control = new AgentControlService(terminals);
  return { calls, terminals, control };
}

test("spawn creates a subagent next to its parent and delivers the initial prompt", async () => {
  const { terminals, control } = serviceFixture();
  const parent = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 100, y: 100 }
  });
  const child = await control.spawn({
    parentSessionId: parent.id,
    provider: "cursor",
    cwd: process.cwd(),
    initialPrompt: "Fix the failing Button test"
  });

  assert.equal(child.role, "subagent");
  assert.equal(child.parentSessionId, parent.id);
  assert.equal(child.provider, "cursor");
  assert.ok(child.position.x > parent.position.x);
  assert.ok(child.position.y > parent.position.y);

  const sent = [...writes.values()].flat().join("");
  assert.match(sent, /Fix the failing Button test\r/u);
  terminals.disposeAll();
});

test("children lists only that parent's subagents in spawn order", () => {
  const { terminals, control } = serviceFixture();
  const parent = terminals.create({
    provider: "claude",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  control.spawn({ parentSessionId: parent.id, provider: "cursor", cwd: process.cwd() });
  control.spawn({ parentSessionId: parent.id, provider: "minimax", cwd: process.cwd() });

  const other = terminals.create({
    provider: "claude",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 500, y: 500 }
  });
  control.spawn({ parentSessionId: other.id, provider: "devin", cwd: process.cwd() });

  assert.deepEqual(control.children(parent.id).map((session) => session.provider), ["cursor", "minimax"]);
  assert.deepEqual(control.children(other.id).map((session) => session.provider), ["devin"]);
  terminals.disposeAll();
});

test("send appends submit unless told otherwise and rejects exited sessions", async () => {
  const { terminals, control } = serviceFixture();
  const parent = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  const child = await control.spawn({ parentSessionId: parent.id, provider: "qwen", cwd: process.cwd() });
  await control.send(child.id, "run the tests");
  await control.send(child.id, " --quiet", false);

  const sent = [...writes.values()].flat().join("");
  assert.match(sent, /run the tests\r --quiet/u);
  terminals.disposeAll();
});

test("observe returns a capped terminal tail and result reflects exit state", () => {
  const { terminals, control } = serviceFixture();
  const parent = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  const observation = control.observe(parent.id);
  assert.equal(observation.sessionId, parent.id);
  assert.equal(observation.output.length <= 8_192, true);

  const running = control.result(parent.id);
  assert.equal(running.state, "running");
  assert.equal(running.exitCode, null);
  terminals.disposeAll();
});

test("cancel disposes the subagent and plain terminals are not agents", async () => {
  const { terminals, control } = serviceFixture();
  const parent = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  const terminal = terminals.create({
    provider: "terminal",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  const child = await control.spawn({ parentSessionId: parent.id, provider: "pi", cwd: process.cwd() });
  control.cancel(child.id);
  assert.equal(terminals.list().some((session) => session.id === child.id), false);

  assert.throws(() => control.send(terminal.id, "text"), /not agents/u);
  assert.throws(() => control.observe(terminal.id), /not agents/u);
  assert.throws(() => control.result(terminal.id), /not agents/u);
  terminals.disposeAll();
});

test("a parent cannot exceed the subagent fan-out cap", () => {
  const { terminals, control } = serviceFixture();
  const parent = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  for (let index = 0; index < 16; index += 1) {
    control.spawn({ parentSessionId: parent.id, provider: "omp", cwd: process.cwd() });
  }
  assert.throws(
    () => control.spawn({ parentSessionId: parent.id, provider: "omp", cwd: process.cwd() }),
    /16 subagents/u
  );
  terminals.disposeAll();
});

test("the control CLI screen masks a custom secret the viewport's top edge cuts", localSocket, async (t) => {
  const { SecretRedactionRegistry } = await import("../src/main/services/safety/SecretRedaction.ts");
  const secret = "purple-otter-marmalade-sings-loudly";
  const f = await fixture(t);
  const registry = new SecretRedactionRegistry();
  registry.add("plugin:p.custom", [secret]);
  f.terminals.configureRedaction(registry);
  const { session } = await f.create();
  const { cols, rows } = f.terminals.geometry(session.id);
  // The secret wraps: its head ends one row, its tail starts the next; that next row is the viewport's first.
  const pty = f.calls.at(-1).pty;
  pty.data(`${"a".repeat(cols - 10)}${secret}\r\n${Array.from({ length: rows - 1 }, (_value, index) => `line ${index}`).join("\r\n")}`);
  let text = "";
  for (let i = 0; i < 50 && !text.includes(`line ${rows - 2}`); i++) {
    await delay(10);
    ({ text } = await f.request("screen", { sessionId: session.id }));
  }
  assert.ok(text.includes(`line ${rows - 2}`) && text.split("\n").length <= rows, "the screen is the current viewport");
  assert.equal(text.includes(secret.slice(10)), false, "the tail on the top row is masked");
  assert.equal(/marmalade|loudly/u.test(text), false);
  assert.match(text, /<redacted:secret>/u, "masked where it stood, as one value");
});

test("an orchestrator tool call looks its sessions up by id: no other card's scrollback is copied", async () => {
  const { terminals, control } = serviceFixture();
  const parent = terminals.create({ provider: "claude", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
  const child = await control.spawn({ parentSessionId: parent.id, provider: "codex", cwd: process.cwd() });
  const bystanders = Array.from({ length: 5 }, () => terminals.create({ provider: "claude", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } }));
  assert.equal(bystanders.length, 5);
  const copied = [];
  const list = terminals.list.bind(terminals);
  const readBuffer = terminals.readBuffer.bind(terminals);
  terminals.list = () => { copied.push("list"); return list(); };
  terminals.readBuffer = (id) => { copied.push(id); return readBuffer(id); };

  // What observe_agent, get_agent_result, list_agents and the ownership check do.
  assert.equal(control.status(child.id).id, child.id);
  assert.equal(control.isInSubtree(parent.id, child.id), true);
  assert.deepEqual(control.children(parent.id).map((session) => session.id), [child.id]);
  control.observe(child.id);
  control.result(child.id);
  assert.throws(() => control.status("missing"), /does not exist/u);

  assert.deepEqual(copied, [child.id, child.id], "only the observed card's own scrollback is read, and no list() snapshot of every card");
  terminals.disposeAll();
});
