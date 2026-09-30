import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { TerminalSessionStore } from "../src/main/services/TerminalSessionStore.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

test("rapid bounds updates during a drag coalesce into a single session-store write", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-bounds-coalesce-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const manager = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner([]));
  const store = new TerminalSessionStore(directory);
  let replaceCalls = 0;
  const originalReplace = store.replace.bind(store);
  store.replace = async (sessions) => {
    replaceCalls += 1;
    return originalReplace(sessions);
  };
  manager.configureSessionPersistence(store, "continue");
  await manager.restorePersistedSessions();

  const created = manager.create({
    provider: "codex",
    profile: "normal",
    cwd: process.cwd(),
    position: { x: 0, y: 0 }
  });
  replaceCalls = 0; // ignore the write `create` itself scheduled

  // A drag fires setBounds many times a second; the old code wrote the whole
  // session store to disk on every single one of them.
  for (let i = 0; i < 20; i += 1) {
    manager.setBounds(created.id, {
      position: { x: i, y: i },
      size: { width: 800, height: 500 }
    });
  }

  assert.equal(replaceCalls, 0, "the write must be deferred while updates keep arriving");
  await delay(300);
  assert.equal(replaceCalls, 1, "20 rapid bounds updates should coalesce into a single write");
  assert.equal(manager.list()[0].size.width, 800);
  assert.equal(manager.list()[0].position.x, 19, "the coalesced write still reflects the latest bounds");

  await manager.shutdown();
});
