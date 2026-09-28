import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager, reachesRenderer } from "../src/main/services/TerminalManager.ts";
import { IPC } from "../src/shared/contracts.ts";

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
