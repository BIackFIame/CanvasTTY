import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LimitsService,
  detectEarlyResets,
  normalizeClaudeLimits,
  normalizeCodexLimits,
  normalizeGrokLimits,
  normalizeKimiLimits,
  openCodeDatabasePath,
  openPlainFile,
  pluginLimitsResult,
  verifiedHomeFolder,
  readOpenCodeGoKeyFromDatabase,
  readQwenHomeState
} from "../src/main/services/LimitsService.ts";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MAX_LIMIT_HOMES_PER_PLUGIN, PluginLimits, validateLimitsHome } from "../src/main/services/PluginLimits.ts";
import { PluginServiceSupervisor } from "../src/main/services/PluginServiceSupervisor.ts";

const FUTURE = Date.UTC(2099, 0, 1);
const FIXTURE_SECRETS = [
  "fixture-grok-token-default-7f3a",
  "fixture-grok-token-home-91c2",
  "fixture-claude-token-default-55aa",
  "fixture-claude-token-home-0b0b",
  "fixture-codex-account-id-4242",
  "fixture-codex-access-token-1717",
  "person@example.invalid",
  "fixturekimiwebdefault",
  "fixturekimiwebhome",
  "fixture-opencode-go-key-home-3c3c",
  "fixture-qwen-api-key-home-d1d1"
];

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met in time.");
};

function registry(available) {
  return {
    get(provider) {
      const executable = available[provider];
      if (executable) return { state: "available", provider, executable, launcher: "native", environment: {}, checked: [] };
      return { state: "unavailable", provider, reason: "cli-not-found", checked: [], diagnostic: "" };
    }
  };
}

function window(id, usedPercent, resetsAt) {
  return { id, bucketId: "b", slot: "primary", isDefaultBucket: true, label: "5h", usedPercent, used: null, limit: null, windowMinutes: 300, resetsAt };
}

function snapshot(windows, extra = {}) {
  return { fetchedAt: 1, providers: [{ provider: "claude", state: "available", source: "claude-usage-api", fetchedAt: 1, windows, ...extra }] };
}

/** A LimitsService stand-in that counts reads and lets the test publish changes. */
function fakeSource(now) {
  const listeners = new Set();
  const source = {
    reads: 0,
    homeReads: [],
    current: null,
    async get() {
      source.reads += 1;
      source.current = { ...snapshot([window("claude:five_hour", 10, FUTURE)], { accountScope: "scope-fingerprint" }), fetchedAt: now() };
      return structuredClone(source.current);
    },
    peek: () => (source.current ? structuredClone(source.current) : null),
    async getHome(provider, home) {
      source.homeReads.push({ provider, home });
      return { fetchedAt: now(), providers: [{ provider, state: "unavailable", source: "grok-billing-api", checkedAt: now(), reason: "not-authenticated" }] };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(change) {
      for (const listener of listeners) listener(change);
    }
  };
  return source;
}

function bridge({ permissions = { "com.example.a": ["limits:read"] }, now = () => Date.now(), debounceMs = 20, source } = {}) {
  const notes = [];
  const limits = source ?? fakeSource(now);
  const instance = new PluginLimits({
    limits,
    notify: (pluginId, serviceId, method, params) => {
      notes.push({ pluginId, serviceId, method, params });
      return true;
    },
    allowed: (pluginId, permission) => (permissions[pluginId] ?? []).includes(permission),
    debounceMs,
    now
  });
  return { instance, notes, limits, permissions };
}

async function pluginData(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-service-limits-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "plugin-data", "com.example.a");
  await mkdir(join(dataDir, "homes", "acct-1"), { recursive: true });
  return { root, dataDir };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 21, 12);
const iso = (ms) => new Date(ms).toISOString();
const claude = (fiveHour, sevenDay) => ({ fetchedAt: 1, providers: [{ provider: "claude", state: "available", source: "claude-usage-api", fetchedAt: 1,
  windows: normalizeClaudeLimits({ five_hour: { utilization: fiveHour[0], resets_at: iso(fiveHour[1]) }, seven_day: { utilization: sevenDay[0], resets_at: iso(sevenDay[1]) } }) }] });
const codex = (primary, secondary) => ({ fetchedAt: 1, providers: [{ provider: "codex", state: "available", source: "codex-app-server", fetchedAt: 1,
  windows: normalizeCodexLimits({ rateLimits: { limitId: "codex",
    primary: { usedPercent: primary[0], windowDurationMins: 300, resetsAt: primary[1] / 1000 },
    secondary: { usedPercent: secondary[0], windowDurationMins: 10_080, resetsAt: secondary[1] / 1000 } } }) }] });
const grok = (used, end) => ({ fetchedAt: 1, providers: [{ provider: "grok", state: "available", source: "grok-billing-api", fetchedAt: 1,
  windows: normalizeGrokLimits({ config: { creditUsagePercent: used, currentPeriod: { start: iso(end - 7 * DAY), end: iso(end) } } }) }] });
const kimi = (used, reset) => ({ fetchedAt: 1, providers: [{ provider: "kimi", state: "available", source: "kimi-usage-api", fetchedAt: 1,
  windows: normalizeKimiLimits({ usage: { limit: 200, used, resetTime: iso(reset) } }) }] });
const flagged = (resets) => resets.map(({ windowId, usedBefore, usedAfter, resetTimeKept }) => ({ windowId, usedBefore, usedAfter, resetTimeKept }));

