import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginManager, validatePluginManifest } from "../src/main/services/PluginManager.ts";
import { PluginServiceSupervisor } from "../src/main/services/PluginServiceSupervisor.ts";
import {
  BROKER_LIMITS,
  BrokerError,
  KeyMask,
  PluginAccountBroker,
  UsageMeter,
  brokerAddressKey,
  brokerAddressPin,
  brokerAllGrantMarker,
  brokerGrantFingerprint,
  validateBrokerOffer
} from "../src/main/services/PluginAccountBroker.ts";
import { addressAllowed, createBrokerTransport, isNonPublicAddress } from "../src/main/services/brokerTransport.ts";
import { SecretRedactionRegistry } from "../src/main/services/safety/SecretRedaction.ts";
import { startFakeModelUpstream } from "./helpers/fake-model-upstream.mjs";

const OWNER = "com.example.accounts";
const CALLER = "com.example.assistant";
const OTHER = "com.example.other";
const SOURCE = "https://github.com/example/accounts.git";
const KEY = "zz-fixture-broker-key-8e41c07a9d3b";
/** Offers with a key are https only; tests deliver them to the fake server through its test transport. */
const HTTPS = "https://models.example.test";

const offerFor = (origin, overrides = {}) => ({
  id: "glm-1",
  label: "GLM plan",
  protocol: "openai",
  baseUrl: `${origin}/api/paas/v4`,
  paths: ["/chat/completions", "/models"],
  models: ["m-stream", "m-json", "m-429", "m-500", "m-redirect", "m-hang", "m-big", "m-anthropic"],
  secretKey: "key.glm-1",
  auth: "bearer",
  flatRate: true,
  ...overrides
});

/**
 * A broker with in-memory deps: one owner whose offer, admit and settle are functions, one caller, grants in a map,
 * and every notification the caller would get collected.
 */
