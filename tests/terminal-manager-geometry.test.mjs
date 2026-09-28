import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

test("Grok PTY starts and restarts only with the renderer-measured grid", () => {
  const calls = [];
  const manager = new TerminalManager(
    () => undefined,
    availableRegistry(),
    undefined,
    undefined,
    true,
    fakeSpawner(calls, { pidBase: 10_000 })
  );
  const session = manager.create({
    provider: "grok",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });

  assert.equal(calls.length, 0);
  manager.resize(session.id, 73, 18);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cols, 73);
  assert.equal(calls[0].options.rows, 18);

  calls[0].process.emitExit(0);
  assert.equal(manager.list()[0].exitCode, 0);
  manager.restart(session.id);
  assert.equal(calls.length, 1);
  manager.resize(session.id, 69, 16);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.cols, 69);
  assert.equal(calls[1].options.rows, 16);
  manager.disposeAll();
});

test("other providers retain immediate startup and subsequent PTY resize", () => {
  const calls = [];
  const manager = new TerminalManager(
    () => undefined,
    availableRegistry(),
    undefined,
    undefined,
    true,
    fakeSpawner(calls, { pidBase: 10_000 })
  );
  const session = manager.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cols, 80);
  assert.equal(calls[0].options.rows, 24);
  manager.resize(session.id, 92, 27);
  assert.deepEqual(calls[0].process.lastResize, { cols: 92, rows: 27 });
  manager.disposeAll();
});

test("answer-capture grants are passed only to the explicitly granted session generation", () => {
  const calls = [];
  const grants = [];
  const runtime = {
    prepareLaunch(input) {
      grants.push(input.answerCaptureGrantExpiresAt);
      return { args: [], environment: {}, cleanup() {} };
    },
    currentStatus() { return null; }
  };
  const manager = new TerminalManager(
    () => undefined,
    availableRegistry(),
    undefined,
    runtime,
    true,
    fakeSpawner(calls, { pidBase: 10_000 })
  );
  const expiresAt = Date.now() + 60_000;
  const session = manager.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  }, { answerCaptureGrantExpiresAt: expiresAt });
  assert.deepEqual(grants, [expiresAt]);

  calls[0].process.emitExit(0);
  manager.restart(session.id);
  assert.deepEqual(grants, [expiresAt, undefined]);
  manager.disposeAll();
});
