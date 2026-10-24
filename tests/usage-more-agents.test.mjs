// OpenCode (JSON files and opencode.db), Qwen Code and Kimi usage, read from fixture stores only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalUsageCollector } from '../src/main/services/LocalUsageCollector.ts';
import { sqliteUriSupported } from '../src/main/services/opencodeUsage.ts';
import { UsageHistoryService } from '../src/main/services/UsageHistoryService.ts';

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

test('Qwen Code chats: one record per response, branch copies once, model kept, text never', async (t) => {
  const home = await folder(t);
  const qwen = join(home, 'qwen-home');
  const chats = join(qwen, 'projects', '-fixture-project', 'chats');
  await mkdir(chats, { recursive: true });
  const line = (session, uuid, at, usage, model = 'qwen3-coder-plus') => JSON.stringify({
    uuid, parentUuid: null, sessionId: session, timestamp: iso(at), type: 'assistant', model,
    message: { role: 'model', parts: [{ text: PROMPT }] }, cwd: '/fixture-project-folder', usageMetadata: usage
  });
  const user = JSON.stringify({ uuid: 'u-1', sessionId: QWEN_SESSION, timestamp: iso(NOW - HOUR), type: 'user', message: { parts: [{ text: PROMPT }] } });
  const usage = { promptTokenCount: 1_000, candidatesTokenCount: 50, cachedContentTokenCount: 600, thoughtsTokenCount: 20, totalTokenCount: 1_070 };
  await writeFile(join(chats, `${QWEN_SESSION}.jsonl`), [user, line(QWEN_SESSION, 'r-1', NOW - HOUR, usage), line(QWEN_SESSION, 'r-2', NOW - 50 * MINUTE, { promptTokenCount: 10, candidatesTokenCount: 1 }, 'not a model')].join('\n') + '\n');
  // A branched session copies the first response verbatim (same uuid) under its own id.
  await writeFile(join(chats, `${QWEN_BRANCH}.jsonl`), line(QWEN_BRANCH, 'r-1', NOW - HOUR, usage) + '\n');
  await writeFile(join(chats, `${QWEN_SESSION}.runtime.json`), JSON.stringify({ secret: PROMPT }));
  const collector = new LocalUsageCollector(home, {}, { QWEN_HOME: qwen });
  const result = await collector.collect(NOW);
  const events = result.events.filter((event) => event.provider === 'qwen');
  assert.equal(events.length, 2, 'the branch copy is the same record');
  assert.ok(events.some((event) => event.model === 'qwen3-coder-plus' && event.input === 1_000 && event.output === 70 && event.cached === 600));
  assert.ok(events.some((event) => event.model === undefined && event.input === 10 && event.output === 1));
  assert.doesNotMatch(JSON.stringify(result.events), /FIXTURE-PROMPT|fixture-project-folder/);
  assert.match(result.coverage.join('\n'), /Qwen Code QWEN_HOME\/projects: 2 logs in window/);
});

