import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";

// Every real agent launch goes through the prepared-launch coordinator; the grant must reach it once.
test("an answer-capture grant reaches the prepared first start and never a restart", async () => {
  const grants = [], exits = [];
  const runtime = { prepareLaunch(input) { grants.push(input.answerCaptureGrantExpiresAt); return { args: [], environment: {}, cleanup() {} }; }, currentStatus() { return null; } };
  const registry = { get: (provider) => ({ state: "available", provider, executable: `/resolved/${provider}`, launcher: "native", environment: { PATH: "/usr/bin" }, checked: [] }) };
  const manager = new TerminalManager(() => undefined, registry, undefined, runtime, true, () => ({ pid: 1, write() {}, kill() {}, pause() {}, resume() {}, resize() {}, onData() { return { dispose() {} }; }, onExit(callback) { exits.push(callback); return { dispose() {} }; } }));
  manager.configureProviderLaunch({ async prepare() { return { args: [], environment: {}, unsetEnvironment: [], skipBridges: false, bindingDigest: "fixture", assertCurrent() {}, async cleanup() {} }; } });
  const expiresAt = Date.now() + 60_000;
  const session = manager.create({ provider: "codex", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } }, { answerCaptureGrantExpiresAt: expiresAt });
  await manager.waitForLaunch(session.id);
  assert.deepEqual(grants, [expiresAt]);
  exits[0]({ exitCode: 0 });
  manager.restart(session.id);
  await manager.waitForLaunch(session.id);
  assert.deepEqual(grants, [expiresAt, undefined]);
  manager.disposeAll();
});