function brokerFixture(t, { offers, admit = async () => ({ ok: true }), limits = {}, transport } = {}) {
  const state = {
    offers,
    ownerReady: true,
    callerReady: true,
    grants: new Map(),
    notifications: [],
    calls: [],
    audit: [],
    registered: [],
    settles: [],
    secret: KEY,
    running: true,
    notifyOk: () => true
  };
  const redaction = new SecretRedactionRegistry();
  const broker = new PluginAccountBroker({
    owners: () => (state.ownerReady ? [{ pluginId: OWNER, serviceId: "accounts", name: "Accounts", sourceUrl: SOURCE }] : []),
    callers: () => [{ pluginId: CALLER, name: "Assistant", ready: state.callerReady }, { pluginId: OTHER, name: "Other", ready: true }],
    grant: (caller, owner, account) => state.grants.get(`${caller} ${owner} ${account}`),
    saveGrant: async (caller, owner, account, fingerprint) => {
      if (fingerprint === null) state.grants.delete(`${caller} ${owner} ${account}`);
      else state.grants.set(`${caller} ${owner} ${account}`, fingerprint);
    },
    running: () => state.running,
    call: async (pluginId, serviceId, method, params) => {
      state.calls.push({ pluginId, method, params });
      if (method === "canvastty.broker.offer") return typeof state.offers === "function" ? state.offers() : state.offers;
      if (method === "canvastty.broker.admit") return admit(params);
      if (method === "canvastty.broker.settle") { state.settles.push(params); return null; }
      throw new Error(`unexpected ${method}`);
    },
    notify: (pluginId, serviceId, method, params) => {
      if (!state.notifyOk()) return false;
      state.notifications.push({ pluginId, serviceId, method, params: structuredClone(params) });
      return true;
    },
    secret: async (owner, key) => (owner === OWNER && key === "key.glm-1" ? state.secret : null),
    registerSecret: (owner, value) => { state.registered.push(owner); redaction.add(`plugin:${owner}`, [value]); },
    redact: (text) => redaction.redact(text),
    audit: (pluginId, serviceId, level, message) => state.audit.push({ pluginId, level, message }),
    limits,
    ...(transport ? { transport } : {})
  });
  t.after(() => broker.dispose());
  const grant = async () => broker.setGrant(CALLER, OWNER, "glm-1", true);
  const request = (params, caller = CALLER) => broker.handle(caller, "router", "accounts.request", params);
  /** The notifications for one request once its `end` arrived. */
  const finished = async (requestId, timeoutMs = 5_000) => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const mine = state.notifications.filter((entry) => entry.params.requestId === requestId);
      if (mine.some((entry) => entry.method === "canvastty.accounts.end")) return mine;
      if (Date.now() > until) throw new Error(`no end for ${requestId}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { broker, state, grant, request, finished };
}

const reasonOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof BrokerError, String(error));
    return error.reason;
  }
  return "ok";
};

const chat = (model, extra = {}) => ({ model, messages: [{ role: "user", content: "hi" }], stream: true, ...extra });

test("manifest: brokerable services need secrets; accounts:broker is a known permission", () => {
  const base = {
    apiVersion: 2, id: OWNER, name: "Accounts", version: "1.0.0", description: "Owner.", contributions: [],
    services: [{ id: "accounts", title: "Accounts", entry: "services/accounts.mjs", brokerable: true }]
  };
  assert.equal(validatePluginManifest({ ...base, permissions: ["secrets"] }).services[0].brokerable, true);
  assert.throws(() => validatePluginManifest({ ...base, permissions: [] }), /needs the secrets permission/);
  assert.throws(() => validatePluginManifest({ ...base, permissions: ["secrets"], services: [{ ...base.services[0], brokerable: "yes" }] }), /true or false/);
  assert.throws(() => validatePluginManifest({
    ...base, permissions: ["secrets"],
    services: [base.services[0], { id: "second", title: "Second", entry: "services/second.mjs", brokerable: true }]
  }), /Only one plugin service/);
  assert.equal(validatePluginManifest({ ...base, permissions: ["secrets"], services: [{ ...base.services[0], brokerable: false }] }).services[0].brokerable, undefined);
  const caller = validatePluginManifest({
    apiVersion: 2, id: CALLER, name: "Assistant", version: "1.0.0", description: "Caller.", contributions: [],
    permissions: ["accounts:broker"], services: [{ id: "router", title: "Router", entry: "services/router.mjs" }]
  });
  assert.deepEqual(caller.permissions, ["accounts:broker"]);
});

test("offers: only https (http only on 127.0.0.1/[::1]), no credentials, query or fragment, allowlisted paths, named models", () => {
  const ok = validateBrokerOffer(offerFor("https://api.z.ai"));
  assert.equal(ok.origin, "https://api.z.ai");
  assert.equal(ok.baseUrl, "https://api.z.ai/api/paas/v4");
  assert.equal(ok.loopback, false);
  // A key never goes to plain http, not even on loopback; a keyless model server on this computer may be offered.
  assert.equal(validateBrokerOffer(offerFor("http://127.0.0.1:9")), null);
  const { secretKey: _secret, auth: _auth, ...keyless } = offerFor("http://127.0.0.1:9");
  const local = validateBrokerOffer(keyless);
  assert.equal(local.loopback, true);
  assert.equal(local.secretKey, null);
  assert.equal(validateBrokerOffer({ ...keyless, auth: "bearer" }), null, "auth without a secret");
  assert.equal(validateBrokerOffer({ ...keyless, secretKey: "key.x" }), null, "a secret without auth");
  for (const bad of [
    offerFor("http://api.z.ai"),
    offerFor("http://localhost:9"),
    offerFor("http://10.0.0.2"),
    { ...offerFor("https://api.z.ai"), baseUrl: "https://user:pw@api.z.ai/v1" },
    { ...offerFor("https://api.z.ai"), baseUrl: "https://api.z.ai/v1?x=1" },
    { ...offerFor("https://api.z.ai"), baseUrl: "https://api.z.ai/v1#f" },
    { ...offerFor("https://api.z.ai"), paths: ["/chat/completions", "/admin"] },
    { ...offerFor("https://api.z.ai"), paths: [] },
    { ...offerFor("https://api.z.ai"), models: [] },
    { ...offerFor("https://api.z.ai"), models: ["two words"] },
    { ...offerFor("https://api.z.ai"), auth: "basic" },
    { ...offerFor("https://api.z.ai"), protocol: "ollama" },
    { ...offerFor("https://api.z.ai"), secretKey: "../other" },
    { ...offerFor("https://api.z.ai"), key: KEY }
  ]) assert.equal(validateBrokerOffer(bad), null, JSON.stringify(bad));
});

test("addresses: only public addresses for https offers, only loopback for loopback offers", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:7f00:1"]) {
    assert.equal(isNonPublicAddress(address), true, address);
    assert.equal(addressAllowed(address, false), false, address);
  }
  for (const address of ["8.8.8.8", "2606:4700::1111", "104.18.0.1"]) assert.equal(addressAllowed(address, false), true, address);
  assert.equal(addressAllowed("127.0.0.1", true), true);
  assert.equal(addressAllowed("::1", true), true);
  assert.equal(addressAllowed("8.8.8.8", true), false);
});

test("an https offer whose name resolves to a private address is refused at connect time", async () => {
  const transport = createBrokerTransport({ resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
  await assert.rejects(transport({
    url: new URL("https://models.example.test:1/chat/completions"), method: "POST", headers: {}, body: Buffer.from("{}"),
    signal: new AbortController().signal, loopback: false
  }), /private or local address/);
  await assert.rejects(transport({
    url: new URL("https://10.0.0.5/chat/completions"), method: "POST", headers: {}, signal: new AbortController().signal, loopback: false
  }), /private or local address/);
  await assert.rejects(transport({
    url: new URL("http://api.example.test/chat/completions"), method: "POST", headers: {}, signal: new AbortController().signal, loopback: false
  }), /Only https/);
});

test("grants: nothing is granted by default; a grant is per pair; withdrawal refuses at once", async (t) => {
  const upstream = await startFakeModelUpstream();
  t.after(() => upstream.close());
  const { broker, state, grant, request, finished } = brokerFixture(t, { transport: upstream.transport, offers: [offerFor(HTTPS)] });
  // Listing and requesting before any grant.
  assert.deepEqual(await broker.handle(CALLER, "router", "accounts.list", {}), { accounts: [] });
  assert.equal(await reasonOf(request({ requestId: "r1", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-json"), stream: false })), "not_granted");
  assert.equal(state.calls.filter((call) => call.method === "canvastty.broker.admit").length, 0, "the owner is not asked to admit");
  assert.equal(upstream.requests.length, 0);

  await grant();
  const listed = await broker.handle(CALLER, "router", "accounts.list", {});
  assert.deepEqual(listed.accounts, [{
    ref: `${OWNER}:glm-1`, owner: OWNER, ownerName: "Accounts", id: "glm-1", label: "GLM plan", protocol: "openai",
    origin: HTTPS, paths: ["/chat/completions", "/models"], models: offerFor(HTTPS).models, flatRate: true
  }]);
  assert.doesNotMatch(JSON.stringify(listed), /key\.glm-1|secretKey/);
  // Another plugin has no grant.
  assert.equal(await reasonOf(request({ requestId: "o1", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-json") }, OTHER)), "not_granted");

  assert.deepEqual(await request({ requestId: "r2", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-json"), stream: false }), { requestId: "r2", accepted: true });
  const done = await finished("r2");
  assert.equal(done.at(-1).params.status, 200);
  assert.deepEqual(done.at(-1).params.usage, { input: 4, output: 2, cached: 0 });

  await broker.setGrant(CALLER, OWNER, "glm-1", false);
  assert.equal(await reasonOf(request({ requestId: "r3", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-json") })), "not_granted");
  // A caller that is not trusted (or lacks the permission) is refused before anything else.
  state.callerReady = false;
  assert.equal(await reasonOf(request({ requestId: "r4", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-json") })), "caller_unavailable");
  assert.equal(await reasonOf(broker.handle(CALLER, "router", "accounts.list", {})), "caller_unavailable");
});

test("the request is built by the host: exact URL, method, headers and body; caller headers, query, other paths and models refused", async (t) => {
  const upstream = await startFakeModelUpstream();
  t.after(() => upstream.close());
  const { state, grant, request, finished } = brokerFixture(t, { transport: upstream.transport, offers: [offerFor(HTTPS)] });
  await grant();
  const ref = `${OWNER}:glm-1`;
  assert.equal(await reasonOf(request({ requestId: "h1", ref, path: "/chat/completions", body: chat("m-json"), headers: { "x-forwarded-host": "evil" } })), "invalid_request");
  assert.equal(await reasonOf(request({ requestId: "h2", ref, path: "/chat/completions", body: chat("m-json"), method: "DELETE" })), "invalid_request");
  assert.equal(await reasonOf(request({ requestId: "h3", ref, path: "/chat/completions", body: chat("m-json"), url: "https://evil.example" })), "invalid_request");
  for (const path of ["/chat/completions?x=1", "/../admin", "https://evil.example/chat/completions", "/messages", "/admin"]) {
    assert.equal(await reasonOf(request({ requestId: "p1", ref, path, body: chat("m-json") })), "path_refused", path);
  }
  assert.equal(await reasonOf(request({ requestId: "m1", ref, path: "/chat/completions", body: chat("gpt-5-pro") })), "model_refused");
  assert.equal(await reasonOf(request({ requestId: "m2", ref, path: "/chat/completions", body: { messages: [] } })), "model_refused");
  assert.equal(await reasonOf(request({ requestId: "b1", ref, path: "/models", body: { model: "m-json" } })), "invalid_request");
  assert.equal(upstream.requests.length, 0, "nothing refused reached the provider");

  await request({ requestId: "ok1", ref, path: "/chat/completions", body: chat("m-json", { stream: false, temperature: 0 }), stream: false });
  await finished("ok1");
  const [sent] = upstream.requests;
  assert.equal(sent.method, "POST");
  assert.equal(sent.url, "/api/paas/v4/chat/completions");
  assert.deepEqual(sent.body, chat("m-json", { stream: false, temperature: 0 }));
  assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
  assert.equal(sent.headers["content-type"], "application/json");
  assert.equal(sent.headers.accept, "application/json");
  const extra = Object.keys(sent.headers).filter((name) => !["authorization", "content-type", "accept", "content-length", "host", "connection"].includes(name));
  assert.deepEqual(extra, [], "no other header is sent");
  assert.deepEqual(state.registered, [OWNER], "the key is registered with the redaction registry");

  await request({ requestId: "g1", ref, path: "/models" });
  const models = await finished("g1");
  assert.equal(upstream.requests[1].method, "GET");
  assert.equal(upstream.requests[1].url, "/api/paas/v4/models");
  const head = models.find((entry) => entry.method === "canvastty.accounts.head").params;
  assert.deepEqual(Object.keys(head).sort(), ["contentType", "requestId", "status"], "response headers are dropped except content-type");
});

test("anthropic offers use x-api-key and anthropic-version; usage is read from the Anthropic stream", async (t) => {
  const upstream = await startFakeModelUpstream();
  t.after(() => upstream.close());
  const { grant, request, finished, broker } = brokerFixture(t, {
    transport: upstream.transport,
    offers: [offerFor(HTTPS, { protocol: "anthropic", auth: "x-api-key", baseUrl: `${HTTPS}/api/anthropic/v1`, paths: ["/messages"] })]
  });
  await grant();
  await request({ requestId: "a1", ref: `${OWNER}:glm-1`, path: "/messages", body: { model: "m-anthropic", max_tokens: 10, messages: [] }, stream: true });
  const done = await finished("a1");
  const [sent] = upstream.requests;
  assert.equal(sent.url, "/api/anthropic/v1/messages");
  assert.equal(sent.headers["x-api-key"], KEY);
  assert.equal(sent.headers.authorization, undefined);
  assert.equal(sent.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(done.at(-1).params.usage, { input: 21, output: 9, cached: 5 });
  void broker;
});

test("streaming: chunks arrive in order with the key masked even when cut across writes; usage from the OpenAI stream", async (t) => {
  const upstream = await startFakeModelUpstream();
  t.after(() => upstream.close());
  const { state, grant, request, finished } = brokerFixture(t, { transport: upstream.transport, offers: [offerFor(HTTPS)] });
  await grant();
  await request({ requestId: "s1", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-stream"), stream: true });
  const done = await finished("s1");
  const methods = done.map((entry) => entry.method);
  assert.equal(methods[0], "canvastty.accounts.head");
  assert.equal(methods.at(-1), "canvastty.accounts.end");
  assert.ok(methods.filter((method) => method === "canvastty.accounts.chunk").length >= 2);
  const text = done.filter((entry) => entry.method === "canvastty.accounts.chunk").map((entry) => entry.params.data).join("");
  assert.match(text, /Hello /);
  assert.match(text, /the key is \[redacted\] ok/);
  assert.match(text, /data: \[DONE\]/);
  assert.deepEqual(done.at(-1).params, { requestId: "s1", status: 200, usage: { input: 11, output: 7, cached: 3 } });
  assert.equal(done[0].params.contentType, "text/event-stream");
  assert.equal(upstream.requests[0].headers.accept, "text/event-stream");
  // Nothing the caller saw, and nothing in either log, holds the key; the logs hold sizes and a hash, not the text.
  const seen = JSON.stringify(state.notifications);
  assert.ok(!seen.includes(KEY));
  assert.ok(!seen.includes("x-key-echo") && !seen.includes("up-123"));
  assert.ok(state.audit.every((line) => !line.message.includes(KEY) && !line.message.includes("hi") && !line.message.includes("Hello")));
  const callerLine = state.audit.find((line) => line.pluginId === CALLER && /ok 200/.test(line.message)).message;
  assert.match(callerLine, /model m-stream: ok 200 · \d+ ms · body \d+ bytes sha256:[0-9a-f]{16} · answer \d+ bytes · usage 11\/7\/3/);
  assert.ok(state.audit.some((line) => line.pluginId === OWNER && /by com\.example\.assistant through glm-1/.test(line.message)));
  // The owner settles with what was used.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(state.settles.at(-1), {
    ref: "glm-1", caller: { pluginId: CALLER }, model: "m-stream", status: "ok", httpStatus: 200, usage: { input: 11, output: 7, cached: 3 }
  });
});

test("upstream errors: status, retry-after and a short masked message; redirects are never followed", async (t) => {
  const upstream = await startFakeModelUpstream();
  t.after(() => upstream.close());
  const { state, grant, request, finished } = brokerFixture(t, { transport: upstream.transport, offers: [offerFor(HTTPS)] });
  await grant();
  await request({ requestId: "e1", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-429"), stream: true });
  const limited = await finished("e1");
  assert.deepEqual(limited.map((entry) => entry.method), ["canvastty.accounts.end"], "no head and no chunk for an error");
  const { error } = limited[0].params;
  assert.equal(error.reason, "upstream");
  assert.equal(error.status, 429);
  assert.equal(error.retryAfter, 7);
  assert.ok(error.message.length <= 300);
  assert.match(error.message, /rate limited for \[redacted\]/);
  assert.ok(!JSON.stringify(limited).includes(KEY));

  await request({ requestId: "e2", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-redirect") });
  const redirected = await finished("e2");
  assert.equal(redirected.at(-1).params.error.reason, "network");
  assert.match(redirected.at(-1).params.error.message, /redirect/);
  assert.equal(upstream.requests.filter((entry) => entry.url.endsWith("/elsewhere")).length, 0, "the Location was not followed");

  await request({ requestId: "e3", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-500") });
  assert.equal((await finished("e3")).at(-1).params.error.status, 503);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(state.settles.map((entry) => [entry.status, entry.httpStatus]), [["upstream", 429], ["network", 302], ["upstream", 503]]);
});

test("cancel: the upstream request is aborted and the caller gets end with cancelled", async (t) => {
  const upstream = await startFakeModelUpstream();
  t.after(() => upstream.close());
  const { broker, state, grant, request, finished } = brokerFixture(t, { transport: upstream.transport, offers: [offerFor(HTTPS)] });
  await grant();
  await request({ requestId: "c1", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-hang"), stream: true });
  for (let i = 0; i < 200 && !state.notifications.some((entry) => entry.method === "canvastty.accounts.chunk"); i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(await broker.handle(CALLER, "router", "accounts.cancel", { requestId: "c1" }), { cancelled: true });
  const done = await finished("c1");
  assert.equal(done.at(-1).params.error.reason, "cancelled");
  for (let i = 0; i < 100 && !upstream.requests[0].closed; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(upstream.requests[0].closed, true, "the provider's connection was closed");
  assert.deepEqual(await broker.handle(CALLER, "router", "accounts.cancel", { requestId: "c1" }), { cancelled: false });
});

test("the caller's service stopping ends its requests; the owner's stopping ends them with owner_unavailable", async (t) => {
  const upstream = await startFakeModelUpstream();
  t.after(() => upstream.close());
  const { broker, state, grant, request, finished } = brokerFixture(t, { transport: upstream.transport, offers: [offerFor(HTTPS)] });
  await grant();
  await request({ requestId: "x1", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-hang") });
  await request({ requestId: "x2", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-hang") });
  for (let i = 0; i < 200 && state.notifications.filter((entry) => entry.method === "canvastty.accounts.chunk").length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  broker.serviceStopped(OWNER, "accounts");
  assert.equal((await finished("x1")).at(-1).params.error.reason, "owner_unavailable");
  assert.equal((await finished("x2")).at(-1).params.error.reason, "owner_unavailable");
  await request({ requestId: "x3", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-hang") });
  for (let i = 0; i < 200 && upstream.requests.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
  const before = state.notifications.length;
  broker.serviceStopped(CALLER, "router");
  for (let i = 0; i < 100 && !upstream.requests[2].closed; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(upstream.requests[2].closed, true);
  assert.ok(state.notifications.slice(before).every((entry) => entry.method !== "canvastty.accounts.end"), "a stopped caller is not written to");
});

test("admit and settle: the owner can veto; a timeout or error refuses; nothing is sent then", async (t) => {
  const upstream = await startFakeModelUpstream();
  t.after(() => upstream.close());
  let answer = { ok: false, reason: `plan used up for ${KEY}` };
  const { state, grant, request } = brokerFixture(t, { transport: upstream.transport, offers: [offerFor(HTTPS)], admit: async () => answer, limits: { admitMs: 50 } });
  await grant();
  const ref = `${OWNER}:glm-1`;
  const refused = request({ requestId: "v1", ref, path: "/chat/completions", body: chat("m-json") });
  await assert.rejects(refused, (error) => error.reason === "budget_refused" && /plan used up/.test(error.message) && !error.message.includes(KEY));
  answer = null;
  assert.equal(await reasonOf(request({ requestId: "v2", ref, path: "/chat/completions", body: chat("m-json") })), "budget_refused");
  answer = Promise.reject(new Error("boom"));
  answer.catch(() => undefined);
  assert.equal(await reasonOf(request({ requestId: "v3", ref, path: "/chat/completions", body: chat("m-json") })), "budget_refused");
  // The owner learns the account, the caller and the model, and the body's size; never the body itself.
  const admitCall = state.calls.filter((call) => call.method === "canvastty.broker.admit").at(-1);
  assert.deepEqual(admitCall.params, { ref: "glm-1", caller: { pluginId: CALLER }, model: "m-json", estimate: { bodyBytes: JSON.stringify(chat("m-json")).length } });
  assert.equal(upstream.requests.length, 0);
});

test("owner disabled, untrusted or no longer offering the account: refused; a changed origin suspends the grant, a changed model list does not", async (t) => {
  const upstream = await startFakeModelUpstream();
  t.after(() => upstream.close());
  let offers = [offerFor(HTTPS)];
  const { broker, state, grant, request, finished } = brokerFixture(t, { transport: upstream.transport, offers: () => offers });
  await grant();
  const ref = `${OWNER}:glm-1`;
  const go = (requestId) => request({ requestId, ref, path: "/chat/completions", body: chat("m-json") });
  state.ownerReady = false;
  assert.equal(await reasonOf(go("d1")), "owner_unavailable");
  state.ownerReady = true;
  state.running = false;
  assert.equal(await reasonOf(go("d2")), "owner_unavailable");
  state.running = true;
  offers = [];
  assert.equal(await reasonOf(go("d3")), "owner_unavailable");
  offers = [offerFor(HTTPS, { models: ["m-json"] })];
  assert.equal(await reasonOf(go("d4")), "ok", "a changed model list keeps the grant");
  await finished("d4");
  offers = [offerFor(HTTPS, { baseUrl: "https://api.other.example/v4" })];
  assert.equal(await reasonOf(go("d5")), "grant_changed");
  assert.equal((await broker.handle(CALLER, "router", "accounts.list", {})).accounts.length, 0);
  assert.deepEqual((await broker.ownerAccounts(OWNER)).grants, [{ caller: CALLER, account: "glm-1", state: "changed" }]);
  offers = [offerFor(HTTPS, { protocol: "anthropic" })];
  assert.equal(await reasonOf(go("d6")), "grant_changed");
  offers = [offerFor(HTTPS, { auth: "x-api-key" })];
  assert.equal(await reasonOf(go("d7")), "grant_changed");
  // Allowing it again pins the new offer.
  offers = [offerFor(HTTPS, { baseUrl: `${HTTPS}/v2` })];
  await grant();
  assert.equal(await reasonOf(go("d8")), "ok");
  // A missing key refuses without sending.
  await finished("d8");
  state.secret = null;
  const sent = upstream.requests.length;
  assert.equal(await reasonOf(go("d9")), "owner_unavailable");
  assert.equal(upstream.requests.length, sent);
});

test("revocation while a request runs: withdrawing the grant or the caller's trust ends it at once", async (t) => {
  const upstream = await startFakeModelUpstream();
  t.after(() => upstream.close());
  let offers = [offerFor(HTTPS)];
  const { broker, state, grant, request, finished } = brokerFixture(t, { transport: upstream.transport, offers: () => offers, limits: { recheckMs: 50 } });
  await grant();
  const go = (requestId) => request({ requestId, ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-hang") });
  await go("w1");
  await new Promise((r) => setTimeout(r, 30));
  state.grants.clear();
  broker.recheck();
  assert.equal((await finished("w1")).at(-1).params.error.reason, "not_granted");
  await grant();
  await go("w2");
  await new Promise((r) => setTimeout(r, 30));
  state.callerReady = false;
  broker.recheck();
  for (let i = 0; i < 100 && !upstream.requests[1].closed; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(upstream.requests[1].closed, true);
  state.callerReady = true;
  // The owner stops offering the account while a request runs: the periodic recheck ends it.
  await go("w3");
  offers = [];
  assert.equal((await finished("w3")).at(-1).params.error.reason, "owner_unavailable");
});

test("rate limits: 4 open per pair and 60 per minute per pair; one log line per minute", async (t) => {
  const upstream = await startFakeModelUpstream();
  t.after(() => upstream.close());
  let now = 1_000_000;
  const { state, grant, request, broker } = brokerFixture(t, { transport: upstream.transport, offers: [offerFor(HTTPS)] });
  await grant();
  const ref = `${OWNER}:glm-1`;
  for (let i = 0; i < BROKER_LIMITS.openPerPair; i++) await request({ requestId: `o${i}`, ref, path: "/chat/completions", body: chat("m-hang") });
  assert.equal(await reasonOf(request({ requestId: "o9", ref, path: "/chat/completions", body: chat("m-hang") })), "rate_limited");
  for (let i = 0; i < BROKER_LIMITS.openPerPair; i++) await broker.handle(CALLER, "router", "accounts.cancel", { requestId: `o${i}` });
  void now;

  // Per minute, with a clock under the test's control.
  const timed = brokerFixture(t, { transport: upstream.transport, offers: [offerFor(HTTPS)] });
  await timed.grant();
  timed.broker.now = () => now;
  let accepted = 0;
  for (let i = 0; i < BROKER_LIMITS.perMinutePerPair + 5; i++) {
    const reason = await reasonOf(timed.request({ requestId: `q${i}`, ref, path: "/chat/completions", body: chat("m-json") }));
    if (reason === "ok") accepted += 1;
    else assert.equal(reason, "rate_limited");
    await timed.finished(`q${i}`).catch(() => undefined);
  }
  assert.equal(accepted, BROKER_LIMITS.perMinutePerPair);
  now += 60_001;
  assert.equal(await reasonOf(timed.request({ requestId: "q-next", ref, path: "/chat/completions", body: chat("m-json") })), "ok", "room again after a minute");
  await timed.finished("q-next");
  assert.ok(timed.state.audit.filter((line) => /rate_limited/.test(line.message)).length <= 1);
  void state;
});

test("bodies over 1 MB are sent in parts; over 8 MB is too large", async (t) => {
  const upstream = await startFakeModelUpstream();
  t.after(() => upstream.close());
  const { broker, grant, request, finished } = brokerFixture(t, { transport: upstream.transport, offers: [offerFor(HTTPS)], limits: { maxBodyBytes: 3 * 1024 * 1024 } });
  await grant();
  const big = JSON.stringify(chat("m-json", { messages: [{ role: "user", content: "z".repeat(2 * 1024 * 1024) }] }));
  for (let at = 0; at < big.length; at += 700 * 1024) {
    await broker.handle(CALLER, "router", "accounts.body", { requestId: "u1", data: big.slice(at, at + 700 * 1024) });
  }
  await request({ requestId: "u1", ref: `${OWNER}:glm-1`, path: "/chat/completions", stream: false });
  await finished("u1");
  assert.equal(upstream.requests[0].body.messages[0].content.length, 2 * 1024 * 1024);
  assert.equal(await reasonOf(broker.handle(CALLER, "router", "accounts.body", { requestId: "u2", data: "a".repeat(800 * 1024) })), "invalid_request");
  const piece = "a".repeat(700 * 1024);
  let reason = "ok";
  for (let i = 0; i < 6 && reason === "ok"; i++) reason = await reasonOf(broker.handle(CALLER, "router", "accounts.body", { requestId: "u3", data: piece }));
  assert.equal(reason, "too_large");
  assert.equal(await reasonOf(request({ requestId: "u4", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-json", { pad: "p".repeat(3 * 1024 * 1024) }) })), "too_large");
});

test("limits on the answer: idle and size end the request", async (t) => {
  const upstream = await startFakeModelUpstream();
  t.after(() => upstream.close());
  const { grant, request, finished } = brokerFixture(t, { transport: upstream.transport, offers: [offerFor(HTTPS)], limits: { idleMs: 150, maxResponseBytes: 1024 } });
  await grant();
  await request({ requestId: "i1", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-hang") });
  assert.equal((await finished("i1")).at(-1).params.error.reason, "timeout");
  await request({ requestId: "i2", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-big") });
  assert.equal((await finished("i2")).at(-1).params.error.reason, "too_large");
});

test("KeyMask and UsageMeter", () => {
  const mask = new KeyMask("secret-value-123");
  const pieces = ["abc secr", "et-val", "ue-123 and secret-", "x end secret-value-1"];
  const out = pieces.map((piece) => mask.push(piece)).join("") + mask.flush();
  assert.equal(out, "abc [redacted] and secret-x end secret-value-1");
  const meter = new UsageMeter();
  meter.sseLine(`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 6, input_tokens_details: { cached_tokens: 2 } } } })}`);
  assert.deepEqual(meter.value(), { input: 5, output: 6, cached: 2 });
  const plain = new UsageMeter();
  plain.json(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 1 } }));
  assert.deepEqual(plain.value(), { input: 3, output: 4, cached: 1 });
  assert.equal(brokerGrantFingerprint(SOURCE, { id: "a", origin: "https://x", protocol: "openai", auth: "bearer" }).length, 64);
});

// ---- PluginManager: the person's grants ----

const ownerManifest = (overrides = {}) => ({
  apiVersion: 2, id: OWNER, name: "Accounts", version: "1.0.0", description: "Offers accounts.", permissions: ["secrets"], contributions: [],
  services: [{ id: "accounts", title: "Accounts", entry: "services/accounts.mjs", brokerable: true }], ...overrides
});
const callerManifest = (overrides = {}) => ({
  apiVersion: 2, id: CALLER, name: "Assistant", version: "1.0.0", description: "Routes.", permissions: ["accounts:broker"], contributions: [],
  services: [{ id: "router", title: "Router", entry: "services/router.mjs" }], ...overrides
});
const otherManifest = () => ({
  apiVersion: 2, id: OTHER, name: "Other", version: "1.0.0", description: "No permission.", permissions: [], contributions: [],
  services: [{ id: "router", title: "Router", entry: "services/router.mjs" }]
});

async function managerWith(userData, packages) {
  const manager = new PluginManager(userData, async (url, destination) => {
    const key = Object.keys(packages).find((candidate) => candidate.toLowerCase() === String(url).toLowerCase().replace(/\.git$/, ""));
    if (!key) throw new Error(`No fixture for ${url}`);
    const pkg = packages[key]();
    await mkdir(join(destination, "services"), { recursive: true });
    await writeFile(join(destination, "canvastty.plugin.json"), JSON.stringify(pkg.manifest));
    for (const [path, content] of Object.entries(pkg.files)) await writeFile(join(destination, path), content);
  });
  await manager.load();
  return manager;
}
const install = async (manager, id) => manager.install((await manager.previewInstall(`https://github.com/example/${id}`)).token);
const FP = "a".repeat(64);

