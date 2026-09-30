import test from "node:test";
import assert from "node:assert/strict";
import { CompanionSessions } from "../src/main/services/companion/CompanionSessions.ts";
import { SessionAccess } from "../src/main/services/companion/SessionAccess.ts";

const request = (action, id = "a".repeat(32)) => ({ version: 1, id, sentAt: Date.now(), action });

function fixture() {
  const access = new SessionAccess();
  access.share({ deviceId: "phone", sessionIds: ["shared"], allowInput: true, allowCreate: false, allowClose: false, allowBrowser: false });
  const writes = [];
  const snapshot = { buffer: Array.from({ length: 35_000 }, (_, i) => String.fromCharCode(33 + i % 80)).join(""), outputOffset: 35_000, cols: 90, rows: 25 };
  const host = {
    list: () => [
      { id: "shared", title: "Safe", provider: "codex", status: "working", cwd: "/secret" },
      { id: "private", title: "Secret", provider: "claude", status: "idle", cwd: "/secret" },
    ],
    overview: () => [
      { id: "shared", title: "Safe", provider: "codex", status: "working", startedAt: 123, exitCode: null, revision: 4, cwd: "/secret" },
      { id: "private", title: "Secret", provider: "claude", status: "idle", startedAt: 234, exitCode: 0, revision: 5, cwd: "/secret" },
    ],
    providers: () => ({ codex: true, claude: false, terminal: true }),
    output: () => snapshot,
    input: (id, data) => { writes.push({ id, data }); return true; },
    read: async () => ({ body: "safe", revision: "v1" }),
  };
  return { service: new CompanionSessions(host, access), host, access, snapshot, writes };
}

test("overview exposes only shared safe metadata and current permissions", async () => {
  const f = fixture();
  const result = await f.service.dispatch("phone", request({ type: "sessions.overview" }));
  assert.deepEqual(result.sessions, [{ id: "shared", title: "Safe", provider: "codex", status: "working", startedAt: 123, exitCode: null, revision: 4 }]);
  assert.equal(result.providers.codex, true);
  assert.equal(result.providers.claude, false);
  assert.deepEqual(result.permissions, { allowInput: true, allowCreate: false, allowClose: false });
  assert.equal(JSON.stringify(result).includes("/secret"), false);
});

test("exited shared session keeps its output but refuses input to a dead PTY", async () => {
  const f = fixture();
  const exited = { id: "shared", title: "Safe", provider: "codex", status: "failed" };
  f.host.list = () => [exited];
  f.host.overview = () => [{ ...exited, startedAt: 123, exitCode: 17, revision: 5 }];
  f.host.input = () => false;

  const overview = await f.service.dispatch("phone", request({ type: "sessions.overview" }));
  assert.deepEqual(overview.sessions, [{ ...exited, startedAt: 123, exitCode: 17, revision: 5 }]);
  const output = await f.service.dispatch("phone", request({ type: "session.output", sessionId: "shared", cursor: null }, "e".repeat(32)));
  assert.equal(output.data, f.snapshot.buffer.slice(-16_000));
  await assert.rejects(f.service.dispatch("phone", request({ type: "session.input", sessionId: "shared", text: "relaunch" }, "f".repeat(32))), { code: "unavailable" });
  assert.equal(f.writes.length, 0);
});

test("raw output catches up in bounded nonoverlapping slices, tail signals omitted history and cursor resets", async () => {
  const f = fixture();
  const output = (cursor) => f.service.dispatch("phone", request({ type: "session.output", sessionId: "shared", cursor }, crypto.randomUUID().replaceAll("-", "")));
  const first = await output(0);
  const second = await output(first.offset);
  const third = await output(second.offset);
  assert.equal(first.data.length, 16_000);
  assert.equal(first.offset, 16_000);
  assert.equal(first.hasMore, true);
  assert.equal(second.offset, 32_000);
  assert.equal(third.offset, 35_000);
  assert.equal(first.data + second.data + third.data, f.snapshot.buffer);
  assert.equal(third.hasMore, false);
  const tail = await output(null);
  assert.deepEqual({ length: tail.data.length, offset: tail.offset, gap: tail.gap, hasMore: tail.hasMore, cols: tail.cols, rows: tail.rows }, { length: 16_000, offset: 35_000, gap: true, hasMore: false, cols: 90, rows: 25 });
  f.snapshot.buffer = f.snapshot.buffer.slice(-2_000);
  const trimmed = await output(31_000);
  assert.equal(trimmed.offset, 35_000);
  assert.equal(trimmed.data.length, 2_000);
  assert.equal(trimmed.gap, true);
  const ahead = await output(40_000);
  assert.equal(ahead.offset, 35_000);
  assert.equal(ahead.gap, true);
});

test("output pages never split a UTF-16 surrogate pair", async () => {
  const f = fixture();
  f.snapshot.buffer = "x".repeat(15_999) + "😀" + "y".repeat(100);
  f.snapshot.outputOffset = f.snapshot.buffer.length;
  const first = await f.service.dispatch("phone", request({ type: "session.output", sessionId: "shared", cursor: 0 }));
  assert.equal(first.offset, 15_999);
  assert.equal(first.data, "x".repeat(15_999));
  const next = await f.service.dispatch("phone", request({ type: "session.output", sessionId: "shared", cursor: first.offset }, "d".repeat(32)));
  assert.equal(next.data.slice(0, 2), "😀");
  assert.equal(first.data + next.data, f.snapshot.buffer);
});

test("fixed keys alone write PTY bytes, invalid input and revocation never act", async () => {
  const f = fixture();
  await assert.rejects(f.service.dispatch("phone", request({ type: "session.key", sessionId: "shared", key: "\u001b[31m" })), { code: "invalid-request" });
  await assert.rejects(f.service.dispatch("phone", request({ type: "session.key", sessionId: "private", key: "enter" })), { code: "not-shared" });
  assert.equal(f.writes.length, 0);
  await f.service.dispatch("phone", request({ type: "session.key", sessionId: "shared", key: "up" }, "b".repeat(32)));
  assert.deepEqual(f.writes, [{ id: "shared", data: "\u001b[A" }]);
  f.access.revoke("phone");
  await assert.rejects(f.service.dispatch("phone", request({ type: "session.key", sessionId: "shared", key: "ctrl-c" }, "c".repeat(32))), { code: "not-paired" });
  assert.equal(f.writes.length, 1);
});
