import assert from "node:assert/strict";
import test from "node:test";
import { createReleasingCache } from "../src/renderer/src/features/skins/releasingCache.ts";

function fakeTimers() {
  const pending = new Set();
  return {
    pending,
    setTimeout(callback) { const timer = { callback }; pending.add(timer); return timer; },
    clearTimeout(timer) { pending.delete(timer); },
    runAll() { for (const timer of [...pending]) { pending.delete(timer); timer.callback(); } }
  };
}

test("a failed load's late release never evicts the fresh entry loaded after it", async () => {
  const timers = fakeTimers();
  const disposed = [];
  let attempt = 0;
  const cache = createReleasingCache({
    load: async (key) => { attempt += 1; if (attempt === 1) throw new Error("read failed"); return `${key}-urls-${attempt}`; },
    dispose: (value) => disposed.push(value),
    delayMs: 30_000,
    timers
  });
  const first = cache.acquire("pack");
  await assert.rejects(first.value, /read failed/u);
  const second = cache.acquire("pack");
  assert.equal(await second.value, "pack-urls-2");
  first.release();
  timers.runAll();
  assert.equal(cache.size(), 1, "the entry in use stays");
  const third = cache.acquire("pack");
  assert.equal(await third.value, "pack-urls-2", "and is shared, not loaded again");
  assert.equal(attempt, 2);
  second.release();
  third.release();
  timers.runAll();
  assert.equal(cache.size(), 0);
  assert.deepEqual(disposed, ["pack-urls-2"]);
});

test("a release then a new acquire within the delay keeps the entry", async () => {
  const timers = fakeTimers();
  const cache = createReleasingCache({ load: async (key) => key, dispose: () => undefined, delayMs: 30_000, timers });
  const one = cache.acquire("k");
  await one.value;
  one.release();
  one.release();
  const two = cache.acquire("k");
  timers.runAll();
  assert.equal(cache.size(), 1);
  two.release();
  timers.runAll();
  assert.equal(cache.size(), 0);
});
