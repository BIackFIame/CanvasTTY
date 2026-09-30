import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { BrowserAutomationService } from "../src/main/services/browser/BrowserAutomationService.ts";

class FakeDebugger extends EventEmitter {
  attached = false;
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
    return this.commandHandler(method, params);
  }
}

class FakeWebContents extends EventEmitter {
  debugger = new FakeDebugger();

  isDestroyed() {
    return false;
  }

  getURL() {
    return "https://fixture.test/";
  }

  getTitle() {
    return "Fixture";
  }
}

function observeFixtureHandler(method) {
  if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
  if (method === "Accessibility.getFullAXTree") return { nodes: [] };
  if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
  return {};
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("an automation command marks its tab busy and releases it after a short idle grace window", async () => {
  const contents = new FakeWebContents();
  contents.debugger.commandHandler = async (method) => observeFixtureHandler(method);
  const busyEvents = [];
  const service = new BrowserAutomationService((tabId, busy) => busyEvents.push({ tabId, busy }));

  await service.register("tab-1", contents, 0);
  // Attaching (Page.enable/DOM.enable/...) goes through the debugger directly, not through the
  // command()/ready() path that tracks busy, so it must not itself flag the tab as busy.
  assert.deepEqual(busyEvents, []);

  await service.observe("tab-1", 0, {});
  assert.equal(busyEvents.filter((event) => event.busy === true).length, 1,
    "a burst of several CDP round-trips for one call must coalesce into a single busy=true transition");
  assert.equal(busyEvents.every((event) => event.tabId === "tab-1"), true);
  assert.equal(busyEvents.some((event) => event.busy === false), false,
    "the tab must still be considered busy immediately after the command completes");

  await delay(650);
  assert.equal(busyEvents.at(-1).busy, false, "busy must clear once the grace window elapses with no further commands");

  service.unregister("tab-1");
});

test("unregistering a tab immediately clears any pending busy state", async () => {
  const contents = new FakeWebContents();
  contents.debugger.commandHandler = async (method) => observeFixtureHandler(method);
  const busyEvents = [];
  const service = new BrowserAutomationService((tabId, busy) => busyEvents.push({ tabId, busy }));
  await service.register("tab-2", contents, 0);
  await service.observe("tab-2", 0, {});
  assert.equal(busyEvents.at(-1).busy, true);

  service.unregister("tab-2");
  assert.equal(busyEvents.at(-1).busy, false, "unregister must not leave a stale busy timer that fires later");

  // Confirm no further (redundant) transition arrives once the original grace timer would have fired.
  const countAfterUnregister = busyEvents.length;
  await delay(650);
  assert.equal(busyEvents.length, countAfterUnregister, "the cleared timer must not still fire after unregister");
});
