/**
 * Contract parity of the two stdio MCP helpers: mcp-helper.mjs and orchestration-helper.mjs against
 * `canvastty-helper mcp-browser` and `canvastty-helper mcp-orchestration`. Each scenario drives both implementations
 * with the same MCP lines and the same scripted gateway; their MCP answers (compared per request id), exit status and
 * every line the gateway received (heartbeat timestamps and random ids masked) must be equal. The real AgentGateway
 * and OrchestrationGateway must work with both. No agent CLI runs; HOME is the runner's fake one.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentGateway } from "../src/main/services/agent-browser/AgentGateway.ts";
import { AGENT_BROWSER_ENV } from "../src/main/services/agent-browser/protocol.ts";
import { OrchestrationBridge } from "../src/main/services/agent-browser/OrchestrationBridge.ts";
import { OrchestrationGateway } from "../src/main/services/agent-browser/OrchestrationGateway.ts";
import {
  IMPLEMENTATIONS, SKIP_NATIVE, baseEnvironment, delay, lineServer, outputHasId, root, startMcp
} from "./native-helper-harness.mjs";

const OPTIONS = { skip: SKIP_NATIVE, timeout: 60_000 };

const browserEnvironment = (address, extra = {}) => baseEnvironment({
  [AGENT_BROWSER_ENV.address]: address,
  [AGENT_BROWSER_ENV.agentId]: "agent-1",
  [AGENT_BROWSER_ENV.connectionId]: "connection-1",
  [AGENT_BROWSER_ENV.terminalSessionId]: "terminal-1",
  [AGENT_BROWSER_ENV.provider]: "codex",
  [AGENT_BROWSER_ENV.capabilityToken]: "bootstrap-capability",
  ...extra
});

const orchestrationEnvironment = (address, extra = {}) => baseEnvironment({
  CANVASTTY_ORCHESTRATION_ADDRESS: address,
  CANVASTTY_ORCHESTRATION_CAPABILITY: "bootstrap-capability",
  CANVASTTY_TERMINAL_SESSION_ID: "terminal-1",
  CANVASTTY_ORCHESTRATION_CONNECTION_ID: "connection-1",
  ...extra
});

const rpc = (id, method, params) => ({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) });
const call = (id, name, args) => rpc(id, "tools/call", { name, ...(args === undefined ? {} : { arguments: args }) });

/**
 * Heartbeats (their timestamp) are dropped and the orchestration helper's random request ids masked. The first line
 * (authenticate) stays first; the rest is sorted, since concurrent calls reach the gateway in either order.
 */
function normalizeReceived(lines) {
  const normalized = lines.flatMap((raw) => {
    let message;
    try { message = JSON.parse(raw); } catch { return [raw]; }
    if (message?.type === "heartbeat") return [];
    if (typeof message?.id === "string" && message.id.startsWith("helper-")) return [raw.replace(message.id, "helper-<id>")];
    return [raw];
  });
  return [...normalized.slice(0, 1), ...normalized.slice(1).sort()];
}

/** Waits for a sentinel ping, then until the helper has been quiet for a moment. */
async function settled(helper, id = "sentinel") {
  helper.send(rpc(id, "ping"));
  await helper.until(outputHasId(id), 10_000);
  let count = -1;
  while (count !== helper.output.length) {
    count = helper.output.length;
    await delay(300);
  }
}

/** Output lines keyed by id where they have one, sorted: concurrent answers may come in either order. */
const normalizeOutput = (lines) => [...lines].sort();

/**
 * Runs `script({ helper, gateway })` for every implementation, each against a fresh gateway made by `makeGateway`
 * (or none), and returns their transcripts.
 */