test("grants in the registry: need the caller's trust and permission and a brokerable owner; survive a restart; end with trust and uninstall", async (t) => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-broker-grants-"));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const packages = {
    [`https://github.com/example/${OWNER}`]: () => ({ manifest: ownerManifest(), files: { "services/accounts.mjs": "// owner\n" } }),
    [`https://github.com/example/${CALLER}`]: () => ({ manifest: callerManifest(), files: { "services/router.mjs": "// caller\n" } }),
    [`https://github.com/example/${OTHER}`]: () => ({ manifest: otherManifest(), files: { "services/router.mjs": "// other\n" } })
  };
  let manager = await managerWith(userData, packages);
  t.after(() => manager.dispose());
  await install(manager, OWNER);
  await install(manager, CALLER);
  await install(manager, OTHER);
  assert.deepEqual(manager.brokerOwners(), [], "an untrusted owner offers nothing");
  await assert.rejects(manager.setBrokerGrant(CALLER, OWNER, "glm-1", FP), /Trust the plugin's native code first/);
  await manager.setNativeCodeTrusted(CALLER, true);
  await assert.rejects(manager.setBrokerGrant(CALLER, OWNER, "glm-1", FP), /does not offer accounts/);
  await manager.setNativeCodeTrusted(OWNER, true);
  await manager.setNativeCodeTrusted(OTHER, true);
  assert.deepEqual(manager.brokerOwners(), [{ pluginId: OWNER, serviceId: "accounts", name: "Accounts", sourceUrl: `https://github.com/example/${OWNER}.git` }]);
  assert.deepEqual(manager.brokerCallers(), [{ pluginId: CALLER, name: "Assistant", ready: true }]);
  await assert.rejects(manager.setBrokerGrant(OTHER, OWNER, "glm-1", FP), /accounts:broker/);
  await assert.rejects(manager.setBrokerGrant(CALLER, OWNER, "glm-1", "nothex"), /invalid/);
  await manager.setBrokerGrant(CALLER, OWNER, "glm-1", FP);
  assert.equal(manager.brokerGrant(CALLER, OWNER, "glm-1"), FP);
  assert.equal(manager.brokerGrant(OTHER, OWNER, "glm-1"), undefined);

  // A restart keeps it (pinned with the caller's native code trust).
  await manager.dispose();
  manager = await managerWith(userData, packages);
  assert.equal(manager.brokerGrant(CALLER, OWNER, "glm-1"), FP);
  // The owner's trust going away suspends (owners() is empty) but keeps the caller's grant.
  await manager.setNativeCodeTrusted(OWNER, false);
  assert.deepEqual(manager.brokerOwners(), []);
  assert.equal(manager.brokerGrant(CALLER, OWNER, "glm-1"), FP);
  await manager.setNativeCodeTrusted(OWNER, true);
  // The caller's own trust going away (an update does the same) removes its grants.
  await manager.setNativeCodeTrusted(CALLER, false);
  assert.equal(manager.brokerGrant(CALLER, OWNER, "glm-1"), undefined);
  await manager.setNativeCodeTrusted(CALLER, true);
  assert.equal(manager.brokerGrant(CALLER, OWNER, "glm-1"), undefined, "trusting again does not revive it");
  // Disabling the owner: it offers nothing.
  await manager.setBrokerGrant(CALLER, OWNER, "glm-1", FP);
  await manager.setEnabled(OWNER, false);
  assert.deepEqual(manager.brokerOwners(), []);
  await manager.setEnabled(OWNER, true);
  await manager.setNativeCodeTrusted(OWNER, true);
  // Uninstalling the owner drops the grants others held for it.
  await manager.uninstall(OWNER);
  assert.equal(manager.brokerGrant(CALLER, OWNER, "glm-1"), undefined);
  const registry = JSON.parse(await readFile(join(userData, "plugins.json"), "utf8"));
  assert.equal(registry[CALLER].brokerGrants, undefined);
});

