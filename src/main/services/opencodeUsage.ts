import { Worker } from 'node:worker_threads';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { UsageEvent } from '../../shared/usageHistory.ts';
import { fingerprint, identifier, record, tokens, usageModel } from './usageReaders.ts';

/*
 * OpenCode keeps one record per model response, rewritten in place while it streams:
 * - OpenCode 1.x before its database: `<data>/storage/message/<session>/<message>.json` (older releases:
 *   `<data>/storage/session/message/…`), `{ id, sessionID, role, modelID, providerID, tokens, time }`;
 * - its database `<data>/opencode.db`: the `message` table (the same JSON in `data`) and, since V2, `session_message`
 *   (`type` 'assistant' or 'compaction', `data.model { providerID, id }`, `data.tokens`). Migrations keep message ids.
 * `tokens` is `{ input, output, reasoning, cache: { read, write } }` with `input` excluding both cache parts and
 * `output` excluding reasoning. Records are identified by message id, so the same message seen in several places
 * (JSON file, `message`, `session_message`) counts once.
 */

/** Per-store cursor, persisted in the collector state: a database's last read, or a JSON file's size and time. */
export interface OpenCodeCursor {
  node: string;
  /** Database: newest `time_updated` read. JSON file: when it was last seen. */
  at: number;
  size?: number;
  mtime?: number;
}

export interface OpenCodeRead {
  events: UsageEvent[];
  cursors: Record<string, OpenCodeCursor>;
  /** Person-readable notes without paths. */
  notes: string[];
  complete: boolean;
}

/** Runs read-only statements on one SQLite URI and returns their rows (worker thread by default; tests replace it). */
export type SqliteQuery = (target: string, statements: string[]) => Promise<Record<string, unknown>[][]>;

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_DEPTH = 3;
/** A row updated this long before the last read is read again: OpenCode writes `time_updated` from its own clock. */
const OVERLAP = 10 * 60_000;
/** Platforms where `/dev/fd/<n>` in a child names the file the parent opened and passed as descriptor <n>. */
const DEV_FD = process.platform === 'darwin' || process.platform === 'linux';

