import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IPC } from "../src/shared/contracts.ts";
import { LocalUsageCollector } from "../src/main/services/LocalUsageCollector.ts";
import { LaunchPipeline } from "../src/main/services/LaunchPipeline.ts";
import { validatePluginManifest } from "../src/main/services/PluginManager.ts";
import { PluginServiceSupervisor } from "../src/main/services/PluginServiceSupervisor.ts";
import {
  MAX_HOMES_PER_CALL,
  MAX_ROWS,
  PluginUsage,
  UNKNOWN_CARD,
  USAGE_CALLS_PER_MINUTE
} from "../src/main/services/PluginUsage.ts";
import { MAX_PLUGIN_HOMES, UNKNOWN_HOME } from "../src/main/services/pluginHomes.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { UsageHistoryService } from "../src/main/services/UsageHistoryService.ts";
import { claudeFlush, claudeUsage, codexUsage, usageModel } from "../src/main/services/usageReaders.ts";

const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

// Fixture values that must never appear in an answer.
const PROMPT = "FIXTURE-PROMPT-do-not-leak-5e5e";
const EMAIL = "person@example.invalid";
const ACCOUNT = "acct-fixture-0c0c0c";
const TOKEN = "fixture-oauth-token-77aa";
const CWD = "/fixture-project-folder/src";

const PLUGIN = "com.example.router";
const OTHER = "com.example.other";
const THREAD_A = "11111111-1111-4111-8111-111111111111";
const THREAD_B = "22222222-2222-4222-8222-222222222222";
const THREAD_OTHER = "33333333-3333-4333-8333-333333333333";
const THREAD_PERSON = "44444444-4444-4444-8444-444444444444";
const THREAD_HOME = "55555555-5555-4555-8555-555555555555";
const THREAD_CODEX_HOME = "66666666-6666-4666-8666-666666666666";
const THREAD_NEXT = "77777777-7777-4777-8777-777777777777";

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met in time.");
};

function event(id, provider, session, model, to, input, output, cached = 0, app) {
  return {
    id, provider, app: app ?? (provider === "claude" ? "Claude Code" : provider === "codex" ? "Codex CLI" : "Hermes"),
    profile: "default", session, from: to - 1_000, to, input, output, cached, timing: "event", ...(model ? { model } : {})
  };
}

/** Core's history as PluginUsage reads it. */
function history(events, { startedAt = NOW - 40 * DAY, health = [{ at: NOW - MINUTE, complete: true }] } = {}) {
  return { peek: () => ({ startedAt, collectedAt: NOW - MINUTE, events, health }) };
}

const HISTORY_EVENTS = [
  event("e1", "claude", THREAD_A.toUpperCase(), "claude-sonnet-4-5", NOW - 2 * HOUR, 1_000, 100, 400),
  event("e2", "claude", THREAD_A, "claude-opus-4-1", NOW - HOUR, 2_000, 200, 1_500),
  event("e3", "codex", THREAD_B, "gpt-5-codex", NOW - 30 * MINUTE, 5_000, 300, 1_000),
  event("e4", "codex", THREAD_B, undefined, NOW - 3 * DAY, 700, 70, 0),
  // Another plugin's card, the person's own session, and a Claude record that shares the Codex card's id.
  event("e5", "claude", THREAD_OTHER, "claude-sonnet-4-5", NOW - HOUR, 9_000, 900, 0),
  event("e6", "claude", THREAD_PERSON, "claude-sonnet-4-5", NOW - HOUR, 8_000, 800, 0),
  event("e7", "claude", THREAD_B, "claude-sonnet-4-5", NOW - HOUR, 6_000, 600, 0)
];

function cards(list) {
  const byId = new Map(list.map((card) => [card.id, card]));
  return {
    byId,
    usageContext: (id) => (byId.has(id) ? structuredClone(byId.get(id)) : null),
    usageContexts: () => [...byId.values()].map((card) => structuredClone(card))
  };
}

const CARDS = [
  { id: "card-a", provider: "claude", threadId: THREAD_A, contributors: [PLUGIN], owner: null },
  { id: "card-b", provider: "codex", threadId: THREAD_B, contributors: [], owner: PLUGIN },
  { id: "card-other", provider: "claude", threadId: THREAD_OTHER, contributors: [OTHER], owner: null },
  { id: "card-person", provider: "claude", threadId: THREAD_PERSON, contributors: [], owner: null },
  { id: "card-nothread", provider: "claude", contributors: [PLUGIN], owner: null },
  { id: "card-grok", provider: "grok", threadId: "99999999-9999-4999-8999-999999999999", contributors: [PLUGIN], owner: null }
];

const ALL = ["usage:read", "launch:contribute"];

function usage({ events = HISTORY_EVENTS, list = CARDS, allowed = () => true, homeCollector, now = () => NOW, homeIntervalMs, historyOptions } = {}) {
  const terminal = cards(list);
  const instance = new PluginUsage({
    history: () => history(events, historyOptions),
    cards: terminal,
    allowed,
    homeCollector: homeCollector ?? ((source, home) => new LocalUsageCollector(home, {}, {}, { only: { source, path: home } })),
    now,
    homeIntervalMs
  });
  return { instance, terminal };
}