// ---- end to end: two real service processes and a real supervisor ----

/** The owner: offers one account at `process.env` origin given in its storage-free answer, admits and settles. */
const OWNER_SOURCE = (origin) => `
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const settles = [];
let admit = true;
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "canvastty.broker.offer") send({ id: m.id, result: [{ id: "glm-1", label: "GLM plan", protocol: "openai", baseUrl: ${JSON.stringify(`${origin}/api/paas/v4`)}, paths: ["/chat/completions"], models: ["m-stream", "m-json"], secretKey: "key.glm-1", auth: "bearer", flatRate: true }] });
  else if (m.method === "canvastty.broker.admit") send({ id: m.id, result: admit ? { ok: true } : { ok: false, reason: "used up" } });
  else if (m.method === "canvastty.broker.settle") { settles.push(m.params); send({ id: m.id, result: null }); }
  else if (m.method === "settles") send({ id: m.id, result: settles });
  else if (m.method === "refuse") { admit = false; send({ id: m.id, result: null }); }
});
`;

/** The caller: forwards `call` as a host request and keeps every accounts notification it gets. */
const CALLER_SOURCE = `
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const waiting = new Map();
const notes = [];
let next = 1;
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "call") { const id = 10000 + next++; waiting.set(id, m.id); send({ id, method: m.params.method, params: m.params.params }); return; }
  if (m.method === "notes") { send({ id: m.id, result: notes }); return; }
  if (typeof m.method === "string" && m.method.startsWith("canvastty.accounts.")) { notes.push({ method: m.method, params: m.params }); return; }
  if (!m.method && waiting.has(m.id)) {
    const asked = waiting.get(m.id);
    waiting.delete(m.id);
    send({ id: asked, result: m.error ? { error: m.error } : { result: m.result } });
  }
});
`;

