import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { OrchestrationGateway } from "../src/main/services/agent-browser/OrchestrationGateway.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { ORCHESTRATION_BRIDGE_PROTOCOL_VERSION } from "../src/main/services/agent-browser/orchestration-protocol.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const writes = [];
// On Windows the gateway listens through the current-user pipe host that CI builds before the tests
// (npm run test:windows-pipe-host); elsewhere the option is ignored.
const WINDOWS_PIPE_HOST = join(process.cwd(), "build", "windows-agent-pipe-host", "canvastty-windows-agent-pipe-host.exe");

class TestClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.pending = new Map();
    this.notifications = [];
    this.socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let index;
      while ((index = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.length === 0) continue;
        const message = JSON.parse(line);
        if (message.type === "response") {
          const resolve = this.pending.get(message.id);
          if (resolve) {
            this.pending.delete(message.id);
            resolve(message);
          }
        } else if (message.type === "authenticated") {
          const resolve = this.pending.get("authenticated");
          if (resolve) {
            this.pending.delete("authenticated");
            resolve(message);
          }
        } else {
          this.notifications.push(message);
        }
      }
    });
  }

  static async connectTo(address) {
    const socket = connect(address);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new TestClient(socket);
  }

  send(message) {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-orchestration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls, { onWrite: (data) => writes.push(data) }));
  const control = new AgentControlService(terminals);
  const gateway = new OrchestrationGateway({
    runtimeDirectory: join(directory, "runtime"),
    handler: new ScopedOrchestrationHandler(control),
    windowsHostPath: WINDOWS_PIPE_HOST
  });
  await gateway.start();
  t.after(() => gateway.stop());
  return { calls, terminals, control, gateway };
}

function line(client, message) {
  return new Promise((resolve, reject) => {
    const key = message.type === "authenticate" ? "authenticated" : message.id;
    client.pending.set(key, resolve);
    setTimeout(() => reject(new Error(`Timed out waiting for ${key}`)), 5_000);
    client.send(message);
  });
}

async function authExpectingFailure(client, capability, token) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for auth failure")), 5_000);
    const poll = setInterval(() => {
      const notification = client.notifications.find((item) => item.type === "error");
      if (notification) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(notification);
      }
    }, 20);
    setTimeout(() => clearInterval(poll), 5_000);
    client.socket.once("close", () => {
      clearInterval(poll);
      clearTimeout(timer);
      const notification = client.notifications.find((item) => item.type === "error");
      if (notification) resolve(notification);
      else reject(new Error("connection closed without an error notification"));
    });
    client.send({
      v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
      type: "authenticate",
      connectionId: capability.connectionId,
      terminalSessionId: capability.terminalSessionId,
      capabilityToken: token
    });
  });
}

async function authenticatedClient(gateway, capability) {
  const client = await TestClient.connectTo(gateway.address);
  const ack = await line(client, {
    v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
    type: "authenticate",
    connectionId: capability.connectionId,
    terminalSessionId: capability.terminalSessionId,
    capabilityToken: capability.capabilityToken
  });
  assert.equal(ack.type, "authenticated");
  return { client, reconnectToken: ack.reconnectToken };
}

test("spawn_agent over the socket creates a scoped subagent and delivers its prompt", async (t) => {
  const { terminals, gateway } = await fixture(t);
  const orchestrator = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 },
    role: "orchestrator"
  });
  const capability = gateway.registerOrchestrator({ terminalSessionId: orchestrator.id });
  const { client } = await authenticatedClient(gateway, capability);

  const spawned = await line(client, {
    v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
    type: "request",
    id: "spawn-1",
    tool: "spawn_agent",
    arguments: { provider: "cursor", cwd: process.cwd(), prompt: "Fix the Button test", title: "UI worker" }
  });
  assert.equal(spawned.type, "response");
  assert.equal(spawned.result.provider, "cursor");
  assert.equal(spawned.result.title, "UI worker");

  const child = terminals.list().find((session) => session.id === spawned.result.sessionId);
  assert.equal(child.role, "subagent");
  assert.equal(child.parentSessionId, orchestrator.id);
  assert.match(writes.join(""), /Fix the Button test\r/u);

  const listed = await line(client, {
    v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
    type: "request",
    id: "list-1",
    tool: "list_agents",
    arguments: {}
  });
  assert.deepEqual(
    listed.result.agents.map((agent) => agent.sessionId),
    [spawned.result.sessionId]
  );
  client.socket.destroy();
  terminals.disposeAll();
});