async function scenario(kind, { makeGateway, env = {}, script }) {
  const transcripts = [];
  for (const implementation of IMPLEMENTATIONS) {
    const gateway = makeGateway ? await makeGateway() : null;
    const address = gateway?.path ?? join(root, "no-gateway.sock");
    const environment = kind === "browser" ? browserEnvironment(address, env) : orchestrationEnvironment(address, env);
    const helper = startMcp(implementation[kind], environment);
    try {
      await script({ helper, gateway });
      helper.end();
      const exit = await Promise.race([helper.exited, delay(5_000).then(() => ({ code: "still running" }))]);
      transcripts.push({
        implementation: implementation.name,
        exit: exit.code,
        output: normalizeOutput(helper.output),
        received: gateway ? gateway.connections.map((connection) => normalizeReceived(connection.lines)) : []
      });
    } finally {
      helper.kill();
      await gateway?.close();
    }
  }
  const [reference, ...others] = transcripts;
  for (const other of others) {
    assert.deepEqual(
      { exit: other.exit, output: other.output, received: other.received },
      { exit: reference.exit, output: reference.output, received: reference.received },
      `${other.implementation} differs from ${reference.implementation}`
    );
  }
  return reference;
}

/** A browser gateway: answers authenticate, then each request by tool with `respond(connection, message)`. */
function browserGateway({ respond = () => undefined, onAuthenticate } = {}) {
  let rotations = 0;
  return () => lineServer((connection, message) => {
    if (message?.type === "authenticate") {
      if (onAuthenticate) return onAuthenticate(connection, message, rotations++);
      connection.send({ v: 1, type: "authenticated", reconnectToken: `rotated-${rotations++}`, heartbeatIntervalMs: 5_000, heartbeatExpiryMs: 15_000 });
      return;
    }
    if (message?.type === "request") respond(connection, message);
  });
}

const ok = (message, data) => ({ v: 1, type: "response", id: message.id, result: { ok: true, requestId: message.id, tabId: null, commandSequence: 1, revisionBefore: null, revisionAfter: null, data } });

