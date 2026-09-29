import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { OrchestrationGateway } from "../src/main/services/agent-browser/OrchestrationGateway.ts";
import { OrchestrationBridge } from "../src/main/services/agent-browser/OrchestrationBridge.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-orch-role-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const browserInputs = [];
  const agentBrowser = {
    prepareLaunch(input) {
      browserInputs.push(input);
      return { agentId: "agent", connectionId: "conn", args: [], environment: {}, cleanup() {} };
    }
  };
  const terminals = new TerminalManager(() => undefined, availableRegistry(), agentBrowser, undefined, true, fakeSpawner(calls));
  const gateway = new OrchestrationGateway({
    runtimeDirectory: join(directory, "runtime"),
    windowsHostPath: join(process.cwd(), "build", "windows-agent-pipe-host", "canvastty-windows-agent-pipe-host.exe"),
    handler: new ScopedOrchestrationHandler(new AgentControlService(terminals))
  });
  await gateway.start();
  t.after(() => gateway.stop());
  terminals.configureOrchestration(new OrchestrationBridge(gateway));
  return { calls, browserInputs, terminals, gateway };
}

test("only orchestrator sessions receive the orchestration capability environment", async (t) => {
  const { calls, browserInputs, terminals } = await fixture(t);

  const orchestrator = terminals.create({
    provider: "claude",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 },
    role: "orchestrator"
  });
  const interactive = terminals.create({
    provider: "claude",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 400, y: 400 }
  });

  // Spawn order matches creation order: orchestrator first, interactive second.
  const orchestratorEnv = calls[0]?.options?.env;
  assert.ok(orchestratorEnv, "orchestrator session spawned");
  assert.ok(orchestratorEnv.CANVASTTY_ORCHESTRATION_ADDRESS);
  assert.ok(orchestratorEnv.CANVASTTY_ORCHESTRATION_CAPABILITY);
  // The helper authenticates with the connection id the capability was issued for.
  assert.ok(orchestratorEnv.CANVASTTY_ORCHESTRATION_CONNECTION_ID);

  const interactiveEnv = calls[1]?.options?.env;
  assert.ok(interactiveEnv, "interactive session spawned");
  assert.equal("CANVASTTY_ORCHESTRATION_ADDRESS" in interactiveEnv, false);

  assert.deepEqual(
    browserInputs.map((input) => input.includeOrchestration === true),
    [true, false]
  );
  terminals.disposeAll();
});

test("disposing an orchestrator session revokes its capability", async (t) => {
  const { terminals, gateway } = await fixture(t);
  const orchestrator = terminals.create({
    provider: "claude",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 },
    role: "orchestrator"
  });
  terminals.dispose(orchestrator.id);
  // The session id is free again: a fresh registration succeeds.
  const capability = gateway.registerOrchestrator({ terminalSessionId: orchestrator.id });
  assert.ok(capability.capabilityToken);
  gateway.revokeTerminalSession(orchestrator.id);
});
