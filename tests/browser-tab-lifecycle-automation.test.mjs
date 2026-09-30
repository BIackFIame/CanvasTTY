/**
 * The hidden-tab lifecycle as automation sees it: a paused page is resumed before any automation CDP command, the
 * freeze itself goes through the tab's debugger without marking it busy, beforeunload handlers are detected through
 * CDP, and an agent command for a sleeping tab wakes it and says so. Fake debugger and WebContents; no Electron.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { BrowserAutomationService } from "../src/main/services/browser/BrowserAutomationService.ts";
import { BROWSER_TAB_RELOADED_NOTICE, BrowserCore } from "../src/main/services/browser/BrowserCore.ts";
import { BrowserTabLifecycle } from "../src/main/services/browser/BrowserTabLifecycle.ts";
import { formatToolResult } from "../src/agent-browser/mcp-helper.mjs";

function fakeContents(log, handlers = {}) {
  let attached = false;
  const debuggerApi = Object.assign(new EventEmitter(), {
    attach() { attached = true; },
    detach() { attached = false; },
    isAttached() { return attached; },
    async sendCommand(method, params) {
      log.push(method === "Page.setWebLifecycleState" ? `${method}:${params.state}` : method);
      if (handlers[method]) return handlers[method](params);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      return {};
    }
  });
  return Object.assign(new EventEmitter(), {
    debugger: debuggerApi,
    isDestroyed: () => false,
    getURL: () => "https://fixture.test/",
    getTitle: () => "Fixture"
  });
}

const ATTACH = ["Page.enable", "DOM.enable", "Runtime.enable", "Accessibility.enable", "Network.enable"];

test("a paused tab is resumed through its debugger before an automation command touches the page", async (t) => {
  const log = [];
  const busy = [];
  let lifecycle;
  const automation = new BrowserAutomationService((tabId, value) => {
    busy.push(value);
    lifecycle.setBusy(tabId, value);
  }, { beforeCommand: async (tabId) => { await lifecycle.ensureLive(tabId); } });
  let clock = 0;
  const timers = [];
  lifecycle = new BrowserTabLifecycle({
    freezeBlocker: () => null,
    discardBlocker: async () => null,
    freeze: (tabId) => automation.setLifecycleState(tabId, "frozen"),
    resume: (tabId) => automation.setLifecycleState(tabId, "active"),
    discard: async () => false,
    restore: async () => undefined,
    stateChanged: () => undefined
  }, {
    now: () => clock,
    setTimer: (callback, ms) => timers.push({ callback, at: clock + ms }),
    clearTimer: () => undefined
  });
  t.after(() => automation.unregister("tab"));
  await automation.register("tab", fakeContents(log), 1);
  lifecycle.track("tab", false);
  assert.deepEqual(log, ATTACH);

  // The scheduled freeze: one lifecycle command through the tab's debugger, and the tab is not "driven" by it.
  clock = timers.at(-1).at;
  timers.at(-1).callback();
  for (let index = 0; index < 10; index += 1) await new Promise(setImmediate);
  assert.equal(lifecycle.state("tab"), "frozen");
  assert.deepEqual(log.slice(ATTACH.length), ["Page.setWebLifecycleState:frozen"]);
  assert.deepEqual(busy, [], "freezing is not automation");

  log.length = 0;
  await automation.observe("tab", 1, {});
  assert.equal(log[0], "Page.setWebLifecycleState:active", "resume comes first");
  assert.ok(log.length > 1, "then the observe commands");
  assert.equal(lifecycle.state("tab"), "active");
});

test("beforeunload handlers on the page are found through CDP, and an unanswered probe counts as one", async (t) => {
  const log = [];
  const listeners = { current: [{ type: "click" }] };
  const automation = new BrowserAutomationService();
  t.after(() => automation.unregister("tab"));
  await automation.register("tab", fakeContents(log, {
    "Runtime.evaluate": () => ({ result: { objectId: "window-1" } }),
    "DOMDebugger.getEventListeners": () => ({ listeners: listeners.current })
  }), 1);
  assert.equal(await automation.hasBeforeUnload("tab"), false);
  assert.ok(log.includes("Runtime.releaseObjectGroup"), "the window handle is released");
  listeners.current = [{ type: "beforeunload" }];
  assert.equal(await automation.hasBeforeUnload("tab"), true);
  assert.equal(await automation.hasBeforeUnload("missing-tab"), true, "an unknown tab is never discarded");

  const failing = new BrowserAutomationService();
  t.after(() => failing.unregister("tab"));
  await failing.register("tab", fakeContents([], {
    "Runtime.evaluate": () => { throw new Error("target closed"); }
  }), 1);
  assert.equal(await failing.hasBeforeUnload("tab"), true);
});

test("an agent command for a sleeping tab wakes it first and the result says the tab was reloaded", async (t) => {
  const log = [];
  const automation = new BrowserAutomationService();
  t.after(() => automation.unregister("tab"));
  const tab = { id: "tab", documentRevision: 4, url: "https://fixture.test/", status: "ready" };
  const wakes = [];
  let asleep = true;
  const host = {
    getSnapshot: () => ({ activeTabId: "tab", tabs: [{ ...tab, preview: "data:image/jpeg;base64,AAAA" }] }),
    getTab: () => tab,
    ensureRuntime: async () => {},
    touchActor() {},
    pendingDialog: () => null,
    prepareTab: async (tabId) => {
      wakes.push(tabId);
      if (!asleep) return { reloaded: false };
      asleep = false;
      tab.documentRevision = 5;
      await automation.register("tab", fakeContents(log), 5);
      return { reloaded: true };
    }
  };
  const audit = { append: async (input) => ({ ...input, hash: "hash", previousHash: null, sequence: 1, version: 1 }) };
  const core = new BrowserCore({ host, automation, policy: {}, audit });
  const actor = { kind: "agent", agentId: "agent", provider: "codex", terminalSessionId: "terminal", connectionId: "connection", cwd: "/tmp" };

  const first = await core.execute(actor, { type: "browser_observe", tabId: "tab", requestId: "first" });
  assert.equal(first.ok, true, JSON.stringify(first.error));
  assert.equal(first.notice, BROWSER_TAB_RELOADED_NOTICE);
  assert.equal(first.revisionAfter, 5);
  assert.match(formatToolResult(first).content.at(-1).text, /tab was reloaded/u, "the agent sees the notice");

  const second = await core.execute(actor, { type: "browser_observe", tabId: "tab", requestId: "second" });
  assert.equal(second.ok, true);
  assert.equal(second.notice, undefined, "only the waking command carries the notice");
  assert.deepEqual(wakes, ["tab", "tab"]);

  // A ref observed before the tab slept is stale after the wake; the error still tells the agent why.
  asleep = true;
  const stale = await core.execute(actor, {
    type: "browser_click",
    tabId: "tab",
    requestId: "stale",
    ref: { ref: "ref_old", tabId: "tab", documentRevision: 5, backendNodeId: 1, frameId: "main" }
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.details?.tabReloaded, true);

  // Closing a sleeping tab does not wake it; neither does reload (its wake is the reload).
  wakes.length = 0;
  host.closeTab = async () => ({ activeTabId: null, tabs: [] });
  host.reload = async () => host.getSnapshot();
  await core.execute(actor, { type: "browser_reload", tabId: "tab", requestId: "reload" });
  await core.execute(actor, { type: "browser_close_tab", tabId: "tab", requestId: "close" });
  assert.deepEqual(wakes, []);

  const listed = await core.execute(actor, { type: "browser_list_tabs", requestId: "list" });
  assert.equal(listed.data.tabs[0].preview, null, "a sleeping tab's picture is never sent to agents");
});