test("browser MCP: handshake, tool list, forwarded calls, results and every refusal are identical", OPTIONS, async () => {
  const bigQuotes = "\"".repeat(200 * 1024);
  const reference = await scenario("browser", {
    makeGateway: browserGateway({
      respond(connection, message) {
        switch (message.tool) {
          case "browser_list_tabs": return connection.send(ok(message, { tabs: [{ id: "t1", title: "é😀" }] }));
          case "browser_screenshot": return connection.send(ok(message, { image: { mimeType: "image/png", data: "iVBORw0KGgo=", width: 1 } }));
          case "browser_read_page": return connection.send({ v: 1, type: "response", id: message.id, error: { code: "STALE_REF", message: "Observe again.", retryable: true } });
          case "browser_observe": return connection.send(ok(message, { artifact: { uri: "canvastty://a/1", size: 12, mimeType: "text/plain" }, elements: [] }));
          case "browser_navigate": return connection.send(`{"v":1,"type":"response","id":${JSON.stringify(message.id)},"result":{"ok":true,"data":{"n":1e400}}}\n`);
          case "browser_back": return connection.send({ v: 1, type: "response", id: message.id });
          case "browser_forward": return connection.send({ v: 1, type: "response", id: message.id, result: { ok: false, error: "x" } });
          case "browser_reload": return connection.send(ok(message, { text: bigQuotes }));
          case "browser_new_tab": return connection.send(ok(message, { mimeType: "image/webp", base64: "UklGR", data: 5 }));
          default: return connection.send(ok(message, { echoed: message.arguments }));
        }
      }
    }),
    async script({ helper }) {
      helper.send(rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
      await helper.until(outputHasId(1));
      helper.send(rpc(undefined, "notifications/initialized"));
      const lines = [
        rpc(2, "tools/list"),
        rpc(3, "ping"),
        call(4, "browser_list_tabs", {}),
        call(5, "browser_screenshot", { tabId: "t1" }),
        call(6, "browser_read_page", { tabId: "t1", limit: 5 }),
        call(7, "browser_observe", {}),
        call(8, "browser_navigate", { url: "https://example.com" }),
        call(9, "browser_back", { tabId: "t1" }),
        call(10, "browser_forward", { tabId: "t1" }),
        call(11, "browser_reload", { tabId: "t1" }),
        call(12, "browser_new_tab", {}),
        call("s-13", "browser_click", { ref: { ref: "e1", tabId: "t", frameId: "f", documentRevision: 1, backendNodeId: 2 } }),
        call(14, "browser_click", {}),
        call(15, "browser_click", { ref: 5 }),
        call(16, "browser_select", { ref: "e", values: [] }),
        call(17, "browser_select", { ref: "e", values: ["a", 1] }),
        call(18, "browser_scroll", { deltaX: 1e9 }),
        call(19, "browser_scroll", { direction: "sideways" }),
        call(20, "browser_wait_for", { condition: "load", timeoutMs: 49 }),
        call(21, "browser_wait_for", { condition: "load", timeoutMs: 1.5 }),
        call(22, "browser_press", { key: "" }),
        call(23, "browser_list_tabs", { "10": 1, zeta: 2, alpha: 3 }),
        call(24, "browser_nope", {}),
        call(25, `browser_${"x".repeat(100)}😀`, {}),
        call(26, "browser_type", { ref: "e", text: "😀".repeat(40_000) }),
        call(27, "browser_handle_dialog", { accept: "yes" }),
        call(28, "browser_list_tabs", []),
        call(29, "browser_list_tabs", null),
        call(30, "browser_list_tabs"),
        rpc(31, "tools/call", { arguments: {} }),
        rpc(32, "tools/call", "not params"),
        rpc(undefined, "tools/call", { name: "browser_list_tabs", arguments: {} }),
        rpc(33, "resources/list"),
        rpc(undefined, "notifications/unknown"),
        { jsonrpc: "1.0", id: 34, method: "ping" },
        { jsonrpc: "2.0", id: 35 },
        rpc({ b: 1, a: [2] }, "ping"),
        rpc(null, "ping"),
        rpc(36.5, "ping"),
        call(37, "browser_upload", { ref: "e", paths: ["/tmp/a", "/tmp/b"] })
      ];
      for (const line of lines) helper.send(line);
      helper.send("garbage\n");
      helper.send("5\n");
      helper.send("[]\n");
      helper.send("\n");
      helper.send('{"jsonrpc":"2.0","id":38,"method":"ping"}\r\n');
      await settled(helper);
    }
  });
  assert.ok(reference.output.some((line) => line.includes('"type":"image"')), "the screenshot came back as image content");
  assert.ok(reference.received[0].some((line) => line.includes('"type":"authenticate"') && line.includes("bootstrap-capability")));
});

test("browser MCP: cancellation, an unreachable gateway, a refusing gateway and broken gateway lines", OPTIONS, async () => {
  // A call the gateway holds, cancelled by the MCP client: CANCELED, and the gateway gets a cancel.
  const cancelled = await scenario("browser", {
    makeGateway: browserGateway(),
    async script({ helper, gateway }) {
      helper.send(rpc(1, "initialize", {}));
      await helper.until(outputHasId(1));
      helper.send(call(2, "browser_wait_for", { condition: "load", timeoutMs: 60_000 }));
      while (!gateway.connections[0].lines.some((line) => line.includes('"type":"request"'))) await delay(10);
      helper.send(rpc(undefined, "notifications/cancelled", { requestId: 2, reason: "user" }));
      helper.send(rpc(undefined, "notifications/cancelled", { requestId: 99 }));
      await helper.until(outputHasId(2));
      while (!gateway.connections[0].lines.some((line) => line.includes('"type":"cancel"'))) await delay(10);
    }
  });
  assert.match(cancelled.output.find((line) => line.includes('"id":2')), /CANCELED/u);

  // A call the gateway never answers times out 5 s after its own timeoutMs.
  const timedOut = await scenario("browser", {
    makeGateway: browserGateway(),
    async script({ helper }) {
      helper.send(rpc(1, "initialize", {}));
      await helper.until(outputHasId(1));
      const started = Date.now();
      helper.send(call(2, "browser_download_wait", { timeoutMs: 50 }));
      await helper.until(outputHasId(2), 8_000);
      assert.ok(Date.now() - started >= 4_900, "waited timeoutMs + 5 s");
    }
  });
  assert.match(timedOut.output.find((line) => line.includes('"id":2')), /TIMEOUT/u);

  // No gateway: initialize waits (reconnecting) until stdin closes, then fails; other methods answer meanwhile.
  const unreachable = await scenario("browser", {
    async script({ helper }) {
      helper.send(rpc(1, "initialize", {}));
      helper.send(rpc(2, "ping"));
      helper.send(rpc(3, "tools/list"));
      await helper.until((output) => output.length >= 2);
      await delay(400);
    }
  });
  assert.match(unreachable.output.find((line) => line.includes('"id":1')), /BRIDGE_UNAVAILABLE/u);

  // A non-retryable gateway error closes the client: initialize fails with its reason, later calls are unavailable.
  await scenario("browser", {
    makeGateway: browserGateway({
      onAuthenticate: (connection) => connection.send({ v: 1, type: "error", error: { code: "AUTH_REPLAYED", message: "Agent browser capability was already used.", retryable: false } })
    }),
    async script({ helper }) {
      helper.send(rpc(1, "initialize", {}));
      await helper.until(outputHasId(1));
      helper.send(call(2, "browser_list_tabs", {}));
      await helper.until(outputHasId(2));
    }
  });

  // Broken gateway lines: an oversized line, invalid JSON, a protocol mismatch, a bad authentication state.
  const broken = {
    "oversized line": (connection) => connection.send(`${"x".repeat(600 * 1024)}\n`),
    "invalid JSON": (connection) => connection.send("garbage\n"),
    "protocol mismatch": (connection) => connection.send({ v: 2, type: "authenticated", reconnectToken: "r" }),
    "null line": (connection) => connection.send("null\n"),
    "bad authentication state": (connection) => connection.send({ v: 1, type: "authenticated", reconnectToken: "r".repeat(129) })
  };
  for (const [label, onAuthenticate] of Object.entries(broken)) {
    await scenario("browser", {
      makeGateway: browserGateway({ onAuthenticate }),
      async script({ helper }) {
        helper.send(rpc(1, "initialize", {}));
        await helper.until(outputHasId(1));
        helper.send(call(2, "browser_list_tabs", {}));
        await helper.until(outputHasId(2));
      }
    }).catch((error) => { throw new Error(`${label}: ${error.message}`); });
  }

  // After authentication, a broken response fails the pending call with the same typed error.
  for (const [label, reply] of Object.entries({
    "oversized response": `${"y".repeat(520 * 1024)}\n`,
    "invalid JSON response": "{\n"
  })) {
    await scenario("browser", {
      makeGateway: browserGateway({ respond: (connection) => connection.send(reply) }),
      async script({ helper }) {
        helper.send(rpc(1, "initialize", {}));
        await helper.until(outputHasId(1));
        helper.send(call(2, "browser_list_tabs", {}));
        await helper.until(outputHasId(2));
      }
    }).catch((error) => { throw new Error(`${label}: ${error.message}`); });
  }
});

test("browser MCP: a dropped connection reconnects with the rotated token and resends the pending call", OPTIONS, async () => {
  const reference = await scenario("browser", {
    makeGateway: () => lineServer((connection, message) => {
      if (message?.type === "authenticate") {
        connection.send({ v: 1, type: "authenticated", reconnectToken: `rotated-${connection.index}`, heartbeatIntervalMs: 1_000 });
        return;
      }
      if (message?.type !== "request") return;
      // The first connection drops the call; the next one answers it.
      if (connection.index === 0) connection.socket.destroy();
      else connection.send(ok(message, { tabs: [] }));
    }),
    async script({ helper, gateway }) {
      helper.send(rpc(1, "initialize", {}));
      await helper.until(outputHasId(1));
      helper.send(call(2, "browser_list_tabs", {}));
      await helper.until(outputHasId(2));
      assert.equal(gateway.connections.length, 2);
    }
  });
  assert.match(reference.received[1][0], /"capabilityToken":"rotated-0"/u);
});

test("browser MCP: oversized lines both ways, and a null request line ends the helper as before", OPTIONS, async () => {
  await scenario("browser", {
    makeGateway: browserGateway({ respond: (connection, message) => connection.send(ok(message, { text: "\"".repeat(200 * 1024) })) }),
    async script({ helper }) {
      helper.send(`${JSON.stringify(rpc(1, "ping")).slice(0, -1)},"pad":"${"p".repeat(600 * 1024)}"}\n`);
      helper.send(rpc(2, "ping"));
      await helper.until(outputHasId(2));
      helper.send(rpc(3, "initialize", {}));
      await helper.until(outputHasId(3));
      helper.send(call(4, "browser_reload", { tabId: "t" }));
      await helper.until(outputHasId(4));
    }
  });
  const crashed = await scenario("browser", {
    async script({ helper }) {
      helper.send(rpc(1, "ping"));
      helper.send("null\n");
      await helper.exited;
    }
  });
  assert.equal(crashed.exit, 1);
});

test("browser MCP: the real AgentGateway serves both implementations", OPTIONS, async (t) => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "canvastty-native-browser-"));
  t.after(() => rm(runtimeDirectory, { recursive: true, force: true }));
  const executed = [];
  const gateway = new AgentGateway({
    execute: async (_actor, command) => {
      executed.push(command.type ?? command.tool ?? "command");
      return { ok: true, requestId: command.requestId, tabId: null, commandSequence: executed.length, revisionBefore: null, revisionAfter: null, data: { tabs: [] } };
    },
    subscribe: () => () => undefined
  }, { runtimeDirectory });
  await gateway.start();
  t.after(() => gateway.close());
  const answers = [];
  for (const implementation of IMPLEMENTATIONS) {
    const capability = gateway.registerAgent({ terminalSessionId: `real-${implementation.name}`, provider: "codex", cwd: root });
    const helper = startMcp(implementation.browser, baseEnvironment({
      [AGENT_BROWSER_ENV.address]: capability.address,
      [AGENT_BROWSER_ENV.agentId]: capability.agentId,
      [AGENT_BROWSER_ENV.connectionId]: capability.connectionId,
      [AGENT_BROWSER_ENV.terminalSessionId]: capability.terminalSessionId,
      [AGENT_BROWSER_ENV.provider]: capability.provider,
      [AGENT_BROWSER_ENV.capabilityToken]: capability.capabilityToken
    }));
    t.after(() => helper.kill());
    helper.send(rpc(1, "initialize", {}));
    await helper.until(outputHasId(1));
    helper.send(call(2, "browser_list_tabs", {}));
    await helper.until(outputHasId(2));
    answers.push(helper.output.map((line) => JSON.parse(line)));
    helper.end();
    await helper.exited;
  }
  assert.equal(answers[0][0].result.serverInfo.name, "canvastty_browser");
  assert.equal(answers[0][1].result.isError, false, answers[0][1].result.content[0].text);
  // The command sequence differs per connection; everything else is equal.
  const withoutSequence = (answer) => JSON.stringify(answer).replace(/\\"commandSequence\\":\d+/gu, "");
  assert.equal(withoutSequence(answers[1]), withoutSequence(answers[0]));
  assert.equal(executed.length, 2);
});

