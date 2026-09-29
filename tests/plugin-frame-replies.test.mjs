import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createFrameReplyGate } from "../src/renderer/src/features/plugins/frameReplies.ts";

// A plugin frame's replies are posted to its window, which outlives the document inside it. These
// cases replay the order in which the host sees requests and load events around a reload.
const win = { name: "frame window" };

test("replies reach the document that asked, across its first load", () => {
  const gate = createFrameReplyGate();
  const first = gate.received("1", win);
  const second = gate.received("2", win);
  gate.loaded();
  const third = gate.received("3", win);
  assert.equal(first(win), true);
  assert.equal(second(win), true);
  assert.equal(third(win), true);
});

test("a reply still running when the frame reloads is not delivered to the new document", () => {
  const gate = createFrameReplyGate();
  gate.received("1", win);
  gate.loaded();
  const oldSecret = gate.received("7", win);
  // The reloaded document asks while its scripts run, before its load event.
  const newStartup = gate.received("1", win);
  gate.loaded();
  const newLater = gate.received("2", win);
  assert.equal(oldSecret(win), false);
  assert.equal(newStartup(win), true);
  assert.equal(newLater(win), true);
});

test("a navigation to a page that asks nothing still cuts off earlier replies", () => {
  const gate = createFrameReplyGate();
  gate.received("1", win);
  gate.loaded();
  const pending = gate.received("4", win);
  gate.loaded();
  assert.equal(pending(win), false);
  const next = gate.received("1", win);
  assert.equal(next(win), true);
});

test("a reply is dropped when the frame no longer shows the window that asked", () => {
  const gate = createFrameReplyGate();
  const pending = gate.received("1", win);
  assert.equal(pending({ name: "another window" }), false);
  assert.equal(pending(undefined), false);
});

test("the plugin frame routes every request reply through the gate", async () => {
  const frame = await readFile(new URL("../src/renderer/src/features/plugins/PluginFrame.tsx", import.meta.url), "utf8");
  assert.match(frame, /replies\.received\(message\.requestId, event\.source\)/);
  assert.match(frame, /onLoad=\{\(\) => \{\s*replies\.loaded\(\);/);
  assert.equal(frame.match(/type: "response"/g)?.length, 2);
  assert.equal(frame.match(/if \(!mayReply\(frame\.current\?\.contentWindow\)\) return;/g)?.length, 2);
});
