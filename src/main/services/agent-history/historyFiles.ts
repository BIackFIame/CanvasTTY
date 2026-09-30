import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { Worker } from "node:worker_threads";
import { normalizeThreadId } from "../../../agent-runtime/runtime-protocol.mjs";
import type { AgentChatHistoryItem, AgentChatHistoryProviderId } from "../../../shared/contracts.ts";

export interface HistoryRecords {
  items: AgentChatHistoryItem[];
  skipped: number;
}

export interface HistoryAdapter {
  read(signal: AbortSignal): Promise<HistoryRecords>;
}

export function unsupportedHistory(provider: string): HistoryAdapter {
  return { read: async (signal) => {
    signal.throwIfAborted();
    throw new Error(`Reading local ${provider} chat history is not supported yet. Use the CLI's session picker.`);
  } };
}

/** Read bounded complete records at the file edges, never materialize a full transcript. */
export async function readJsonMetadata(path: string, signal: AbortSignal): Promise<{ rows: Record<string, unknown>[]; modifiedAt: number }> {
  signal.throwIfAborted();
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    const limit = 64 * 1024;
    const rows: Record<string, unknown>[] = [];
    for (const offset of info.size <= limit ? [0] : [0, Math.max(limit, info.size - limit)]) {
      signal.throwIfAborted();
      // Include the preceding byte so a complete line at the boundary is kept.
      const start = offset > 0 ? offset - 1 : offset;
      const buffer = Buffer.alloc(Math.min(limit + (offset > 0 ? 1 : 0), info.size - start));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      if (offset > 0) lines.shift();
      if (start + bytesRead < info.size) lines.pop();
      for (const line of lines) {
        try { if (line.trim()) rows.push(record(JSON.parse(line))); }
        catch { /* Partial or malformed records do not hide other metadata. */ }
      }
    }
    return { rows, modifiedAt: info.mtimeMs };
  } finally { await file.close(); }
}

export function historyItem(provider: AgentChatHistoryProviderId, value: Record<string, unknown>): AgentChatHistoryItem | null {
  const id = normalizeThreadId(provider, value.id);
  const timestamp = typeof value.lastActivityAt === "number" ? value.lastActivityAt : NaN;
  if (!id || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > 8.64e15) return null;
  const cwd = typeof value.cwd === "string" && value.cwd.length <= 4096 && !value.cwd.includes("\0") && isAbsolute(value.cwd)
    ? value.cwd : null;
  const title = typeof value.title === "string" ? value.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 256) : "";
  return { provider, id, title: title || `${provider} · ${id}`, cwd, lastActivityAt: timestamp };
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function historyPromptTitle(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 256);
  if (!Array.isArray(value)) return "";
  return value.map(record).filter((part) => typeof part.text === "string")
    .map((part) => String(part.text).slice(0, 256)).join(" ").slice(0, 256);
}

export function missing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

/** Never read the transcript after the first metadata line, or an unbounded summary file. */
export async function readJson(path: string, firstLine = false): Promise<unknown> {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    if (!firstLine && size > 512 * 1024) throw new Error("History summary is too large.");
    const buffer = Buffer.alloc(Math.min(size, firstLine ? 64 * 1024 : 512 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    if (firstLine && size > bytesRead && !text.includes("\n")) throw new Error("History metadata is too large.");
    return JSON.parse(firstLine ? text.split("\n", 1)[0]! : text);
  } finally {
    await file.close();
  }
}

export async function* historyFiles(root: string, filename: (name: string) => boolean, signal: AbortSignal, depth = 0): AsyncGenerator<string> {
  signal.throwIfAborted();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    signal.throwIfAborted();
    const path = join(root, entry.name);
    // No symlinks: histories cannot make a scan wander outside the provider store.
    if (entry.isDirectory() && depth < 6) yield* historyFiles(path, filename, signal, depth + 1);
    else if (entry.isFile() && filename(entry.name)) yield path;
  }
}

