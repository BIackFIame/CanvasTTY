import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  BrowserAutomationService,
  redactBitmapPixels,
  stableElementRefId
} from "../src/main/services/browser/BrowserAutomationService.ts";

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

function axFixtureHandler(method, params) {
  if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
  if (method === "Accessibility.getFullAXTree") {
    return {
      nodes: [{
        backendDOMNodeId: 41,
        frameId: "main",
        role: { value: "button" },
        name: { value: "Run" },
        properties: []
      }]
    };
  }
  if (method === "Page.getLayoutMetrics") {
    return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
  }
  if (method === "DOM.getBoxModel") {
    const x = params?.backendNodeId === 42 ? 200 : 20;
    return { model: { border: [x, 20, x + 80, 20, x + 80, 60, x, 60] } };
  }
  if (method === "DOM.describeNode") return { node: { nodeName: "BUTTON", attributes: [] } };
  return {};
}

test("element refs stay stable for a tab, revision, frame, and backend node", async () => {
  const contents = new FakeWebContents();
  contents.debugger.commandHandler = axFixtureHandler;
  const automation = new BrowserAutomationService();
  await automation.register("tab-stable", contents, 7);

  const first = await automation.observe("tab-stable", 7);
  const second = await automation.observe("tab-stable", 7);
  assert.equal(first.elements[0].ref.ref, second.elements[0].ref.ref);
  assert.equal(automation.sessions.get("tab-stable").refs.size, 1);
  assert.equal(
    first.elements[0].ref.ref,
    stableElementRefId("tab-stable", 7, "main", 41)
  );
  assert.notEqual(
    stableElementRefId("tab-stable", 7, "child", 41),
    first.elements[0].ref.ref
  );

  await automation.waitFor("tab-stable", 7, "element", "Run", 200);
  assert.equal(automation.sessions.get("tab-stable").refs.size, 1);
  automation.unregister("tab-stable");
});

test("read and observe share credential identity classification", async () => {
  const contents = new FakeWebContents();
  contents.debugger.commandHandler = async (method, params) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [{
          backendDOMNodeId: 71,
          frameId: "main",
          role: { value: "textbox" },
          name: { value: "Recovery code" },
          value: { value: "must-not-leak" },
          properties: []
        }]
      };
    }
    if (method === "Page.getLayoutMetrics") {
      return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
    }
    if (method === "DOM.getBoxModel") {
      return { model: { border: [20, 20, 220, 20, 220, 60, 20, 60] } };
    }
    if (method === "DOM.describeNode" && params.backendNodeId === 71) {
      return { node: { nodeName: "INPUT", attributes: ["name", "account-passcode"] } };
    }
    return {};
  };
  const automation = new BrowserAutomationService();
  await automation.register("tab-credentials", contents, 8);
  const observation = await automation.observe("tab-credentials", 8);
  assert.equal(observation.elements[0].value, null);
  const page = await automation.readPage("tab-credentials", 8);
  assert.equal(page.text.includes("must-not-leak"), false);
  automation.unregister("tab-credentials");
});

test("network-idle tracks CDP inflight request lifecycle", async () => {
  const contents = new FakeWebContents();
  const automation = new BrowserAutomationService();
  await automation.register("tab-network", contents, 1);
  assert.ok(contents.debugger.commands.some(({ method }) => method === "Network.enable"));

  contents.debugger.emit("message", {}, "Network.requestWillBeSent", { requestId: "request-1" });
  const session = automation.sessions.get("tab-network");
  session.networkLastChangeAt = Date.now() - 2_000;
  await assert.rejects(
    automation.waitFor("tab-network", 1, "network-idle", undefined, 120),
    (error) => error?.code === "TIMEOUT"
  );
  assert.deepEqual([...session.inflightRequests], ["request-1"]);

  contents.debugger.emit("message", {}, "Network.loadingFinished", { requestId: "request-1" });
  session.networkLastChangeAt = Date.now() - 2_000;
  assert.deepEqual(await automation.waitFor(
    "tab-network",
    1,
    "network-idle",
    undefined,
    120
  ), { matched: true });
  automation.unregister("tab-network");
});

