import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TerminalDataRouter } from "../src/shared/terminalDataRouter.ts";
import { attachTerminalOutput } from "../src/renderer/src/features/terminal/terminalOutput.ts";

// Terminal output reaches the renderer once per batch; the preload hands it to the one card it belongs to
// instead of to every card, so a canvas of N busy cards costs N bridge calls per round of output, not N².

const event = (id, data, outputOffset) => ({ id, data, outputOffset });

test("a listener registered for a session gets only that session's output, in order", () => {
  const router = new TerminalDataRouter();
  const a = [];
  const b = [];
  router.subscribe((e) => a.push(e.data), "a");
  router.subscribe((e) => b.push(e.data), "b");
  router.dispatch(event("a", "1", 1));
  router.dispatch(event("b", "x", 1));
  router.dispatch(event("a", "2", 2));
  router.dispatch(event("c", "nobody", 6));
  assert.deepEqual(a, ["1", "2"]);
  assert.deepEqual(b, ["x"]);
});

test("a listener without an id still gets every session's output", () => {
  const router = new TerminalDataRouter();
  const all = [];
  const unsubscribe = router.subscribe((e) => all.push(`${e.id}:${e.data}`));
  router.dispatch(event("a", "1", 1));
  router.dispatch(event("b", "2", 1));
  unsubscribe();
  router.dispatch(event("a", "3", 2));
  assert.deepEqual(all, ["a:1", "b:2"]);
});

test("unsubscribing one card leaves the other listeners of that session and forgets empty sessions", () => {
  const router = new TerminalDataRouter();
  const first = [];
  const second = [];
  const stopFirst = router.subscribe((e) => first.push(e.data), "a");
  const stopSecond = router.subscribe((e) => second.push(e.data), "a");
  router.dispatch(event("a", "1", 1));
  stopFirst();
  stopFirst();
  router.dispatch(event("a", "2", 2));
  stopSecond();
  router.dispatch(event("a", "3", 3));
  assert.deepEqual(first, ["1"]);
  assert.deepEqual(second, ["1", "2"]);
  assert.equal(router.byId.size, 0, "no per-session entry outlives its last listener");
});

test("a card calls one listener per batch no matter how many other cards are busy", async () => {
  const router = new TerminalDataRouter();
  const api = { onData: (listener, id) => router.subscribe(listener, id), readBuffer: async () => ({ buffer: "", outputOffset: 0 }) };
  const calls = new Map();
  const cards = Array.from({ length: 24 }, (_, index) => `card-${index}`);
  const written = new Map(cards.map((id) => [id, []]));
  const detach = cards.map((id) => attachTerminalOutput({
    onData: (listener, filter) => api.onData((e) => { calls.set(id, (calls.get(id) ?? 0) + 1); listener(e); }, filter),
    readBuffer: api.readBuffer
  }, id, (chunk) => written.get(id).push(chunk), assert.fail, () => ""));
  await new Promise((resolve) => setImmediate(resolve));
  for (const id of cards) router.dispatch(event(id, `out ${id}`, `out ${id}`.length));
  for (const id of cards) {
    assert.equal(calls.get(id), 1, `${id} was called only for its own batch`);
    assert.deepEqual(written.get(id), [`out ${id}`]);
  }
  for (const stop of detach) stop();
  router.dispatch(event("card-0", "late", 20));
  assert.deepEqual(written.get("card-0"), ["out card-0"], "a detached card gets nothing more");
});

test("the preload routes terminal output through one IPC listener and the card subscribes by its id", async () => {
  const preload = await readFile(new URL("../src/preload/index.ts", import.meta.url), "utf8");
  assert.match(preload, /ipcRenderer\.on\(IPC\.terminalDataBatch, [^\n]*\n\s*for \(const payload of batch\) terminalData\.dispatch\(payload\);/);
  assert.match(preload, /onData: \(listener[^\n]*id\?: string\) => terminalData\.subscribe\(listener, id\)/);
  assert.doesNotMatch(preload, /subscribe\(IPC\.terminalData/);
});