test('Kimi: Kimi Code usage.record and kimi-cli StatusUpdate, session from the folder', async (t) => {
  const home = await folder(t);
  const code = join(home, 'kimi-code');
  const main = join(code, 'sessions', KIMI_CODE_SESSION, 'agents', 'main');
  const sub = join(code, 'sessions', KIMI_CODE_SESSION, 'agents', 'agent-0');
  await mkdir(main, { recursive: true });
  await mkdir(sub, { recursive: true });
  const record = (at, usage, model = 'kimi-k2') => JSON.stringify({ type: 'usage.record', model, usage, usageScope: 'turn', time: at });
  await writeFile(join(main, 'wire.jsonl'), [
    JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: NOW - HOUR }),
    JSON.stringify({ type: 'turn.prompt', input: PROMPT, origin: { kind: 'user' }, time: NOW - HOUR }),
    record(NOW - HOUR + 1_000, { inputOther: 100, output: 30, inputCacheRead: 400, inputCacheCreation: 10 })
  ].join('\n') + '\n');
  await writeFile(join(sub, 'wire.jsonl'), record(NOW - HOUR + 2_000, { inputOther: 5, output: 2, inputCacheRead: 0, inputCacheCreation: 0 }) + '\n');
  await writeFile(join(main, 'context.jsonl'), JSON.stringify({ role: 'user', content: PROMPT, usage: { output: 1 } }) + '\n');
  const legacy = join(home, 'kimi-share', 'sessions', '0123456789abcdef0123456789abcdef', KIMI_CLI_SESSION);
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'wire.jsonl'), [
    JSON.stringify({ type: 'metadata', protocol_version: '1.1' }),
    JSON.stringify({ timestamp: (NOW - 2 * HOUR) / 1000, message: { type: 'TurnBegin', payload: { user_input: PROMPT } } }),
    JSON.stringify({ timestamp: (NOW - 2 * HOUR + 500) / 1000, message: { type: 'StatusUpdate', payload: { context_usage: 0.1, token_usage: { input_other: 70, output: 9, input_cache_read: 30, input_cache_creation: 0 }, message_id: 'chatcmpl-1' } } }),
    JSON.stringify({ timestamp: (NOW - 2 * HOUR + 600) / 1000, message: { type: 'StatusUpdate', payload: { context_usage: 0.2 } } })
  ].join('\n') + '\n');
  const collector = new LocalUsageCollector(home, {}, { KIMI_CODE_HOME: code, KIMI_SHARE_DIR: join(home, 'kimi-share') });
  const result = await collector.collect(NOW);
  const events = result.events.filter((event) => event.provider === 'kimi').map((event) => [event.session, event.model ?? null, event.input, event.output, event.cached]);
  assert.deepEqual(events.sort(), [
    [KIMI_CLI_SESSION, null, 100, 9, 30],
    [KIMI_CODE_SESSION, 'kimi-k2', 510, 30, 400],
    [KIMI_CODE_SESSION, 'kimi-k2', 5, 2, 0]
  ].sort());
  assert.doesNotMatch(JSON.stringify(result.events), /FIXTURE-PROMPT/);
});

test('Qwen and Kimi account homes are read alone and follow no link', async (t) => {
  const root = await folder(t);
  const person = join(root, 'person-qwen');
  await mkdir(join(person, 'projects', 'p', 'chats'), { recursive: true });
  const line = JSON.stringify({ uuid: 'r-9', sessionId: QWEN_SESSION, timestamp: iso(NOW - HOUR), type: 'assistant', model: 'm', usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 } });
  await writeFile(join(person, 'projects', 'p', 'chats', `${QWEN_SESSION}.jsonl`), line + '\n');
  const home = join(root, 'qwen-home');
  await mkdir(home);
  await symlink(join(person, 'projects'), join(home, 'projects'));
  const linked = await new LocalUsageCollector(root, {}, {}, { only: { source: 'qwen', path: home } }).collect(NOW);
  assert.deepEqual(linked.events, []);
  const real = join(root, 'qwen-real');
  await mkdir(join(real, 'projects', 'p', 'chats'), { recursive: true });
  await writeFile(join(real, 'projects', 'p', 'chats', `${QWEN_SESSION}.jsonl`), line + '\n');
  const ok = await new LocalUsageCollector(root, {}, { QWEN_HOME: person }, { only: { source: 'qwen', path: real } }).collect(NOW);
  assert.equal(ok.events.length, 1, 'only the home, not QWEN_HOME from the environment');
  assert.equal(ok.events[0].profile, 'home');
});

test('the history store keeps OpenCode cursors and older states without them load unchanged', async (t) => {
  const directory = await folder(t);
  const cursor = { node: '1:2', at: NOW - MINUTE };
  const create = (state) => new UsageHistoryService({
    directory,
    limits: { getProviders: async () => ({ fetchedAt: NOW, providers: [] }) },
    createCollector: (collectorState) => ({
      state: collectorState,
      collect: async () => {
        Object.assign(collectorState, state);
        return { events: [], coverage: [], complete: true };
      }
    }),
    now: () => NOW
  });
  const service = create({ opencode: { [fp('db')]: cursor } });
  await service.load();
  await service.collect();
  await service.dispose();
  const saved = JSON.parse(await readFile(join(directory, 'usage-history.json'), 'utf8'));
  assert.deepEqual(saved.collector.opencode, { [fp('db')]: cursor });
  const reloaded = create({});
  await reloaded.load();
  assert.equal(reloaded.get().error, null, 'no record was invalid');
  assert.deepEqual((await readdir(directory)).filter((name) => name.includes('corrupt')), []);
  await reloaded.dispose();
});

