import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_RUNTIME_ENV } from "../src/agent-runtime/runtime-protocol.mjs";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";

for (const provider of ["omp", "pi"]) test(`${provider} identifies ordinary launches, keeps same-project sessions separate, and follows session switches`, {
  skip: process.platform === "win32" ? "POSIX runtime socket integration" : false
}, async t => {
  const { default: extension } = await import("../src/agent-runtime/omp-extension.mjs").catch(error => {
    assert.fail(`OMP lifecycle extension must be available: ${error.message}`);
  });
  const root = await mkdtemp(join(tmpdir(), "ctty-omp-"));
  const previous = Object.fromEntries(Object.values(AGENT_RUNTIME_ENV).map(key => [key, process.env[key]]));
  const manager = new TerminalManager(() => {}, {
    get: provider => ({ provider, state: "available", executable: "/resolved/omp", launcher: "native", environment: {}, checked: [] }),
    snapshot: () => ({})
  }, undefined, undefined, true, command => ({
    pid: 1234, process: command, write() {}, resize() {}, kill() {}, pause() {}, resume() {},
    onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} })
  }));
  const signals = [];
  const gateway = new RuntimeGateway({ runtimeDirectory: root, onSignal(id, signal) {
    signals.push(signal);
    manager.applyProviderSignal(id, { kind: "lifecycle", ...signal });
  } });
  t.after(async () => {
    await gateway.close();
    await manager.shutdown();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  await gateway.start();
  function create(threadId) {
    const session = manager.create({ provider, profile: "normal", cwd: root, position: { x: 0, y: 0 } });
    const capability = gateway.registerSession(session.id, provider);
    const handlers = new Map();
    extension({ on: (event, handler) => handlers.set(event, handler) });
    const context = { cwd: root, agent: { kind: "main", depth: 0 }, sessionManager: { getSessionId: () => threadId } };
    return { session, context, setThread: id => { threadId = id; }, async emit(event, ctx = context) {
      for (const [key, value] of Object.entries(capability)) {
        if (AGENT_RUNTIME_ENV[key]) process.env[AGENT_RUNTIME_ENV[key]] = value;
      }
      assert.ok(handlers.has(event), `missing ${event} handler`);
      await handlers.get(event)({ type: event }, ctx);
    } };
  }
  const first = create(FIRST);
  const second = create(SECOND);
  await first.emit("session_start");
  await second.emit("session_start");
  assert.equal(manager.findLocalConversation(provider, FIRST)?.id, first.session.id);
  assert.equal(manager.findLocalConversation(provider, SECOND)?.id, second.session.id);
  await first.emit("agent_start");
  assert.equal(manager.getMetadata(first.session.id).status, "working");
  await first.emit("agent_end");
  assert.equal(manager.getMetadata(first.session.id).status, "idle");
  assert.equal(manager.getMetadata(first.session.id).turnCompleted, true);
  first.setThread(THIRD);
  await first.emit("session_switch");
  assert.equal(manager.findLocalConversation(provider, FIRST), null);
  assert.equal(manager.findLocalConversation(provider, THIRD)?.id, first.session.id);
  first.setThread(FIRST);
  await first.emit("session_branch");
  assert.equal(manager.findLocalConversation(provider, FIRST)?.id, first.session.id);
  first.setThread(THIRD);
  await first.emit("session_fork");
  assert.equal(manager.findLocalConversation(provider, THIRD)?.id, first.session.id);
  const before = signals.length;
  await first.emit("session_start", { ...first.context, agent: { kind: "sub", depth: 0 }, sessionManager: { getSessionId: () => THIRD } });
  await first.emit("agent_end", { ...first.context, agent: { kind: "sub", depth: 1 } });
  assert.equal(signals.length, before, "subagents must not replace the terminal's conversation or status");
  assert.equal(manager.getMetadata(first.session.id).threadId, THIRD);
});