test("early reset (a): the share drops before the announced time and a new reset time is reported", () => {
  // Claude 5h at 55% resetting in 3 h and weekly at 70% resetting in 4 days; both come back early with fresh windows.
  const before = claude([55, T0 + 3 * HOUR], [70, T0 + 4 * DAY]);
  const after = claude([0, T0 + 5 * HOUR], [0, T0 + 7 * DAY]);
  const found = detectEarlyResets(before, after, T0);
  assert.deepEqual(flagged(found), [
    { windowId: "claude:five_hour", usedBefore: 55, usedAfter: 0, resetTimeKept: false },
    { windowId: "claude:seven_day", usedBefore: 70, usedAfter: 0, resetTimeKept: false }
  ]);
  assert.deepEqual(found[0], {
    provider: "claude", windowId: "claude:five_hour", slot: "primary", windowLabel: "5h", windowMinutes: 300,
    usedBefore: 55, usedAfter: 0, announcedResetAt: T0 + 3 * HOUR, reportedResetAtAfter: T0 + 5 * HOUR, resetTimeKept: false
  });
  // Codex primary and secondary windows, and Grok's billing period, the same way; an account home is named.
  assert.deepEqual(flagged(detectEarlyResets(codex([40, T0 + 2 * HOUR], [80, T0 + 3 * DAY]), codex([1, T0 + 5 * HOUR], [2, T0 + 7 * DAY]), T0)), [
    { windowId: "codex:primary", usedBefore: 40, usedAfter: 1, resetTimeKept: false },
    { windowId: "codex:secondary", usedBefore: 80, usedAfter: 2, resetTimeKept: false }
  ]);
  const homeFound = detectEarlyResets(grok(64, T0 + 2 * DAY), grok(0, T0 + 9 * DAY), T0, "/data/homes/grok-1");
  assert.equal(homeFound.length, 1);
  assert.equal(homeFound[0].home, "/data/homes/grok-1");
  assert.equal(homeFound[0].provider, "grok");
  // A window counted in used/limit (Kimi) is compared by its share.
  assert.deepEqual(flagged(detectEarlyResets(kimi(150, T0 + 3 * DAY), kimi(0, T0 + 7 * DAY), T0)), [{ windowId: "kimi:weekly", usedBefore: 75, usedAfter: 0, resetTimeKept: false }]);
});

test("early reset (b): the share drops but the provider keeps the old reset time; that time arriving is not another reset", () => {
  const weekEnd = T0 + 6 * DAY;
  const steps = [
    codex([20, T0 + 4 * HOUR], [55, weekEnd]),
    codex([20, T0 + 4 * HOUR], [0, weekEnd]), // early, old time kept
    codex([25, T0 + 4 * HOUR], [12, weekEnd]), // used again
    codex([30, T0 + 4 * HOUR], [30, weekEnd])
  ];
  const kept = detectEarlyResets(steps[0], steps[1], T0);
  assert.deepEqual(flagged(kept), [{ windowId: "codex:secondary", usedBefore: 55, usedAfter: 0, resetTimeKept: true }]);
  assert.equal(kept[0].announcedResetAt, weekEnd);
  assert.equal(kept[0].reportedResetAtAfter, weekEnd);
  assert.deepEqual(detectEarlyResets(steps[1], steps[2], T0 + DAY), []);
  // The kept old time arrives (or is a minute away by the provider's clock): the normal reset, not flagged.
  assert.deepEqual(detectEarlyResets(steps[3], codex([30, T0 + 4 * HOUR], [0, weekEnd + 7 * DAY]), weekEnd + 60_000), []);
  assert.deepEqual(detectEarlyResets(steps[3], codex([30, T0 + 4 * HOUR], [0, weekEnd]), weekEnd - 60_000), []);
  // Unless the share drops substantially again before it.
  assert.deepEqual(flagged(detectEarlyResets(steps[3], codex([30, T0 + 4 * HOUR], [0, weekEnd]), T0 + 3 * DAY)),
    [{ windowId: "codex:secondary", usedBefore: 30, usedAfter: 0, resetTimeKept: true }]);
});

test("not an early reset: a reset time that only moves, noise, small drops, and normal resets", () => {
  const before = claude([55, T0 + 3 * HOUR], [70, T0 + 4 * DAY]);
  // The reset time moved later (or earlier) without a usage drop.
  assert.deepEqual(detectEarlyResets(before, claude([56, T0 + 5 * HOUR], [70, T0 + 6 * DAY]), T0), []);
  assert.deepEqual(detectEarlyResets(before, claude([55, T0 + HOUR], [70, T0 + DAY]), T0), []);
  // Noise of 1-2 points, also near zero.
  assert.deepEqual(detectEarlyResets(before, claude([53, T0 + 3 * HOUR], [69, T0 + 4 * DAY]), T0), []);
  assert.deepEqual(detectEarlyResets(claude([4, T0 + 3 * HOUR], [6, T0 + 4 * DAY]), claude([2, T0 + 3 * HOUR], [4, T0 + 4 * DAY]), T0), []);
  // A drop smaller than half of what was used (55 -> 30) is not a reset; down to 5% or less is.
  assert.deepEqual(detectEarlyResets(before, claude([30, T0 + 3 * HOUR], [70, T0 + 4 * DAY]), T0), []);
  assert.deepEqual(flagged(detectEarlyResets(claude([9, T0 + 3 * HOUR], [70, T0 + 4 * DAY]), claude([5, T0 + 3 * HOUR], [70, T0 + 4 * DAY]), T0)),
    [{ windowId: "claude:five_hour", usedBefore: 9, usedAfter: 5, resetTimeKept: true }]);
  // At or after the announced time it is the normal reset.
  assert.deepEqual(detectEarlyResets(before, claude([0, T0 + 8 * HOUR], [70, T0 + 4 * DAY]), T0 + 3 * HOUR), []);
  // No announced time before, or no share: nothing is inferred.
  const unknown = { fetchedAt: 1, providers: [{ ...before.providers[0], windows: before.providers[0].windows.map((window) => ({ ...window, resetsAt: null })) }] };
  assert.deepEqual(detectEarlyResets(unknown, claude([0, T0 + HOUR], [0, T0 + DAY]), T0), []);
  // An unavailable or stale reading after is not compared.
  assert.deepEqual(detectEarlyResets(before, { fetchedAt: 1, providers: [{ ...before.providers[0], state: "stale", failedAt: 2, reason: "timeout", windows: [] }] }, T0), []);
});

