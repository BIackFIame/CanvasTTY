import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { BrowserAutomationService } from "../src/main/services/browser/BrowserAutomationService.ts";

class FakeDebugger extends EventEmitter {
  attached = false;
  commandHandler = null;

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
    if (this.commandHandler) return this.commandHandler(method, params);
    return {};
  }
}

class FakeWebContents extends EventEmitter {
  debugger = new FakeDebugger();

  isDestroyed() {
    return false;
  }
}

test("Electron dialogs remain pending until trusted browser handling answers them", async () => {
  const contents = new FakeWebContents();
  let electronDefaultHandlerCalled = false;
  contents.on("-run-dialog", () => {
    electronDefaultHandlerCalled = true;
  });

  const snapshots = [];
  const automation = new BrowserAutomationService();
  await automation.register("tab-dialog", contents, 3, (dialog) => snapshots.push(dialog));

  let inputPending = false;
  let releaseInput = () => {};
  contents.debugger.commandHandler = (method) => {
    if (method !== "Input.dispatchMouseEvent") return {};
    inputPending = true;
    return new Promise((resolve) => {
      releaseInput = () => {
        inputPending = false;
        resolve({});
      };
    });
  };
  const session = automation.sessions.get("tab-dialog");
  const input = automation.commandAllowDialog(session, "Input.dispatchMouseEvent", { type: "mouseReleased" });

  let answer = null;
  contents.emit("-run-dialog", {
    dialogType: "prompt",
    messageText: "Name?",
    defaultPromptText: "Ada"
  }, (accept, promptText) => {
    answer = { accept, promptText };
    releaseInput();
  });

  assert.deepEqual(await input, { completed: false });

  assert.equal(electronDefaultHandlerCalled, false);
  assert.deepEqual(snapshots.at(-1), {
    tabId: "tab-dialog",
    type: "prompt",
    message: "Name?",
    defaultPrompt: "Ada",
    openedAt: snapshots.at(-1).openedAt
  });
  assert.equal(answer, null);

  await automation.handleDialog("tab-dialog", true, "Grace");
  assert.deepEqual(answer, { accept: true, promptText: "Grace" });
  assert.equal(inputPending, false);
  assert.equal(snapshots.at(-1), null);
  automation.unregister("tab-dialog");
});

test("type reports nothing typed when focusing the element opened a dialog", async () => {
  const contents = new FakeWebContents();
  const automation = new BrowserAutomationService();
  await automation.register("tab-focus-dialog", contents, 3, () => undefined);
  const session = automation.sessions.get("tab-focus-dialog");
  automation.refPoint = async () => ({ session, entry: { value: { backendNodeId: 7 } }, point: { x: 4, y: 5 } });
  const methods = [];
  contents.debugger.commandHandler = (method) => {
    methods.push(method);
    if (method !== "DOM.focus") return {};
    // The page's focus handler raises an alert: focus does not return until the dialog is answered.
    return new Promise((resolve) => {
      contents.emit("-run-dialog", { dialogType: "alert", messageText: "focused!" }, () => resolve({}));
    });
  };
  const result = await automation.type("tab-focus-dialog", 3, "e1", "secret text");
  assert.deepEqual(result, { point: { x: 4, y: 5 }, typed: false });
  assert.equal(methods.includes("Input.insertText"), false, "no text was inserted");
  await automation.handleDialog("tab-focus-dialog", true);
  automation.unregister("tab-focus-dialog");
});