test("drag queues release before awaiting a native drag-loop response", async () => {
  const contents = new FakeWebContents();
  const blockedMoves = [];
  let released = false;
  contents.debugger.commandHandler = async (method, params) => {
    if (method !== "Input.dispatchMouseEvent") return {};
    if (params.type === "mouseMoved" && params.buttons === 1 && params.y >= 40) {
      return new Promise((resolve) => blockedMoves.push(resolve));
    }
    if (params.type === "mouseReleased") {
      released = true;
      for (const resolve of blockedMoves.splice(0)) resolve({});
    }
    return {};
  };
  const automation = new BrowserAutomationService();
  await automation.register("tab-drag", contents, 2);
  const session = automation.sessions.get("tab-drag");
  session.refs.set("source", {
    value: { ref: "source", tabId: "tab-drag", frameId: "main", documentRevision: 2, backendNodeId: 41 },
    bounds: { x: 20, y: 20, width: 80, height: 40 }
  });
  session.refs.set("target", {
    value: { ref: "target", tabId: "tab-drag", frameId: "main", documentRevision: 2, backendNodeId: 42 },
    bounds: { x: 200, y: 20, width: 80, height: 40 }
  });
  contents.debugger.commandHandler = ((inputHandler) => async (method, params) => {
    if (method === "DOM.getBoxModel") return axFixtureHandler(method, params);
    return inputHandler(method, params);
  })(contents.debugger.commandHandler);

  assert.deepEqual(await automation.drag("tab-drag", 2, "source", "target"), { x: 240, y: 40 });
  assert.equal(released, true);
  assert.equal(blockedMoves.length, 0);
  automation.unregister("tab-drag");
});

test("drag exits cleanly when mousedown opens an Electron dialog", async () => {
  const contents = new FakeWebContents();
  let finishPressed = () => {};
  contents.debugger.commandHandler = async (method, params) => {
    if (method === "DOM.getBoxModel") return axFixtureHandler(method, params);
    if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
      queueMicrotask(() => contents.emit("-run-dialog", {
        dialogType: "alert",
        messageText: "mousedown dialog"
      }, () => finishPressed()));
      return new Promise((resolve) => {
        finishPressed = () => resolve({});
      });
    }
    return {};
  };
  const automation = new BrowserAutomationService();
  await automation.register("tab-dialog-drag", contents, 3);
  const session = automation.sessions.get("tab-dialog-drag");
  for (const [ref, backendNodeId, x] of [["source", 41, 20], ["target", 42, 200]]) {
    session.refs.set(ref, {
      value: { ref, tabId: "tab-dialog-drag", frameId: "main", documentRevision: 3, backendNodeId },
      bounds: { x, y: 20, width: 80, height: 40 }
    });
  }

  assert.deepEqual(await automation.drag("tab-dialog-drag", 3, "source", "target"), { x: 240, y: 40 });
  await automation.handleDialog("tab-dialog-drag", true);
  automation.unregister("tab-dialog-drag");
});

test("screenshot sensitive bounds include flattened iframe and shadow nodes", async () => {
  const contents = new FakeWebContents();
  contents.debugger.commandHandler = async (method, params) => {
    if (method === "DOM.getFlattenedDocument") {
      return {
        nodes: [
          { backendNodeId: 50, nodeName: "INPUT", attributes: ["type", "password"] },
          { backendNodeId: 51, nodeName: "TEXTAREA", attributes: ["name", "api-token"] },
          { backendNodeId: 52, nodeName: "INPUT", attributes: ["name", "public-value"] }
        ]
      };
    }
    if (method === "DOM.getBoxModel") {
      const x = params.backendNodeId === 50 ? 10 : 110;
      return { model: { border: [x, 15, x + 90, 15, x + 90, 45, x, 45] } };
    }
    return {};
  };
  const automation = new BrowserAutomationService();
  await automation.register("tab-sensitive", contents, 4);
  assert.deepEqual(await automation.sensitiveBoundsForScreenshot(
    automation.sessions.get("tab-sensitive")
  ), [
    { x: 10, y: 15, width: 90, height: 30 },
    { x: 110, y: 15, width: 90, height: 30 }
  ]);
  automation.unregister("tab-sensitive");
});

