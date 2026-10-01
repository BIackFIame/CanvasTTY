import assert from "node:assert/strict";
import test from "node:test";
import { AgentRegistry } from "../src/main/services/browser/AgentRegistry.ts";
import { BROWSER_SCREENSHOT_MAX_BINARY_BYTES } from "../src/main/services/browser/BrowserAutomationService.ts";

const actor = {
  kind: "agent",
  agentId: "agent-1",
  provider: "codex",
  terminalSessionId: "terminal-1",
  connectionId: "connection-1",
  cwd: "/tmp/project"
};

test("heartbeats alone do not invent browser activity or a cursor", () => {
  const registry = new AgentRegistry(() => 1_000);
  assert.equal(registry.heartbeat(actor), false);
  assert.deepEqual(registry.snapshot(), []);

  assert.equal(registry.touch(actor, "tab-1"), true);
  assert.equal(registry.forTab("tab-1")[0].label, "Codex");
  assert.deepEqual(registry.forTab("tab-1")[0].cursor, { x: 0, y: 0, updatedAt: 0 });
});

test("AgentRegistry follows tab/cursor heartbeats and expires presence at 15 seconds", () => {
  let now = 1_000;
  const registry = new AgentRegistry(() => now);
  assert.equal(registry.touch(actor, "tab-1", { x: 320, y: 240 }), true);
  assert.deepEqual(registry.forTab("tab-1")[0].cursor, { x: 320, y: 240, updatedAt: 1_000 });

  now = 12_000;
  assert.equal(registry.snapshot()[0].connectionState, "stale");
  registry.heartbeat(actor, now);
  assert.equal(registry.snapshot()[0].connectionState, "connected");

  now = 27_001;
  assert.deepEqual(registry.snapshot(), []);
});

test("AgentRegistry assigns the OpenCode identity and official mark color", () => {
  const registry = new AgentRegistry(() => 1_000);
  registry.touch({ ...actor, provider: "opencode", connectionId: "opencode-connection" }, "tab-1");
  const presence = registry.forTab("tab-1")[0];
  assert.equal(presence.label, "OpenCode");
  assert.equal(presence.brandColor, "#5A5858");
});

test("AgentRegistry assigns the Hermes identity and provider color", () => {
  const registry = new AgentRegistry(() => 1_000);
  registry.touch({ ...actor, provider: "hermes", connectionId: "hermes-connection" }, "tab-1");
  const presence = registry.forTab("tab-1")[0];
  assert.equal(presence.label, "Hermes");
  assert.equal(presence.brandColor, "#D6A700");
});

test("bounded screenshot base64 plus its JSON envelope fits the 512 KiB bridge", () => {
  const result = {
    v: 1,
    type: "response",
    id: "request-1",
    result: {
      ok: true,
      requestId: "request-1",
      tabId: "tab-1",
      commandSequence: 1,
      revisionBefore: 1,
      revisionAfter: 1,
      data: {
        untrustedWebContent: true,
        mimeType: "image/jpeg",
        base64: Buffer.alloc(BROWSER_SCREENSHOT_MAX_BINARY_BYTES).toString("base64"),
        width: 1_280,
        height: 720
      }
    }
  };
  assert.ok(Buffer.byteLength(`${JSON.stringify(result)}\n`) < 512 * 1024);
});

test("presence expiry runs a timer only while an agent is present", () => {
  let now = 1_000;
  const running = new Set();
  const timers = {
    setInterval(callback, ms) { const timer = { callback, ms, unref() { return timer; } }; running.add(timer); return timer; },
    clearInterval(timer) { running.delete(timer); }
  };
  let expired = 0;
  const registry = new AgentRegistry(() => now, { onExpired: () => { expired += 1; }, timers });
  assert.equal(running.size, 0, "nothing ticks for a browser no agent uses");
  registry.touch(actor, "tab-1");
  const presence = registry.snapshot()[0];
  assert.equal(running.size, 1);
  assert.equal([...running][0].ms, 1_000);
  registry.touch({ ...actor, connectionId: "connection-2" }, "tab-1");
  assert.equal(running.size, 1, "one timer for every agent");
  registry.disconnect(actor);
  assert.equal(running.size, 1, "another agent is still present");
  now += 16_000;
  [...running][0].callback();
  assert.equal(expired, 1, "the expired agent is reported");
  assert.equal(running.size, 0, "and the timer stops with the last agent");
  registry.replace([{ ...presence, connectionId: "restored", lastHeartbeatAt: now }]);
  assert.equal(running.size, 1, "restored presence expires too");
  registry.replace([]);
  assert.equal(running.size, 0);
  registry.touch(actor, "tab-1");
  registry.dispose();
  assert.equal(running.size, 0);
  registry.touch(actor, "tab-1");
  assert.equal(running.size, 0, "never again once disposed");
});
