import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createFrameReplyGate } from "../src/renderer/src/features/plugins/frameReplies.ts";

// A plugin frame's replies are posted to its window, which outlives the document inside it. These
// cases replay the order in which the host sees documents, requests and load events.
const win = { name: "frame window" };
const A = "example.plugin-a";
const B = "example.plugin-b";
const shownGate = (pluginId = A, entry = "canvastty-plugin://a/index.html") => {
  const gate = createFrameReplyGate();
  gate.showing(pluginId, entry);
  return gate;
};

test("replies reach the document that asked, across its first load and re-renders", () => {
  const gate = shownGate();
  const first = gate.received("1", win, A);
  const second = gate.received("2", win, A);
  gate.showing(A, "canvastty-plugin://a/index.html");
  gate.loaded();
  const third = gate.received("3", win, A);
  for (const reply of [first, second, third]) assert.equal(reply(win, A), true);
});

test("a reply finished after the frame switched to another plugin, before it loaded or asked anything, is dropped", () => {
  const gate = shownGate();
  gate.received("1", win, A);
  const secret = gate.received("5", win, A);
  // Same iframe element, same window object: only the document the host points it at changed.
  gate.showing(B, "canvastty-plugin://b/index.html");
  assert.equal(secret(win, B), false);
  assert.equal(secret(win, A), false, "the generation alone cuts it too");
  const fresh = gate.received("1", win, B);
  assert.equal(fresh(win, B), true);
});

test("a reply still running when the frame reloads itself is not delivered to the new document", () => {
  const gate = shownGate();
  gate.received("1", win, A);
  gate.loaded();
  const oldSecret = gate.received("7", win, A);
  // The reloaded document asks while its scripts run, before its load event.
  const newStartup = gate.received("1", win, A);
  gate.loaded();
  const newLater = gate.received("2", win, A);
  assert.equal(oldSecret(win, A), false);
  assert.equal(newStartup(win, A), true);
  assert.equal(newLater(win, A), true);
});

test("a navigation to a page that asks nothing still cuts off earlier replies", () => {
  const gate = shownGate();
  gate.received("1", win, A);
  gate.loaded();
  const pending = gate.received("4", win, A);
  gate.loaded();
  assert.equal(pending(win, A), false);
});

test("a reply is dropped when the frame no longer shows the window or the plugin that asked", () => {
  const gate = shownGate();
  const pending = gate.received("1", win, A);
  assert.equal(pending({ name: "another window" }, A), false);
  assert.equal(pending(undefined, A), false);
  assert.equal(pending(win, B), false);
});

test("the plugin frame routes every request reply through the gate", async () => {
  const frame = await readFile(new URL("../src/renderer/src/features/plugins/PluginFrame.tsx", import.meta.url), "utf8");
  assert.match(frame, /replies\.showing\(plugin\.manifest\.id, entryUrl\);/);
  assert.match(frame, /replies\.received\(message\.requestId, event\.source, plugin\.manifest\.id\)/);
  assert.equal(frame.match(/type: "response"/g)?.length, 2);
  assert.equal(frame.match(/if \(!mayReply\(frame\.current\?\.contentWindow, servedPlugin\.current\)\) return;/g)?.length, 2);
});
