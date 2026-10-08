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
async function legacyConversation(home, cwd, sessionId, title = "") {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "kimi.json"), JSON.stringify({ work_dirs: [{ path: cwd }] }));
  const dir = join(home, "sessions", createHash("md5").update(cwd).digest("hex"), sessionId);
  await mkdir(dir, { recursive: true });
  await jsonl(join(dir, "context.jsonl"), [{ role: "user", content: title || "Legacy prompt" }]);
  if (title) await writeFile(join(dir, "state.json"), JSON.stringify({ custom_title: title }));
}
async function modernState(home, sessionId, fields = {}) {
  const dir = join(home, "sessions", "wd_project", sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "state.json"), JSON.stringify({
    id: sessionId, version: 2, cwd: fields.cwd, title: fields.title || "Modern title",
    createdAt: at - 1000, updatedAt: at, custom: {}, ...fields
  }));
}

test("Kimi retains legacy conversations when the modern sessions store is empty", async t => {
  const root = await directory(t);
  const legacy = join(root, "legacy");
  const modern = join(root, "modern");
  await legacyConversation(legacy, root, id, "Legacy title");
  await mkdir(join(modern, "sessions"), { recursive: true });
  const result = await kimiHistory(legacy, modern).read(signal());
  assert.deepEqual(result.items.map(item => item.id), [id]);
});

test("Kimi retains legacy conversations when modern records are excluded or invalid", async t => {
  const root = await directory(t);
  const legacy = join(root, "legacy");
  const modern = join(root, "modern");
  await legacyConversation(legacy, root, id, "Legacy title");
  await modernState(modern, `session_${id}`, { custom: { child_session_kind: "child" } });
  await modernState(modern, "session_22222222-2222-4222-8222-222222222222", { version: 1 });
  const result = await kimiHistory(legacy, modern).read(signal());
  assert.deepEqual(result.items.map(item => item.id), [id]);
});

test("Kimi prefers the native ID for migrated history and keeps distinct legacy chats with equal titles", async t => {
  const root = await directory(t);
  const legacy = join(root, "legacy");
  const modern = join(root, "modern");
  const otherId = "22222222-2222-4222-8222-222222222222";
  await legacyConversation(legacy, root, id, "Same title");
  await legacyConversation(legacy, root, otherId, "Same title");
  await modernState(modern, `session_${id}`, {
    title: "Migrated renamed title",
    custom: { imported_from_kimi_cli: true, kimi_cli_session_id: id }
  });
  const result = await kimiHistory(legacy, modern).read(signal());
  assert.deepEqual(result.items.map(item => item.id), [`session_${id}`, otherId]);
  assert.equal(result.items[0].title, "Migrated renamed title");
});

test("Kimi accepts the native ses ID emitted by the legacy migrator", async t => {
  const root = await directory(t);
  const modern = join(root, "modern");
  await modernState(modern, `ses_${id}`, { cwd: root, title: "Imported" });
  const result = await kimiHistory(join(root, "missing-legacy"), modern).read(signal());
  assert.deepEqual(result.items.map(item => item.id), [`ses_${id}`]);
});

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

test("Kimi Code reads current session metadata, omits child sessions and prefers it over migrated legacy copies", async t => {
  const root = await directory(t);
  const legacy = join(root, "legacy");
  const current = join(root, "current");
  const currentId = `session_${id}`;
  const session = join(current, "sessions", "wd_project", currentId);
  await mkdir(session, { recursive: true });
  await mkdir(legacy);
  await writeFile(join(legacy, "kimi.json"), JSON.stringify({ work_dirs: [{ path: root }] }));
  const migrated = join(legacy, "sessions", createHash("md5").update(root).digest("hex"), id);
  await mkdir(migrated, { recursive: true });
  await jsonl(join(migrated, "context.jsonl"), [{ role: "user", content: "Outdated legacy title" }]);
  await writeFile(join(session, "state.json"), JSON.stringify({
    id: currentId, version: 2, cwd: root, title: "Renamed current chat",
    createdAt: at - 1000, updatedAt: at, custom: {}, agents: { main: { type: "main" } }
  }));
  const childId = "session_22222222-2222-4222-8222-222222222222";
  const child = join(current, "sessions", "wd_project", childId);
  await mkdir(child, { recursive: true });
  await writeFile(join(child, "state.json"), JSON.stringify({
    id: childId, version: 2, cwd: root, updatedAt: at, custom: { child_session_kind: "child", parent_session_id: currentId }
  }));
  const result = await kimiHistory(legacy, current).read(signal());
  assert.deepEqual(result.items, [{ provider: "kimi", id: currentId, cwd: root, title: "Renamed current chat", lastActivityAt: at }]);
  const launch = resolveTerminalLaunch("kimi", "normal", [], {
    providerCli: { provider: "kimi", state: "available", executable: "/resolved/kimi", launcher: "native", environment: {} },
    resumePrevious: true, resumeThreadId: currentId
  });
  assert.deepEqual(launch.args, ["--session", currentId]);
});

test("Kimi Code derives an unnamed chat's title from its last user prompt in the main agent wire log", async t => {
  const root = await directory(t);
  const currentId = `session_${id}`;
  const session = join(root, "sessions", "wd_project", currentId);
  await mkdir(join(session, "agents", "main"), { recursive: true });
  await writeFile(join(session, "state.json"), JSON.stringify({
    id: currentId, version: 2, cwd: root, updatedAt: at, custom: {}
  }));
  await jsonl(join(session, "agents", "main", "wire.jsonl"), [
    { type: "profile.bind", systemPrompt: "x".repeat(80 * 1024) },
    { type: "turn.prompt", agentId: "main", origin: { kind: "user" }, input: [{ type: "text", text: "First question" }] },
    { type: "turn.prompt", agentId: "main", origin: { kind: "user" }, input: [{ type: "text", text: "Latest question" }] },
    { type: "turn.prompt", agentId: "main", origin: { kind: "system" }, input: [{ type: "text", text: "Internal reminder" }] }
  ]);
  const result = await kimiHistory(join(root, "legacy"), root).read(signal());
  assert.equal(result.items[0]?.title, "Latest question");
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
  assert.deepEqual(await kimiHistory(root, join(root, "absent-current-store")).read(signal()), result);
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
