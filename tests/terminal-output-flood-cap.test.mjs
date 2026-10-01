import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { IPC } from "../src/shared/contracts.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

// A flood of PTY data (e.g. `cat` on a huge file) can push many `data` events before the 16 ms batch
// timer's callback gets a turn, since each event only needs the event loop, not the timer's turn.
// pendingOutput must not grow without bound while that happens.

test("a large output burst is flushed once it crosses the cap, instead of buffering without limit", () => {
  const events = [];
  const calls = [];
  const manager = new TerminalManager((channel, payload) => {
    if (channel === IPC.terminalData) events.push(payload);
  }, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  const { id } = manager.create({ provider: "codex", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
  const session = manager.sessions.get(id);

  const chunk = "x".repeat(200_000);
  // 6 * 200_000 = 1_200_000 chars, over the 1_048_576-char cap; without a cap these
  // would all sit in pendingOutput until the 16 ms batch timer's callback ran.
  for (let i = 0; i < 6; i += 1) calls[0].process.emitData(chunk);

  assert.equal(events.length, 1, "crossing the cap must force an immediate flush, synchronously");
  assert.equal(events[0].data.length, 1_200_000);
  assert.equal(session.pendingOutput.length, 0, "flushed output must not remain buffered");
  assert.equal(session.pendingOutputChars, 0, "the byte counter resets once flushed");

  manager.disposeAll();
});

test("a burst under the cap still waits for the batch timer", async () => {
  const events = [];
  const calls = [];
  const manager = new TerminalManager((channel, payload) => {
    if (channel === IPC.terminalData) events.push(payload);
  }, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  const { id } = manager.create({ provider: "codex", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
  const session = manager.sessions.get(id);

  calls[0].process.emitData("small burst\r\n");
  assert.equal(events.length, 0, "a small burst must not flush before the batch timer fires");
  assert.equal(session.pendingOutput.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(events.length, 1);
  manager.disposeAll();
});
