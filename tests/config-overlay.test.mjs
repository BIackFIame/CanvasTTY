import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireConfigurationLock,
  atomicWrite,
  ensurePrivateDirectory,
  hashText,
  releaseConfigurationLock,
  restoreFromBackup,
  writeExactWithCas
} from "../src/main/services/configOverlay.ts";

const fixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), "ctty-overlay-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

test("a held lock refuses a second owner; a dead owner's lock is reclaimed; release removes it", { skip: process.platform === "win32" }, (t) => {
  const root = fixture(t);
  const path = join(root, ".lock");
  const lock = acquireConfigurationLock(path, "Hermes");
  assert.throws(() => acquireConfigurationLock(path, "Hermes"), /Another CanvasTTY process is updating Hermes configuration/);
  releaseConfigurationLock(path, lock, "Hermes");
  assert.throws(() => statSync(path), { code: "ENOENT" });

  writeFileSync(path, `${JSON.stringify({ createdAt: 1, nonce: "a".repeat(32), pid: deadPid(), version: 1 })}\n`);
  const reclaimed = [];
  const next = acquireConfigurationLock(path, "Kimi", { beforeReclaim: (_path, nonce) => reclaimed.push(nonce) });
  assert.deepEqual(reclaimed, ["a".repeat(32)]);
  releaseConfigurationLock(path, next, "Kimi");

  writeFileSync(path, "not a lock");
  assert.throws(() => acquireConfigurationLock(path, "Kimi"), /Kimi configuration lock is invalid or foreign/);
});

test("compare-and-swap writes, atomic replacement and backup restore", { skip: process.platform === "win32" }, (t) => {
  const root = fixture(t);
  const config = join(root, "nested", "config.yaml");
  atomicWrite(config, "a: 1\n", 0o640);
  assert.equal(statSync(config).mode & 0o777, 0o640);
  assert.equal(statSync(join(root, "nested")).mode & 0o777, 0o700);
  writeExactWithCas(config, "a: 1\n", "a: 2\n", "Hermes");
  assert.throws(() => writeExactWithCas(config, "a: 1\n", "a: 3\n", "Hermes"), /Hermes configuration changed concurrently/);
  assert.equal(readFileSync(config, "utf8"), "a: 2\n");
  assert.equal(statSync(config).mode & 0o777, 0o640, "the file keeps its mode");

  const backup = join(root, "backup");
  writeFileSync(backup, "a: 1\n");
  assert.throws(() => restoreFromBackup(config, hashText("other"), backup, "backup invalid"), /backup invalid/);
  restoreFromBackup(config, hashText("a: 1\n"), backup, "backup invalid");
  assert.equal(readFileSync(config, "utf8"), "a: 1\n");
  restoreFromBackup(config, null, backup, "backup invalid");
  assert.throws(() => statSync(config), { code: "ENOENT" });

  ensurePrivateDirectory(join(root, "a", "b"));
  assert.equal(statSync(join(root, "a", "b")).mode & 0o777, 0o700);
});
