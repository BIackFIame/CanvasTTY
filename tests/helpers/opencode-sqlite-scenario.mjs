// Builds OpenCode V2 fixture databases (never a real one) and reads them the way LimitsService does. Run by
// tests/plugin-service-limits.test.mjs in-process when this runtime's node:sqlite opens URI filenames, and otherwise
// under Electron's Node (ELECTRON_RUN_AS_NODE), which the app runs on. Prints one JSON line of results.
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LimitsService, readOpenCodeGoKeyFromDatabase } from "../../src/main/services/LimitsService.ts";

const DB_KEY = "fixture-opencode-db-key-a1a1";
const OLD_KEY = "fixture-opencode-db-key-old-b2b2";
const LEGACY_KEY = "fixture-opencode-legacy-key-c3c3";

const SCHEMA = `CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL,
  connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)`;

function create(path, { wal = false, rows = [], table = true } = {}) {
  const db = new DatabaseSync(path);
  if (wal) db.exec("PRAGMA journal_mode = WAL");
  if (table) db.exec(SCHEMA);
  else db.exec("CREATE TABLE session (id TEXT)");
  const insert = table ? db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)") : null;
  for (const [index, row] of rows.entries()) {
    insert.run(`cred_${index}`, row.integration, "label", JSON.stringify(row.value), row.active ? 1 : 0, index, row.updated ?? index);
  }
  return db;
}

async function snapshotFolder(folder) {
  const entries = {};
  for (const name of (await readdir(folder)).sort()) {
    const info = await lstat(join(folder, name));
    entries[name] = { size: info.size, mtime: info.mtimeMs };
  }
  return entries;
}

