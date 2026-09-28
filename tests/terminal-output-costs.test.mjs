import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager, reachesRenderer } from "../src/main/services/TerminalManager.ts";
import { IPC } from "../src/shared/contracts.ts";
import { attachTerminalOutput } from "../src/renderer/src/features/terminal/terminalOutput.ts";

// What terminal output costs the main process: the scrollback ring holds only what it keeps, and a card
// that becomes visible again is sent the output it missed, not its whole history.

const MAX_SCROLLBACK_CHARS = 240_000;
const availableRegistry = {
  get: (provider) => ({ state: "available", provider, executable: "/resolved/codex", launcher: "native", environment: {}, checked: [] })
};

function createManager(t) {
  const rendered = [];
  const listeners = new Set();
  let emitData;
  const manager = new TerminalManager((channel, event) => {
    if (channel !== IPC.terminalData || !reachesRenderer(event)) return;
    rendered.push(event);
    for (const listener of listeners) listener(event);
  }, availableRegistry, undefined, undefined, true, () => ({
    pid: 10000, process: "codex", kill() {}, write() {}, resize() {},
    onData(listener) { emitData = listener; return { dispose() {} }; },
    onExit() { return { dispose() {} }; }
  }));
  t.after(() => manager.disposeAll());
  const { id } = manager.create({ provider: "codex", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
  const flush = () => manager.flushOutput(id, manager.sessions.get(id));
  const rendererApi = {
    onData(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    readBuffer() { return Promise.resolve(manager.readBuffer(id)); }
  };
  return { manager, id, rendered, rendererApi, data: (chunk) => emitData(chunk), flush };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const chunkOf = (index, size) => `${String(index).padStart(8, "0")}${"x".repeat(size - 10)}\r\n`;

test("the scrollback ring references only the text it keeps: dropped chunks are released at once", (t) => {
  const { manager, id, data, flush } = createManager(t);
  for (const size of [1_024, 16_384, 65_536]) {
    for (let i = 0; i < 64; i++) data(chunkOf(i, size));
    flush();
    const session = manager.sessions.get(id);
    const referenced = session.bufferChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    assert.equal(referenced, session.bufferLength, `${size}-char chunks: nothing outside the ring is still referenced`);
    assert.ok(session.bufferLength <= MAX_SCROLLBACK_CHARS);
  }
  // History is unchanged by the release: the ring still reads back as the last 240 000 characters.
  let expected = "";
  for (let i = 0; i < 64; i++) expected += chunkOf(i, 65_536);
  assert.equal(manager.readBuffer(id).buffer, expected.slice(-MAX_SCROLLBACK_CHARS));
});

test("a card that becomes visible again is sent the output it missed, not its whole scrollback", async (t) => {
  const { manager, id, rendered, rendererApi, data, flush } = createManager(t);
  const written = [];
  const detach = attachTerminalOutput(rendererApi, id, (chunk) => written.push(chunk), assert.fail, () => {
    throw new Error("unexpected replay gap in a sub-limit stretch");
  });
  t.after(detach);
  const history = "h".repeat(200_000);
  data(history);
  flush();
  await settle();
  manager.setVisible(id, false);
  data("missed one\r\n");
  flush();
  data("missed two\r\n");
  flush();
  const before = rendered.length;

  manager.setVisible(id, true);
  await settle();

  assert.equal(rendered.length, before + 1, "exactly one replay");
  const replay = rendered.at(-1);
  assert.equal(replay.data, "missed one\r\nmissed two\r\n", "only the missed stretch crosses IPC");
  assert.equal(replay.outputOffset, manager.readBuffer(id).outputOffset);
  assert.equal(written.join(""), `${history}missed one\r\nmissed two\r\n`, "the card shows the same text as before, each byte once");
});

test("zooming every card out and back in costs the missed output only, however long the history", (t) => {
  const cards = Array.from({ length: 8 }, () => createManager(t));
  for (const card of cards) {
    card.data("y".repeat(MAX_SCROLLBACK_CHARS + 5_000));
    card.flush();
    card.manager.setVisible(card.id, false);
    card.data("z".repeat(1_024));
    card.flush();
  }
  const sent = cards.map((card) => {
    const before = card.rendered.length;
    card.manager.setVisible(card.id, true);
    return card.rendered.slice(before).reduce((sum, event) => sum + event.data.length, 0);
  });
  assert.deepEqual(sent, Array(8).fill(1_024));
});