test("a service gets limits:read data only with the permission, and never for a disabled or untrusted plugin", async () => {
  const { instance } = bridge({ permissions: { "com.example.a": ["limits:read"] } });
  // The service's manifest lacks the permission.
  assert.throws(() => instance.handle("com.example.a", "svc", "limits.get", {}, [], "/data"), /limits:read/);
  assert.throws(() => instance.handle("com.example.a", "svc", "limits.subscribe", {}, [], "/data"), /limits:read/);
  // The manifest has it, but the host's registry says the plugin is disabled, untrusted or gone now.
  assert.throws(() => instance.handle("com.example.b", "svc", "limits.get", {}, ["limits:read"], "/data"), /limits:read/);
  // An account home also needs launch:contribute.
  assert.throws(() => instance.handle("com.example.a", "svc", "limits.get", { provider: "grok", home: "/data/homes/a" }, ["limits:read"], "/data"), /launch:contribute/);
  const answer = await instance.handle("com.example.a", "svc", "limits.get", {}, ["limits:read"], "/data");
  assert.equal(answer.state, "ready");
  assert.equal(instance.handle("com.example.a", "svc", "other.method", {}, ["limits:read"], "/data"), undefined);
  instance.dispose();
});

test("the service answer is the page answer: one builder, account scope removed", async () => {
  const { instance, limits } = bridge();
  const answer = await instance.handle("com.example.a", "svc", "limits.get", {}, ["limits:read"], "/data");
  assert.deepEqual(answer, pluginLimitsResult(limits.peek()));
  assert.equal(JSON.stringify(answer).includes("accountScope"), false);
  // The surface path (registerIpc) answers limits.get with the same builder.
  const ipc = await readFile(new URL("../src/main/ipc/registerIpc.ts", import.meta.url), "utf8");
  assert.match(ipc, /method === "limits\.get"\) \{\s*plugins\.assertPermission\(pluginId, "limits:read"\);\s*return pluginLimitsResult\(await limits\.get\(\)\);/);
  instance.dispose();
});

test("service reads come from the cache: at most one refresh per service interval, never more than the page policy", async () => {
  let clock = 1_000_000;
  const { instance, limits } = bridge({ now: () => clock });
  const get = () => instance.handle("com.example.a", "svc", "limits.get", {}, ["limits:read"], "/data");
  await get();
  assert.equal(limits.reads, 1);
  // A fresh snapshot (under 60 s) is served as it is, to every caller.
  for (let index = 0; index < 50; index += 1) await get();
  assert.equal(limits.reads, 1);
  clock += 61_000;
  // Older than 60 s, but a service refreshed under 5 minutes ago: the last snapshot, with its fetchedAt.
  const stale = await get();
  assert.equal(limits.reads, 1);
  assert.equal(stale.snapshot.fetchedAt, 1_000_000);
  clock += 5 * 60_000;
  await get();
  assert.equal(limits.reads, 2);
  // Subscribing never reads.
  instance.handle("com.example.a", "svc", "limits.subscribe", {}, ["limits:read"], "/data");
  assert.equal(limits.reads, 2);
  instance.dispose();
});

test("subscribing before the first read answers loading without starting one", () => {
  const { instance, limits } = bridge();
  assert.deepEqual(instance.handle("com.example.a", "svc", "limits.subscribe", {}, ["limits:read"], "/data"), { state: "loading", snapshot: null });
  assert.equal(limits.reads, 0);
  instance.dispose();
});