const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-opencode-db-")));
const results = {};
try {
  const goRows = [
    { integration: "opencode-go", value: { type: "key", key: OLD_KEY }, active: false, updated: 5 },
    { integration: "opencode-go", value: { type: "key", key: DB_KEY }, active: true, updated: 1 },
    { integration: "openai", value: { type: "key", key: "fixture-other-provider-key-d4d4" }, active: true }
  ];
  const scenario = async (name, build, options) => {
    const folder = join(root, name);
    await mkdir(folder);
    const path = join(folder, "opencode.db");
    const cleanup = await build(path, folder);
    const before = await snapshotFolder(folder);
    const value = await readOpenCodeGoKeyFromDatabase(path, options);
    const after = await snapshotFolder(folder);
    await cleanup?.();
    results[name] = { value: value === undefined ? "undefined" : value, unchanged: JSON.stringify(before) === JSON.stringify(after), files: Object.keys(after) };
  };
  await scenario("rollback-journal", (path) => { create(path, { rows: goRows }).close(); });
  await scenario("wal-closed", (path) => { create(path, { wal: true, rows: goRows }).close(); });
  // A live writer: the row exists only in WAL frames; -wal and -shm are present.
  await scenario("wal-live-writer", (path) => {
    const db = create(path, { wal: true });
    db.exec("PRAGMA wal_autocheckpoint = 0");
    db.prepare("INSERT INTO credential VALUES ('c', 'opencode-go', 'l', ?, NULL, NULL, 1, 1, 1)").run(JSON.stringify({ type: "key", key: DB_KEY }));
    return () => db.close();
  });
  // WAL frames without -shm (a writer that stopped uncleanly): skipped, and no -shm is created.
  await scenario("wal-without-shm", async (path, folder) => {
    const source = join(root, "wal-source");
    await mkdir(source);
    const db = create(join(source, "opencode.db"), { wal: true });
    db.exec("PRAGMA wal_autocheckpoint = 0");
    db.prepare("INSERT INTO credential VALUES ('c', 'opencode-go', 'l', ?, NULL, NULL, 1, 1, 1)").run(JSON.stringify({ type: "key", key: DB_KEY }));
    await copyFile(join(source, "opencode.db"), path);
    await copyFile(join(source, "opencode.db-wal"), `${path}-wal`);
    db.close();
  });
  await scenario("no-go-row", (path) => { create(path, { rows: [goRows[2]] }).close(); });
  await scenario("oauth-value", (path) => { create(path, { rows: [{ integration: "opencode-go", value: { type: "oauth", methodID: "m", refresh: "r", access: "a", expires: 1 }, active: true }] }).close(); });
  await scenario("no-credential-table", (path) => { create(path, { table: false }).close(); });
  // The database is replaced by another one between the open and the SQLite read: the other key is never returned.
  await scenario("swapped-after-open", (path, folder) => {
    create(path, { rows: goRows }).close();
    create(join(folder, "intruder.db"), { rows: [{ integration: "opencode-go", value: { type: "key", key: "fixture-intruder-key-e5e5" }, active: true }] }).close();
  }, { refuseSymlinks: true, afterOpen: async () => {
    const folder = join(root, "swapped-after-open");
    await rename(join(folder, "opencode.db"), join(folder, "original.db"));
    await rename(join(folder, "intruder.db"), join(folder, "opencode.db"));
  } });
  // A live writer whose -wal is a link (an account home): not read.
  await scenario("symlinked-wal", async (path, folder) => {
    const db = create(path, { wal: true, rows: goRows });
    db.exec("PRAGMA wal_autocheckpoint = 0");
    db.prepare("INSERT INTO credential VALUES ('z', 'x', 'l', '{}', NULL, NULL, 0, 9, 9)").run();
    db.close();
    await writeFile(join(folder, "elsewhere-wal"), "x");
    await writeFile(`${path}-shm`, "");
    await writeFile(`${path}-wal`, "frames");
    await rm(`${path}-wal`);
    await symlink(join(folder, "elsewhere-wal"), `${path}-wal`);
  }, { refuseSymlinks: true });
  await scenario("symlinked-db", async (path, folder) => {
    const real = join(folder, "elsewhere.db");
    create(real, { rows: goRows }).close();
    await symlink(real, path);
  }, { refuseSymlinks: true });

  // Through LimitsService for an account home: the database decides over a stale legacy auth.json.
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(init.headers.authorization);
    return Response.json({ usage: { rolling: { percent: 7, resetsAt: "2099-01-01T00:00:00Z" } } });
  };
  const registry = { get: (provider) => provider === "opencode"
    ? { state: "available", provider, executable: "/fixture/opencode", launcher: "native", environment: {}, checked: [] }
    : { state: "unavailable", provider, reason: "cli-not-found", checked: [], diagnostic: "" } };
  const service = new LimitsService(registry, "test");
  try {
    const dataHome = join(root, "home-data");
    await mkdir(dataHome);
    create(join(dataHome, "opencode.db"), { wal: true, rows: goRows }).close();
    await writeFile(join(dataHome, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: LEGACY_KEY } }));
    const xdgRoot = join(root, "home-xdg");
    await mkdir(join(xdgRoot, "opencode"), { recursive: true });
    create(join(xdgRoot, "opencode", "opencode.db"), { rows: [goRows[1]] }).close();
    const signedOut = join(root, "home-signed-out");
    await mkdir(signedOut);
    create(join(signedOut, "opencode.db"), { rows: [goRows[2]] }).close();
    await writeFile(join(signedOut, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: LEGACY_KEY } }));
    const legacyOnly = join(root, "home-legacy");
    await mkdir(legacyOnly);
    await writeFile(join(legacyOnly, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: LEGACY_KEY } }));
    const before = await snapshotFolder(dataHome);
    const read = async (home) => {
      const answer = (await service.getHome("opencode", home)).providers[0];
      return answer.state === "available" ? { state: answer.state, used: answer.windows[0].usedPercent } : { state: answer.state, reason: answer.reason };
    };
    results.service = {
      dataHome: await read(dataHome),
      xdgRoot: await read(xdgRoot),
      signedOut: await read(signedOut),
      legacyOnly: await read(legacyOnly),
      dataHomeUnchanged: JSON.stringify(before) === JSON.stringify(await snapshotFolder(dataHome)),
      authorizations: seen.map((value) => value === `Bearer ${DB_KEY}` ? "db" : value === `Bearer ${LEGACY_KEY}` ? "legacy" : "other")
    };
  } finally {
    service.dispose();
    globalThis.fetch = originalFetch;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(results)}\n`);
