import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  GRANT_LIMITS,
  GrantGate,
  applyGrants,
  declinedResults,
  parseGrantRequest,
  planGrants,
  rowApplies
} from "../src/renderer/src/features/plugins/grantsPlan.ts";

const ASSISTANT = "canvastty-assistant";
const ACCOUNTS = "canvastty-accounts";
const ENVIRONMENTS = "canvastty-environments";

const plugin = (id, extra = {}, manifest = {}) => ({
  manifest: {
    apiVersion: 2, id, name: id, version: "1.0.0", description: "x", contributions: [], permissions: [],
    services: [{ id: "main", title: "Main", entry: "services/main.mjs" }], ...manifest
  },
  sourceUrl: `https://github.com/example/${id}.git`, enabled: true, installedAt: 1, selectedModules: [], enabledHooks: [],
  nativeCodeTrusted: false, decisionsMayAllow: false, mayStartOrchestrators: false, ...extra
});

function registry({ assistantTrusted = false } = {}) {
  return [
    plugin(ASSISTANT, {
      nativeCodeTrusted: assistantTrusted,
      sharedReads: [
        { plugin: ACCOUNTS, method: "accounts.routes", providerName: "Accounts", description: "Routes.", dataClass: "D1", state: "needs-approval", providerReady: false },
        { plugin: ACCOUNTS, method: "accounts.quota", providerName: "Accounts", description: "Quota.", state: "not-shared", providerReady: false }
      ]
    }, {
      permissions: ["sessions:launch", "accounts:broker", "decision:provide"],
      services: [{ id: "main", title: "Main", entry: "services/main.mjs", decide: { events: ["pre-tool"] } }],
      uses: [{ plugin: ACCOUNTS, method: "accounts.routes" }, { plugin: ACCOUNTS, method: "accounts.quota" }]
    }),
    plugin(ACCOUNTS, {}, { permissions: ["secrets"], services: [{ id: "accounts", title: "Accounts", entry: "services/a.mjs", brokerable: true }] }),
    plugin(ENVIRONMENTS),
    plugin("canvastty-widget", {}, { services: undefined })
  ];
}

const SETUP = [
  { kind: "nativeCode", plugin: ACCOUNTS },
  { kind: "nativeCode", plugin: ASSISTANT },
  { kind: "nativeCode", plugin: ENVIRONMENTS },
  { kind: "mayStartOrchestrators" },
  { kind: "sharedRead", provider: ACCOUNTS, method: "accounts.routes" },
  { kind: "brokerGrant", owner: ACCOUNTS, account: "*" },
  { kind: "trustUpdates", plugin: ASSISTANT },
  { kind: "trustUpdates", plugin: ENVIRONMENTS }
];

/** Setters that record what was applied and flip the registry like main would. */
function fakeApi(plugins, { ownerStartsAfter = 0, failBroker = false } = {}) {
  const calls = [];
  let brokerAsks = 0;
  const find = (id) => plugins.find((candidate) => candidate.manifest.id === id);
  return {
    calls,
    api: {
      setNativeCodeTrusted: async (id, on) => { calls.push(["native", id, on]); find(id).nativeCodeTrusted = on; },
      setMayStartOrchestrators: async (id, on) => { calls.push(["orchestrators", id, on]); },
      setDecisionsMayAllow: async (id, on) => { calls.push(["decisions", id, on]); },
      setSharedReadApproved: async (id, provider, method, on) => { calls.push(["read", id, provider, method, on]); },
      setBrokerGrant: async (caller, owner, account, on) => { if (failBroker) throw new Error("Error invoking remote method 'x': Error: owner gone"); calls.push(["broker", caller, owner, account, on]); },
      setTrustUpdates: async (id, on) => { calls.push(["updates", id, on]); },
      brokerAccounts: async () => ({ available: brokerAsks++ >= ownerStartsAfter, accounts: [], callers: [], grants: [] }),
      wait: async () => {}
    }
  };
}

const noBroker = async () => null;

