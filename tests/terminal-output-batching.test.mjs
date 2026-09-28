import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager, reachesRenderer } from "../src/main/services/TerminalManager.ts";
import { TerminalRendererOutbox } from "../src/main/services/TerminalRendererOutbox.ts";
import { IPC } from "../src/shared/contracts.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

// Terminal output crosses into the renderer once per batch window for the whole canvas: one timer flushes
// every session with queued output, and the renderer transport sends that flush as a single IPC message.

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canvas(t, sessions = 4) {
  const sent = [];
  const outbox = new TerminalRendererOutbox((channel, payload) => sent.push({ channel, payload: structuredClone(payload) }));
  const calls = [];
  const manager = new TerminalManager((channel, payload) => {
    if (reachesRenderer(payload)) outbox.push(channel, payload);
  }, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => manager.disposeAll());
  const ids = Array.from({ length: sessions }, (_, index) =>
    manager.create({ provider: "terminal", cwd: process.cwd(), profile: "normal", position: { x: index * 700, y: 0 } }).id);
  const print = (index, text) => calls[index].process.emitData(text);
  return { manager, ids, sent, print, outbox };
}

test("output of every session in one batch window leaves as one renderer message, each session's text joined", async (t) => {
  const { ids, sent, print } = canvas(t);
  sent.length = 0;
  print(2, "c1 ");
  print(0, "a1 ");
  print(2, "c2 ");
  print(1, "b1 ");
  print(0, "a2 ");
  await wait(40);
  const data = sent.filter((message) => message.channel === IPC.terminalDataBatch);
  assert.equal(data.length, 1, "one IPC message for the whole window");
  assert.equal(sent.some((message) => message.channel === IPC.terminalData), false, "no per-session messages");
  const batch = data[0].payload;
  assert.deepEqual(batch.map((event) => event.id), [ids[2], ids[0], ids[1]], "sessions in the order their output first arrived");
  assert.deepEqual(batch.map((event) => event.data), ["c1 c2 ", "a1 a2 ", "b1 "]);
  assert.deepEqual(batch.map((event) => event.outputOffset), [6, 6, 3]);
});

test("one timer serves every busy session instead of one timer per session", async (t) => {
  const { print } = canvas(t, 8);
  const original = globalThis.setTimeout;
  let batchTimers = 0;
  globalThis.setTimeout = function (fn, ms, ...rest) {
    if (ms === 16) batchTimers++;
    return original.call(this, fn, ms, ...rest);
  };
  try {
    for (let round = 0; round < 3; round++) for (let index = 0; index < 8; index++) print(index, `round ${round}\r\n`);
  } finally {
    globalThis.setTimeout = original;
  }
  assert.equal(batchTimers, 1);
  await wait(40);
});

test("a flush forced by visibility or removal still reaches the renderer before the event that forced it", async (t) => {
  const { manager, ids, sent, print } = canvas(t, 2);
  sent.length = 0;
  print(0, "queued before close");
  print(1, "other card");
  manager.dispose(ids[0]);
  const channels = sent.map((message) => message.channel);
  assert.deepEqual(channels, [IPC.terminalDataBatch, IPC.terminalRemoved], "the pending output goes out first, in one message");
  assert.deepEqual(sent[0].payload.map((event) => [event.id, event.data]), [[ids[0], "queued before close"]]);
  await wait(40);
  const later = sent.slice(2);
  assert.equal(later.length, 1);
  assert.deepEqual(later[0].payload.map((event) => [event.id, event.data]), [[ids[1], "other card"]], "the other card's batch still leaves on the timer");
});

test("the outbox keeps the emitted order: session events flush the output collected before them", () => {
  const sent = [];
  const tasks = [];
  const outbox = new TerminalRendererOutbox((channel, payload) => sent.push([channel, payload]), (task) => tasks.push(task));
  const data = (id, text) => ({ id, data: text, outputOffset: text.length });
  outbox.push(IPC.terminalData, data("a", "1"));
  outbox.push(IPC.terminalData, data("b", "2"));
  assert.equal(tasks.length, 1, "one scheduled send per task");
  assert.equal(sent.length, 0);
  outbox.push(IPC.terminalSession, { session: { id: "a" } });
  outbox.push(IPC.terminalData, data("a", "3"));
  for (const task of tasks.splice(0)) task();
  assert.deepEqual(sent.map(([channel]) => channel), [IPC.terminalDataBatch, IPC.terminalSession, IPC.terminalDataBatch]);
  assert.deepEqual(sent[0][1].map((event) => event.data), ["1", "2"]);
  assert.deepEqual(sent[2][1].map((event) => event.data), ["3"]);
  for (const task of tasks.splice(0)) task();
  assert.equal(sent.length, 3, "an empty flush sends nothing");
});
