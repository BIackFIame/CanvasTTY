// OpenCode database usage scenarios. Run by tests/usage-more-agents.test.mjs under a runtime whose node:sqlite opens
// URI filenames: this Node when it can, otherwise Electron's Node (ELECTRON_RUN_AS_NODE), which the app runs on.
// Fixture stores only, built in a temporary folder.
import test from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalUsageCollector } from '../../src/main/services/LocalUsageCollector.ts';
import { readOpenCodeStore } from '../../src/main/services/opencodeUsage.ts';
import { PluginUsage } from '../../src/main/services/PluginUsage.ts';

import { DatabaseSync } from 'node:sqlite';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / 1000) * 1000;
const iso = (ms) => new Date(ms).toISOString();
const PROMPT = 'FIXTURE-PROMPT-do-not-leak-9b9b';
const SES_A = 'ses_3fA9cK2pQ7wLmN8xY1zR4tV6bD';
const SES_B = 'ses_7hJ2kL9mN4pQ6rS8tU1vW3xY5z';
const SES_CHILD = 'ses_child00000000000000000001';
const SES_GRANDCHILD = 'ses_child00000000000000000002';
const SES_FILE_CHILD = 'ses_child00000000000000000003';
const QWEN_SESSION = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const QWEN_BRANCH = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const KIMI_CODE_SESSION = 'session_cccccccc-3333-4333-8333-cccccccccccc';
const KIMI_CLI_SESSION = 'dddddddd-4444-4444-8444-dddddddddddd';

async function folder(t, prefix = 'usage-agents-') {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

/** Every name, size and time below `dir`, links included, not followed. */
async function listing(dir) {
  const out = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const info = await lstat(path);
    out[path] = entry.isFile() ? `${info.size}:${info.mtimeMs}:${createHash('sha256').update(await readFile(path)).digest('hex')}` : entry.isSymbolicLink() ? 'link' : 'dir';
  }
  return out;
}

const tokens = (input, output, reasoning = 0, read = 0, write = 0) => ({ input, output, reasoning, cache: { read, write } });

/** An OpenCode database with V2 `session_message` rows and older `message` rows (one message in both). */
function openCodeDatabase(path, { wal = false, keepOpen = false } = {}) {
  const db = new DatabaseSync(path);
  if (wal) db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
  db.prepare('INSERT INTO session VALUES (?, NULL, ?, ?)').run(SES_A, PROMPT, '/fixture-project-folder');
  // A subagent session (OpenCode's task tool) under SES_A, and one below it.
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run(SES_CHILD, SES_A, PROMPT, '/fixture-project-folder');
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run(SES_GRANDCHILD, SES_CHILD, PROMPT, '/fixture-project-folder');
  const v2 = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)');
  v2.run('msg_v2user', SES_A, 'user', 1, NOW - 2 * HOUR, NOW - 2 * HOUR, JSON.stringify({ time: { created: NOW - 2 * HOUR }, content: [{ type: 'text', text: PROMPT }] }));
  v2.run('msg_v2assistant', SES_A, 'assistant', 2, NOW - 2 * HOUR, NOW - 2 * HOUR + 5_000, JSON.stringify({
    agent: 'build', model: { providerID: 'zai-coding-plan', id: 'glm-4.6' }, content: [{ type: 'text', text: PROMPT }],
    tokens: tokens(100, 20, 5, 300, 40), cost: 0.01, time: { created: NOW - 2 * HOUR, completed: NOW - 2 * HOUR + 5_000 }
  }));
  v2.run('msg_v2compaction', SES_A, 'compaction', 3, NOW - HOUR, NOW - HOUR, JSON.stringify({
    status: 'completed', reason: 'auto', summary: PROMPT, model: { providerID: 'zai-coding-plan', id: 'glm-4.6' }, tokens: tokens(50, 10), time: { created: NOW - HOUR }
  }));
  v2.run('msg_v2child', SES_GRANDCHILD, 'assistant', 1, NOW - 40 * MINUTE, NOW - 40 * MINUTE, JSON.stringify({
    agent: 'general', model: { providerID: 'zai-coding-plan', id: 'glm-4.6' }, content: [], tokens: tokens(60, 6), time: { created: NOW - 40 * MINUTE }
  }));
  v2.run('msg_v2streaming', SES_A, 'assistant', 4, NOW - 30 * MINUTE, NOW - 30 * MINUTE, JSON.stringify({
    agent: 'build', model: { providerID: 'zai-coding-plan', id: 'glm-4.6' }, content: [], time: { created: NOW - 30 * MINUTE }
  }));
  const v1 = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  // Migrated: the same message in both tables counts once.
  v1.run('msg_v2assistant', SES_A, NOW - 2 * HOUR, NOW - 2 * HOUR + 5_000, JSON.stringify({ role: 'assistant', modelID: 'glm-4.6', providerID: 'zai-coding-plan', tokens: tokens(100, 20, 5, 300, 40), time: { created: NOW - 2 * HOUR } }));
  v1.run('msg_old1', SES_B, NOW - 3 * HOUR, NOW - 3 * HOUR + 1_000, JSON.stringify({ role: 'assistant', modelID: 'kimi-k2', providerID: 'moonshot', system: [PROMPT], path: { cwd: '/fixture-project-folder' }, tokens: tokens(7, 3), time: { created: NOW - 3 * HOUR } }));
  v1.run('msg_olduser', SES_B, NOW - 3 * HOUR, NOW - 3 * HOUR, JSON.stringify({ role: 'user', summary: { title: PROMPT }, time: { created: NOW - 3 * HOUR } }));
  v1.run('msg_ancient', SES_B, NOW - 40 * DAY, NOW - 40 * DAY, JSON.stringify({ role: 'assistant', modelID: 'm', providerID: 'p', tokens: tokens(1, 1), time: { created: NOW - 40 * DAY } }));
  if (keepOpen) return db;
  db.close();
  return null;
}