test("bitmap redaction clears every captured byte in sensitive rectangles", () => {
  const bitmap = Buffer.alloc(10 * 10 * 4, 0x7f);
  redactBitmapPixels(bitmap, 10, 10, {
    width: 10,
    height: 10,
    offsetX: 10,
    offsetY: 20
  }, [{ x: 12, y: 23, width: 3, height: 2 }]);

  const pixel = (x, y) => [...bitmap.subarray((y * 10 + x) * 4, (y * 10 + x + 1) * 4)];
  assert.deepEqual(pixel(2, 3), [0, 0, 0, 0]);
  assert.deepEqual(pixel(9, 9), [0x7f, 0x7f, 0x7f, 0x7f]);
  assert.throws(
    () => redactBitmapPixels(Buffer.alloc(3), 1, 1, { width: 1, height: 1 }, []),
    (error) => error?.code === "BRIDGE_UNAVAILABLE"
  );
});

test("screenshot redaction fails closed when sensitive bounds cannot be resolved", async () => {
  const contents = new FakeWebContents();
  contents.debugger.commandHandler = async (method) => {
    if (method === "DOM.getFlattenedDocument") {
      return { nodes: [{ backendNodeId: 60, nodeName: "INPUT", attributes: ["type", "password"] }] };
    }
    if (method === "DOM.getBoxModel") throw new Error("target closed");
    return {};
  };
  const automation = new BrowserAutomationService();
  await automation.register("tab-fail-closed", contents, 5);
  await assert.rejects(
    automation.sensitiveBoundsForScreenshot(automation.sessions.get("tab-fail-closed")),
    (error) => error?.code === "BRIDGE_UNAVAILABLE"
  );
  automation.unregister("tab-fail-closed");
});

/** A page of `count` visible buttons (ids 1000...). */
function manyButtons(count) {
  return (method, params) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Accessibility.getFullAXTree") {
      return { nodes: Array.from({ length: count }, (_, index) => ({ backendDOMNodeId: 1000 + index, frameId: "main", role: { value: "button" }, name: { value: `B${index}` }, properties: [] })) };
    }
    if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
    if (method === "DOM.getBoxModel") return { model: { border: [10, 10, 50, 10, 50, 30, 10, 30] } };
    if (method === "DOM.describeNode") return { node: { nodeName: "BUTTON", attributes: [] } };
    return {};
  };
}

test("observe measures only the elements of the page it returns (and one more to know there is a next page)", async () => {
  const contents = new FakeWebContents();
  contents.debugger.commandHandler = manyButtons(600);
  const automation = new BrowserAutomationService();
  await automation.register("tab-many", contents, 1);
  const boxes = () => contents.debugger.commands.filter((command) => command.method === "DOM.getBoxModel").length;
  const first = await automation.observe("tab-many", 1, { limit: 50 });
  assert.equal(first.elements.length, 50);
  assert.ok(first.nextCursor);
  assert.equal(boxes(), 51);
  const before = boxes();
  const second = await automation.observe("tab-many", 1, { limit: 50, cursor: first.nextCursor });
  assert.equal(second.elements[0].name, "B50");
  assert.equal(boxes() - before, 101);
  const last = await automation.observe("tab-many", 1, { limit: 200 });
  assert.equal(last.elements.length, 200);
  automation.unregister("tab-many");
});

test("waiting for text or an element polls less often the longer it waits", async () => {
  const contents = new FakeWebContents();
  contents.debugger.commandHandler = manyButtons(3);
  const automation = new BrowserAutomationService();
  await automation.register("tab-wait", contents, 1);
  await assert.rejects(automation.waitFor("tab-wait", 1, "element", "never there", 2_000), /timed out/u);
  const walks = contents.debugger.commands.filter((command) => command.method === "Accessibility.getFullAXTree").length;
  assert.ok(walks <= 10, `${walks} tree walks in 2 s (every 100 ms would be about 20)`);
  automation.unregister("tab-wait");
});

test("the per-document sensitive-node cache stays bounded", async () => {
  const contents = new FakeWebContents();
  contents.debugger.commandHandler = manyButtons(200);
  const automation = new BrowserAutomationService();
  await automation.register("tab-cache", contents, 1);
  const session = automation.sessions.get("tab-cache");
  for (let round = 0; round < 12; round += 1) {
    contents.debugger.commandHandler = (method, params) => {
      const answer = manyButtons(200)(method, params);
      if (method === "Accessibility.getFullAXTree") {
        for (const node of answer.nodes) node.backendDOMNodeId += round * 1_000;
      }
      return answer;
    };
    await automation.observe("tab-cache", 1, { limit: 200 });
  }
  assert.ok(session.sensitiveNodes.size <= 1_000, `${session.sensitiveNodes.size} cached`);
  automation.unregister("tab-cache");
});
