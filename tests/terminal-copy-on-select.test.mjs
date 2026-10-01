import assert from "node:assert/strict";
import test from "node:test";
import { attachTerminalCopyOnSelect } from "../src/renderer/src/features/terminal/terminalCopyOnSelect.ts";

class FakeTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  fire(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

function setup() {
  const document = new FakeTarget();
  const window = new FakeTarget();
  window.setTimeout = globalThis.setTimeout.bind(globalThis);
  window.clearTimeout = globalThis.clearTimeout.bind(globalThis);
  const screen = new FakeTarget();
  screen.ownerDocument = document;
  document.defaultView = window;
  let selection = "retained text";
  const selectionListeners = new Set();
  const copied = [];
  const detach = attachTerminalCopyOnSelect(
    screen,
    () => selection,
    () => true,
    (text) => copied.push(text),
    (listener) => {
      selectionListeners.add(listener);
      return () => selectionListeners.delete(listener);
    }
  );
  return {
    document,
    screen,
    copied,
    setSelection(text) { selection = text; },
    notifySelectionChange() {
      for (const listener of [...selectionListeners]) listener();
    },
    detach
  };
}

const leftButton = { button: 0 };

test("an ordinary TUI click does not copy a retained selection", async () => {
  const state = setup();
  state.screen.fire("mousedown", leftButton);
  state.document.fire("mouseup", leftButton);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(state.copied, []);
  state.detach();
});

test("a genuine selection change copies even when the selected text is unchanged", async () => {
  const state = setup();
  state.screen.fire("mousedown", { button: 0, shiftKey: true });
  state.notifySelectionChange();
  state.document.fire("mouseup", { button: 0, shiftKey: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(state.copied, ["retained text"]);
  state.detach();
});