test("changed notifications are debounced, carry the early-reset flag, and stop for a disabled or stopped service", async () => {
  const { instance, notes, limits, permissions } = bridge({
    permissions: { "com.example.a": ["limits:read"], "com.example.b": ["limits:read"], "com.example.c": [] }
  });
  for (const pluginId of ["com.example.a", "com.example.b"]) {
    instance.handle(pluginId, "svc", "limits.subscribe", {}, ["limits:read"], "/data");
  }
  const reset = { provider: "claude", windowId: "claude:five_hour", slot: "primary", windowLabel: "5h", windowMinutes: 300,
    usedBefore: 90, usedAfter: 0, announcedResetAt: FUTURE, reportedResetAtAfter: FUTURE, resetTimeKept: true };
  limits.emit({ snapshot: snapshot([window("claude:five_hour", 90, FUTURE)], { accountScope: "x" }), earlyResets: [] });
  limits.emit({ snapshot: snapshot([window("claude:five_hour", 0, FUTURE + 1)], { accountScope: "x" }), earlyResets: [reset] });
  limits.emit({ snapshot: snapshot([window("claude:five_hour", 1, FUTURE + 1)], { accountScope: "x" }), earlyResets: [] });
  await waitFor(() => notes.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(notes.length, 2, "three changes within the debounce window are one notification per service");
  for (const note of notes) {
    assert.equal(note.method, "canvastty.limits.changed");
    assert.equal(note.params.state, "ready");
    assert.equal(note.params.earlyReset, true);
    assert.deepEqual(note.params.earlyResets, [reset]);
    assert.equal(note.params.snapshot.providers[0].windows[0].usedPercent, 1, "the latest snapshot");
    assert.equal(JSON.stringify(note.params).includes("accountScope"), false);
  }
  // Plugin b is disabled mid-subscription; a's service stops (and its subscription ends with it).
  notes.length = 0;
  permissions["com.example.b"] = [];
  instance.serviceStopped("com.example.a", "svc");
  limits.emit({ snapshot: snapshot([window("claude:five_hour", 20, FUTURE)]), earlyResets: [] });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(notes, []);
  instance.dispose();
});

test("an account home's change goes only to the plugin whose data folder holds it", async (t) => {
  const { dataDir } = await pluginData(t);
  const home = join(dataDir, "homes", "acct-1");
  const { instance, notes, limits } = bridge({
    permissions: { "com.example.a": ["limits:read", "launch:contribute"], "com.example.b": ["limits:read", "launch:contribute"] }
  });
  const both = ["limits:read", "launch:contribute"];
  instance.handle("com.example.a", "svc", "limits.subscribe", {}, both, dataDir);
  instance.handle("com.example.b", "svc", "limits.subscribe", {}, both, "/elsewhere");
  await instance.handle("com.example.a", "svc", "limits.get", { provider: "grok", home }, both, dataDir);
  limits.emit({ snapshot: snapshot([window("w", 1, FUTURE)]), home: { provider: "grok", home }, earlyResets: [] });
  await waitFor(() => notes.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(notes.map((note) => note.pluginId), ["com.example.a"]);
  assert.equal(notes[0].params.home, home);
  assert.equal(notes[0].params.provider, "grok");
  instance.dispose();
});

test("only existing folders inside the plugin's own data folder are account homes", async (t) => {
  const { root, dataDir } = await pluginData(t);
  const home = join(dataDir, "homes", "acct-1");
  assert.equal(validateLimitsHome(dataDir, home), home);
  assert.equal(validateLimitsHome(dataDir, `${home}/`), home);
  const other = join(root, "plugin-data", "com.example.other", "homes", "acct-9");
  await mkdir(other, { recursive: true });
  const outside = join(root, "outside");
  await mkdir(outside);
  await symlink(outside, join(dataDir, "homes", "linked"));
  await symlink(join(dataDir, "homes"), join(dataDir, "alias"));
  await writeFile(join(dataDir, "homes", "file"), "x");
  const refused = [
    undefined, 42, "", "relative/homes/acct-1", "homes/acct-1",
    dataDir, // the whole data folder is not one account's home
    join(dataDir, "homes", "missing"),
    `${dataDir}/homes/../homes/acct-1`, // not an exact path
    `${dataDir}/../com.example.other/homes/acct-9`, // traversal to another plugin
    other, // another plugin's data
    join(root, "plugin-data"),
    outside, process.env.HOME ?? "/", "/",
    join(dataDir, "homes", "linked"), // a symbolic link out of the data folder
    join(dataDir, "alias", "acct-1"), // reached through a symbolic link
    join(dataDir, "homes", "file"),
    `${home}\u0000x`, `${home}/${"x".repeat(5_000)}`
  ];
  for (const candidate of refused) {
    assert.throws(() => validateLimitsHome(dataDir, candidate), /not an account home/, String(candidate));
  }
  // A data folder that is itself a symbolic link is refused as a whole.
  const linkedData = join(root, "plugin-data", "com.example.linked");
  await symlink(dataDir, linkedData);
  assert.throws(() => validateLimitsHome(linkedData, join(linkedData, "homes", "acct-1")), /not an account home/);

  const { instance, limits } = bridge({ permissions: { "com.example.a": ["limits:read", "launch:contribute"] } });
  const both = ["limits:read", "launch:contribute"];
  for (const candidate of [other, join(dataDir, "homes", "linked"), "relative"]) {
    await assert.rejects(instance.handle("com.example.a", "svc", "limits.get", { provider: "grok", home: candidate }, both, dataDir), /not an account home/);
  }
  await assert.rejects(instance.handle("com.example.a", "svc", "limits.get", { provider: "nope", home }, both, dataDir), /provider/);
  await assert.rejects(instance.handle("com.example.a", "svc", "limits.get", { provider: "grok" }, both, dataDir), /not an account home/);
  assert.deepEqual(limits.homeReads, [], "a refused home is never read");
  instance.dispose();
});

test("a plugin may ask about a bounded number of account homes; removed ones free their place", async (t) => {
  const { dataDir } = await pluginData(t);
  const { instance, limits } = bridge({ permissions: { "com.example.a": ["limits:read", "launch:contribute"] } });
  const both = ["limits:read", "launch:contribute"];
  const homes = [];
  for (let index = 0; index <= MAX_LIMIT_HOMES_PER_PLUGIN; index += 1) {
    const home = join(dataDir, "pool", `acct-${index}`);
    await mkdir(home, { recursive: true });
    homes.push(home);
  }
  for (const home of homes.slice(0, MAX_LIMIT_HOMES_PER_PLUGIN)) {
    await instance.handle("com.example.a", "svc", "limits.get", { provider: "grok", home }, both, dataDir);
  }
  const last = homes[MAX_LIMIT_HOMES_PER_PLUGIN];
  await assert.rejects(instance.handle("com.example.a", "svc", "limits.get", { provider: "grok", home: last }, both, dataDir), /at most 32/);
  // A known home is still answered.
  await instance.handle("com.example.a", "svc", "limits.get", { provider: "grok", home: homes[0] }, both, dataDir);
  await rm(homes[1], { recursive: true });
  await instance.handle("com.example.a", "svc", "limits.get", { provider: "grok", home: last }, both, dataDir);
  assert.equal(limits.homeReads.length, MAX_LIMIT_HOMES_PER_PLUGIN + 2);
  instance.dispose();
});

/** Real LimitsService over fixture credentials: Grok and Claude through stubbed HTTP, Codex through a fake CLI. */
async function fixtureLimits(t, options = {}) {
  const { root, dataDir } = await pluginData(t);
  const home = join(dataDir, "homes", "acct-1");
  const grokDefault = join(root, "grok-default");
  const codexDefault = join(root, "codex-default");
  await mkdir(grokDefault);
  await mkdir(codexDefault);
  const grokAuth = (token) => JSON.stringify({ "https://auth.x.ai::client": { key: token, auth_mode: "oidc", expires_at: "2099-01-01T00:00:00Z", email: FIXTURE_SECRETS[6] } });
  await writeFile(join(grokDefault, "auth.json"), grokAuth(FIXTURE_SECRETS[0]));
  await writeFile(join(home, "auth.json"), grokAuth(FIXTURE_SECRETS[1]));
  const codexAuth = JSON.stringify({ tokens: { account_id: FIXTURE_SECRETS[4], access_token: FIXTURE_SECRETS[5] }, email: FIXTURE_SECRETS[6] });
  await writeFile(join(codexDefault, "auth.json"), codexAuth);
  const codex = join(root, "codex");
  await writeFile(codex, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.CODEX_HOME;
fs.appendFileSync(path.join(${JSON.stringify(root)}, "codex-starts"), home + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === "account/rateLimits/read"
    ? { rateLimits: { limitId: "codex", primary: { usedPercent: home.endsWith("acct-1") ? 33 : 11, windowDurationMins: 300, resetsAt: 4070908800 } } }
    : message.method === "account/read" ? { account: { type: "chatgpt" }, requiresOpenaiAuth: true } : {};
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
});
`, { mode: 0o700 });
  // `kimi web`: records its data root and pid, prints its local address with a token, and runs until stopped.
  const kimiCli = join(root, "kimi");
  await writeFile(kimiCli, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.KIMI_CODE_HOME || "default";
fs.appendFileSync(path.join(${JSON.stringify(root)}, "kimi-starts"), home + " " + process.pid + "\\n");
const port = process.argv[process.argv.indexOf("--port") + 1];
process.stdout.write("Local:   http://127.0.0.1:" + port + "/#token=" + (home === "default" ? "fixturekimiwebdefault" : "fixturekimiwebhome") + "\\n");
setInterval(() => {}, 60_000);
`, { mode: 0o700 });
  // OpenCode Go in an XDG data root (opencode/auth.json), and a Qwen home configured for an API key.
  const openCodeHome = join(dataDir, "homes", "opencode-1");
  await mkdir(join(openCodeHome, "opencode"), { recursive: true });
  await writeFile(join(openCodeHome, "opencode", "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: FIXTURE_SECRETS[9] } }));
  const qwenHome = join(dataDir, "homes", "qwen-1");
  await mkdir(qwenHome, { recursive: true });
  await writeFile(join(qwenHome, "settings.json"), JSON.stringify({ security: { auth: { selectedType: "openai" } }, env: { OPENAI_API_KEY: FIXTURE_SECRETS[10] } }));
  const kimiHome = join(dataDir, "homes", "kimi-1");
  await mkdir(kimiHome, { recursive: true });

  const previous = { GROK_HOME: process.env.GROK_HOME, CODEX_HOME: process.env.CODEX_HOME };
  process.env.GROK_HOME = grokDefault;
  process.env.CODEX_HOME = codexDefault;
  const originalFetch = globalThis.fetch;
  const requests = [];
  let percent = options.grokPercent ?? (() => 25);
  globalThis.fetch = async (url, init) => {
    const authorization = init.headers.authorization;
    requests.push({ url: String(url), authorization });
    if (options.fetchDelayMs) await new Promise((resolve) => setTimeout(resolve, options.fetchDelayMs));
    if (String(url).endsWith("/api/v1/oauth/usage")) {
      return Response.json({ usage: { limit: 200, used: authorization === `Bearer ${FIXTURE_SECRETS[8]}` ? 50 : 20, resetTime: "2099-01-01T00:00:00Z" } });
    }
    if (String(url).startsWith("https://opencode.ai/")) {
      return Response.json({ usage: { rolling: { percent: authorization === `Bearer ${FIXTURE_SECRETS[9]}` ? 12 : 99, resetsAt: "2099-01-01T00:00:00Z" } } });
    }
    return Response.json({ config: { creditUsagePercent: percent(authorization), currentPeriod: { start: "2026-10-20T00:00:00Z", end: "2099-01-01T00:00:00Z" } } });
  };
  const keychain = [];
  const service = new LimitsService(registry({ codex, claude: "/fixture/claude", grok: "/fixture/grok", kimi: kimiCli, opencode: "/fixture/opencode", qwen: "/fixture/qwen" }), "test", {
    cacheTtlMs: options.cacheTtlMs ?? 60_000,
    homeCacheTtlMs: options.homeCacheTtlMs,
    environment: process.env,
    claude: {
      platform: "darwin",
      account: "fixture-user",
      environment: {},
      keychainRequest: async (serviceName) => {
        keychain.push(serviceName);
        const token = serviceName === "Claude Code-credentials" ? FIXTURE_SECRETS[2] : FIXTURE_SECRETS[3];
        return JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `${token}-refresh` }, email: FIXTURE_SECRETS[6] });
      },
      request: async (_url, token) => {
        requests.push({ url: "claude", authorization: `Bearer ${token}` });
        return { five_hour: { utilization: token === FIXTURE_SECRETS[3] ? 44 : 22, resets_at: "2099-01-01T00:00:00Z" } };
      }
    }
  });
  t.after(() => {
    service.dispose();
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return { root, dataDir, home, kimiHome, openCodeHome, qwenHome, service, requests, keychain, setGrokPercent: (next) => { percent = next; } };
}

function assertNoSecrets(value, label) {
  const text = JSON.stringify(value);
  for (const secret of FIXTURE_SECRETS) assert.equal(text.includes(secret), false, `${label} leaks ${secret}`);
  assert.equal(text.includes("accountScope"), false, `${label} has an account scope`);
  assert.equal(/token|email|account_?id|refresh/i.test(text), false, `${label} names a credential field`);
}

test("no token, email or account id reaches a service, for the default login or an account home", { skip: process.platform === "win32" }, async (t) => {
  const { dataDir, home, kimiHome, openCodeHome, qwenHome, service, requests, keychain, root } = await fixtureLimits(t);
  const notes = [];
  const limits = new PluginLimits({
    limits: service,
    notify: (pluginId, serviceId, method, params) => notes.push(params),
    allowed: () => true,
    debounceMs: 5
  });
  t.after(() => limits.dispose());
  const both = ["limits:read", "launch:contribute"];
  limits.handle("com.example.a", "svc", "limits.subscribe", {}, both, dataDir);
  const answers = [await limits.handle("com.example.a", "svc", "limits.get", {}, both, dataDir)];
  const homes = { codex: home, claude: home, grok: home, kimi: kimiHome, opencode: openCodeHome, qwen: qwenHome };
  for (const [provider, providerHome] of Object.entries(homes)) {
    answers.push(await limits.handle("com.example.a", "svc", "limits.get", { provider, home: providerHome }, both, dataDir));
  }
  await waitFor(() => notes.length > 0);
  for (const [index, answer] of answers.entries()) assertNoSecrets(answer, `answer ${index}`);
  for (const [index, note] of notes.entries()) assertNoSecrets(note, `notification ${index}`);

  const providers = (answer) => Object.fromEntries(answer.snapshot.providers.map((provider) => [provider.provider, provider]));
  const defaults = providers(answers[0]);
  assert.equal(defaults.grok.windows[0].usedPercent, 25);
  assert.equal(defaults.claude.windows[0].usedPercent, 22);
  assert.equal(defaults.codex.windows[0].usedPercent, 11);
  // Each account home is read with its own credentials and nothing else.
  const [codexHome, claudeHome, grokHome, kimiHomeAnswer, openCodeAnswer, qwenAnswer] = answers.slice(1).map((answer) => answer.snapshot.providers);
  assert.equal(codexHome.length, 1);
  assert.equal(codexHome[0].windows[0].usedPercent, 33);
  assert.equal(claudeHome[0].windows[0].usedPercent, 44);
  assert.equal(grokHome[0].state, "available");
  const homeHash = createHash("sha256").update(home.normalize("NFC")).digest("hex").slice(0, 8);
  assert.deepEqual(keychain, ["Claude Code-credentials", `Claude Code-credentials-${homeHash}`]);
  assert.deepEqual(requests.filter(({ url }) => url.includes("grok.com")).map(({ authorization }) => authorization),
    [`Bearer ${FIXTURE_SECRETS[0]}`, `Bearer ${FIXTURE_SECRETS[1]}`]);
  const starts = (await readFile(join(root, "codex-starts"), "utf8")).trim().split("\n");
  assert.deepEqual(starts.slice(1), [home], "one app-server for the home, started with its CODEX_HOME");
  // Kimi: one `kimi web` with the home as its data root, read with that server's token, stopped right after.
  assert.equal(defaults.kimi.windows[0].usedPercent, 10);
  assert.equal(kimiHomeAnswer[0].windows[0].usedPercent, 25);
  const kimiStarts = (await readFile(join(root, "kimi-starts"), "utf8")).trim().split("\n").map((line) => line.split(" "));
  assert.deepEqual(kimiStarts.map(([started]) => started), ["default", kimiHome]);
  const kimiPid = Number(kimiStarts[1][1]);
  await waitFor(() => { try { process.kill(kimiPid, 0); return false; } catch { return true; } });
  // OpenCode Go: the key in the home's opencode/auth.json.
  assert.equal(openCodeAnswer[0].windows[0].usedPercent, 12);
  assert.ok(requests.some(({ url, authorization }) => url.startsWith("https://opencode.ai/") && authorization === `Bearer ${FIXTURE_SECRETS[9]}`));
  // Qwen: passive, no request; an API-key home has no quota protocol.
  assert.equal(qwenAnswer[0].state, "unavailable");
  assert.equal(qwenAnswer[0].reason, "unsupported-protocol");
  assert.equal(requests.some(({ url }) => /qwen|dashscope|aliyun/i.test(url)), false);
});

test("an account home's credential file is never read through a symbolic link", { skip: process.platform === "win32" }, async (t) => {
  const { root, dataDir, service, requests } = await fixtureLimits(t);
  const home = join(dataDir, "homes", "linked-auth");
  await mkdir(home, { recursive: true });
  // Points at the default login's Grok sign-in outside the plugin's data.
  await symlink(join(root, "grok-default", "auth.json"), join(home, "auth.json"));
  const answer = (await service.getHome("grok", home)).providers[0];
  assert.equal(answer.state, "unavailable");
  assert.equal(answer.reason, "not-authenticated");
  assert.equal(requests.length, 0);
});

test("OpenCode Go in an account home: a linked opencode folder, auth.json or home is never read", { skip: process.platform === "win32" }, async (t) => {
  const { root, dataDir, service, requests } = await fixtureLimits(t);
  const outside = join(root, "outside-opencode");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "fixture-outside-opencode-key" } }));
  // <home>/opencode is a link to a folder outside the plugin's data.
  const linkedFolder = join(dataDir, "homes", "oc-linked-folder");
  await mkdir(linkedFolder, { recursive: true });
  await symlink(outside, join(linkedFolder, "opencode"));
  // <home>/auth.json is a link.
  const linkedFile = join(dataDir, "homes", "oc-linked-file");
  await mkdir(linkedFile, { recursive: true });
  await symlink(join(outside, "auth.json"), join(linkedFile, "auth.json"));
  // The home itself became a link after it was validated.
  const linkedHome = join(dataDir, "homes", "oc-linked-home");
  await symlink(outside, linkedHome);
  for (const home of [linkedFolder, linkedFile, linkedHome]) {
    const answer = (await service.getHome("opencode", home)).providers[0];
    assert.equal(answer.state, "unavailable", home);
    assert.match(answer.reason, /subscription-required|not-authenticated/);
  }
  assert.equal(requests.some(({ url }) => url.startsWith("https://opencode.ai/")), false);
  assert.equal(await verifiedHomeFolder(linkedFolder, ["opencode"]), null);
  assert.equal(await verifiedHomeFolder(linkedHome), null);
  assert.equal(await verifiedHomeFolder(linkedFolder), linkedFolder);
});