test("foreign session ids are protocol errors, not filtered results", async (t) => {
  const { terminals, gateway } = await fixture(t);
  const orchestrator = terminals.create({
    provider: "claude",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 },
    role: "orchestrator"
  });
  const stranger = terminals.create({
    provider: "claude",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 900, y: 900 }
  });
  const capability = gateway.registerOrchestrator({ terminalSessionId: orchestrator.id });
  const { client } = await authenticatedClient(gateway, capability);

  const response = await line(client, {
    v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
    type: "request",
    id: "observe-1",
    tool: "observe_agent",
    arguments: { sessionId: stranger.id }
  });
  assert.equal(response.error.code, "INVALID_REQUEST");
  assert.match(response.error.message, /subtree/u);
  client.socket.destroy();
  terminals.disposeAll();
});

test("unauthenticated commands and replayed bootstrap tokens are rejected", async (t) => {
  const { terminals, gateway } = await fixture(t);
  const orchestrator = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 },
    role: "orchestrator"
  });
  const capability = gateway.registerOrchestrator({ terminalSessionId: orchestrator.id });

  const eager = await TestClient.connectTo(gateway.address);
  const rejected = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 5_000);
    const poll = setInterval(() => {
      const notification = eager.notifications.find((item) => item.type === "error");
      if (notification) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(notification);
      }
    }, 20);
    setTimeout(() => clearInterval(poll), 5_000);
    eager.send({
      v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
      type: "request",
      id: "list-1",
      tool: "list_agents",
      arguments: {}
    });
  });
  assert.equal(rejected.error.code, "AUTH_INVALID");
  eager.socket.destroy();

  const { client, reconnectToken } = await authenticatedClient(gateway, capability);
  client.socket.destroy();

  // The one-use bootstrap token cannot authenticate a second connection...
  const replay = await TestClient.connectTo(gateway.address);
  const replayFailure = await authExpectingFailure(replay, capability, capability.capabilityToken);
  assert.equal(replayFailure.error.code, "AUTH_INVALID");
  replay.socket.destroy();

  // ...but the rotated reconnect token can (helper restarts).
  const rejoined = await TestClient.connectTo(gateway.address);
  const rejoinAck = await line(rejoined, {
    v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
    type: "authenticate",
    connectionId: capability.connectionId,
    terminalSessionId: capability.terminalSessionId,
    capabilityToken: reconnectToken
  });
  assert.equal(rejoinAck.type, "authenticated");
  rejoined.socket.destroy();
  terminals.disposeAll();
});

test("revoking the orchestrator session ends its connection and capability", async (t) => {
  const { terminals, gateway } = await fixture(t);
  const orchestrator = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 },
    role: "orchestrator"
  });
  const capability = gateway.registerOrchestrator({ terminalSessionId: orchestrator.id });
  const { client } = await authenticatedClient(gateway, capability);

  const closed = new Promise((resolve) => client.socket.once("close", resolve));
  gateway.revokeTerminalSession(orchestrator.id);
  await closed;

  // The lease is gone: even the not-yet-used bootstrap token is dead now.
  const revival = await TestClient.connectTo(gateway.address);
  const revivalFailure = await authExpectingFailure(revival, capability, capability.capabilityToken);
  assert.equal(revivalFailure.error.code, "AUTH_INVALID");
  revival.socket.destroy();
  terminals.disposeAll();
});

test("unknown tools and invalid arguments never reach the handler", async (t) => {
  const { terminals, gateway } = await fixture(t);
  const orchestrator = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 },
    role: "orchestrator"
  });
  const capability = gateway.registerOrchestrator({ terminalSessionId: orchestrator.id });
  const { client } = await authenticatedClient(gateway, capability);

  // Invalid arguments are a protocol error: the gateway answers with an error
  // notification and closes the connection instead of returning a response.
  const failure = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 5_000);
    const onNotification = () => {
      const notification = client.notifications.find((item) => item.type === "error");
      if (!notification) return;
      clearTimeout(timer);
      client.socket.off("close", onNotification);
      resolve(notification);
    };
    client.socket.once("close", onNotification);
    const poll = setInterval(() => {
      const notification = client.notifications.find((item) => item.type === "error");
      if (notification) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(notification);
      }
    }, 20);
    setTimeout(() => clearInterval(poll), 5_000);
    client.socket.write(`${JSON.stringify({
      v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
      type: "request",
      id: "bad-1",
      tool: "spawn_agent",
      arguments: { provider: "cursor" }
    })}\n`);
  });
  assert.equal(failure.error.code, "INVALID_REQUEST");
  assert.match(failure.error.message, /cwd/u);
  terminals.disposeAll();
});