export async function readJsonLines(path: string, visit: (value: unknown) => void, signal: AbortSignal, accept: (line: string) => boolean = () => true): Promise<number> {
  const stream = createReadStream(path, { encoding: "utf8", signal });
  let skipped = 0;
  let pending = "";
  let oversized = false;
  const consume = (): void => {
    if (!pending.trim() || !accept(pending)) return;
    try { visit(JSON.parse(pending)); }
    catch { skipped += 1; }
  };
  try {
    for await (const chunk of stream) {
      signal.throwIfAborted();
      const parts = String(chunk).split("\n");
      for (let index = 0; index < parts.length; index++) {
        if (!oversized) {
          pending += parts[index];
          if (pending.length > 64 * 1024) { pending = ""; oversized = true; skipped += 1; }
        }
        if (index < parts.length - 1) {
          if (!oversized) consume();
          pending = "";
          oversized = false;
        }
      }
    }
    if (!oversized) consume();
  } finally {
    stream.destroy();
  }
  return skipped;
}

/** node:sqlite is built into Electron's Node runtime. Synchronous queries stay off the main/UI thread. */
export async function sqliteHistory(path: string, provider: "codex" | "hermes" | "opencode" | "minimax", signal: AbortSignal): Promise<HistoryRecords> {
  await stat(path); // A missing store is reported, never created by SQLite.
  signal.throwIfAborted();
  const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      let db;
      try {
        db = new DatabaseSync(workerData.path, { readOnly: true });
        db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000');
        const table = workerData.provider === 'codex' ? 'threads' : workerData.provider === 'hermes' ? 'sessions' : workerData.provider === 'minimax' ? 'local_runtime_sessions' : 'session';
        const columns = new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map(row => row.name));
        const time = workerData.provider === 'codex'
          ? (columns.has('updated_at_ms') ? 'COALESCE(updated_at_ms, updated_at * 1000)' : 'updated_at * 1000')
          : workerData.provider === 'hermes'
            ? (columns.has('last_activity_at') ? 'COALESCE(last_activity_at, started_at) * 1000' : 'started_at * 1000')
            : 'time_updated';
        const title = workerData.provider === 'codex' && columns.has('name')
          ? "COALESCE(NULLIF(name, ''), title)" : columns.has('title') ? 'title' : 'NULL';
        const cwd = workerData.provider === 'opencode' && columns.has('directory')
          ? 'directory' : columns.has('cwd') ? 'cwd' : 'NULL';
        const query = workerData.provider === 'minimax'
          ? "SELECT session_id AS id, CASE WHEN json_valid(record_json) THEN substr(json_extract(record_json, '$.title'), 1, 256) END AS title, CASE WHEN json_valid(record_json) THEN CASE WHEN length(json_extract(record_json, '$.workspaceDir')) <= 4096 THEN json_extract(record_json, '$.workspaceDir') END END AS cwd, updated_at_ms AS lastActivityAt FROM local_runtime_sessions"
          : 'SELECT id, substr(' + title + ', 1, 256) AS title, CASE WHEN length(' + cwd + ') <= 4096 THEN ' + cwd + ' ELSE NULL END AS cwd, ' + time + ' AS lastActivityAt FROM ' + table;
        const rows = db.prepare(query).all();
        parentPort.postMessage({ rows });
      } catch { parentPort.postMessage({ error: true }); }
      finally { if (db) db.close(); }
    `, { eval: true, workerData: { path, provider } });
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      void worker.terminate();
    };
    const abort = (): void => { finish(); reject(new Error("History reading stopped.")); };
    const timer = setTimeout(() => { finish(); reject(new Error("History database read timed out.")); }, 15_000);
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (value: { rows?: Record<string, unknown>[]; error?: boolean }) => {
      finish();
      if (value.rows) resolve(value.rows);
      else reject(new Error("History database could not be read. Check access and the provider store format."));
    });
    worker.once("error", () => { finish(); reject(new Error("SQLite history reader is unavailable in this runtime.")); });
    worker.once("exit", (code) => {
      if (code !== 0) { finish(); reject(new Error("History reader stopped.")); }
    });
  });
  const items = rows.map((row) => historyItem(provider, row)).filter((item): item is AgentChatHistoryItem => item !== null);
  return { items, skipped: rows.length - items.length };
}