test("parse: only known kinds and fields, 1 to 24 items, a short plain reason; duplicates collapse", () => {
  const parsed = parseGrantRequest({ reason: "Set up Auto‮(evil)\n\u0007", items: [...SETUP, SETUP[0]] });
  assert.equal(parsed.items.length, SETUP.length);
  assert.equal(parsed.reason, "Set up Auto (evil)");
  assert.equal(parseGrantRequest({ reason: "x".repeat(500), items: [SETUP[0]] }).reason.length, GRANT_LIMITS.reasonChars);
  for (const bad of [
    null, [], {}, { items: [] }, { items: Array.from({ length: 25 }, () => SETUP[3]) }, { items: [SETUP[0]], extra: 1 },
    { items: [{ kind: "yolo" }] }, { items: [{ kind: "nativeCode" }] }, { items: [{ kind: "nativeCode", plugin: "Bad Id" }] },
    { items: [{ kind: "mayStartOrchestrators", plugin: ACCOUNTS }] }, { items: [{ kind: "brokerGrant", owner: ACCOUNTS, account: "**" }] },
    { items: [{ kind: "sharedRead", provider: ACCOUNTS, method: "Bad method" }] }, { items: [{ kind: "nativeCode", plugin: ACCOUNTS, sourceUrl: "x" }] },
    { reason: 5, items: [SETUP[0]] }
  ]) assert.throws(() => parseGrantRequest(bad), /grants\.request/u, JSON.stringify(bad));
});

test("plan: rows come from the registry; trust updates start unticked; impossible and granted items are not shown", async () => {
  const plugins = registry();
  const plan = await planGrants(ASSISTANT, parseGrantRequest({ items: [...SETUP,
    { kind: "nativeCode", plugin: "canvastty-widget" }, { kind: "nativeCode", plugin: "not-installed" },
    { kind: "sharedRead", provider: ACCOUNTS, method: "accounts.quota" }, { kind: "sharedRead", provider: ACCOUNTS, method: "other.read" }
  ] }), plugins, noBroker);
  // Only low-impact rows start ticked: the requester's own native code and its shared read. Another plugin's native
  // code, may start orchestrators, every account of an owner and trusting updates are ticked by the person.
  assert.deepEqual(plan.rows.map((row) => [row.item.kind, row.ticked]), [
    ["nativeCode", false], ["nativeCode", true], ["nativeCode", false], ["mayStartOrchestrators", false], ["sharedRead", true],
    ["brokerGrant", false], ["trustUpdates", false], ["trustUpdates", false]
  ]);
  const single = await planGrants(ASSISTANT, parseGrantRequest({ items: [{ kind: "nativeCode", plugin: ASSISTANT }, { kind: "brokerGrant", owner: ACCOUNTS, account: "glm-1" }, { kind: "decisionsMayAllow" }] }), registry(), noBroker);
  assert.deepEqual(single.rows.map((row) => row.ticked), [true, true, false], "one named account stays ticked; allowing agent actions does not");
  assert.deepEqual(plan.settled.map(({ result }) => [result.result, result.reason]), [
    ["failed", "has no native code"], ["failed", "not installed or disabled"], ["failed", "the other plugin does not share it"],
    ["failed", "not declared in this plugin's uses"]
  ]);
  // Already granted: not shown again.
  const trusted = registry({ assistantTrusted: true });
  trusted[0].mayStartOrchestrators = true;
  const again = await planGrants(ASSISTANT, parseGrantRequest({ items: [{ kind: "nativeCode", plugin: ASSISTANT }, { kind: "mayStartOrchestrators" }] }), trusted, noBroker);
  assert.deepEqual(again.rows, []);
  assert.deepEqual(declinedResults(again).map((result) => result.result), ["already", "already"]);
});

