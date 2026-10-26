import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { getBackgroundSyncClock, synchronizedBackgroundTime, synchronizedBackgroundDelay } from "../src/renderer/src/features/terminal/backgroundSyncClock.ts";

test("same scene and speed share a persistent clock; changing speed can start continuously", () => {
  const first = getBackgroundSyncClock("sync-test", 1, null);
  assert.equal(getBackgroundSyncClock("sync-test", 1, null), first);
  const second = getBackgroundSyncClock("sync-test", 2, first);
  assert.equal(getBackgroundSyncClock("sync-test", 2, null), second);
  assert.notEqual(getBackgroundSyncClock("other-scene", 1, null), first);
  assert(Math.abs(second.time - (second.origin - first.origin) / 1000) < 1e-6);
  assert.equal(synchronizedBackgroundTime({ origin: 1000, time: 3, speed: 2 }, 2500, 12), 6);
  assert.equal(synchronizedBackgroundDelay({ origin: 1000, time: 0, speed: 1 }, 1500, 12, 200), 250);
});

test("workers created at different times stay in phase, rejoin after pause and restore independent playback", async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../src/renderer/src/features/terminal/asciiBackground.worker.ts", import.meta.url))],
    bundle: true, write: false, format: "iife", platform: "browser",
    plugins: [{ name: "sync-scene-probe", setup(build) {
      build.onLoad({ filter: /pieces[\\/]donut\.js$/ }, () => ({
        contents: 'export const meta={cols:1,rows:1,cell:1,fps:12,still:2};export default ()=>time=>{recordFrameTime(time);return "X";}',
        loader: "js",
      }));
    } }],
  });
  async function worker(origin, absoluteNow) {
    let now = absoluteNow - origin, next = 0;
    const timers = new Map(), times = [], self = {};
    const canvas = { width: 80, height: 40 };
    const ctx = new Proxy({ canvas }, { get: (target, key) => key in target ? target[key] : () => {} });
    canvas.getContext = kind => kind === "2d" ? ctx : null;
    vm.runInNewContext(bundle.outputFiles[0].text, {
      self, console, performance: { timeOrigin: origin, now: () => now },
      recordFrameTime: time => times.push(time),
      setTimeout: (callback, delay) => { timers.set(++next, { callback, delay }); return next; },
      clearTimeout: id => timers.delete(id),
    });
    const send = data => self.onmessage({ data });
    await send({ type: "init", canvas, scene: "donut" });
    return {
      times, timers, send,
      at(time) { now = time - origin; },
      tick(time) {
        now = time - origin;
        const [id, timer] = [...timers][0];
        timers.delete(id);
        timer.callback();
      },
    };
  }
  const clock = { origin: 10000, time: 0, speed: 1 };
  const workers = [];
  for (let index = 0; index < 4; index++) {
    const probe = await worker(index * 1500, 10000 + index * 700);
    await probe.send({ type: "synchronize", clock });
    await probe.send({ type: "playing", value: true });
    workers.push(probe);
  }
  for (const probe of workers) probe.tick(20000);
  assert(workers.every(probe => probe.times.at(-1) === 12));
  assert(workers.every(probe => probe.timers.size === 1));
  const frozen = workers[0];
  await frozen.send({ type: "playing", value: false });
  assert.equal(frozen.timers.size, 0);
  for (const probe of workers.slice(1)) probe.tick(21000);
  assert.equal(frozen.times.at(-1), 12);
  frozen.at(21000);
  await frozen.send({ type: "playing", value: true });
  frozen.tick(21000);
  assert(workers.every(probe => probe.times.at(-1) === 13));
  const late = await worker(19000, 21000);
  await late.send({ type: "synchronize", clock });
  assert.equal(late.times.at(-1), 13, "late initialization draws the shared frame immediately");
  const fastClock = { origin: 21000, time: 11, speed: 2 };
  for (const probe of workers) {
    await probe.send({ type: "speed", value: 2 });
    await probe.send({ type: "synchronize", clock: fastClock });
    probe.tick(22000);
  }
  assert(workers.every(probe => probe.times.at(-1) === 15));
  await frozen.send({ type: "synchronize", clock: null });
  frozen.tick(22100);
  assert(Math.abs(frozen.times.at(-1) - 15.2) < 1e-8);
  for (const probe of [...workers, late]) await probe.send({ type: "playing", value: false });
  assert([...workers, late].every(probe => probe.timers.size === 0));
});
