import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager, reachesRenderer } from "../src/main/services/TerminalManager.ts";
import { IPC } from "../src/shared/contracts.ts";
import { attachTerminalOutput, createTerminalDeliveryGate } from "../src/renderer/src/features/terminal/terminalOutput.ts";
import { surfaceLifecycle } from "../src/renderer/src/features/workspace/surfaceLifecycle.ts";

// A terminal card's surface lifecycle drives the main-process output stream. HOME editing hides the whole
// window layer with CSS; summary zoom turns the card into a thumbnail. Either way the card is suspended:
// the renderer receives no terminalData, so xterm parses and paints nothing, while the PTY keeps running
// and its scrollback stays canonical. When the card is visible again it gets the missed output exactly
// once. This drives a real TerminalManager, the card's delivery gate and its real output dedup, the same
// pieces TerminalCard wires together, and counts what reaches xterm.

const availableRegistry = {
  get: (provider) => ({ state: "available", provider, executable: "/resolved/codex", launcher: "native", environment: {}, checked: [] })
};

function createCard(t) {
  const rendererListeners = new Set();
  let rendered = 0;
  let emitData;
  const manager = new TerminalManager((channel, event) => {
    if (channel !== IPC.terminalData) return;
    if (!reachesRenderer(event)) return;
    rendered += 1;
    for (const listener of rendererListeners) listener(event);
  }, availableRegistry, undefined, undefined, true, () => ({
    pid: 10000, process: "codex", kill() {}, write() {}, resize() {},
    onData(listener) { emitData = listener; return { dispose() {} }; },
    onExit() { return { dispose() {} }; }
  }));
  t.after(() => manager.disposeAll());
  const { id } = manager.create({ provider: "codex", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
  const rendererApi = {
    onData(listener) { rendererListeners.add(listener); return () => rendererListeners.delete(listener); },
    readBuffer() { return Promise.resolve(manager.readBuffer(id)); },
    setVisible(sessionId, visible) {
      setVisibleCalls.push(visible);
      manager.setVisible(sessionId, visible);
    }
  };
  const setVisibleCalls = [];
  const xtermWrites = [];
  const detach = attachTerminalOutput(rendererApi, id, (chunk) => xtermWrites.push(chunk), assert.fail, () => {
    throw new Error("unexpected replay gap");
  });
  const gate = createTerminalDeliveryGate(rendererApi, id);
  t.after(() => { gate.dispose(); detach(); });
  const produce = (chunk) => {
    emitData(chunk);
    manager.flushOutput(id, manager.sessions.get(id));
  };
  // What TerminalCard derives from its props on every render.
  const render = ({ summary = false, hidden = false, focused = false } = {}) => gate.set(surfaceLifecycle({ summary, hidden, focused }));
  return { manager, id, produce, render, xtermWrites, setVisibleCalls, renderedCount: () => rendered };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("HOME editing suspends the card: busy output reaches the scrollback but not xterm, then replays once", async (t) => {
  const card = createCard(t);
  card.render();
  await settle();
  card.produce("before\r\n");
  await settle();
  assert.deepEqual(card.xtermWrites, ["before\r\n"]);

  card.render({ hidden: true }); // HOME editing starts
  const writesAtHide = card.xtermWrites.length;
  for (let index = 0; index < 50; index += 1) card.produce(`busy ${index}\r\n`);
  await settle();
  assert.equal(card.xtermWrites.length, writesAtHide, "a hidden card parses nothing");
  assert.match(card.manager.readBuffer(card.id).buffer, /busy 49/u, "the PTY and its scrollback keep going");

  card.render({ hidden: false }); // HOME editing ends
  await settle();
  assert.equal(card.xtermWrites.length, writesAtHide + 1, "the missed output arrives as one replay");
  assert.equal(card.xtermWrites.join(""), card.manager.readBuffer(card.id).buffer, "nothing lost, nothing written twice");

  card.produce("after\r\n");
  await settle();
  assert.equal(card.xtermWrites.at(-1), "after\r\n", "live output resumes");
});

test("summary zoom suspends the card the same way, and the two reasons combine", async (t) => {
  const card = createCard(t);
  card.render();
  card.render({ summary: true });
  card.produce("while summarized\r\n");
  card.render({ summary: true, hidden: true });
  card.produce("while summarized and hidden\r\n");
  card.render({ summary: false, hidden: true });
  card.produce("still hidden\r\n");
  await settle();
  assert.deepEqual(card.xtermWrites, [], "no reason to draw, nothing written");
  card.render();
  await settle();
  assert.equal(card.xtermWrites.join(""), "while summarized\r\nwhile summarized and hidden\r\nstill hidden\r\n");
});

test("the card calls setVisible only when its liveness changes, not on every render", (t) => {
  const card = createCard(t);
  card.render();
  card.render({ focused: true });
  card.render({ focused: false });
  card.render({ hidden: true });
  card.render({ hidden: true, summary: true });
  card.render({ hidden: true, focused: true });
  card.render();
  assert.deepEqual(card.setVisibleCalls, [true, false, true]);
});

test("a card that mounts during HOME editing never receives live output until it is shown", async (t) => {
  const card = createCard(t);
  card.render({ hidden: true });
  card.produce("produced while hidden\r\n");
  await settle();
  assert.deepEqual(card.setVisibleCalls, [false]);
  assert.equal(card.xtermWrites.join(""), "", "history loaded on mount was empty and nothing streamed since");
  card.render();
  await settle();
  assert.equal(card.xtermWrites.join(""), "produced while hidden\r\n");
});