/** OpenCode 1.x message files (before its database). */
async function openCodeFiles(dataDir) {
  const write = async (session, message, value) => {
    const dir = join(dataDir, 'storage', 'message', session);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${message}.json`), JSON.stringify({ id: message, sessionID: session, ...value }));
  };
  await write(SES_B, 'msg_file1', { role: 'assistant', modelID: 'claude-sonnet-4-5', providerID: 'anthropic', system: [PROMPT], tokens: tokens(11, 2, 1, 5, 0), time: { created: NOW - 50 * MINUTE, completed: NOW - 49 * MINUTE } });
  await write(SES_B, 'msg_fileuser', { role: 'user', summary: { title: PROMPT }, time: { created: NOW - 51 * MINUTE } });
  await write(SES_FILE_CHILD, 'msg_filechild', { role: 'assistant', modelID: 'claude-sonnet-4-5', providerID: 'anthropic', tokens: tokens(4, 4), time: { created: NOW - 45 * MINUTE } });
  await mkdir(join(dataDir, 'storage', 'session', 'project1'), { recursive: true });
  await writeFile(join(dataDir, 'storage', 'session', 'project1', `${SES_FILE_CHILD}.json`), JSON.stringify({ id: SES_FILE_CHILD, parentID: SES_B, title: PROMPT }));
  // Also in the database: counted once.
  await write(SES_B, 'msg_old1', { role: 'assistant', modelID: 'kimi-k2', providerID: 'moonshot', tokens: tokens(7, 3), time: { created: NOW - 3 * HOUR } });
}

const EXPECTED_OPENCODE = [
  ['msg_old1', SES_B, 'moonshot/kimi-k2', 7, 3, 0],
  ['msg_v2assistant', SES_A, 'zai-coding-plan/glm-4.6', 440, 25, 300],
  ['msg_v2compaction', SES_A, 'zai-coding-plan/glm-4.6', 50, 10, 0],
  ['msg_file1', SES_B, 'anthropic/claude-sonnet-4-5', 16, 3, 5],
  ['msg_v2child', SES_A, 'zai-coding-plan/glm-4.6', 60, 6, 0],
  ['msg_filechild', SES_B, 'anthropic/claude-sonnet-4-5', 4, 4, 0]
];
const fp = (value) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const shape = (events) => events.map((event) => [event.id, event.session, event.model, event.input, event.output, event.cached])
  .sort((a, b) => (a[0] < b[0] ? -1 : 1));
const expected = (rows) => rows.map(([id, ...rest]) => [fp(`opencode:${id}`), ...rest]).sort((a, b) => (a[0] < b[0] ? -1 : 1));

test('OpenCode: database (both tables) and message files, each message once, accounting fields only', async (t) => {
  const home = await folder(t);
  const dataDir = join(home, 'data', 'opencode');
  await mkdir(dataDir, { recursive: true });
  openCodeDatabase(join(dataDir, 'opencode.db'));
  await openCodeFiles(dataDir);
  const before = await listing(home);
  const collector = new LocalUsageCollector(home, {}, { XDG_DATA_HOME: join(home, 'data') });
  const result = await collector.collect(NOW);
  assert.deepEqual(await listing(home), before, 'nothing in the store changes or appears');
  const opencode = result.events.filter((event) => event.provider === 'opencode');
  assert.deepEqual(shape(opencode), expected(EXPECTED_OPENCODE));
  assert.ok(opencode.every((event) => event.app === 'OpenCode' && event.profile === 'default'));
  // OpenCode's own estimate is kept, labelled as such, only where it recorded one.
  assert.deepEqual(opencode.filter((event) => event.providerCostEstimate !== undefined).map((event) => [event.id, event.providerCostEstimate]),
    [[fp('opencode:msg_v2assistant'), 0.01]]);
  assert.doesNotMatch(JSON.stringify(result.events), /FIXTURE-PROMPT|fixture-project-folder/);
  assert.match(result.coverage.join('\n'), /OpenCode XDG_DATA_HOME: database: 5 records read; message files: 4 in window, 4 read/);
  assert.match(result.coverage.join('\n'), /Grok is not covered/);
  assert.equal(result.complete, true);

  // Nothing changed: the database cursor and file sizes skip everything already read.
  const again = await collector.collect(NOW + MINUTE);
  assert.deepEqual(shape(again.events.filter((event) => event.provider === 'opencode')),
    expected(EXPECTED_OPENCODE.filter(([id]) => id === 'msg_v2child')), 'only rows updated within 10 minutes of the newest read are read again');
  const db = new DatabaseSync(join(dataDir, 'opencode.db'));
  db.prepare("UPDATE session_message SET time_updated = ?, data = json_set(data, '$.tokens', json(?)) WHERE id = 'msg_v2streaming'")
    .run(NOW + 2 * MINUTE, JSON.stringify(tokens(9, 9)));
  db.close();
  const third = await collector.collect(NOW + 3 * MINUTE);
  assert.ok(third.events.some((event) => event.id === fp('opencode:msg_v2streaming') && event.input === 9), 'a message that finished streaming is read');
});

test('OpenCode database: no side files with a closed WAL, a live writer, or a rollback journal; WAL without -shm is skipped', async (t) => {
  const root = await folder(t);
  const read = async (dataDir, noFollow = true) => readOpenCodeStore({
    dataDir, database: join(dataDir, 'opencode.db'), noFollow, profile: 'home', cursors: {}, now: NOW, retention: 30 * DAY,
  });
  for (const [name, options] of [['journal', {}], ['wal-closed', { wal: true }]]) {
    const dir = join(root, name);
    await mkdir(dir);
    openCodeDatabase(join(dir, 'opencode.db'), options);
    const before = await listing(dir);
    const result = await read(dir);
    assert.equal(result.events.length, 4, name);
    assert.deepEqual(await listing(dir), before, `${name}: no -wal, -shm or journal created`);
  }
  const live = join(root, 'live');
  await mkdir(live);
  openCodeDatabase(join(live, 'opencode.db'), { wal: true });
  // A running OpenCode is another process: it holds the database open with rows only in WAL frames.
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(${JSON.stringify(join(live, 'opencode.db'))});
    db.exec('PRAGMA wal_autocheckpoint = 0');
    db.prepare("INSERT INTO session_message VALUES ('msg_live', ?, 'assistant', 9, ?, ?, ?)")
      .run(${JSON.stringify(SES_A)}, ${NOW - MINUTE}, ${NOW - MINUTE}, ${JSON.stringify(JSON.stringify({ model: { providerID: 'p', id: 'm' }, tokens: tokens(5, 5), time: { created: NOW - MINUTE } }))});
    process.stdout.write('ready\\n');
    process.stdin.on('end', () => { db.close(); process.exit(0); });
    process.stdin.resume();
  `], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      writer.stdout.once('data', resolve);
      writer.once('exit', (code) => reject(new Error(`writer exited ${code}`)));
    });
    const names = (await readdir(live)).sort();
    assert.deepEqual(names, ['opencode.db', 'opencode.db-shm', 'opencode.db-wal']);
    const before = await listing(live);
    const result = await read(live);
    assert.ok(result.events.some((event) => event.id === fp('opencode:msg_live')), 'rows only in WAL frames are read');
    assert.deepEqual((await readdir(live)).sort(), names);
    assert.deepEqual(await listing(live), before, 'the running writer\'s files are not touched, -shm included');
  } finally {
    writer.stdin.end();
    await new Promise((resolve) => (writer.exitCode !== null ? resolve() : writer.once('exit', resolve)));
  }

  const stale = join(root, 'stale');
  await mkdir(stale);
  const source = join(root, 'stale-source');
  await mkdir(source);
  const held = openCodeDatabase(join(source, 'opencode.db'), { wal: true, keepOpen: true });
  held.prepare("INSERT INTO message VALUES ('msg_wal', ?, ?, ?, ?)").run(SES_B, NOW, NOW, JSON.stringify({ role: 'assistant', modelID: 'm', providerID: 'p', tokens: tokens(1, 1), time: { created: NOW } }));
  await copyFile(join(source, 'opencode.db'), join(stale, 'opencode.db'));
  await copyFile(join(source, 'opencode.db-wal'), join(stale, 'opencode.db-wal'));
  held.close();
  const result = await read(stale);
  assert.deepEqual(result.events, []);
  assert.match(result.notes.join(' '), /WAL without shared-memory index/);
  assert.equal(result.complete, false);
  assert.deepEqual((await readdir(stale)).sort(), ['opencode.db', 'opencode.db-wal'], 'no -shm created');
});