test("cancel reaches the running command and the answer is CANCELED, not the late result", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-orchestration-cancel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let signal = null;
  let finish;
  const gateway = new OrchestrationGateway({
    runtimeDirectory: join(directory, "runtime"),
    handler: {
      execute: (_sessionId, _request, abortSignal) => {
        signal = abortSignal ?? null;
        return new Promise((resolve) => { finish = resolve; });
      }
    },
    windowsHostPath: WINDOWS_PIPE_HOST
  });
  await gateway.start();
  t.after(() => gateway.stop());
  const capability = gateway.registerOrchestrator({ terminalSessionId: "orchestrator-1" });
  const { client } = await authenticatedClient(gateway, capability);
  t.after(() => client.socket.destroy());

  const answer = line(client, { v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION, type: "request", id: "slow-1", tool: "list_agents", arguments: {} });
  for (let i = 0; i < 100 && !finish; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  client.send({ v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION, type: "cancel", id: "slow-1" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  finish({ agents: [] });
  const response = await answer;
  assert.equal(signal?.aborted, true, "the handler received the abort signal");
  assert.equal(response.error?.code, "CANCELED");
});

test("a spawn_agent canceled while it was starting closes the agent it created", async () => {
  const controller = new AbortController();
  const canceled = [];
  const control = {
    status: () => ({ role: "orchestrator", provider: "codex" }),
    profileFor: () => ({ profile: "normal", inherited: true }),
    spawn: async () => {
      controller.abort();
      return { id: "child-1", provider: "codex", status: "running", title: "worker" };
    },
    cancel: (id) => canceled.push(id)
  };
  const handler = new ScopedOrchestrationHandler(control);
  await assert.rejects(
    handler.execute("orchestrator-1", { id: "spawn-1", tool: "spawn_agent", arguments: { provider: "codex", cwd: process.cwd() } }, controller.signal),
    (error) => error.bridgeError?.code === "CANCELED" || error.code === "CANCELED"
  );
  assert.deepEqual(canceled, ["child-1"]);
  const late = new AbortController();
  late.abort();
  await assert.rejects(handler.execute("orchestrator-1", { id: "spawn-2", tool: "spawn_agent", arguments: {} }, late.signal));
  assert.deepEqual(canceled, ["child-1"], "nothing is spawned after cancel");
});

test("start and stop in flight: a second start waits for the first, and a stop during start leaves nothing listening", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-orchestration-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gateway = new OrchestrationGateway({
    runtimeDirectory: join(directory, "runtime"), handler: { execute: async () => ({}) }, windowsHostPath: WINDOWS_PIPE_HOST
  });
  await Promise.all([gateway.start(), gateway.start()]);
  const first = gateway.address;
  assert.ok(first);
  await gateway.stop();

  const starting = gateway.start();
  const stopping = gateway.stop();
  await Promise.all([starting, stopping]);
  assert.equal(gateway.address, null);
  assert.throws(() => gateway.registerOrchestrator({ terminalSessionId: "late" }), /not running/u);
  // It starts again normally afterwards.
  await gateway.start();
  const client = await TestClient.connectTo(gateway.address);
  client.socket.destroy();
  await gateway.stop();
});

test("a send_to_agent canceled while its text waited delivers nothing and answers CANCELED", async () => {
  const controller = new AbortController();
  let received = null;
  const control = {
    status: (id) => id === "orchestrator-1" ? { role: "orchestrator", provider: "codex" } : { id, parentSessionId: "orchestrator-1", provider: "codex" },
    send: async (_id, _text, _submit, signal) => {
      received = signal;
      controller.abort();
      throw new Error("The text for agent child-1 was not delivered: The delivery was cancelled.");
    }
  };
  const handler = new ScopedOrchestrationHandler(control);
  handler.requireOwned = () => undefined;
  await assert.rejects(
    handler.execute("orchestrator-1", { id: "send-1", tool: "send_to_agent", arguments: { sessionId: "child-1", prompt: "hi" } }, controller.signal),
    (error) => error.bridgeError?.code === "CANCELED" || error.code === "CANCELED"
  );
  assert.equal(received, controller.signal, "the signal reaches the delivery");
});

test("deliverInput with a cancelled signal writes nothing to the card", async () => {
  const written = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner([], { onWrite: (data) => written.push(data) }));
  const card = terminals.create({ provider: "codex", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 } });
  const before = written.length;
  const controller = new AbortController();
  controller.abort();
  const delivery = await terminals.deliverInput(card.id, "hello\r", undefined, controller.signal);
  assert.equal(delivery.delivered, false);
  assert.match(delivery.reason, /cancelled/u);
  assert.equal(written.length, before);
  assert.equal((await terminals.deliverInput(card.id, "hello\r")).delivered, true);
  terminals.disposeAll();
});