test("a credential file swapped between the check and the open is refused", { skip: process.platform === "win32" }, async (t) => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "canvastty-swap-")));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, "auth.json");
  await writeFile(path, "{}");
  await writeFile(join(folder, "other.json"), "{\"other\":true}");
  // Replaced by another regular file: a different inode than the one checked.
  await assert.rejects(openPlainFile(path, true, async () => {
    await rm(path);
    await rename(join(folder, "other.json"), path);
  }), /not a plain file/);
  // Replaced by a link: O_NOFOLLOW refuses it.
  await writeFile(join(folder, "target.json"), "{}");
  await assert.rejects(openPlainFile(path, true, async () => {
    await rm(path);
    await symlink(join(folder, "target.json"), path);
  }));
  // Unchanged: opened.
  await rm(path);
  await writeFile(path, "{}");
  const opened = await openPlainFile(path, true);
  await opened.handle.close();
});

test("account homes are read from the cache: once per home interval, two at a time", { skip: process.platform === "win32" }, async (t) => {
  const { dataDir, service, requests } = await fixtureLimits(t, { fetchDelayMs: 40 });
  const homes = [];
  for (let index = 0; index < 5; index += 1) {
    const home = join(dataDir, "pool", `acct-${index}`);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "auth.json"), JSON.stringify({ k: { key: `fixture-pool-${index}`, auth_mode: "oidc", expires_at: "2099-01-01T00:00:00Z" } }));
    homes.push(home);
  }
  let running = 0;
  let peak = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    running += 1;
    peak = Math.max(peak, running);
    try {
      return await original(url, init);
    } finally {
      running -= 1;
    }
  };
  // Ten callers at once for each of five homes: one read per home, at most two at a time.
  await Promise.all(homes.flatMap((home) => Array.from({ length: 10 }, () => service.getHome("grok", home))));
  assert.equal(requests.length, 5);
  assert.equal(peak, 2);
  // Asked again within the home interval: served from the cache.
  for (const home of homes) await service.getHome("grok", home);
  assert.equal(requests.length, 5);
  assert.deepEqual(service.peekHome("grok", homes[0]).providers[0].windows[0].usedPercent, 25);
});