test('OpenCode account home: links and a swapped database are refused', async (t) => {
  const root = await folder(t);
  const person = join(root, 'person-opencode');
  await mkdir(person);
  openCodeDatabase(join(person, 'opencode.db'));
  await openCodeFiles(person);
  const collect = async (home) => {
    const collector = new LocalUsageCollector(root, {}, {}, { only: { source: 'opencode', path: home } });
    return collector.collect(NOW);
  };

  // The database, the storage folder and a message file each linked to the person's own store.
  const linked = join(root, 'home-links');
  await mkdir(join(linked, 'storage', 'message', SES_B), { recursive: true });
  await symlink(join(person, 'opencode.db'), join(linked, 'opencode.db'));
  await symlink(join(person, 'storage', 'message', SES_B, 'msg_file1.json'), join(linked, 'storage', 'message', SES_B, 'msg_file1.json'));
  assert.deepEqual((await collect(linked)).events, []);
  const linkedStorage = join(root, 'home-linked-storage');
  await mkdir(join(linkedStorage, 'storage'), { recursive: true });
  await symlink(join(person, 'storage', 'message'), join(linkedStorage, 'storage', 'message'));
  assert.deepEqual((await collect(linkedStorage)).events, []);
  const linkedParent = join(root, 'home-linked-parent');
  await mkdir(linkedParent);
  await symlink(join(person, 'storage'), join(linkedParent, 'storage'));
  assert.deepEqual((await collect(linkedParent)).events, [], 'a linked storage folder above the message folder');
  // XDG_DATA_HOME-style home whose `opencode` folder is a link.
  const linkedNested = join(root, 'home-linked-nested');
  await mkdir(linkedNested);
  await symlink(person, join(linkedNested, 'opencode'));
  assert.deepEqual((await collect(linkedNested)).events, []);
  // A -wal that is a link: the database is skipped.
  const linkedWal = join(root, 'home-linked-wal');
  await mkdir(linkedWal);
  openCodeDatabase(join(linkedWal, 'opencode.db'));
  await writeFile(join(root, 'elsewhere-wal'), 'x');
  await symlink(join(root, 'elsewhere-wal'), join(linkedWal, 'opencode.db-wal'));
  const walResult = await collect(linkedWal);
  assert.deepEqual(walResult.events, []);
  assert.match(walResult.coverage.join(' '), /side file is a link/);

  // A real home, as a data folder and as XDG_DATA_HOME: read.
  const real = join(root, 'home-real');
  await mkdir(join(real, 'opencode'), { recursive: true });
  openCodeDatabase(join(real, 'opencode', 'opencode.db'));
  const ok = await collect(real);
  assert.equal(ok.events.length, 4);
  assert.ok(ok.events.every((event) => event.profile === 'home'));

  // The database replaced by the person's between the open and the read: the rows are dropped.
  const swapped = join(root, 'home-swap');
  await mkdir(swapped);
  openCodeDatabase(join(swapped, 'opencode.db'));
  const other = join(root, 'other.db');
  const otherDb = new DatabaseSync(other);
  otherDb.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)");
  otherDb.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('msg_person', SES_B, NOW, NOW, JSON.stringify({ role: 'assistant', modelID: 'm', providerID: 'p', tokens: tokens(777, 7), time: { created: NOW } }));
  otherDb.close();
  const result = await readOpenCodeStore({
    dataDir: swapped, database: join(swapped, 'opencode.db'), noFollow: true, profile: 'home', cursors: {}, now: NOW, retention: 30 * DAY,
    afterOpen: () => rename(other, join(swapped, 'opencode.db'))
  });
  assert.equal(result.events.some((event) => event.id === fp('opencode:msg_person')), false, 'the swapped-in database is never read');
  assert.deepEqual(result.events, [], 'the swap is detected and the rows dropped');
  assert.match(result.notes.join(' '), /replaced while it was read/);
});