test("end to end: a real caller service streams through a real owner's account; the key never reaches the caller", async (t) => {
  const upstream = await startFakeModelUpstream();
  t.after(() => upstream.close());
  const userData = await mkdtemp(join(tmpdir(), "canvastty-broker-e2e-"));
  const packages = {
    [`https://github.com/example/${OWNER}`]: () => ({ manifest: ownerManifest(), files: { "services/accounts.mjs": OWNER_SOURCE(HTTPS) } }),
    [`https://github.com/example/${CALLER}`]: () => ({ manifest: callerManifest(), files: { "services/router.mjs": CALLER_SOURCE } }),
    [`https://github.com/example/${OTHER}`]: () => ({ manifest: otherManifest(), files: { "services/router.mjs": CALLER_SOURCE } })
  };
  const manager = await managerWith(userData, packages);
  const redaction = new SecretRedactionRegistry();
  let supervisor = null;
  const broker = new PluginAccountBroker({
    owners: () => manager.brokerOwners(),
    callers: () => manager.brokerCallers(),
    grant: (caller, owner, account) => manager.brokerGrant(caller, owner, account),
    saveGrant: async (caller, owner, account, fingerprint) => { await manager.setBrokerGrant(caller, owner, account, fingerprint); },
    running: (pluginId, serviceId) => supervisor.running(pluginId, serviceId),
    call: (pluginId, serviceId, method, params, timeoutMs) => supervisor.hostCall(pluginId, serviceId, method, params, timeoutMs),
    notify: (pluginId, serviceId, method, params) => supervisor.notify(pluginId, serviceId, method, params),
    secret: async (owner, key) => (owner === OWNER && key === "key.glm-1" ? KEY : null),
    registerSecret: (owner, value) => redaction.add(`plugin:${owner}`, [value]),
    redact: (text) => redaction.redact(text),
    audit: (pluginId, serviceId, level, message) => supervisor.audit(pluginId, serviceId, level, message),
    transport: upstream.transport
  });
  supervisor = new PluginServiceSupervisor({
    command: process.execPath,
    hostVersion: "9.9.9",
    locale: () => "en",
    requestTimeoutMs: 8_000,
    stopGraceMs: 300,
    host: {
      storageGet: async () => null,
      storageSet: async () => undefined,
      emit: () => undefined,
      registerSecrets: (pluginId, values) => redaction.add(`plugin:${pluginId}`, values),
      accounts: (pluginId, serviceId, method, params) => broker.handle(pluginId, serviceId, method, params),
      stopped: (pluginId, serviceId) => broker.serviceStopped(pluginId, serviceId)
    }
  });
  manager.setServiceObserver(async (specs) => { broker.recheck(); await supervisor.sync(specs); });
  t.after(async () => {
    broker.dispose();
    await supervisor.dispose();
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
  });
  for (const id of [OWNER, CALLER, OTHER]) {
    await install(manager, id);
    await manager.setNativeCodeTrusted(id, true);
  }
  const call = async (pluginId, method, params) => supervisor.request(pluginId, "router", "call", { method, params });
  const notes = () => supervisor.request(CALLER, "router", "notes", {});
  const ref = `${OWNER}:glm-1`;
  const body = chat("m-stream");

  // Nothing before the person's grant; the other plugin lacks the permission entirely.
  assert.deepEqual((await call(CALLER, "accounts.list", {})).result, { accounts: [] });
  assert.equal((await call(CALLER, "accounts.request", { requestId: "e1", ref, path: "/chat/completions", body, stream: true })).error.data.reason, "not_granted");
  assert.match((await call(OTHER, "accounts.list", {})).error.message, /accounts:broker/);
  // A surface cannot send the owner's host-only methods.
  await assert.rejects(supervisor.request(OWNER, "accounts", "canvastty.broker.offer", {}), /invalid/);

  // The person's grant, as the Settings switch makes it (from the owner's offer as it is now).
  const before = await broker.ownerAccounts(OWNER);
  assert.equal(before.accounts[0].label, "GLM plan");
  assert.deepEqual(before.callers, [{ pluginId: CALLER, name: "Assistant", ready: true }]);
  await broker.setGrant(CALLER, OWNER, "glm-1", true);
  assert.deepEqual((await broker.ownerAccounts(OWNER)).grants, [{ caller: CALLER, account: "glm-1", state: "granted" }]);
  const listed = (await call(CALLER, "accounts.list", {})).result.accounts;
  assert.deepEqual(listed.map((account) => [account.ref, account.origin, account.flatRate]), [[ref, HTTPS, true]]);

  assert.deepEqual((await call(CALLER, "accounts.request", { requestId: "e2", ref, path: "/chat/completions", body, stream: true })).result, { requestId: "e2", accepted: true });
  let seen = [];
  for (let i = 0; i < 300 && !seen.some((note) => note.method === "canvastty.accounts.end"); i++) {
    await new Promise((r) => setTimeout(r, 10));
    seen = await notes();
  }
  const end = seen.find((note) => note.method === "canvastty.accounts.end").params;
  assert.deepEqual(end, { requestId: "e2", status: 200, usage: { input: 11, output: 7, cached: 3 } });
  const text = seen.filter((note) => note.method === "canvastty.accounts.chunk").map((note) => note.params.data).join("");
  assert.match(text, /the key is \[redacted\] ok/);
  assert.equal(upstream.requests.at(-1).headers.authorization, `Bearer ${KEY}`, "the provider got the owner's key");
  // Scan everything the caller could have seen: answers, notifications, and its log.
  const callerVisible = JSON.stringify({ seen, listed, log: supervisor.report(CALLER).log });
  assert.ok(!callerVisible.includes(KEY), "the key never reaches the caller");
  assert.ok(!JSON.stringify(supervisor.report(OWNER).log).includes(KEY), "nor any log");
  for (let i = 0; i < 100 && (await supervisor.request(OWNER, "accounts", "settles", {})).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual((await supervisor.request(OWNER, "accounts", "settles", {}))[0].usage, { input: 11, output: 7, cached: 3 });

  // The owner vetoes.
  await supervisor.request(OWNER, "accounts", "refuse", {});
  assert.equal((await call(CALLER, "accounts.request", { requestId: "e3", ref, path: "/chat/completions", body })).error.data.reason, "budget_refused");
  // Disabling the owner refuses at once; so does withdrawing the grant.
  await manager.setEnabled(OWNER, false);
  assert.equal((await call(CALLER, "accounts.request", { requestId: "e4", ref, path: "/chat/completions", body })).error.data.reason, "owner_unavailable");
  await manager.setEnabled(OWNER, true);
  await manager.setNativeCodeTrusted(OWNER, true);
  await broker.setGrant(CALLER, OWNER, "glm-1", false);
  assert.equal((await call(CALLER, "accounts.request", { requestId: "e5", ref, path: "/chat/completions", body })).error.data.reason, "not_granted");
});

test("an offer whose label or models carry a secret CanvasTTY knows is not shown to callers", async (t) => {
  const upstream = await startFakeModelUpstream();
  t.after(() => upstream.close());
  let offers = [offerFor(HTTPS)];
  const { broker, grant, request, finished } = brokerFixture(t, { transport: upstream.transport, offers: () => offers });
  await grant();
  await request({ requestId: "k1", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-json") });
  await finished("k1");
  offers = [offerFor(HTTPS, { label: `plan ${KEY}` })];
  const listed = await broker.handle(CALLER, "router", "accounts.list", {});
  assert.deepEqual(listed.accounts, []);
  assert.ok(!JSON.stringify(await broker.ownerAccounts(OWNER)).includes(KEY));
});

test("loopback: a keyed offer on plain http is refused and a process squatting the port never gets a credential; a keyless one works", async (t) => {
  // The squatter: whatever listens on the loopback port the owner named (say, while the real local server is down).
  const squatter = await startFakeModelUpstream();
  t.after(() => squatter.close());
  const keyed = { ...offerFor(squatter.origin), baseUrl: `${squatter.origin}/v1` };
  const { secretKey: _secret, auth: _auth, ...keyless } = keyed;
  let offers = [keyed];
  // The real transport, not the test one: the request would really go to 127.0.0.1.
  const { broker, state, request, finished } = brokerFixture(t, { offers: () => offers });
  // A keyed loopback offer is not an offer at all: it cannot be granted, listed or used.
  await assert.rejects(broker.setGrant(CALLER, OWNER, "glm-1", true), /not offered/);
  state.grants.set(`${CALLER} ${OWNER} glm-1`, brokerGrantFingerprint(SOURCE, { id: "glm-1", origin: squatter.origin, protocol: "openai", auth: "bearer" }));
  assert.equal(await reasonOf(request({ requestId: "l1", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-json") })), "owner_unavailable");
  assert.equal(squatter.requests.length, 0, "nothing reached the port");
  assert.equal(state.calls.filter((call) => call.method === "canvastty.broker.admit").length, 0);
  // A keyless account on this computer (a local model server) works over loopback, with no auth header at all.
  offers = [keyless];
  await broker.setGrant(CALLER, OWNER, "glm-1", true);
  await request({ requestId: "l2", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-json"), stream: false });
  const done = await finished("l2");
  assert.equal(done.at(-1).params.status, 200);
  assert.equal(squatter.requests.length, 1);
  assert.equal(squatter.requests[0].headers.authorization, undefined);
  assert.equal(squatter.requests[0].headers["x-api-key"], undefined);
  assert.deepEqual(state.registered, [], "no key was even read");
  assert.ok(!squatter.requests.some((entry) => JSON.stringify(entry).includes(KEY)));
});

// ---- C1: one grant for every account an owner offers ----

test("all-accounts grant: covers every offered account and new ones on allowed addresses; a new address waits for the person", async (t) => {
  const upstream = await startFakeModelUpstream();
  t.after(() => upstream.close());
  const CHINA = "https://open.bigmodel.example";
  let offers = [offerFor(HTTPS)];
  const { broker, request, finished } = brokerFixture(t, { transport: upstream.transport, offers: () => offers });
  const go = (requestId, account, caller = CALLER) => request({ requestId, ref: `${OWNER}:${account}`, path: "/chat/completions", body: chat("m-json"), stream: false }, caller);
  assert.equal(await reasonOf(go("a0", "glm-1")), "not_granted", "nothing by default");

  await broker.setGrant(CALLER, OWNER, "*", true);
  assert.equal(await reasonOf(go("a1", "glm-1")), "ok");
  await finished("a1");
  // A new account on an address the person allowed: covered without another click.
  offers = [offerFor(HTTPS), offerFor(HTTPS, { id: "glm-2", label: "GLM plan 2" })];
  assert.deepEqual((await broker.handle(CALLER, "router", "accounts.list", {})).accounts.map((account) => account.id), ["glm-1", "glm-2"]);
  assert.equal(await reasonOf(go("a2", "glm-2")), "ok");
  await finished("a2");
  // Another caller holds nothing.
  assert.equal(await reasonOf(go("o1", "glm-2", OTHER)), "not_granted");

  // A new account on a new address: suspended until the person allows the grant again.
  offers = [...offers, offerFor(CHINA, { id: "glm-cn", label: "GLM China" })];
  let refusal = null;
  try { await go("a3", "glm-cn"); } catch (error) { refusal = error; }
  assert.equal(refusal?.reason, "not_granted");
  assert.match(refusal.message, /address the person has not allowed yet/u);
  assert.deepEqual((await broker.handle(CALLER, "router", "accounts.list", {})).accounts.map((account) => account.id), ["glm-1", "glm-2"]);
  const view = await broker.ownerAccounts(OWNER);
  assert.deepEqual(view.allGrants, [{ caller: CALLER, state: "on" }]);
  assert.deepEqual(view.grants, [
    { caller: CALLER, account: "glm-1", state: "granted" },
    { caller: CALLER, account: "glm-2", state: "granted" },
    { caller: CALLER, account: "glm-cn", state: "new-address" }
  ]);
  await broker.setGrant(CALLER, OWNER, "*", true);
  assert.equal(await reasonOf(go("a4", "glm-cn")), "ok");
  await finished("a4");
  // The same origin with another protocol or auth scheme is another address.
  offers = [offerFor(HTTPS, { id: "glm-4", auth: "x-api-key" })];
  assert.equal(await reasonOf(go("a5", "glm-4")), "not_granted");
});

test("all-accounts grant: withdrawing it ends running requests at once; an account's own grant is untouched", async (t) => {
  const upstream = await startFakeModelUpstream();
  t.after(() => upstream.close());
  const { broker, state, request, finished } = brokerFixture(t, {
    transport: upstream.transport, offers: [offerFor(HTTPS), offerFor(HTTPS, { id: "glm-2" })], limits: { recheckMs: 50 }
  });
  await broker.setGrant(CALLER, OWNER, "*", true);
  await broker.setGrant(CALLER, OWNER, "glm-2", true);
  await request({ requestId: "h1", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-hang") });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await broker.setGrant(CALLER, OWNER, "*", false);
  assert.equal((await finished("h1")).at(-1).params.error.reason, "not_granted");
  assert.equal(await reasonOf(request({ requestId: "h2", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-json") })), "not_granted");
  assert.equal(await reasonOf(request({ requestId: "h3", ref: `${OWNER}:glm-2`, path: "/chat/completions", body: chat("m-json"), stream: false })), "ok");
  await finished("h3");
  // A pin left without its marker is not enough, and a marker without the pin is not either (PluginManager removes
  // the pins with the marker; this fixture does not, so clear them here).
  for (const key of [...state.grants.keys()]) if (key.includes(" *.")) state.grants.delete(key);
  const pin = brokerAddressPin(SOURCE, offerFor(HTTPS));
  state.grants.set(`${CALLER} ${OWNER} ${brokerAddressKey(pin)}`, pin);
  assert.equal(await reasonOf(request({ requestId: "h4", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-json") })), "not_granted");
  state.grants.delete(`${CALLER} ${OWNER} ${brokerAddressKey(pin)}`);
  state.grants.set(`${CALLER} ${OWNER} *`, brokerAllGrantMarker(SOURCE));
  assert.equal(await reasonOf(request({ requestId: "h5", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-json") })), "not_granted");
  // A marker for another source (the owner switched repositories) covers nothing.
  state.grants.set(`${CALLER} ${OWNER} ${brokerAddressKey(pin)}`, pin);
  state.grants.set(`${CALLER} ${OWNER} *`, brokerAllGrantMarker("https://github.com/someone-else/accounts.git"));
  assert.equal(await reasonOf(request({ requestId: "h6", ref: `${OWNER}:glm-1`, path: "/chat/completions", body: chat("m-json") })), "not_granted");
  assert.deepEqual((await broker.ownerAccounts(OWNER)).allGrants, [{ caller: CALLER, state: "changed" }]);
  assert.notEqual(brokerAddressPin(SOURCE, offerFor(HTTPS)), brokerAddressPin("https://github.com/someone-else/accounts.git", offerFor(HTTPS)));
});

test("all-accounts grant in the registry: only * and *.<16 hex> keys; withdrawing * removes its addresses; it goes with the caller's trust", async (t) => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-broker-all-"));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const packages = {
    [`https://github.com/example/${OWNER}`]: () => ({ manifest: ownerManifest(), files: { "services/accounts.mjs": "// owner\n" } }),
    [`https://github.com/example/${CALLER}`]: () => ({ manifest: callerManifest(), files: { "services/router.mjs": "// caller\n" } })
  };
  let manager = await managerWith(userData, packages);
  t.after(() => manager.dispose());
  await install(manager, OWNER);
  await install(manager, CALLER);
  await manager.setNativeCodeTrusted(OWNER, true);
  await manager.setNativeCodeTrusted(CALLER, true);
  for (const bad of ["**", "*.", "*.abc", `*.${"g".repeat(16)}`, `*.${"a".repeat(17)}`, "*x"]) {
    await assert.rejects(manager.setBrokerGrant(CALLER, OWNER, bad, FP), /invalid/u, bad);
  }
  const pinKey = `*.${"b".repeat(16)}`;
  await manager.setBrokerGrant(CALLER, OWNER, pinKey, "b".repeat(64));
  await manager.setBrokerGrant(CALLER, OWNER, "*", FP);
  await manager.setBrokerGrant(CALLER, OWNER, "glm-1", "c".repeat(64));
  await manager.dispose();
  manager = await managerWith(userData, packages);
  assert.equal(manager.brokerGrant(CALLER, OWNER, "*"), FP, "kept over a restart");
  assert.equal(manager.brokerGrant(CALLER, OWNER, pinKey), "b".repeat(64));
  await manager.setBrokerGrant(CALLER, OWNER, "*", null);
  assert.equal(manager.brokerGrant(CALLER, OWNER, "*"), undefined);
  assert.equal(manager.brokerGrant(CALLER, OWNER, pinKey), undefined, "its addresses go with it");
  assert.equal(manager.brokerGrant(CALLER, OWNER, "glm-1"), "c".repeat(64), "an account's own grant stays");
  await manager.setBrokerGrant(CALLER, OWNER, "*", FP);
  await manager.setNativeCodeTrusted(CALLER, false);
  assert.equal(manager.brokerGrant(CALLER, OWNER, "*"), undefined, "revoked with the caller's native code trust");
});