test("LimitsService publishes only real changes, with early resets detected once in LimitsService", { skip: process.platform === "win32" }, async (t) => {
  let percent = 80;
  const { home, service } = await fixtureLimits(t, { cacheTtlMs: 0, homeCacheTtlMs: 0, grokPercent: () => percent });
  const changes = [];
  const stop = service.onChange((change) => changes.push(change));
  await service.get();
  await service.get();
  assert.equal(changes.length, 1, "an identical second snapshot is not a change");
  assert.deepEqual(changes[0].earlyResets, []);
  percent = 5;
  await service.get();
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[1].earlyResets.map(({ provider, usedBefore, usedAfter, resetTimeKept }) => ({ provider, usedBefore, usedAfter, resetTimeKept })),
    [{ provider: "grok", usedBefore: 80, usedAfter: 5, resetTimeKept: true }]);
  // The same for an account home, named in the change.
  percent = 70;
  await service.getHome("grok", home);
  percent = 0;
  await service.getHome("grok", home);
  assert.deepEqual(changes.at(-1).home, { provider: "grok", home });
  assert.equal(changes.at(-1).earlyResets.length, 1);
  assert.equal(changes.at(-1).earlyResets[0].home, home);
  stop();
  percent = 50;
  await service.get();
  assert.equal(changes.length, 4, "no change after unsubscribing");
});