test('the usage report is unchanged: records of OpenCode, Qwen Code and Kimi are left out of it', async () => {
  const { buildUsageReport } = await import('../src/shared/usageReport.ts');
  const event = (id, provider) => ({ id, provider, app: provider, profile: 'default', session: 's', from: NOW - HOUR, to: NOW - HOUR, input: 10, output: 1, cached: 0, timing: 'event' });
  const history = (events) => ({ version: 1, startedAt: NOW - DAY, collectedAt: NOW, samples: [], events, coverage: [], providerStatus: [], error: null, health: [] });
  const base = buildUsageReport(history([event('a', 'codex')]), { now: NOW, period: '24h' });
  const more = buildUsageReport(history([event('a', 'codex'), event('b', 'opencode'), event('c', 'qwen'), event('d', 'kimi')]), { now: NOW, period: '24h' });
  assert.deepEqual(more, base);
});

/** A runtime whose node:sqlite opens URI filenames: this one, or Electron's Node as the app runs it. */
async function uriRuntime() {
  if (await sqliteUriSupported()) return { command: process.execPath, env: {} };
  try {
    const electron = createRequire(import.meta.url)('electron');
    if (typeof electron === 'string') {
      await readdir(join(electron, '..'));
      return { command: electron, env: { ELECTRON_RUN_AS_NODE: '1' } };
    }
  } catch { /* No Electron binary installed. */ }
  return null;
}

test('OpenCode database scenarios under a runtime with SQLite URI support (the app\'s Electron Node)', async (t) => {
  const runtime = await uriRuntime();
  if (!runtime) { t.skip('no runtime with SQLite URI support'); return; }
  const script = fileURLToPath(new URL('./helpers/opencode-usage-scenarios.mjs', import.meta.url));
  const output = await new Promise((resolve) => {
    execFile(runtime.command, [script], {
      // Without the runner's NODE_TEST_CONTEXT the helper reports as a plain test file (TAP).
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT')), ...runtime.env, NODE_OPTIONS: '--experimental-strip-types --experimental-sqlite --no-warnings' },
      timeout: 120_000, maxBuffer: 16 * 1024 * 1024
    }, (error, out, err) => resolve({ code: error ? (error.code ?? 1) : 0, text: `${out}\n${err}` }));
  });
  assert.equal(output.code, 0, output.text);
  assert.match(output.text, /(?:#|ℹ) pass 4\b/);
  assert.match(output.text, /(?:#|ℹ) fail 0\b/);
});

test('OpenCode database without SQLite URI support: skipped as incomplete, nothing created', async (t) => {
  const home = await folder(t);
  const dataDir = join(home, 'opencode');
  await mkdir(dataDir);
  // Any file named opencode.db: it is never opened by SQLite here.
  await writeFile(join(dataDir, 'opencode.db'), 'SQLite format 3\u0000fixture');
  await openCodeFiles(dataDir);
  const before = await listing(home);
  const calls = [];
  const collector = new LocalUsageCollector(home, {}, {}, {
    only: { source: 'opencode', path: home },
    openCodeQuery: async (target) => { calls.push(target); throw new Error('unable to open database file'); }
  });
  const result = await collector.collect(NOW);
  assert.deepEqual(await listing(home), before);
  assert.equal(result.complete, false);
  assert.match(result.coverage.join(' '), /cannot open read-only URI filenames; not collected/);
  // The message files are still read; only the database is skipped.
  assert.ok(result.events.some((event) => event.id === createHash('sha256').update('opencode:msg_file1').digest('hex').slice(0, 24)));
  assert.ok(calls.length >= 1 && calls.every((target) => /^file:.*\?mode=ro&immutable=1$/.test(target)));
});
