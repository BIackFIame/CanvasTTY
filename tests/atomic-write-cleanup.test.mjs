import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createQwenHookSettings } from "../src/main/services/agent-runtime/ProviderRuntimeLaunch.ts";
import { TerminalSessionStore } from "../src/main/services/TerminalSessionStore.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-atomic-write-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// A folder with content where the file should be makes the final rename fail,
// as a locked file (EPERM from antivirus on Windows) does.
async function blockRename(path) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "keep"), "");
}

test("provider hook settings leave no temporary file when the rename fails", async (t) => {
  const root = await fixture(t);
  const target = join(root, `qwen-hooks-${createHash("sha256").update("session-1", "utf8").digest("hex").slice(0, 24)}.json`);
  await blockRename(target);
  assert.throws(() => createQwenHookSettings({
    helper: { command: process.execPath, args: ["/helper.mjs"] },
    platform: "linux",
    runtimeDirectory: root,
    terminalSessionId: "session-1"
  }));
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
});

test("the terminal session store leaves no temporary file when the rename fails and keeps its folder private", async (t) => {
  const root = await fixture(t);
  const dataDir = join(root, "user-data");
  const store = new TerminalSessionStore(dataDir);
  await blockRename(join(dataDir, "terminal-sessions.json"));
  await assert.rejects(store.clear());
  assert.deepEqual((await readdir(dataDir)).filter((name) => name.endsWith(".tmp")), []);

  const fresh = join(root, "fresh", "user-data");
  await new TerminalSessionStore(fresh).clear();
  if (process.platform !== "win32") assert.equal((await stat(fresh)).mode & 0o077, 0, "a folder the store creates is private");
});
