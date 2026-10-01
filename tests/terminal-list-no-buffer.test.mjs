import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

// Every card subscribes and calls readBuffer() for its own history on mount (attachTerminalOutput), so
// terminal.list()'s hydration snapshot must not also carry the full scrollback for every session: it is
// serialized across IPC and thrown away unread.

test("list() omits scrollback (readBuffer still returns it in full)", () => {
  const calls = [];
  const manager = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  const { id } = manager.create({ provider: "codex", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });

  const history = "line of scrollback\r\n".repeat(5_000); // ~100 KB for one session alone
  calls[0].process.emitData(history);
  manager.flushOutput(id, manager.sessions.get(id));

  const listed = manager.list().find((session) => session.id === id);
  assert.equal(listed.buffer, "", "list() must not carry a session's history");

  const read = manager.readBuffer(id);
  assert.equal(read.buffer, history, "readBuffer() must still return the full history a card asks for");

  manager.disposeAll();
});

test("a large per-session history no longer inflates terminal.list()'s payload", () => {
  const calls = [];
  const manager = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  const sessions = Array.from({ length: 5 }, (_, index) =>
    manager.create({ provider: "codex", cwd: process.cwd(), profile: "normal", position: { x: index * 700, y: 0 } }));

  const history = "x".repeat(50_000);
  sessions.forEach((session, index) => {
    calls[index].process.emitData(history);
    manager.flushOutput(session.id, manager.sessions.get(session.id));
  });

  const payloadBytes = JSON.stringify(manager.list()).length;
  // Before: 5 sessions x 50,000 chars of scrollback each would already exceed 250,000 bytes on
  // their own. After: the whole list is just metadata, nowhere close to that.
  assert.ok(payloadBytes < 50_000, `list() payload should be small (metadata only), was ${payloadBytes} bytes`);

  manager.disposeAll();
});