// ---- orchestration ----

function orchestrationGateway({ onAuthenticate, respond = () => undefined, listTools } = {}) {
  return () => lineServer((connection, message) => {
    if (message?.type === "authenticate") {
      if (onAuthenticate) return onAuthenticate(connection, message);
      connection.send({ v: 1, type: "authenticated", reconnectToken: `rotated-${connection.index}`, heartbeatIntervalMs: 5_000 });
      return;
    }
    if (message?.type === "list_tools") return listTools?.(connection, message);
    if (message?.type === "request") respond(connection, message);
  });
}

test("orchestration MCP: validation, plugin tools, gateway answers and failures are identical", OPTIONS, async () => {
  await scenario("orchestration", {
    makeGateway: orchestrationGateway({
      listTools: (connection, message) => connection.send({ v: 1, type: "response", id: message.id, result: { tools: [{ name: "p-one__run", description: "d", inputSchema: { type: "object" } }] } }),
      respond(connection, message) {
        const reply = (value) => connection.send({ v: 1, type: "response", id: message.id, ...value });
        switch (message.tool) {
          case "list_agents": return reply({ result: { agents: [{ id: "a", title: "é😀" }] } });
          case "p-one__run": return reply({ result: { text: "plugin says hi", isError: true } });
          case "p-one__raw": return reply({ result: { text: 5 } });
          case "observe_agent": return reply({ error: { code: "NOT_FOUND", message: "No such agent.", retryable: false } });
          case "get_agent_result": return reply({ error: "just text" });
          case "cancel_agent": return reply({});
          case "send_to_agent": return connection.send(`{"v":1,"type":"response","id":${JSON.stringify(message.id)},"result":{"n":1e400}}\n`);
          default: return reply({ result: { echoed: message.arguments } });
        }
      }
    }),
    async script({ helper }) {
      helper.send(rpc(1, "initialize", {}));
      await helper.until(outputHasId(1));
      const lines = [
        rpc(2, "tools/list"),
        call(3, "list_agents", {}),
        call(4, "p-one__run", { x: 1 }),
        call(5, "p-one__raw"),
        call(6, "observe_agent", { sessionId: "s" }),
        call(7, "get_agent_result", { sessionId: "s" }),
        call(8, "cancel_agent", {}),
        call(9, "send_to_agent", { sessionId: "s", prompt: "p" }),
        call(10, "spawn_agent", { provider: "nope😀".padEnd(40, "x"), cwd: "" }),
        call(11, "spawn_agent", {}),
        call(12, "spawn_agent", { provider: "codex", cwd: "/w", profile: "yolo", effort: "max", model: "", title: "t".repeat(81), launchOptions: { a: { b: 1 } } }),
        call(13, "spawn_agent", { provider: "codex", cwd: "/w", launchOptions: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, {}])) }),
        call(14, "spawn_agent", { provider: "codex", cwd: "/w", launchOptions: { p: { v: "x".repeat(17_000) } } }),
        call(15, "spawn_agent", { provider: "claude", cwd: "/w", prompt: "go", launchOptions: { p: { account: "a", on: true } } }),
        call(16, "wait_for_agent", { sessionId: "s", timeoutSeconds: 601 }),
        call(17, "wait_for_agent", { sessionId: "s", timeoutSeconds: 1.5 }),
        call(18, "observe_agent", { sessionId: 5, maxChars: 10, "10": 1, zz: 2 }),
        call(19, "send_to_agent", { sessionId: "s", prompt: "p", submit: "yes" }),
        call(20, "list_agents", []),
        call(21, "unknown_tool", {}),
        call(22, "Bad__Name", {}),
        rpc(23, "tools/call", {}),
        rpc(24, "ping"),
        rpc(25, "nope"),
        { jsonrpc: "2.0", id: 26 }
      ];
      for (const line of lines) helper.send(line);
      helper.send("garbage\n");
      helper.send(`${JSON.stringify(rpc(27, "ping")).slice(0, -1)},"pad":"${"p".repeat(130 * 1024)}"}\n`);
      helper.send(rpc(28, "ping"));
      await settled(helper);
    }
  });
});