test("an untrusted plugin must ask for its own native code first, and gets nothing else without it", async () => {
  await assert.rejects(planGrants(ASSISTANT, parseGrantRequest({ items: [{ kind: "mayStartOrchestrators" }] }), registry(), noBroker), /not trusted/u);
  await assert.rejects(planGrants(ASSISTANT, parseGrantRequest({ items: [{ kind: "nativeCode", plugin: ACCOUNTS }] }), registry(), noBroker), /not trusted/u);
  const plugins = registry();
  const plan = await planGrants(ASSISTANT, parseGrantRequest({ items: SETUP }), plugins, noBroker);
  // The person unticks the Assistant's own native code: everything else is declined, even Accounts' trust.
  const ticks = plan.rows.map((row) => !(row.item.kind === "nativeCode" && row.item.plugin === ASSISTANT));
  assert.equal(plan.rows.filter((row) => rowApplies(plan, ticks, row, plugins)).length, 0);
  const { api, calls } = fakeApi(plugins);
  const results = await applyGrants(plan, ticks, plugins, api);
  assert.deepEqual(calls, []);
  assert.ok(results.every((result) => result.result === "declined"));
});

test("apply: native code first (the requester's own first), then the rest, in the request's order; unticked stays off", async () => {
  const plugins = registry();
  const plan = await planGrants(ASSISTANT, parseGrantRequest({ items: SETUP }), plugins, noBroker);
  // The person ticks everything except trusting the Assistant's updates.
  const ticks = plan.rows.map((row) => !(row.item.kind === "trustUpdates" && row.item.plugin === ASSISTANT));
  const { api, calls } = fakeApi(plugins, { ownerStartsAfter: 2 });
  const results = await applyGrants(plan, ticks, plugins, api);
  assert.deepEqual(calls, [
    ["native", ASSISTANT, true], ["native", ACCOUNTS, true], ["native", ENVIRONMENTS, true],
    ["orchestrators", ASSISTANT, true], ["read", ASSISTANT, ACCOUNTS, "accounts.routes", true],
    ["broker", ASSISTANT, ACCOUNTS, "*", true], ["updates", ENVIRONMENTS, true]
  ]);
  assert.deepEqual(results.map((result) => `${result.kind}:${result.result}`), [
    "nativeCode:granted", "nativeCode:granted", "nativeCode:granted", "mayStartOrchestrators:granted", "sharedRead:granted",
    "brokerGrant:granted", "trustUpdates:declined", "trustUpdates:granted"
  ]);
});

test("apply: a setter error fails only its row; a broker grant waits (bounded) for a just-trusted owner", async () => {
  const plugins = registry({ assistantTrusted: true });
  const plan = await planGrants(ASSISTANT, parseGrantRequest({ items: [{ kind: "nativeCode", plugin: ACCOUNTS }, { kind: "brokerGrant", owner: ACCOUNTS, account: "*" }, { kind: "decisionsMayAllow" }] }), plugins, noBroker);
  const { api } = fakeApi(plugins, { failBroker: true });
  const results = await applyGrants(plan, plan.rows.map(() => true), plugins, api);
  assert.deepEqual(results.map((result) => [result.result, result.reason]), [["granted", undefined], ["failed", "owner gone"], ["granted", undefined]]);
  // A trusted owner whose service never answers: the grant fails after the bounded wait, with a way out.
  const later = registry({ assistantTrusted: true });
  later[1].nativeCodeTrusted = true;
  const plan2 = await planGrants(ASSISTANT, parseGrantRequest({ items: [{ kind: "brokerGrant", owner: ACCOUNTS, account: "glm-1" }] }), later, noBroker);
  const never = fakeApi(later, { ownerStartsAfter: Infinity });
  let clock = 0;
  const realNow = Date.now;
  Date.now = () => (clock += 1_000);
  try {
    const [result] = await applyGrants(plan2, [true], later, never.api);
    assert.equal(result.result, "failed");
    assert.match(result.reason, /did not start in time/u);
    assert.deepEqual(never.calls, []);
  } finally {
    Date.now = realNow;
  }
});