test("a Qwen home is read passively: which sign-in it holds decides the reason, and nothing is sent", async (t) => {
  const { dataDir } = await pluginData(t);
  const make = async (name, files) => {
    const home = join(dataDir, "qwen", name);
    await mkdir(home, { recursive: true });
    for (const [file, content] of Object.entries(files)) await writeFile(join(home, file), content);
    return home;
  };
  assert.equal(await readQwenHomeState(await make("empty", {})), "not-authenticated");
  // Qwen OAuth's free tier ended on 2026-04-15: there is no plan to read.
  assert.equal(await readQwenHomeState(await make("oauth", { "oauth_creds.json": JSON.stringify({ access_token: "x" }) })), "subscription-required");
  assert.equal(await readQwenHomeState(await make("oauth-selected", { "settings.json": JSON.stringify({ security: { auth: { selectedType: "qwen-oauth" } } }) })), "subscription-required");
  // Coding Plan, Token Plan or another API key, with comments as Qwen Code allows: no quota protocol.
  assert.equal(await readQwenHomeState(await make("plan", { "settings.json": `// Coding Plan\n${JSON.stringify({ security: { auth: { selectedType: "openai" } }, env: { BAILIAN_CODING_PLAN_API_KEY: "x" } })}` })), "unsupported-protocol");
  assert.equal(await readQwenHomeState(await make("legacy", { "settings.json": JSON.stringify({ selectedAuthType: "openai" }) })), "unsupported-protocol");
  assert.equal(await readQwenHomeState(await make("broken", { "settings.json": "{not json" })), "protocol-error");
});

/** Whether this runtime's node:sqlite opens `file:` URIs (Node 24 and the app's Electron do; older Node does not). */
async function sqliteUriSupported() {
  const folder = await mkdtemp(join(tmpdir(), "canvastty-sqlite-uri-"));
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const path = join(folder, "probe.db");
    new DatabaseSync(path).close();
    // Read-only: a runtime without URI support fails on the literal name instead of creating it.
    const db = new DatabaseSync(`${pathToFileURL(path).href}?mode=ro&immutable=1`, { readOnly: true });
    db.close();
    return true;
  } catch {
    return false;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** A runtime that can run the OpenCode database scenario: this one, or Electron's Node as the app runs it. */
async function sqliteScenarioRuntime() {
  if (await sqliteUriSupported()) return { command: process.execPath, env: {} };
  try {
    const electron = createRequire(import.meta.url)("electron");
    if (typeof electron === "string") {
      await readdir(join(electron, ".."));
      return { command: electron, env: { ELECTRON_RUN_AS_NODE: "1" } };
    }
  } catch {
    // No Electron binary installed.
  }
  return null;
}

test("OpenCode V2 database: read-only, no side files, the active OpenCode Go key, and it decides over auth.json", async (t) => {
  const runtime = await sqliteScenarioRuntime();
  if (!runtime) {
    t.skip("no runtime with SQLite URI support");
    return;
  }
  const script = fileURLToPath(new URL("./helpers/opencode-sqlite-scenario.mjs", import.meta.url));
  const stdout = await new Promise((resolve, reject) => {
    execFile(runtime.command, [script], {
      env: { ...process.env, ...runtime.env, NODE_OPTIONS: "--experimental-strip-types --experimental-sqlite --no-warnings" },
      timeout: 60_000
    }, (error, out, err) => (error ? reject(new Error(`${error.message}\n${err}`)) : resolve(out)));
  });
  const results = JSON.parse(stdout.trim().split("\n").at(-1));
  const key = "fixture-opencode-db-key-a1a1";
  // The active OpenCode Go row (not a newer inactive one, not another provider's), in every journal state.
  assert.equal(results["rollback-journal"].value, key);
  assert.equal(results["wal-closed"].value, key);
  assert.equal(results["wal-live-writer"].value, key, "committed WAL frames of a running OpenCode are read");
  // WAL frames without -shm cannot be read without creating one: skipped.
  assert.equal(results["wal-without-shm"].value, "undefined");
  assert.deepEqual(results["wal-without-shm"].files, ["opencode.db", "opencode.db-wal"]);
  assert.equal(results["no-go-row"].value, null);
  assert.equal(results["oauth-value"].value, null);
  assert.equal(results["no-credential-table"].value, "undefined");
  assert.equal(results["symlinked-db"].value, "undefined", "an account home's database is never read through a link");
  assert.equal(results["symlinked-wal"].value, "undefined", "nor through a linked -wal");
  // Swapped after the open: on macOS the read is bound to the file opened first, elsewhere the inode check drops it;
  // the intruder's key is never returned.
  assert.notEqual(results["swapped-after-open"].value, "fixture-intruder-key-e5e5");
  assert.equal(results["swapped-after-open"].value, "undefined");
  for (const [name, result] of Object.entries(results)) {
    if (name !== "service" && name !== "swapped-after-open") assert.equal(result.unchanged, true, `${name}: no file created or changed`);
  }
  assert.deepEqual(results["wal-closed"].files, ["opencode.db"], "no -wal or -shm after an immutable read");
  // Through LimitsService for account homes: a data folder or an XDG data root; the database decides over a stale
  // legacy auth.json, a database without a Go key means signed out, and auth.json alone still works.
  assert.deepEqual(results.service.dataHome, { state: "available", used: 7 });
  assert.deepEqual(results.service.xdgRoot, { state: "available", used: 7 });
  assert.deepEqual(results.service.signedOut, { state: "unavailable", reason: "subscription-required" });
  assert.deepEqual(results.service.legacyOnly, { state: "available", used: 7 });
  assert.deepEqual(results.service.authorizations, ["db", "db", "legacy"]);
  assert.equal(results.service.dataHomeUnchanged, true);
});

test("without SQLite URI support the database is skipped without creating anything", async (t) => {
  if (await sqliteUriSupported()) {
    t.skip("this runtime supports SQLite URIs");
    return;
  }
  const { DatabaseSync } = await import("node:sqlite");
  const folder = await realpath(await mkdtemp(join(tmpdir(), "canvastty-opencode-old-runtime-")));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, "opencode.db");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE credential (id TEXT, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_updated INTEGER)");
  db.close();
  assert.equal(await readOpenCodeGoKeyFromDatabase(path), undefined);
  assert.deepEqual(await readdir(folder), ["opencode.db"]);
});

