import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { BrowserAutomationService } from "../src/main/services/browser/BrowserAutomationService.ts";

class FakeDebugger extends EventEmitter {
  attached = false;
  commands = [];
  commandHandler = async () => ({});

  attach() {
    this.attached = true;
  }

  detach() {
    this.attached = false;
  }

  isAttached() {
    return this.attached;
  }

  async sendCommand(method, params) {
    this.commands.push({ method, params });
    return this.commandHandler(method, params);
  }
}

class FakeWebContents extends EventEmitter {
  debugger = new FakeDebugger();
  loading = false;

  isDestroyed() {
    return false;
  }

  isLoading() {
    return this.loading;
  }

  getURL() {
    return "https://fixture.test/";
  }

  getTitle() {
    return "Fixture";
  }
}

function presenceFixtureHandler(method) {
  if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
  if (method === "Page.createIsolatedWorld") return { executionContextId: 99 };
  return {};
}

function presence(x, y, updatedAt = 1) {
  return {
    agentId: "agent-1",
    connectionId: "conn-1",
    provider: "claude",
    label: "Agent",
    brandColor: "#7A8291",
    terminalSessionId: "term-1",
    currentTabId: "tab-presence",
    cursor: { x, y, updatedAt },
    connectionState: "live",
    connectedAt: 0,
    lastHeartbeatAt: 0
  };
}

function countEvaluate(contents) {
  return contents.debugger.commands.filter((c) => c.method === "Runtime.evaluate").length;
}

test("repeated identical presence updates do not re-send Runtime.evaluate", async () => {
  const contents = new FakeWebContents();
  contents.debugger.commandHandler = presenceFixtureHandler;
  const automation = new BrowserAutomationService();
  await automation.register("tab-presence", contents, 1);
  contents.debugger.attach();

  await automation.setAgentPresences("tab-presence", [presence(10, 20)]);
  const afterFirst = countEvaluate(contents);
  assert.equal(afterFirst, 1, "first send should render the presence once");

  // Same cursor position resent several times, as syncViews does on every
  // owner move/resize even when nothing about the presence changed.
  await automation.setAgentPresences("tab-presence", [presence(10, 20)]);
  await automation.setAgentPresences("tab-presence", [presence(10, 20)]);
  await automation.setAgentPresences("tab-presence", [presence(10, 20)]);
  assert.equal(countEvaluate(contents), afterFirst, "unchanged presence state must not re-run Runtime.evaluate");

  // A real change must still go through.
  await automation.setAgentPresences("tab-presence", [presence(30, 40)]);
  assert.equal(countEvaluate(contents), afterFirst + 1, "changed presence state must be rendered");

  // Repeated empty clears (e.g. agent disconnect fan-out) must also be deduped.
  await automation.setAgentPresences("tab-presence", []);
  const afterClear = countEvaluate(contents);
  await automation.setAgentPresences("tab-presence", []);
  await automation.setAgentPresences("tab-presence", []);
  assert.equal(countEvaluate(contents), afterClear, "repeated empty presence clears must not re-run Runtime.evaluate");

  automation.unregister("tab-presence");
});