async function call(instance, method, params, { pluginId = PLUGIN, permissions = ALL, dataDir = "/nonexistent-data" } = {}) {
  return instance.handle(pluginId, method, params, permissions, dataDir);
}

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return error.message;
  }
  throw new Error("expected a refusal");
}

/** Every string in an answer, keys and values. */
function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => strings(entry, out));
  else if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) { out.push(key); strings(entry, out); }
  return out;
}

// ---- Fixture CLI homes, written as Claude Code and Codex write them ----

function claudeLines(session, messages) {
  return messages.flatMap(({ id, model, at, input, read = 0, write = 0, output }) => [
    JSON.stringify({ type: "user", timestamp: iso(at - 500), sessionId: session, cwd: CWD, message: { role: "user", content: PROMPT } }),
    JSON.stringify({
      type: "assistant", timestamp: iso(at), sessionId: session, cwd: CWD, userEmail: EMAIL, accountUuid: ACCOUNT,
      message: {
        id, model, role: "assistant", content: [{ type: "text", text: PROMPT }, { type: "tool_use", input: { file_path: `${CWD}/secret.txt` } }],
        usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output }
      }
    })
  ]).join("\n") + "\n";
}

async function writeClaudeHome(home, session, messages) {
  const folder = join(home, "projects", "-fixture-project-folder-src");
  await mkdir(folder, { recursive: true });
  const file = join(folder, `${session}.jsonl`);
  await writeFile(file, claudeLines(session, messages));
  // Idle long enough that the newest message is final.
  const old = new Date(NOW - 10 * MINUTE);
  await utimes(file, old, old);
  return file;
}