test("OpenCode's database path: OPENCODE_DB absolute or relative to the data folder, none in memory", () => {
  assert.equal(openCodeDatabasePath("/data/opencode"), "/data/opencode/opencode.db");
  assert.equal(openCodeDatabasePath("/data/opencode", "custom.db"), "/data/opencode/custom.db");
  assert.equal(openCodeDatabasePath("/data/opencode", "/elsewhere/x.db"), "/elsewhere/x.db");
  assert.equal(openCodeDatabasePath("/data/opencode", ":memory:"), null);
});

/** A service that forwards `ask` to the host and records host notifications. */
const SERVICE = `
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const waiting = new Map();
const notes = [];
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "ask") { waiting.set(1000 + m.id, m.id); send({ id: 1000 + m.id, method: m.params.method, params: m.params.params }); return; }
  if (m.method === "notes") { send({ id: m.id, result: notes }); return; }
  if (m.method === "canvastty.limits.changed") { notes.push(m.params); return; }
  if (!m.method && waiting.has(m.id)) {
    const id = waiting.get(m.id);
    waiting.delete(m.id);
    send({ id, result: m.error ? { error: m.error } : { result: m.result } });
  }
});
`;

test("through the supervisor: limits.* reach the host with the service's own permissions and data folder", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-service-limits-sup-")));
  const source = fakeSource(() => Date.now());
  const enabled = new Map([["com.example.a", ["limits:read"]], ["com.example.b", []]]);
  let limits = null;
  const seen = [];
  const instance = new PluginServiceSupervisor({
    command: process.execPath,
    hostVersion: "9.9.9",
    locale: () => "en",
    requestTimeoutMs: 3_000,
    stopGraceMs: 300,
    host: {
      storageGet: async () => null,
      storageSet: async () => undefined,
      emit: () => undefined,
      limits: (pluginId, serviceId, method, params, permissions, dataDir) => {
        seen.push({ pluginId, dataDir });
        return limits.handle(pluginId, serviceId, method, params, permissions, dataDir);
      },
      stopped: (pluginId, serviceId) => limits.serviceStopped(pluginId, serviceId)
    }
  });
  limits = new PluginLimits({
    limits: source,
    notify: (pluginId, serviceId, method, params) => instance.notify(pluginId, serviceId, method, params),
    allowed: (pluginId, permission) => (enabled.get(pluginId) ?? []).includes(permission),
    debounceMs: 10
  });
  t.after(async () => { limits.dispose(); await instance.dispose(); await rm(root, { recursive: true, force: true }); });
  const spec = async (pluginId, permissions) => {
    const folder = join(root, pluginId);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "svc.mjs"), SERVICE);
    return { pluginId, serviceId: "svc", root: folder, entryPath: join(folder, "svc.mjs"), sha256: createHash("sha256").update(SERVICE).digest("hex"), dataDir: join(folder, "data"), permissions };
  };
  const a = await spec("com.example.a", ["limits:read"]);
  const b = await spec("com.example.b", []);
  await instance.sync([a, b]);
  await waitFor(() => instance.running("com.example.a", "svc") && instance.running("com.example.b", "svc"));
  const ask = (pluginId, method, params = {}) => instance.request(pluginId, "svc", "ask", { method, params });

  const granted = await ask("com.example.a", "limits.get");
  assert.deepEqual(granted.result, pluginLimitsResult(source.peek()));
  assert.equal(seen[0].dataDir, a.dataDir, "the data folder comes from the host's record of the service");
  const refused = await ask("com.example.b", "limits.get");
  assert.match(refused.error.message, /limits:read/);
  assert.match((await ask("com.example.a", "limits.get", { provider: "grok", home: join(a.dataDir, "x") })).error.message, /launch:contribute/);

  await ask("com.example.a", "limits.subscribe");
  source.emit({ snapshot: snapshot([window("claude:five_hour", 3, FUTURE)]), earlyResets: [] });
  await waitFor(async () => (await instance.request("com.example.a", "svc", "notes", null)).length === 1);

  // The plugin is disabled: its service is stopped, the subscription ends, and nothing more is sent.
  enabled.set("com.example.a", []);
  await instance.sync([b]);
  const sent = [];
  const notify = instance.notify.bind(instance);
  instance.notify = (...args) => { sent.push(args); return notify(...args); };
  source.emit({ snapshot: snapshot([window("claude:five_hour", 4, FUTURE)]), earlyResets: [] });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(sent, []);
});
