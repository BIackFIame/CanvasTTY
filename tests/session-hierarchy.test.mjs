import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { TerminalSessionStore } from "../src/main/services/TerminalSessionStore.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

function manager(calls) {
  return new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
}

test("sessions default to the agent role without hierarchy fields", () => {
  const calls = [];
  const terminal = manager(calls);
  const session = terminal.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  assert.equal(session.role, "agent");
  assert.equal("parentSessionId" in session, false);
  terminal.disposeAll();
});

test("a subagent records its parent and keeps the parent alive", () => {
  const calls = [];
  const terminal = manager(calls);
  const parent = terminal.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  const child = terminal.create({
    provider: "cursor",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 40, y: 40 },
    role: "subagent",
    parentSessionId: parent.id
  });

  assert.equal(child.role, "subagent");
  assert.equal(child.parentSessionId, parent.id);

  const children = terminal.list().filter((session) => session.parentSessionId === parent.id);
  assert.deepEqual(children.map((session) => session.id), [child.id]);
  terminal.disposeAll();
});

test("closing a parent closes its subagents; other children and unrelated cards stay", () => {
  const calls = [];
  const terminal = manager(calls);
  const create = (extra) => terminal.create({ provider: "codex", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 }, ...extra });
  const parent = create({ role: "orchestrator" });
  const child = create({ role: "subagent", parentSessionId: parent.id });
  const grandchild = create({ role: "subagent", parentSessionId: child.id });
  const other = create({});
  const killed = [];
  for (const call of calls) {
    const kill = call.process.kill.bind(call.process);
    call.process.kill = () => { killed.push(call); return kill(); };
  }
  terminal.dispose(parent.id);
  assert.deepEqual(terminal.list().map((session) => session.id), [other.id]);
  assert.equal(killed.length, 3, "every PTY of the subtree is stopped");
  assert.equal(grandchild.parentSessionId, child.id);
  terminal.disposeAll();
});

test("subagents require a live parent session", () => {
  const calls = [];
  const terminal = manager(calls);
  assert.throws(
    () => terminal.create({
      provider: "claude",
      cwd: process.cwd(),
      profile: "normal",
      position: { x: 0, y: 0 },
      role: "subagent"
    }),
    /requires a parent/u
  );
  assert.throws(
    () => terminal.create({
      provider: "claude",
      cwd: process.cwd(),
      profile: "normal",
      position: { x: 0, y: 0 },
      role: "subagent",
      parentSessionId: "00000000-0000-4000-8000-000000000000"
    }),
    /Parent terminal session does not exist/u
  );
  terminal.disposeAll();
});

test("unknown roles are rejected", () => {
  const calls = [];
  const terminal = manager(calls);
  assert.throws(
    () => terminal.create({
      provider: "claude",
      cwd: process.cwd(),
      profile: "normal",
      position: { x: 0, y: 0 },
      role: "daemon"
    }),
    /Unknown session role/u
  );
  terminal.disposeAll();
});

test("hierarchy persists and orphan subagents are dropped on restore", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-hierarchy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const calls = [];
  const first = manager(calls);
  const store = new TerminalSessionStore(directory);
  first.configureSessionPersistence(store, "continue");
  const parent = first.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  first.create({
    provider: "cursor",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 40, y: 40 },
    role: "subagent",
    parentSessionId: parent.id
  });
  // An orchestrator without any parent is a legitimate standalone role.
  first.create({
    provider: "claude",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 80, y: 80 },
    role: "orchestrator"
  });
  await first.shutdown();

  const secondCalls = [];
  const second = manager(secondCalls);
  second.configureSessionPersistence(new TerminalSessionStore(directory), "continue");
  await second.restorePersistedSessions();
  const restored = second.list();
  assert.deepEqual(
    restored.map((session) => [session.role, session.parentSessionId ?? null]).sort(),
    [["agent", null], ["orchestrator", null], ["subagent", parent.id]]
  );
  await second.shutdown();

  // Now drop the parent from the persisted state and restore again: the
  // orphan subagent restores as nothing.
  const { readFile, writeFile } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile(join(directory, "terminal-sessions.json"), "utf8"));
  raw.sessions = raw.sessions.filter((session) => session.role !== "orchestrator" && session.role !== "subagent");
  await writeFile(join(directory, "terminal-sessions.json"), JSON.stringify(raw));

  const thirdCalls = [];
  const third = manager(thirdCalls);
  third.configureSessionPersistence(new TerminalSessionStore(directory), "continue");
  await third.restorePersistedSessions();
  assert.deepEqual(third.list().map((session) => session.role), ["agent"]);
  await third.shutdown();
});