test("orchestration MCP: an unreachable gateway, a failing tool list and a dropped connection", OPTIONS, async () => {
  await scenario("orchestration", {
    async script({ helper }) {
      helper.send(rpc(1, "initialize", {}));
      await helper.until(outputHasId(1));
      helper.send(rpc(2, "tools/list"));
      helper.send(call(3, "list_agents", {}));
      await helper.until((output) => output.length >= 3);
    }
  });
  await scenario("orchestration", {
    makeGateway: orchestrationGateway({
      listTools: (connection, message) => connection.send({ v: 1, type: "response", id: message.id, error: { code: "X", message: "no" } })
    }),
    async script({ helper }) {
      helper.send(rpc(1, "tools/list"));
      await helper.until(outputHasId(1));
    }
  });
  await scenario("orchestration", {
    makeGateway: orchestrationGateway({
      listTools: (connection, message) => connection.send({ v: 1, type: "response", id: message.id, result: { tools: "no" } })
    }),
    async script({ helper }) {
      helper.send(rpc(1, "tools/list"));
      await helper.until(outputHasId(1));
    }
  });
  const reconnected = await scenario("orchestration", {
    makeGateway: orchestrationGateway({
      respond(connection, message) {
        if (connection.index === 0) connection.socket.destroy();
        else connection.send({ v: 1, type: "response", id: message.id, result: { agents: [] } });
      }
    }),
    async script({ helper, gateway }) {
      helper.send(rpc(1, "initialize", {}));
      await helper.until(outputHasId(1));
      helper.send(call(2, "list_agents", {}));
      await helper.until(outputHasId(2));
      while (gateway.connections.length < 2 || gateway.connections[1].lines.length === 0) await delay(20);
      helper.send(call(3, "list_agents", {}));
      await helper.until(outputHasId(3));
    }
  });
  assert.match(reconnected.received[1][0], /"capabilityToken":"rotated-0"/u);
});