async function writeCodexHome(home, session, model, at, total) {
  const folder = join(home, "sessions", "2026", "10", "20");
  await mkdir(folder, { recursive: true });
  const usage = { input_tokens: total[0], cached_input_tokens: total[1], output_tokens: total[2], reasoning_output_tokens: 5 };
  const lines = [
    { timestamp: iso(at - 2_000), type: "session_meta", payload: { id: session, originator: "codex_cli_rs", cwd: CWD, instructions: PROMPT, account_id: ACCOUNT } },
    { timestamp: iso(at - 1_000), type: "turn_context", payload: { cwd: CWD, model, user_instructions: PROMPT } },
    { timestamp: iso(at), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } } }
  ];
  await writeFile(join(folder, `rollout-2026-10-20T10-00-00-${session}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

async function pluginData(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-plugin-usage-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "plugin-data", PLUGIN);
  const otherData = join(root, "plugin-data", OTHER);
  await mkdir(join(dataDir, "homes"), { recursive: true });
  await mkdir(otherData, { recursive: true });
  return { root, dataDir, otherData };
}

// ---- Readers keep the model, and only as a plain identifier ----

test("usage records carry the model the log names, never free text", () => {
  const context = { profile: "default", session: "fallback" };
  const state = {};
  const at = iso(NOW - HOUR);
  const message = (id, model) => ({ type: "assistant", timestamp: at, sessionId: THREAD_A, message: { id, model, usage: { input_tokens: 10, output_tokens: 2 } } });
  assert.equal(claudeUsage(message("m1", "claude-sonnet-4-5"), state, context), null);
  const first = claudeUsage(message("m2", "not a model; rm -rf /"), state, context);
  assert.equal(first.model, "claude-sonnet-4-5");
  const second = claudeFlush(state, context);
  assert.equal(second.input, 10);
  assert.equal("model" in second, false, "free text is dropped");

  const codex = {};
  const line = (type, payload, offset = 0) => ({ timestamp: iso(NOW - HOUR + offset), type, payload });
  codexUsage(line("session_meta", { id: THREAD_B, originator: "codex_cli_rs" }), codex, context);
  const before = codexUsage(line("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 10, output_tokens: 1 }, last_token_usage: { input_tokens: 10, output_tokens: 1 } } }, 1), codex, context);
  assert.equal("model" in before, false, "no turn_context yet: no model");
  codexUsage(line("turn_context", { model: "gpt-5-codex" }, 2), codex, context);
  const after = codexUsage(line("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 30, output_tokens: 4 } } }, 3), codex, context);
  assert.equal(after.model, "gpt-5-codex");
  assert.deepEqual([after.input, after.output], [20, 3]);

  assert.equal(usageModel("anthropic/claude-sonnet-4"), "anthropic/claude-sonnet-4");
  assert.equal(usageModel("gpt 5"), "");
  assert.equal(usageModel("x".repeat(121)), "");
});

test("core's history keeps a valid model and counts a record with an invalid one as invalid", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-usage-model-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = [
    event("ok", "claude", THREAD_A, "claude-opus-4-1", NOW - HOUR, 10, 1),
    event("bad", "claude", THREAD_A, "free text", NOW - HOUR, 10, 1)
  ];
  const create = () => new UsageHistoryService({
    directory,
    limits: { getProviders: async () => ({ fetchedAt: NOW, providers: [] }) },
    createCollector: (state) => ({ state, collect: async () => ({ events, coverage: [], complete: true }) }),
    now: () => NOW
  });
  const service = create();
  await service.load();
  await service.collect();
  assert.deepEqual(service.peek().events.map((entry) => [entry.id, entry.model]), [["ok", "claude-opus-4-1"]]);
  assert.match(service.get().coverage.join(" "), /1 invalid usage records/);
  await service.dispose();
  const reloaded = create();
  await reloaded.load();
  assert.equal(reloaded.peek().events[0].model, "claude-opus-4-1", "the model survives a restart");
  await reloaded.dispose();
});

// ---- Permission ----

test("usage:read is required, in the manifest and in the host's registry at the moment of the call", async () => {
  const registry = new Map([[PLUGIN, new Set(ALL)]]);
  const { instance } = usage({ allowed: (pluginId, permission) => registry.get(pluginId)?.has(permission) === true });
  assert.match(await refusal(call(instance, "usage.session", { cardId: "card-a" }, { permissions: ["launch:contribute"] })), /usage:read/);
  assert.match(await refusal(call(instance, "usage.summary", {}, { permissions: [] })), /usage:read/);
  assert.equal((await call(instance, "usage.session", { cardId: "card-a" })).measured, true);
  // Disabled, untrusted or removed: the registry no longer grants it, whatever the service's start-time spec says.
  registry.delete(PLUGIN);
  assert.match(await refusal(call(instance, "usage.session", { cardId: "card-a" })), /usage:read/);
  assert.match(await refusal(call(instance, "usage.summary", {})), /usage:read/);
  // Account homes also need launch:contribute.
  registry.set(PLUGIN, new Set(["usage:read"]));
  assert.match(await refusal(call(instance, "usage.summary", { homes: [] }, { permissions: ["usage:read"] })), /launch:contribute/);
  assert.match(await refusal(call(instance, "usage.summary", { homes: [] })), /launch:contribute/);
  assert.equal(instance.handle(PLUGIN, "usage.unknown", {}, ALL, "/x"), undefined, "unknown methods fall through");
});

test("the manifest accepts usage:read and the install review names it", async () => {
  const { readFile } = await import("node:fs/promises");
  const example = JSON.parse(await readFile(new URL("../examples/plugins/launch-env/canvastty.plugin.json", import.meta.url), "utf8"));
  const manifest = validatePluginManifest({ ...example, permissions: [...example.permissions, "usage:read"] });
  assert.ok(manifest.permissions.includes("usage:read"));
  assert.throws(() => validatePluginManifest({ ...example, permissions: [...example.permissions, "usage:write"] }), /Unknown plugin permission/);
  const settings = await readFile(new URL("../src/renderer/src/features/plugins/PluginSettingsSection.tsx", import.meta.url), "utf8");
  // The label loads with Settings (PluginSettingsSection), not with the startup string table.
  const ru = /ru: \{[^}]*"usage:read": "([^"]+)"/u.exec(settings)?.[1];
  const en = /en: \{[^}]*"usage:read": "([^"]+)"/u.exec(settings)?.[1];
  assert.ok(ru && en, "ru and en labels");
  const i18n = await readFile(new URL("../src/renderer/src/lib/i18n.ts", import.meta.url), "utf8");
  assert.doesNotMatch(i18n, /permissionUsageRead/u);
});

// ---- Ownership ----

test("a plugin reads only cards it started or whose launches carry its launch options", async () => {
  const { instance } = usage();
  assert.equal((await call(instance, "usage.session", { cardId: "card-a" })).measured, true, "launch options");
  assert.equal((await call(instance, "usage.session", { cardId: "card-b" })).measured, true, "sessions.create");
  for (const cardId of ["card-other", "card-person", "no-such-card", "", 42, "x".repeat(129), undefined]) {
    assert.equal(await refusal(call(instance, "usage.session", { cardId })), UNKNOWN_CARD, String(cardId));
  }
  assert.equal(await refusal(call(instance, "usage.session", { cardId: "card-a" }, { pluginId: OTHER })), UNKNOWN_CARD);
  assert.equal((await call(instance, "usage.session", { cardId: "card-other" }, { pluginId: OTHER })).totals.input, 9_000);
});

test("ownership comes from the real launch: options chosen for the plugin or sessions.create, never a launch policy", async (t) => {
  const runsRoot = await mkdtemp(join(tmpdir(), "canvastty-usage-runs-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const contributor = (pluginId, extra = {}) => ({
    pluginId, pluginName: pluginId, serviceId: "svc", secrets: false,
    launch: { fields: [{ key: "on", label: "On", kind: "boolean", default: true }], ...extra }
  });
  const pipeline = new LaunchPipeline({
    contributors: () => [contributor(PLUGIN), contributor("com.example.policy", { policy: true })],
    call: async () => null,
    secret: async () => null,
    runsRoot
  });
  const spawned = [];
  const events = [];
  let usageService = null;
  const manager = new TerminalManager((channel, payload) => { events.push(channel); usageService?.observe(channel, payload); }, {
    get: (provider) => ({ state: "available", provider, executable: `/resolved/${provider}`, launcher: "native", environment: { PATH: "/usr/bin" }, checked: [] }),
    snapshot: () => ({})
  }, undefined, undefined, true, (command, args, options) => {
    spawned.push({ command, args, options });
    return {
      pid: 41_000 + spawned.length, process: command, write() {}, resize() {}, kill() {}, pause() {}, resume() {},
      onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }
    };
  });
  t.after(() => manager.shutdown());
  manager.configureLaunchPipeline(pipeline);
  usageService = new PluginUsage({
    history: () => history([
      event("x1", "claude", THREAD_A, "claude-sonnet-4-5", NOW - HOUR, 100, 10),
      event("x2", "claude", THREAD_B, "claude-sonnet-4-5", NOW - HOUR, 200, 20),
      event("x3", "claude", THREAD_PERSON, "claude-sonnet-4-5", NOW - HOUR, 300, 30),
      event("x4", "claude", THREAD_NEXT, "claude-sonnet-4-5", NOW - HOUR, 400, 40)
    ]),
    cards: manager,
    allowed: () => true,
    homeCollector: () => { throw new Error("no homes here"); },
    now: () => NOW
  });
  const at = { x: 0, y: 0 };
  const chosen = manager.create({ provider: "claude", profile: "normal", cwd: process.cwd(), position: at, launchOptions: { [PLUGIN]: {} } });
  const started = manager.create({ provider: "claude", profile: "normal", cwd: process.cwd(), position: at }, { origin: "plugin", ownerPluginId: OTHER });
  const personal = manager.create({ provider: "claude", profile: "normal", cwd: process.cwd(), position: at });
  await waitFor(() => spawned.length === 3);
  manager.applyProviderSignal(chosen.id, { kind: "lifecycle", state: "working", threadId: THREAD_A });
  manager.applyProviderSignal(started.id, { kind: "lifecycle", state: "working", threadId: THREAD_B });
  manager.applyProviderSignal(personal.id, { kind: "lifecycle", state: "working", threadId: THREAD_PERSON });

  assert.deepEqual(manager.usageContext(chosen.id), { id: chosen.id, provider: "claude", threadId: THREAD_A, contributors: [PLUGIN], owner: null });
  assert.deepEqual(manager.usageContext(started.id).owner, OTHER);
  const session = (pluginId, cardId) => usageService.handle(pluginId, "usage.session", { cardId }, ALL, "/x");
  assert.equal((await session(PLUGIN, chosen.id)).totals.input, 100);
  assert.equal((await session(OTHER, started.id)).totals.input, 200);
  // The policy plugin was asked about every launch but contributed nothing: it owns none of them.
  for (const pluginId of ["com.example.policy", OTHER]) assert.equal(await refusal(session(pluginId, chosen.id)), UNKNOWN_CARD);
  for (const pluginId of [PLUGIN, OTHER, "com.example.policy"]) assert.equal(await refusal(session(pluginId, personal.id)), UNKNOWN_CARD);
  const summary = await usageService.handle(PLUGIN, "usage.summary", {}, ALL, "/x");
  assert.equal(summary.totals.input, 100, "the summary covers the same cards only");
  // A resume moves the card to a new conversation: both are the card's.
  manager.applyProviderSignal(chosen.id, { kind: "lifecycle", state: "working", threadId: THREAD_NEXT });
  assert.equal((await session(PLUGIN, chosen.id)).totals.input, 500);

  // A closed card stays readable for this run, by the same plugins only.
  manager.dispose(chosen.id);
  manager.dispose(personal.id);
  assert.equal(manager.usageContext(chosen.id), null);
  assert.equal((await session(PLUGIN, chosen.id)).totals.input, 500);
  assert.equal(await refusal(session(OTHER, chosen.id)), UNKNOWN_CARD);
  assert.equal(await refusal(session(PLUGIN, personal.id)), UNKNOWN_CARD);
  assert.equal((await usageService.handle(PLUGIN, "usage.summary", {}, ALL, "/x")).totals.input, 500);
  assert.ok(events.includes(IPC.terminalRemoved));
});

// ---- Shapes ----

test("usage.session: totals and per-model counts of the card's conversation, matched by agent", async () => {
  const { instance } = usage();
  assert.deepEqual(await call(instance, "usage.session", { cardId: "card-a" }), {
    cardId: "card-a",
    provider: "claude",
    measured: true,
    totals: { input: 3_000, output: 300, cached: 1_900, events: 2 },
    models: [
      { model: "claude-opus-4-1", input: 2_000, output: 200, cached: 1_500, events: 1 },
      { model: "claude-sonnet-4-5", input: 1_000, output: 100, cached: 400, events: 1 }
    ],
    firstAt: NOW - 2 * HOUR - 1_000,
    lastAt: NOW - HOUR,
    coverage: { collectedAt: NOW - MINUTE, complete: true }
  });
  // The Codex card does not take the Claude record that shares its conversation id.
  const codex = await call(instance, "usage.session", { cardId: "card-b" });
  assert.deepEqual(codex.totals, { input: 5_700, output: 370, cached: 1_000, events: 2 });
  assert.deepEqual(codex.models.map((row) => row.model), ["gpt-5-codex", null]);
  assert.deepEqual(await call(instance, "usage.session", { cardId: "card-nothread" }),
    { cardId: "card-nothread", provider: "claude", measured: false, reason: "conversation-unknown" });
  assert.deepEqual(await call(instance, "usage.session", { cardId: "card-grok" }),
    { cardId: "card-grok", provider: "grok", measured: false, reason: "provider-not-recorded" });
});

test("usage.summary: grouped by provider, model or home, limited to the period and the plugin's cards", async () => {
  const { instance } = usage();
  const byProvider = await call(instance, "usage.summary", { since: NOW - DAY, until: NOW });
  assert.deepEqual(byProvider, {
    since: NOW - DAY,
    until: NOW,
    groupBy: ["provider"],
    totals: { input: 8_000, output: 600, cached: 2_900, events: 3, sessions: 2 },
    rows: [
      { provider: "codex", input: 5_000, output: 300, cached: 1_000, events: 1, sessions: 1 },
      { provider: "claude", input: 3_000, output: 300, cached: 1_900, events: 2, sessions: 1 }
    ],
    truncated: false,
    coverage: { collectedAt: NOW - MINUTE, complete: true }
  });
  const byModel = await call(instance, "usage.summary", { since: NOW - 7 * DAY, groupBy: ["provider", "model"] });
  assert.deepEqual(byModel.rows.map((row) => [row.provider, row.model, row.input]), [
    ["codex", "gpt-5-codex", 5_000], ["claude", "claude-opus-4-1", 2_000], ["claude", "claude-sonnet-4-5", 1_000], ["codex", null, 700]
  ]);
  const byHome = await call(instance, "usage.summary", { groupBy: "home" });
  assert.deepEqual(byHome.rows, [{ home: null, input: 8_000, output: 600, cached: 2_900, events: 3, sessions: 2 }]);
  // Defaults: the last 24 hours.
  assert.deepEqual([byHome.since, byHome.until], [NOW - DAY, NOW]);
  const empty = await call(instance, "usage.summary", { since: NOW - 10 * DAY, until: NOW - 5 * DAY });
  assert.deepEqual([empty.totals.events, empty.rows], [0, []]);

  for (const [params, pattern] of [
    [{ since: NOW, until: NOW - 1 }, /before until/],
    [{ since: NOW - 31 * DAY, until: NOW }, /30 days/],
    [{ since: "yesterday" }, /time in milliseconds/],
    [{ until: -1 }, /time in milliseconds/],
    [{ groupBy: "account" }, /groupBy/],
    [{ groupBy: ["model", "model"] }, /groupBy/],
    [{ groupBy: [] }, /groupBy/]
  ]) assert.match(await refusal(call(instance, "usage.summary", params)), pattern, JSON.stringify(params));
});

test("coverage says incomplete when a collection over the period missed sources or history started later", async () => {
  const late = usage({ historyOptions: { startedAt: NOW - 2 * HOUR } }).instance;
  assert.equal((await call(late, "usage.summary", { since: NOW - DAY })).coverage.complete, false);
  assert.equal((await call(late, "usage.summary", { since: NOW - HOUR })).coverage.complete, true);
  const gaps = usage({ historyOptions: { health: [{ at: NOW - 3 * HOUR, complete: true }, { at: NOW - 2 * HOUR, complete: false, lost: true }] } }).instance;
  assert.equal((await call(gaps, "usage.summary", { since: NOW - DAY })).coverage.complete, false);
  assert.equal((await call(gaps, "usage.summary", { since: NOW - HOUR })).coverage.complete, true);
});

// ---- Account homes ----

test("account homes in the plugin's data folder are read with the log readers, that folder only", async (t) => {
  const { dataDir } = await pluginData(t);
  const claudeHome = join(dataDir, "homes", "claude-1");
  const codexHome = join(dataDir, "homes", "codex-1");
  await writeClaudeHome(claudeHome, THREAD_HOME, [
    { id: "msg_home_1", model: "claude-sonnet-4-5", at: NOW - 2 * HOUR, input: 100, read: 300, write: 50, output: 40 },
    { id: "msg_home_2", model: "claude-opus-4-1", at: NOW - HOUR, input: 10, read: 0, write: 0, output: 4 }
  ]);
  await writeCodexHome(codexHome, THREAD_CODEX_HOME, "gpt-5-codex", NOW - HOUR, [900, 100, 60]);
  const list = [...CARDS, { id: "card-home", provider: "claude", threadId: THREAD_HOME, contributors: [PLUGIN], owner: null }];
  const { instance } = usage({ list });
  const homes = [{ provider: "claude", home: claudeHome }, { provider: "codex", home: codexHome }];
  const opts = { dataDir };

  const session = await call(instance, "usage.session", { cardId: "card-home", homes: homes.slice(0, 1) }, opts);
  assert.deepEqual(session.totals, { input: 460, output: 44, cached: 300, events: 2 });
  assert.deepEqual(session.models.map((row) => row.model), ["claude-sonnet-4-5", "claude-opus-4-1"]);
  assert.equal(session.coverage.complete, true);
  const withoutHome = await call(instance, "usage.session", { cardId: "card-home" }, opts);
  assert.deepEqual(withoutHome.totals.events, 0, "without the home only core's history is read");

  const summary = await call(instance, "usage.summary", { groupBy: ["home", "provider", "model"], homes }, opts);
  assert.deepEqual(summary.rows.map((row) => [row.home, row.provider, row.model, row.input, row.output]), [
    [null, "codex", "gpt-5-codex", 5_000, 300],
    [null, "claude", "claude-opus-4-1", 2_000, 200],
    [null, "claude", "claude-sonnet-4-5", 1_000, 100],
    [1, "codex", "gpt-5-codex", 900, 60],
    [0, "claude", "claude-sonnet-4-5", 450, 40],
    [0, "claude", "claude-opus-4-1", 10, 4]
  ]);
  assert.equal(summary.totals.sessions, 4);
});

test("no prompt, path, e-mail, account or conversation id reaches an answer", async (t) => {
  const { dataDir } = await pluginData(t);
  const claudeHome = join(dataDir, "homes", "claude-1");
  const codexHome = join(dataDir, "homes", "codex-1");
  await writeClaudeHome(claudeHome, THREAD_HOME, [{ id: "msg_home_1", model: "claude-sonnet-4-5", at: NOW - HOUR, input: 1, output: 1 }]);
  await writeCodexHome(codexHome, THREAD_CODEX_HOME, "gpt-5-codex", NOW - HOUR, [9, 1, 2]);
  const list = [...CARDS, { id: "card-home", provider: "claude", threadId: THREAD_HOME, contributors: [PLUGIN], owner: null }];
  const { instance } = usage({ list });
  const homes = [{ provider: "claude", home: claudeHome }, { provider: "codex", home: codexHome }];
  const answers = [
    await call(instance, "usage.session", { cardId: "card-a" }, { dataDir }),
    await call(instance, "usage.session", { cardId: "card-home", homes }, { dataDir }),
    await call(instance, "usage.session", { cardId: "card-nothread" }, { dataDir }),
    await call(instance, "usage.summary", { groupBy: ["provider", "model", "home"], homes, since: NOW - 7 * DAY }, { dataDir })
  ];
  const forbidden = [PROMPT, EMAIL, ACCOUNT, TOKEN, CWD, "fixture-project-folder", dataDir, claudeHome, codexHome, tmpdir(),
    THREAD_A, THREAD_B, THREAD_HOME, THREAD_CODEX_HOME, THREAD_OTHER, THREAD_PERSON, "msg_home_1", "e1", "secret.txt"];
  const text = JSON.stringify(answers);
  for (const value of forbidden) {
    assert.equal(text.toLowerCase().includes(value.toLowerCase()), false, `answer contains ${value}`);
  }
  // Every string is a field name or one of a few known values: nothing copied from a log but the model name.
  const allowed = new Set([
    "cardId", "card-a", "card-home", "card-nothread", "provider", "claude", "codex", "measured", "reason", "conversation-unknown",
    "totals", "models", "model", "input", "output", "cached", "events", "firstAt", "lastAt", "coverage", "collectedAt", "complete",
    "since", "until", "groupBy", "home", "rows", "truncated", "sessions",
    "claude-sonnet-4-5", "claude-opus-4-1", "gpt-5-codex"
  ]);
  assert.deepEqual(strings(answers).filter((value) => !allowed.has(value)), []);
});

test("unknown homes are refused with nothing read: outside, symlinked, the data folder, another plugin's", async (t) => {
  const { root, dataDir, otherData } = await pluginData(t);
  const outside = join(root, "outside");
  await writeClaudeHome(outside, THREAD_PERSON, [{ id: "msg_person", model: "claude-sonnet-4-5", at: NOW - HOUR, input: 7_777, output: 7 }]);
  const othersHome = join(otherData, "homes", "claude-1");
  await writeClaudeHome(othersHome, THREAD_OTHER, [{ id: "msg_other", model: "claude-sonnet-4-5", at: NOW - HOUR, input: 8_888, output: 8 }]);
  await symlink(outside, join(dataDir, "homes", "link"));
  await mkdir(join(dataDir, "real"), { recursive: true });
  await symlink(join(dataDir, "real"), join(dataDir, "linked-parent"));
  await mkdir(join(dataDir, "real", "claude-2"));
  await writeFile(join(dataDir, "homes", "file"), "x");
  const reads = [];
  const { instance } = usage({ homeCollector: (source, home) => { reads.push(home); return { collect: async () => ({ events: [], complete: true, lost: false }) }; } });
  const refused = async (home, provider = "claude") => refusal(call(instance, "usage.summary", { homes: [{ provider, home }] }, { dataDir }));
  for (const home of [
    "homes/claude-1", `${dataDir}/homes/../homes/x`, dataDir, `${dataDir}/`, othersHome, outside, join(dataDir, "missing"),
    join(dataDir, "homes", "file"), join(dataDir, "homes", "link"), join(dataDir, "linked-parent", "claude-2"),
    `${dataDir}/homes\u0000x`, `/${"a".repeat(5_000)}`, process.env.HOME ?? "/", "", 7, null
  ]) assert.equal(await refused(home), UNKNOWN_HOME, String(home));
  assert.match(await refused(join(dataDir, "homes"), "grok"), /claude, codex, opencode, qwen or kimi/);
  assert.match(await refusal(call(instance, "usage.summary", { homes: "x" }, { dataDir })), /at most 8/);
  assert.match(await refusal(call(instance, "usage.summary", { homes: Array.from({ length: MAX_HOMES_PER_CALL + 1 }, () => ({ provider: "claude", home: join(dataDir, "homes") })) }, { dataDir })), /at most 8/);
  assert.deepEqual(reads, []);

  // A data folder that is itself a symbolic link is refused too.
  await symlink(dataDir, join(root, "data-link"));
  await mkdir(join(dataDir, "homes", "ok"));
  assert.equal(await refusal(call(instance, "usage.summary", { homes: [{ provider: "claude", home: join(root, "data-link", "homes", "ok") }] }, { dataDir: join(root, "data-link") })), UNKNOWN_HOME);
  assert.deepEqual(reads, []);
});

test("inside a valid home, symbolic links to other folders and logs are not followed", async (t) => {
  const { root, dataDir } = await pluginData(t);
  const outside = join(root, "person-claude");
  const personLog = await writeClaudeHome(outside, THREAD_PERSON, [{ id: "msg_person", model: "claude-sonnet-4-5", at: NOW - HOUR, input: 7_777, output: 7 }]);
  const linkedProjects = join(dataDir, "homes", "a");
  await mkdir(linkedProjects, { recursive: true });
  await symlink(join(outside, "projects"), join(linkedProjects, "projects"));
  const linkedLog = join(dataDir, "homes", "b");
  await mkdir(join(linkedLog, "projects", "p"), { recursive: true });
  await symlink(personLog, join(linkedLog, "projects", "p", `${THREAD_PERSON}.jsonl`));
  await mkdir(join(linkedLog, "projects", "q"), { recursive: true });
  await symlink(join(outside, "projects", "-fixture-project-folder-src"), join(linkedLog, "projects", "q", "dir"));
  const { instance } = usage();
  const summary = await call(instance, "usage.summary", {
    groupBy: "home", homes: [{ provider: "claude", home: linkedProjects }, { provider: "claude", home: linkedLog }]
  }, { dataDir });
  assert.deepEqual(summary.rows.filter((row) => row.home !== null), [], "nothing outside the homes is counted");
});

test("at most 32 homes per plugin: the 33rd is refused until one is removed", async (t) => {
  const { dataDir } = await pluginData(t);
  let now = NOW;
  const { instance } = usage({ now: () => now, homeCollector: () => ({ collect: async () => ({ events: [], complete: true, lost: false }) }) });
  const homes = [];
  for (let index = 0; index <= MAX_PLUGIN_HOMES; index += 1) {
    homes.push(join(dataDir, "homes", `h${index}`));
    await mkdir(homes.at(-1));
  }
  const ask = async (home) => {
    now += 3_000;
    return instance.handle(PLUGIN, "usage.summary", { homes: [{ provider: "claude", home }] }, ALL, dataDir);
  };
  for (const home of homes.slice(0, MAX_PLUGIN_HOMES)) await ask(home);
  assert.match(await refusal(ask(homes[MAX_PLUGIN_HOMES])), /at most 32 account homes/);
  await ask(homes[0]);
  await rm(homes[5], { recursive: true });
  await ask(homes[MAX_PLUGIN_HOMES]);
});

// ---- Rate and size limits ----

test("30 calls a minute per plugin, both methods together; other plugins are not affected", async () => {
  let now = NOW;
  const { instance } = usage({ now: () => now });
  for (let index = 0; index < USAGE_CALLS_PER_MINUTE; index += 1) {
    await call(instance, index % 2 ? "usage.summary" : "usage.session", index % 2 ? {} : { cardId: "card-a" });
  }
  assert.match(await refusal(call(instance, "usage.summary", {})), /limited to 30 a minute; try again in 60 s/);
  assert.equal((await call(instance, "usage.session", { cardId: "card-other" }, { pluginId: OTHER })).measured, true);
  now += 60_001;
  assert.equal((await call(instance, "usage.summary", {})).totals.events, 3);
});

test("each home is read at most once a minute, single-flight, at most two at once", async (t) => {
  const { dataDir } = await pluginData(t);
  let now = NOW;
  let running = 0;
  let peak = 0;
  const reads = new Map();
  const { instance } = usage({
    now: () => now,
    homeCollector: (source, home) => ({
      collect: async () => {
        reads.set(home, (reads.get(home) ?? 0) + 1);
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
        return { events: [event(`h-${home}`, "claude", THREAD_HOME, "claude-sonnet-4-5", NOW - HOUR, 10, 1)], complete: true, lost: false };
      }
    })
  });
  const homes = [];
  for (let index = 0; index < 5; index += 1) {
    homes.push({ provider: "claude", home: join(dataDir, "homes", `h${index}`) });
    await mkdir(homes.at(-1).home);
  }
  const answers = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    call(instance, "usage.summary", { homes: index % 2 ? homes : homes.slice(0, 3) }, { pluginId: `com.example.p${index}`, dataDir })));
  assert.deepEqual([...reads.values()], [1, 1, 1, 1, 1]);
  assert.equal(peak, 2);
  assert.equal(answers[1].totals.input, 50, "every home's records are counted once");
  now += 30_000;
  await call(instance, "usage.summary", { homes }, { dataDir });
  assert.deepEqual([...reads.values()], [1, 1, 1, 1, 1], "within the interval the cached records answer");
  now += 31_000;
  await call(instance, "usage.summary", { homes }, { dataDir });
  assert.deepEqual([...reads.values()], [2, 2, 2, 2, 2]);
});

test("answers are bounded: at most 256 rows, the rest still in the totals", async () => {
  const many = Array.from({ length: MAX_ROWS + 10 }, (_, index) =>
    event(`m${index}`, "claude", THREAD_A, `model-${index}`, NOW - HOUR, 1_000 + index, 1));
  const { instance } = usage({ events: many });
  const summary = await call(instance, "usage.summary", { groupBy: "model" });
  assert.equal(summary.rows.length, MAX_ROWS);
  assert.equal(summary.truncated, true);
  assert.equal(summary.totals.events, MAX_ROWS + 10);
  assert.equal(summary.rows[0].model, `model-${MAX_ROWS + 9}`, "the largest groups are kept");
  const session = await call(instance, "usage.session", { cardId: "card-a" });
  assert.equal(session.models.length, MAX_ROWS);
  assert.equal(session.totals.events, MAX_ROWS + 10);
});

// ---- Through the supervisor ----

const SERVICE = `
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const waiting = new Map();
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "ask") { waiting.set(1000 + m.id, m.id); send({ id: 1000 + m.id, method: m.params.method, params: m.params.params }); return; }
  if (!m.method && waiting.has(m.id)) {
    const id = waiting.get(m.id);
    waiting.delete(m.id);
    send({ id, result: m.error ? { error: m.error } : { result: m.result } });
  }
});
`;

test("through the supervisor: usage.* reach the host with the service's own permissions and data folder", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-service-usage-sup-")));
  const registry = new Map([[PLUGIN, ["usage:read"]], [OTHER, []]]);
  const seen = [];
  const { instance: usageService } = usage({ allowed: (pluginId, permission) => (registry.get(pluginId) ?? []).includes(permission) });
  const supervisor = new PluginServiceSupervisor({
    command: process.execPath,
    hostVersion: "9.9.9",
    locale: () => "en",
    requestTimeoutMs: 3_000,
    stopGraceMs: 300,
    host: {
      storageGet: async () => null,
      storageSet: async () => undefined,
      emit: () => undefined,
      usage: (pluginId, method, params, permissions, dataDir) => {
        seen.push({ pluginId, dataDir, permissions });
        return usageService.handle(pluginId, method, params, permissions, dataDir);
      }
    }
  });
  t.after(async () => { await supervisor.dispose(); await rm(root, { recursive: true, force: true }); });
  const spec = async (pluginId, permissions) => {
    const folder = join(root, pluginId);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "svc.mjs"), SERVICE);
    return { pluginId, serviceId: "svc", root: folder, entryPath: join(folder, "svc.mjs"), sha256: createHash("sha256").update(SERVICE).digest("hex"), dataDir: join(folder, "data"), permissions };
  };
  const a = await spec(PLUGIN, ["usage:read"]);
  const b = await spec(OTHER, []);
  await supervisor.sync([a, b]);
  await waitFor(() => supervisor.running(PLUGIN, "svc") && supervisor.running(OTHER, "svc"));
  const ask = (pluginId, method, params = {}) => supervisor.request(pluginId, "svc", "ask", { method, params });

  const granted = await ask(PLUGIN, "usage.session", { cardId: "card-a" });
  assert.equal(granted.result.totals.input, 3_000);
  assert.equal(seen[0].dataDir, a.dataDir, "the data folder comes from the host's record of the service");
  assert.deepEqual(seen[0].permissions, ["usage:read"]);
  assert.match((await ask(OTHER, "usage.summary")).error.message, /usage:read/);
  assert.match((await ask(PLUGIN, "usage.summary", { homes: [] })).error.message, /launch:contribute/);
  assert.equal((await ask(PLUGIN, "usage.nothing")).error.code, -32601);
  // Disabled in the registry while still running: refused at once.
  registry.set(PLUGIN, []);
  assert.match((await ask(PLUGIN, "usage.session", { cardId: "card-a" })).error.message, /usage:read/);
});