test("broker grants: an owner that offers nothing or another account is refused; a granted all-accounts grant is not asked again", async () => {
  const plugins = registry({ assistantTrusted: true });
  plugins[1].nativeCodeTrusted = true;
  const offer = async () => ({
    available: true, accounts: [{ ref: `${ACCOUNTS}:glm-1`, owner: ACCOUNTS, ownerName: "Accounts", id: "glm-1", label: "GLM", protocol: "openai", origin: "https://api.z.ai", paths: [], models: ["glm-5"], flatRate: true }],
    callers: [], grants: [{ caller: ASSISTANT, account: "glm-1", state: "granted" }], allGrants: [{ caller: ASSISTANT, state: "on" }]
  });
  const plan = await planGrants(ASSISTANT, parseGrantRequest({ items: [
    { kind: "brokerGrant", owner: ACCOUNTS, account: "*" }, { kind: "brokerGrant", owner: ACCOUNTS, account: "glm-9" },
    { kind: "brokerGrant", owner: ENVIRONMENTS, account: "*" }, { kind: "brokerGrant", owner: ASSISTANT, account: "*" }
  ] }), plugins, offer);
  assert.deepEqual(plan.rows, []);
  assert.deepEqual(plan.settled.map(({ result }) => result.result), ["already", "failed", "failed", "failed"]);
});

test("gate: one dialog at a time, 3 per plugin in 10 minutes, 60 s pause after everything was declined", () => {
  let now = 0;
  const gate = new GrantGate(() => now);
  gate.enter(ASSISTANT);
  assert.throws(() => gate.enter(ACCOUNTS), /Another consent dialog/u);
  gate.leave(ASSISTANT, true);
  assert.throws(() => gate.enter(ASSISTANT), /just declined/u);
  gate.enter(ACCOUNTS);
  gate.leave(ACCOUNTS, false);
  now += GRANT_LIMITS.declinedMs + 1;
  gate.enter(ASSISTANT); gate.leave(ASSISTANT, false);
  gate.enter(ASSISTANT); gate.leave(ASSISTANT, false);
  assert.throws(() => gate.enter(ASSISTANT), /At most 3/u);
  now += GRANT_LIMITS.windowMs;
  gate.enter(ASSISTANT);
  gate.leave(ASSISTANT, false);
});

test("wiring: only a frame the person is in may ask; the dialog is CanvasTTY's own, lazy, and starts on Cancel", async () => {
  const frame = await readFile(new URL("../src/renderer/src/features/plugins/PluginFrame.tsx", import.meta.url), "utf8");
  const dialog = await readFile(new URL("../src/renderer/src/features/plugins/grantsRequest.tsx", import.meta.url), "utf8");
  assert.match(frame, /method === "grants\.request"[\s\S]{0,400}await import\("\.\/grantsRequest"\)/u);
  assert.match(dialog, /if \(!input\.personInFrame \|\| !activated\) throw/u);
  assert.match(dialog, /navigator\.userActivation\?\.isActive === true/u);
  assert.match(dialog, /cancel\.current\?\.focus\(\)/u);
  assert.match(dialog, /"canvastty:grants-dialog"/u);
  // The plugin's own text is shown only as the quoted reason.
  assert.match(dialog, /plan\.reason && <blockquote/u);
  const sdk = await readFile(new URL("../src/main/services/PluginManager.ts", import.meta.url), "utf8");
  assert.match(sdk, /grants: Object\.freeze\(\{\n\s+request: \(params\) => request\("grants\.request", params\)/u);
  // A separate plugin window has no path to it: its preload forwards to the main process, which does not answer it.
  const main = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(main, /grants\.request/u);
});

test("settings.open: known sections only, on the person's action, through the lazily loaded part", async () => {
  const frame = await readFile(new URL("../src/renderer/src/features/plugins/PluginFrame.tsx", import.meta.url), "utf8");
  const pages = await readFile(new URL("../src/renderer/src/features/plugins/grantsRequest.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/renderer/src/App.tsx", import.meta.url), "utf8");
  assert.match(frame, /method === "settings\.open" \? pages\.openSettings\(params, personInFrame\)/u);
  assert.match(pages, /\{ agents: "agents", "native-code": "agents", plugins: "plugins", appearance: "appearance" \}/u);
  assert.match(pages, /if \(!personInFrame\) throw new Error\("settings\.open answers only/u);
  assert.match(app, /\["canvastty:open-settings", section\]/u);
  const sdk = await readFile(new URL("../src/main/services/PluginManager.ts", import.meta.url), "utf8");
  assert.match(sdk, /open: \(section\) => request\("settings\.open", \{ section \}\)/u);
});