test("orchestration MCP: a gateway that is not up yet is retried, and a failed first connection is not final", OPTIONS, async () => {
  // Connections below `refuse` are dropped before authentication, like a gateway that is (re)starting.
  const flakyGateway = (refuse) => () => lineServer(
    (connection, message) => {
      if (message?.type === "authenticate") connection.send({ v: 1, type: "authenticated", reconnectToken: `rotated-${connection.index}`, heartbeatIntervalMs: 5_000 });
      if (message?.type === "request") connection.send({ v: 1, type: "response", id: message.id, result: { agents: [] } });
    },
    (connection) => {
      if (connection.index < refuse) connection.socket.destroy();
    }
  );
  // One dropped attempt: the same initialize still succeeds on a later attempt.
  const retried = await scenario("orchestration", {
    makeGateway: flakyGateway(1),
    async script({ helper }) {
      helper.send(rpc(1, "initialize", {}));
      await helper.until(outputHasId(1), 10_000);
      helper.send(call(2, "list_agents", {}));
      await helper.until(outputHasId(2), 10_000);
    }
  });
  assert.ok(retried.output.some((line) => line.includes('"id":1') && line.includes('"result"')), "initialize succeeded after a retry");
  assert.ok(retried.output.some((line) => line.includes('"id":2') && line.includes("agents")), "the call went through");
  // Every attempt of the first call is dropped: it fails, but the next call connects again instead of failing forever.
  const recovered = await scenario("orchestration", {
    makeGateway: flakyGateway(3),
    async script({ helper, gateway }) {
      helper.send(rpc(1, "initialize", {}));
      await helper.until(outputHasId(1), 10_000);
      assert.equal(gateway.connections.length, 3, "the first call tried a bounded number of times");
      helper.send(call(2, "list_agents", {}));
      await helper.until(outputHasId(2), 10_000);
    }
  });
  assert.ok(recovered.output.some((line) => line.includes('"id":1') && line.includes('"error"')), "the first initialize failed");
  assert.ok(recovered.output.some((line) => line.includes('"id":2') && line.includes("agents") && line.includes('"isError":false')), "a later call reconnected");
});

