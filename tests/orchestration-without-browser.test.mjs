/**
 * canvastty_agents does not depend on browser access. An orchestrator (or a session a plugin tool applies to) gets
 * the orchestration MCP server whether "Agent access" to the browser is on or off; canvastty_browser and its
 * capability are there only while browser access is on. Every provider that takes the servers today (Claude Code,
 * Codex, Qwen Code, OpenCode, Hermes, Kimi per-run and shared) is checked in all four combinations, with the
 * JavaScript and the native helper launches. No agent CLI runs; the homes are temporary folders.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { AGENT_BROWSER_ENV, AgentBrowserBridge } from "../src/main/services/agent-browser/AgentBrowserBridge.ts";

const providerClis = Object.freeze({
  get: (provider) => ({ state: "available", provider, executable: `/resolved/${provider}`, launcher: "native", environment: {}, checked: [] }),
  snapshot() { throw new Error("not needed"); }
});

const HELPER_FORMS = {
  node: {
    helper: { command: "/app/CanvasTTY", args: ["/app/agent-browser/mcp-helper.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } },
    orchestrationHelper: { command: "/app/CanvasTTY", args: ["/app/agent-browser/orchestration-helper.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } }
  },
  native: {
    helper: { command: "/app/helpers/canvastty-helper", args: ["mcp-browser"] },
    orchestrationHelper: { command: "/app/helpers/canvastty-helper", args: ["mcp-orchestration"] }
  }
};

function fakeGateway() {
  const registered = [];
  const revoked = [];
  return {
    registered,
    revoked,
    isEnabled: true,
    setEnabled(value) { this.isEnabled = value; },
    registerAgent(input) {
      registered.push(input.terminalSessionId);
      return {
        agentId: "agent-id", connectionId: "connection-id", terminalSessionId: input.terminalSessionId,
        provider: input.provider, capabilityToken: "browser-secret", address: "/tmp/canvastty.sock"
      };
    },
    revokeTerminalSession(id) { revoked.push(id); }
  };
}

/** Which CanvasTTY MCP servers a prepared launch attaches, read the way each CLI reads its configuration. */
async function serversOf(provider, launch, homes) {
  const names = (servers) => Object.keys(servers ?? {}).filter((name) => name.startsWith("canvastty_")).sort();
  if (provider === "claude" || provider === "qwen") {
    return names(JSON.parse(launch.args[launch.args.indexOf("--mcp-config") + 1]).mcpServers);
  }
  if (provider === "codex") {
    return launch.args.filter((arg) => arg.startsWith("mcp_servers.")).map((arg) => /^mcp_servers\.([^=]+)=/u.exec(arg)[1]).sort();
  }
  if (provider === "opencode") return names(JSON.parse(launch.environment.OPENCODE_CONFIG_CONTENT).mcp);
  if (provider === "hermes") return names(parseYaml(await readFile(join(homes.hermes, "config.yaml"), "utf8")).mcp_servers);
  const perRun = launch.args[launch.args.indexOf("--mcp-config-file") + 1];
  return names(JSON.parse(await readFile(perRun ?? join(homes.kimi, "mcp.json"), "utf8")).mcpServers);
}

const CASES = [
  { provider: "claude" }, { provider: "codex" }, { provider: "qwen" }, { provider: "opencode" }, { provider: "hermes" },
  { provider: "kimi", perRun: true, label: "kimi (per-run config)" }, { provider: "kimi", perRun: false, label: "kimi (shared mcp.json)" }
];

for (const [form, helpers] of Object.entries(HELPER_FORMS)) {
  for (const { provider, perRun = true, label = provider } of CASES) {
    test(`${label}, ${form} helpers: canvastty_agents regardless of browser access, canvastty_browser only with it`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "canvastty-orch-browser-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const homes = { hermes: join(root, "hermes"), kimi: join(root, "kimi") };
      const gateway = fakeGateway();
      const bridge = new AgentBrowserBridge(gateway, {
        ...helpers, providerClis, runtimeDirectory: join(root, "runtime"),
        hermesHomeDirectory: homes.hermes, kimiHomeDirectory: homes.kimi, probeKimiPerRunConfig: () => perRun
      });
      const combinations = [
        { browser: true, orchestration: true, expected: ["canvastty_agents", "canvastty_browser"] },
        { browser: true, orchestration: false, expected: ["canvastty_browser"] },
        { browser: false, orchestration: true, expected: ["canvastty_agents"] },
        { browser: false, orchestration: false, expected: null }
      ];
      for (const { browser, orchestration, expected } of combinations) {
        const name = `${label} / browser ${browser ? "on" : "off"} / orchestration ${orchestration ? "on" : "off"}`;
        bridge.setEnabled(browser);
        const id = `t-${browser}-${orchestration}`;
        const launch = bridge.prepareLaunch({
          terminalSessionId: id, provider, cwd: "/tmp/project",
          ...(orchestration ? { includeOrchestration: true, orchestrationTools: ["list_agents", "spawn_agent"] } : {})
        });
        if (expected === null) {
          assert.equal(launch, null, name);
          continue;
        }
        assert.deepEqual(await serversOf(provider, launch, homes), expected, name);
        const text = JSON.stringify(launch);
        // Without browser access: no browser capability is issued and none reaches the agent.
        assert.equal(gateway.registered.includes(id), browser, `${name}: browser capability issued`);
        assert.equal(AGENT_BROWSER_ENV.capabilityToken in launch.environment, browser, `${name}: browser environment`);
        assert.equal(text.includes("browser-secret"), browser, `${name}: browser secret`);
        if (!browser) {
          assert.equal(text.includes("mcp__canvastty_browser"), false, `${name}: no browser tools allowed`);
          assert.equal(text.includes(helpers.helper.args[0]), false, `${name}: no browser helper`);
        }
        launch.cleanup();
        assert.equal(gateway.revoked.includes(id), browser, `${name}: revoked on cleanup`);
        // The shared configurations are restored once the last launch using them is gone.
        if (provider === "hermes") assert.equal(existsSync(join(homes.hermes, "config.yaml")), false, `${name}: Hermes config restored`);
        if (provider === "kimi" && !perRun) assert.equal(existsSync(join(homes.kimi, "mcp.json")), false, `${name}: Kimi mcp.json restored`);
      }
    });
  }
}

test("a shared Hermes or Kimi configuration is never handed to a launch with the other browser access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-orch-browser-shared-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gateway = fakeGateway();
  const bridge = new AgentBrowserBridge(gateway, {
    ...HELPER_FORMS.native, providerClis, runtimeDirectory: join(root, "runtime"),
    hermesHomeDirectory: join(root, "hermes"), kimiHomeDirectory: join(root, "kimi"), probeKimiPerRunConfig: () => false
  });
  for (const provider of ["hermes", "kimi"]) {
    const first = bridge.prepareLaunch({ terminalSessionId: `${provider}-1`, provider, cwd: "/tmp", includeOrchestration: true });
    bridge.setEnabled(false);
    assert.throws(
      () => bridge.prepareLaunch({ terminalSessionId: `${provider}-2`, provider, cwd: "/tmp", includeOrchestration: true }),
      /browser access cannot change while a temporary/u
    );
    first.cleanup();
    const second = bridge.prepareLaunch({ terminalSessionId: `${provider}-3`, provider, cwd: "/tmp", includeOrchestration: true });
    assert.ok(second, `${provider}: works again once the first launch is gone`);
    second.cleanup();
    bridge.setEnabled(true);
  }
});
