import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { jsonlHistory } from "../src/main/services/agent-history/jsonlHistory.ts";
import { kimiHistory } from "../src/main/services/agent-history/kimiHistory.ts";
import { minimaxHistory } from "../src/main/services/agent-history/minimaxHistory.ts";
import { readJsonMetadata, sqliteHistory } from "../src/main/services/agent-history/historyFiles.ts";
import { resolveTerminalLaunch } from "../src/main/services/terminalLaunch.ts";

const id = "11111111-1111-4111-8111-111111111111";
const at = Date.UTC(2026, 8, 28, 12);
const signal = () => new AbortController().signal;
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function jsonl(path, rows) {
  await writeFile(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  await utimes(path, at / 1000, at / 1000);
}

test("OpenCode activity stays in milliseconds", async t => {
  const root = await directory(t);
  const path = join(root, "opencode.db");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE session (id TEXT, title TEXT, directory TEXT, time_updated INTEGER)");
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?)").run("ses_abc123", "Project chat", root, at);
  db.close();
  const result = await sqliteHistory(path, "opencode", signal());
  assert.deepEqual(result.items, [{ provider: "opencode", id: "ses_abc123", title: "Project chat", cwd: root, lastActivityAt: at }]);
});

test("a complete metadata record exactly at the tail boundary is retained", async t => {
  const root = await directory(t);
  const path = join(root, "boundary.jsonl");
  const first = JSON.stringify({ sessionId: id, cwd: root }) + "\n";
  const tail = JSON.stringify({ type: "system", subtype: "custom_title", systemPayload: { customTitle: "Boundary title" } }) + "\n";
  await writeFile(path, first + " ".repeat(64 * 1024 - Buffer.byteLength(first) - 1) + "\n" + tail);
  const { rows } = await readJsonMetadata(path, signal());
  assert.equal(rows.find(row => row.subtype === "custom_title")?.systemPayload.customTitle, "Boundary title");
});

test("Claude and Pi keep a renamed title in the middle of a long conversation", async t => {
  const root = await directory(t);
  for (const provider of ["claude", "pi"]) {
    const dir = join(root, provider);
    await mkdir(dir);
    await jsonl(join(dir, `${id}.jsonl`), [
      provider === "claude" ? { sessionId: id, cwd: root, type: "user", message: { content: "Initial" } }
        : { type: "session", id, cwd: root },
      ...Array(200).fill({ type: "message", message: { role: "assistant", content: "x".repeat(1000) } }),
      provider === "claude" ? { type: "custom-title", customTitle: "Renamed" } : { type: "session_info", name: "Renamed" },
      ...Array(200).fill({ type: "message", message: { role: "assistant", content: "y".repeat(1000) } })
    ]);
    const result = await jsonlHistory(provider, dir).read(signal());
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].title, "Renamed");
    assert.equal(result.items[0].lastActivityAt, at);
    assert.deepEqual(Object.keys(result.items[0]).sort(), ["cwd", "id", "lastActivityAt", "provider", "title"]);
  }
});

test("Qwen custom titles and OMP mutable title headers produce resumable project entries", async t => {
  const root = await directory(t);
  for (const provider of ["qwen", "omp"]) {
    const dir = join(root, provider);
    await mkdir(dir);
    await jsonl(join(dir, `${id}.jsonl`), provider === "qwen" ? [
      { sessionId: id, cwd: root, type: "user", message: { parts: [{ text: "Initial" }] } },
      { type: "system", subtype: "custom_title", systemPayload: { customTitle: "Renamed" } }
    ] : [{ type: "title", title: "Renamed" }, { type: "session", id, cwd: root }]);
    const result = await jsonlHistory(provider, dir).read(signal());
    assert.equal(result.items[0].title, "Renamed");
    assert.equal(result.items[0].cwd, root);
  }
});

test("Kimi lists local workspaces with custom titles and excludes remote workspaces", async t => {
  const root = await directory(t);
  await writeFile(join(root, "kimi.json"), JSON.stringify({ work_dirs: [{ path: root, kaos: "local" }, { path: "/remote", kaos: "ssh" }] }));
  const dir = join(root, "sessions", createHash("md5").update(root).digest("hex"), id);
  await mkdir(dir, { recursive: true });
  await jsonl(join(dir, "context.jsonl"), [{ role: "user", content: "Initial" }]);
  await writeFile(join(dir, "state.json"), JSON.stringify({ custom_title: "Renamed" }));
  const result = await kimiHistory(root).read(signal());
  assert.deepEqual(result.items, [{ provider: "kimi", id, cwd: root, title: "Renamed", lastActivityAt: at }]);
});

test("MiniMax extracts only metadata from the confirmed runtime store", async t => {
  const root = await directory(t);
  await mkdir(join(root, "v2", "sqlite"), { recursive: true });
  const db = new DatabaseSync(join(root, "v2", "sqlite", "runtime-state.sqlite"));
  db.exec("CREATE TABLE local_runtime_sessions (session_id TEXT, record_json TEXT, updated_at_ms INTEGER)");
  db.prepare("INSERT INTO local_runtime_sessions VALUES (?, ?, ?)").run("local-session_123", JSON.stringify({ title: "Renamed", workspaceDir: root, messages: ["private transcript"] }), at);
  db.close();
  const result = await minimaxHistory(root).read(signal());
  assert.deepEqual(result.items, [{ provider: "minimax", id: "local-session_123", title: "Renamed", cwd: root, lastActivityAt: at }]);
});

test("Cursor sidecars exclude empty conversations and subagents, preserving exact resume", async t => {
  const root = await directory(t);
  const dir = join(root, "chats", "workspace-hash", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "store.db"), "fixture: metadata reader must not open transcript storage");
  await writeFile(join(dir, "meta.json"), JSON.stringify({ schemaVersion: 1, hasConversation: true, title: "Renamed", cwd: root, createdAtMs: at - 1000, updatedAtMs: at }));
  const { cursorHistory } = await import("../src/main/services/agent-history/cursorHistory.ts");
  assert.deepEqual((await cursorHistory(root).read(signal())).items, [{ provider: "cursor", id, title: "Renamed", cwd: root, lastActivityAt: at }]);
  const launch = resolveTerminalLaunch("cursor", "normal", [], {
    providerCli: { provider: "cursor", state: "available", executable: "/resolved/agent", launcher: "native", environment: {} },
    resumePrevious: true, resumeThreadId: id
  });
  assert.deepEqual(launch.args, ["--resume", id]);
  for (const extra of [{ isSubagent: true }, { hasConversation: false }]) {
    await writeFile(join(dir, "meta.json"), JSON.stringify({ schemaVersion: 1, hasConversation: true, ...extra, title: "Renamed", cwd: root, updatedAtMs: at }));
    assert.equal((await cursorHistory(root).read(signal())).items.length, 0);
  }
});