test("orchestration MCP: the real OrchestrationGateway serves both implementations", OPTIONS, async (t) => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "canvastty-native-orch-"));
  t.after(() => rm(runtimeDirectory, { recursive: true, force: true }));
  const calls = [];
  const gateway = new OrchestrationGateway({
    runtimeDirectory: join(runtimeDirectory, "runtime"),
    handler: {
      async execute(sessionId, request) {
        calls.push({ sessionId, tool: request.tool });
        return { agents: [] };
      }
    }
  });
  await gateway.start();
  t.after(() => gateway.stop());
  const answers = [];
  for (const implementation of IMPLEMENTATIONS) {
    const launch = new OrchestrationBridge(gateway).prepareLaunch({ terminalSessionId: "orchestrator-1" });
    t.after(() => launch.cleanup());
    const helper = startMcp(implementation.orchestration, baseEnvironment(launch.environment));
    t.after(() => helper.kill());
    helper.send(rpc(1, "initialize", {}));
    await helper.until(outputHasId(1));
    helper.send(rpc(2, "tools/list"));
    helper.send(call(3, "list_agents", {}));
    await helper.until((output) => output.length >= 3);
    answers.push(normalizeOutput(helper.output));
    helper.end();
    await helper.exited;
  }
  assert.deepEqual(answers[1], answers[0]);
  assert.deepEqual(calls, [{ sessionId: "orchestrator-1", tool: "list_agents" }, { sessionId: "orchestrator-1", tool: "list_agents" }]);
});