test('plugin usage: OpenCode, Qwen and Kimi cards and account homes', async (t) => {
  const root = await folder(t);
  const dataDir = join(root, 'plugin-data', 'com.example.router');
  const ocHome = join(dataDir, 'homes', 'opencode-1');
  const qwenHome = join(dataDir, 'homes', 'qwen-1');
  const kimiHome = join(dataDir, 'homes', 'kimi-1');
  await mkdir(join(ocHome, 'opencode'), { recursive: true });
  openCodeDatabase(join(ocHome, 'opencode', 'opencode.db'));
  await mkdir(join(qwenHome, 'projects', 'p', 'chats'), { recursive: true });
  await writeFile(join(qwenHome, 'projects', 'p', 'chats', `${QWEN_SESSION}.jsonl`),
    JSON.stringify({ uuid: 'r-1', sessionId: QWEN_SESSION, timestamp: iso(NOW - HOUR), type: 'assistant', model: 'qwen3-coder-plus', usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 4 } }) + '\n');
  await mkdir(join(kimiHome, 'sessions', KIMI_CODE_SESSION, 'agents', 'main'), { recursive: true });
  await writeFile(join(kimiHome, 'sessions', KIMI_CODE_SESSION, 'agents', 'main', 'wire.jsonl'),
    JSON.stringify({ type: 'usage.record', model: 'kimi-k2', usage: { inputOther: 8, output: 2, inputCacheRead: 0, inputCacheCreation: 0 }, time: NOW - HOUR }) + '\n');
  const cards = [
    { id: 'oc', provider: 'opencode', threadId: SES_A, contributors: ['com.example.router'], owner: null },
    { id: 'qw', provider: 'qwen', threadId: QWEN_SESSION, contributors: ['com.example.router'], owner: null },
    { id: 'ki', provider: 'kimi', threadId: KIMI_CODE_SESSION, contributors: ['com.example.router'], owner: null }
  ];
  const usage = new PluginUsage({
    history: () => ({ peek: () => ({ startedAt: NOW - 40 * DAY, collectedAt: NOW, events: [], health: [] }) }),
    cards: { usageContext: (id) => cards.find((card) => card.id === id) ?? null, usageContexts: () => cards },
    allowed: () => true,
    homeCollector: (source, home) => new LocalUsageCollector(home, {}, {}, { only: { source, path: home } }),
    now: () => NOW
  });
  const ask = (method, params) => usage.handle('com.example.router', method, params, ['usage:read', 'launch:contribute'], dataDir);
  const oc = await ask('usage.session', { cardId: 'oc', homes: [{ provider: 'opencode', home: ocHome }] });
  assert.equal(oc.totals.providerCostEstimate, 0.01);
  assert.equal(oc.models[0].providerCostEstimate, 0.01);
  assert.deepEqual([oc.measured, oc.totals.input, oc.totals.output, oc.models.map((row) => row.model)],
    [true, 550, 41, ['zai-coding-plan/glm-4.6']]);
  const qw = await ask('usage.session', { cardId: 'qw', homes: [{ provider: 'qwen', home: qwenHome }] });
  assert.deepEqual([qw.totals.input, qw.totals.output], [40, 4]);
  const ki = await ask('usage.session', { cardId: 'ki', homes: [{ provider: 'kimi', home: kimiHome }] });
  assert.deepEqual([ki.totals.input, ki.totals.output], [8, 2]);
  const summary = await ask('usage.summary', { groupBy: ['home', 'provider', 'model'], homes: [{ provider: 'opencode', home: ocHome }, { provider: 'qwen', home: qwenHome }, { provider: 'kimi', home: kimiHome }] });
  assert.deepEqual(summary.rows.map((row) => [row.home, row.provider, row.model, row.input]).sort(), [
    [0, 'opencode', 'zai-coding-plan/glm-4.6', 550],
    [1, 'qwen', 'qwen3-coder-plus', 40],
    [0, 'opencode', 'moonshot/kimi-k2', 7],
    [2, 'kimi', 'kimi-k2', 8]
  ].sort());
  assert.doesNotMatch(JSON.stringify([oc, qw, ki, summary]), /FIXTURE-PROMPT|ses_|session_|plugin-data|fixture-project/);
});
