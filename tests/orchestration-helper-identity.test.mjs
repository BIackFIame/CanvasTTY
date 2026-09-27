/**
 * The real canvastty_agents helper must authenticate with the environment an orchestrator card gets. The gateway
 * issues each capability for one connection id and refuses any other, so the helper has to use that id instead of
 * making one up.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OrchestrationBridge } from "../src/main/services/agent-browser/OrchestrationBridge.ts";
import { OrchestrationGateway } from "../src/main/services/agent-browser/OrchestrationGateway.ts";

const HELPER = fileURLToPath(new URL("../src/agent-browser/orchestration-helper.mjs", import.meta.url));

function startHelper(environment) {
  const child = spawn(process.execPath, [HELPER], {
    env: { PATH: process.env.PATH, ...environment },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const waiting = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  const request = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No answer to ${method}.`)), 5_000);
    waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  });
  return { child, request };
}

test("the orchestration helper authenticates with the card's own capability and reaches the tools", async (t) => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "canvastty-orch-helper-"));
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

  const launch = new OrchestrationBridge(gateway).prepareLaunch({ terminalSessionId: "orchestrator-1" });
  assert.ok(launch, "the bridge is enabled");
  t.after(() => launch.cleanup());
  const { child, request } = startHelper(launch.environment);
  t.after(() => child.kill());

  const initialized = await request(1, "initialize", {});
  assert.equal(initialized.error, undefined, `initialize failed: ${JSON.stringify(initialized.error)}`);
  assert.equal(initialized.result.serverInfo.name, "canvastty_agents");

  const listed = await request(2, "tools/call", { name: "list_agents", arguments: {} });
  assert.equal(listed.result.isError, false, listed.result.content?.[0]?.text);
  assert.deepEqual(JSON.parse(listed.result.content[0].text), { agents: [] });
  assert.deepEqual(calls, [{ sessionId: "orchestrator-1", tool: "list_agents" }]);
});