class StoreProblem extends Error {}

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
let db;
try {
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(workerData.target, { readOnly: true, timeout: 2000 });
  parentPort.postMessage({ results: workerData.statements.map((sql) => db.prepare(sql).all()) });
} catch (error) {
  parentPort.postMessage({ error: String((error && error.message) || error).slice(0, 200) });
} finally {
  try { if (db) db.close(); } catch {}
}`;

/**
 * Default query: node:sqlite (the app's Electron Node) in a worker thread, so the main thread never waits on SQLite.
 * A descriptor named by `/dev/fd/<n>` belongs to this process, so the worker reads the file the caller opened.
 */
export const workerSqliteQuery: SqliteQuery = (target, statements) => new Promise((resolve, reject) => {
  let worker: Worker;
  try {
    worker = new Worker(WORKER, { eval: true, workerData: { target, statements } });
  } catch {
    reject(new StoreProblem('SQLite is unavailable in this runtime; not collected'));
    return;
  }
  const timer = setTimeout(() => { void worker.terminate(); reject(new StoreProblem('read timed out')); }, 15_000);
  worker.once('message', (value: { results?: Record<string, unknown>[][]; error?: string }) => {
    clearTimeout(timer);
    void worker.terminate();
    if (value.results) resolve(value.results);
    else reject(Object.assign(new Error('sqlite failed'), { stderr: value.error ?? '' }));
  });
  worker.once('error', () => { clearTimeout(timer); reject(new StoreProblem('SQLite is unavailable in this runtime; not collected')); });
});

const uriSupport = new WeakMap<SqliteQuery, Promise<boolean>>();
/**
 * Whether this runtime's node:sqlite opens URI filenames (Node 24 / the app's Electron does; Node 23 does not). Probed
 * once by opening this executable read-only as an immutable URI: without URI support the name is a plain relative
 * file that does not exist, and a read-only open creates nothing.
 */
export function sqliteUriSupported(query: SqliteQuery = workerSqliteQuery): Promise<boolean> {
  let known = uriSupport.get(query);
  if (!known) {
    known = query(`${pathToFileURL(process.execPath).href}?mode=ro&immutable=1`, []).then(() => true, () => false);
    uriSupport.set(query, known);
  }
  return known;
}

/**
 * Opens a regular file for reading. With `noFollow` the last step may not be a symbolic link: it is checked with
 * lstat, opened with O_NOFOLLOW where the platform has it, and the open file must be the one checked (same device and
 * inode), so a path swapped in between is refused (the same rule as account-home credential reads).
 */
export async function openPlainFile(path: string, noFollow: boolean, afterCheck?: () => Promise<void>): Promise<{ handle: FileHandle; dev: number; ino: number }> {
  const notPlain = (): Error => Object.assign(new Error('not a plain file'), { code: 'ENOENT' });
  const checked = noFollow ? await lstat(path) : null;
  if (checked && !checked.isFile()) throw notPlain();
  await afterCheck?.();
  const handle = await open(path, fsConstants.O_RDONLY | (noFollow ? fsConstants.O_NOFOLLOW ?? 0 : 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || (checked && (checked.dev !== info.dev || checked.ino !== info.ino))) throw notPlain();
    return { handle, dev: info.dev, ino: info.ino };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function eventFrom(
  id: unknown, session: unknown, provider: unknown, model: unknown, values: unknown[], from: unknown, to: unknown, profile: string, now: number,
  cost: unknown
): UsageEvent | 'invalid' | null {
  const messageId = identifier(id);
  if (!messageId) return 'invalid';
  const counted = values.map(tokens);
  if (counted.some(value => value === null)) return 'invalid';
  const [input, output, reasoning, read, write] = counted as number[];
  if (!input && !output && !reasoning && !read && !write) return null;
  const start = typeof from === 'number' && Number.isFinite(from) && from > 0 ? from : null;
  let end = typeof to === 'number' && Number.isFinite(to) && to > 0 ? to : start;
  if (start === null || end === null) return 'invalid';
  end = Math.min(Math.max(end, start), now);
  const name = usageModel(typeof provider === 'string' && typeof model === 'string' && provider && model ? `${provider}/${model}` : model);
  return {
    id: fingerprint(`opencode:${messageId}`), provider: 'opencode', app: 'OpenCode', profile,
    session: identifier(session) || `opencode-${fingerprint(String(session ?? '')).slice(0, 12)}`,
    from: Math.min(start, end), to: end, input: input + read + write, output: output + reasoning, cached: read, timing: 'event',
    ...(name ? { model: name } : {}),
    // OpenCode's own price estimate for this response (USD, from its model list), kept apart from the counts.
    ...(typeof cost === 'number' && Number.isFinite(cost) && cost > 0 && cost < 1_000 ? { providerCostEstimate: cost } : {}),
  };
}

/**
 * Accounting columns only: json_extract keeps message text inside SQLite. With `session.parent_id`, a subagent's
 * session (OpenCode's task tool) is reported under its root session, the conversation the card is attached to.
 */
function databaseQuery(tables: Set<string>, since: number, parents: boolean): string {
  const tokenColumns = (data: string): string => ['input', 'output', 'reasoning', 'cache.read', 'cache.write']
    .map((path, index) => `json_extract(${data}, '$.tokens.${path}') AS t${index}`).concat(`json_extract(${data}, '$.cost') AS c`).join(', ');
  const parts: string[] = [];
  if (tables.has('session_message')) {
    parts.push(`SELECT id, session_id AS s, time_created AS tc, time_updated AS tu, json_extract(data, '$.model.providerID') AS p, `
      + `json_extract(data, '$.model.id') AS m, ${tokenColumns('data')} FROM session_message `
      + `WHERE type IN ('assistant', 'compaction') AND time_updated >= ${since} AND json_valid(data) AND json_type(data, '$.tokens') = 'object'`);
  }
  if (tables.has('message')) {
    parts.push(`SELECT id, session_id AS s, time_created AS tc, time_updated AS tu, json_extract(data, '$.providerID') AS p, `
      + `json_extract(data, '$.modelID') AS m, ${tokenColumns('data')} FROM message `
      + `WHERE time_updated >= ${since} AND json_valid(data) AND json_extract(data, '$.role') = 'assistant' AND json_type(data, '$.tokens') = 'object'`);
  }
  if (!parents) return parts.join(' UNION ALL ');
  return `WITH RECURSIVE root(id, top, depth) AS (SELECT id, id, 0 FROM session WHERE parent_id IS NULL `
    + `UNION ALL SELECT session.id, root.top, root.depth + 1 FROM session JOIN root ON session.parent_id = root.id WHERE root.depth < 8), `
    + `usage AS (${parts.join(' UNION ALL ')}) `
    + `SELECT usage.id, COALESCE(root.top, usage.s) AS s, usage.tc, usage.tu, usage.p, usage.m, usage.t0, usage.t1, usage.t2, usage.t3, usage.t4, usage.c `
    + `FROM usage LEFT JOIN root ON root.id = usage.s`;
}

/**
 * Reads OpenCode's usage from one data folder without changing anything in it. `noFollow` (an account home) refuses
 * every symbolic link: the database, its `-wal`/`-shm`, the storage folders and the JSON files.
 *
 * The database is opened as a file first (O_NOFOLLOW for a home) and checked to be a regular file. Without WAL frames
 * node:sqlite (in a worker thread) reads it `immutable` through `/dev/fd/<n>`, the descriptor already open (no lock, no
 * side file, and bound to
 * the checked file). With WAL frames and `-shm` (a running OpenCode) it is read by path with `mode=ro&readonly_shm=1`
 * through the existing side files, which creates none. WAL frames without `-shm` are skipped (reading them would
 * create one). After the read the path must still be the file opened first (device and inode), or the rows are
 * dropped.
 */
export async function readOpenCodeStore(options: {
  dataDir: string;
  database: string | null;
  noFollow: boolean;
  profile: string;
  cursors: Record<string, OpenCodeCursor>;
  now: number;
  retention: number;
  /** Tests only: replaces the worker-thread query. */
  query?: SqliteQuery;
  /** Tests only: runs between opening the database and reading it. */
  afterOpen?: () => Promise<void>;
}): Promise<OpenCodeRead> {
  const { dataDir, noFollow, profile, now, retention } = options;
  const result: OpenCodeRead = { events: [], cursors: {}, notes: [], complete: true };
  const seen = new Set<string>();
  const take = (event: UsageEvent | 'invalid' | null, counters: { invalid: number }): void => {
    if (event === 'invalid') { counters.invalid++; return; }
    if (!event || event.to < now - retention || seen.has(event.id)) return;
    seen.add(event.id);
    result.events.push(event);
  };

  if (options.database) {
    const key = fingerprint(options.database);
    const counters = { invalid: 0 };
    try {
      const read = await readDatabase(options.database, noFollow, options.cursors[key], now, retention, options.query ?? workerSqliteQuery, options.afterOpen);
      if (read) {
        for (const row of read.rows) {
          take(eventFrom(row.id, row.s, row.p, row.m, [row.t0, row.t1, row.t2, row.t3, row.t4], row.tc, row.tu, profile, now, row.c), counters);
        }
        result.cursors[key] = read.cursor;
        result.notes.push(`database: ${read.rows.length} records read${counters.invalid ? `, ${counters.invalid} with invalid counters skipped` : ''}`);
        if (counters.invalid) result.complete = false;
      } else if (options.cursors[key]) {
        result.cursors[key] = options.cursors[key];
      }
    } catch (error) {
      result.complete = false;
      result.notes.push(`database: ${error instanceof StoreProblem ? error.message : 'read failed'}; not collected this time`);
      if (options.cursors[key]) result.cursors[key] = options.cursors[key];
    }
  }

  const counters = { invalid: 0, files: 0, read: 0, unreadable: 0 };
  // Session files name each subagent session's parent: its usage is reported under the root session.
  const parents = await sessionParents(dataDir, noFollow);
  const rootOf = (session: unknown): unknown => {
    let current = session;
    for (let depth = 0; depth < 8 && typeof current === 'string' && parents.has(current); depth++) current = parents.get(current);
    return current;
  };
  for (const folder of [['storage', 'message'], ['storage', 'session', 'message']]) {
    const root = join(dataDir, ...folder);
    const walk = async (directory: string, depth: number): Promise<void> => {
      let entries;
      try {
        const info = await lstat(directory);
        if (!info.isDirectory()) return;
        // In a home every folder on the way must be a real one: the real path is the home's plus the same names.
        if (depth === 0 && noFollow && await realpath(directory) !== join(await realpath(dataDir), ...folder)) return;
        entries = await readdir(directory, { withFileTypes: true });
      } catch { if (depth > 0) counters.unreadable++; return; }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { if (depth < MAX_DEPTH) await walk(path, depth + 1); continue; }
        if (!entry.name.endsWith('.json') || (!entry.isFile() && (noFollow || !entry.isSymbolicLink()))) continue;
        try {
          const info = noFollow ? await lstat(path) : await stat(path);
          if (!info.isFile() || info.mtimeMs < now - retention) continue;
          counters.files++;
          const key = fingerprint(path), node = `${info.dev}:${info.ino}`, known = options.cursors[key];
          if (known && known.node === node && known.size === info.size && known.mtime === info.mtimeMs) {
            result.cursors[key] = { ...known, at: now };
            continue;
          }
          if (info.size > MAX_JSON_BYTES) { counters.invalid++; continue; }
          const opened = await openPlainFile(path, noFollow);
          let raw: string;
          try { raw = await opened.handle.readFile('utf8'); } finally { await opened.handle.close(); }
          counters.read++;
          let value: Record<string, unknown>;
          try { value = record(JSON.parse(raw)); } catch { continue; } // Being rewritten: read again next time.
          result.cursors[key] = { node, at: now, size: info.size, mtime: info.mtimeMs };
          if (value.role !== 'assistant') continue;
          const t = record(value.tokens), cache = record(t.cache), time = record(value.time);
          take(eventFrom(value.id, rootOf(value.sessionID), value.providerID, value.modelID,
            [t.input, t.output, t.reasoning, cache.read, cache.write], time.created, time.completed ?? info.mtimeMs, profile, now, value.cost), counters);
        } catch { counters.unreadable++; }
      }
    };
    await walk(root, 0);
  }
  if (counters.files) {
    result.notes.push(`message files: ${counters.files} in window, ${counters.read} read`
      + `${counters.invalid ? `, ${counters.invalid} invalid` : ''}${counters.unreadable ? `, ${counters.unreadable} unreadable` : ''}`);
  }
  if (counters.invalid || counters.unreadable) result.complete = false;
  return result;
}

/** `storage/session/**` session files (OpenCode 1.x): id → parentID, read as plain files, at most 4,096. */
async function sessionParents(dataDir: string, noFollow: boolean): Promise<Map<string, string>> {
  const parents = new Map<string, string>();
  const root = join(dataDir, 'storage', 'session');
  let budget = 4_096;
  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries;
    try {
      if (depth === 0 && noFollow && await realpath(directory) !== join(await realpath(dataDir), 'storage', 'session')) return;
      entries = await readdir(directory, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      if (budget <= 0) return;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (depth < 2 && entry.name !== 'message' && entry.name !== 'part') await walk(path, depth + 1); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      budget--;
      try {
        const opened = await openPlainFile(path, noFollow);
        let raw: string;
        try {
          if ((await opened.handle.stat()).size > MAX_JSON_BYTES) continue;
          raw = await opened.handle.readFile('utf8');
        } finally { await opened.handle.close(); }
        const value = record(JSON.parse(raw));
        const id = identifier(value.id), parent = identifier(value.parentID);
        if (id && parent && id !== parent) parents.set(id, parent);
      } catch { /* Not a session file. */ }
    }
  };
  await walk(root, 0);
  return parents;
}

async function readDatabase(
  database: string,
  noFollow: boolean,
  cursor: OpenCodeCursor | undefined,
  now: number,
  retention: number,
  query: SqliteQuery,
  afterOpen?: () => Promise<void>
): Promise<{ rows: Record<string, unknown>[]; cursor: OpenCodeCursor } | null> {
  let opened: { handle: FileHandle; dev: number; ino: number };
  try {
    opened = await openPlainFile(database, noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || (error as NodeJS.ErrnoException)?.code === 'ELOOP') return null;
    throw new StoreProblem('not readable');
  }
  try {
    await afterOpen?.();
    const side = async (suffix: string): Promise<number | null | 'link'> => {
      try {
        const info = await lstat(`${database}${suffix}`);
        return noFollow && !info.isFile() ? 'link' : info.size;
      } catch { return null; }
    };
    const [wal, shm] = await Promise.all([side('-wal'), side('-shm')]);
    if (wal === 'link' || shm === 'link') throw new StoreProblem('a side file is a link; skipped');
    const frames = wal !== null && wal > 0;
    if (frames && shm === null) throw new StoreProblem('WAL without shared-memory index (writer stopped uncleanly); skipped to avoid a stale read');
    if (!(await sqliteUriSupported(query))) {
      throw new StoreProblem("this runtime's SQLite cannot open read-only URI filenames; not collected");
    }
    const node = `${opened.dev}:${opened.ino}`;
    const since = Math.floor(cursor && cursor.node === node ? Math.max(cursor.at - OVERLAP, now - retention) : now - retention);
    // Without WAL frames: immutable through the descriptor opened above (no lock, no side file, bound to that file).
    const target = frames ? `${pathToFileURL(database).href}?mode=ro&readonly_shm=1`
      : DEV_FD ? `file:/dev/fd/${opened.handle.fd}?mode=ro&immutable=1` : `${pathToFileURL(database).href}?mode=ro&immutable=1`;
    const run = async (sql: string): Promise<Record<string, unknown>[]> => {
      try {
        const [rows] = await query(target, [sql]);
        return (rows ?? []).map(record);
      } catch (error) {
        if (error instanceof StoreProblem) throw error;
        throw new StoreProblem(sqliteText(error));
      }
    };
    const tables = new Set((await run("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('message', 'session_message', 'session') "
      + "UNION ALL SELECT 'session.parent_id' FROM pragma_table_info('session') WHERE name = 'parent_id'")).map(row => String(row.name)));
    const rows = tables.has('message') || tables.has('session_message')
      ? await run(databaseQuery(tables, since, tables.has('session.parent_id'))) : [];
    const after = await (noFollow ? lstat(database) : stat(database)).catch(() => null);
    if (!after || after.dev !== opened.dev || after.ino !== opened.ino) throw new StoreProblem('the database was replaced while it was read; skipped');
    const newest = rows.reduce((max, row) => typeof row.tu === 'number' && row.tu <= now ? Math.max(max, row.tu) : max, cursor?.node === node ? cursor.at : 0);
    return { rows, cursor: { node, at: newest || now - retention } };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

function sqliteText(error: unknown): string {
  const e = error as NodeJS.ErrnoException & { stderr?: unknown; killed?: boolean };
  if (e.killed) return 'read timed out';
  const text = String(e.stderr || e.message || '');
  if (/not a database|malformed|corrupt/i.test(text)) return 'database is corrupt or not SQLite';
  if (/locked|busy/i.test(text)) return 'database is busy';
  if (/no such (table|column)|json/i.test(text)) return 'unsupported schema';
  if (/unable to open/i.test(text)) return 'database cannot be opened read-only';
  return 'read failed';
}
