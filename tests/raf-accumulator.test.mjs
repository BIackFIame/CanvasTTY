import assert from "node:assert/strict";
import test from "node:test";
import { createRafAccumulator } from "../src/renderer/src/features/workspace/rafAccumulator.ts";

// A trackpad pinch-zoom fires many wheel events between two paints. Before this accumulator
// existed, a pinch-zoom committed camera state (and re-rendered every canvas card) once per
// wheel event; a trackpad pan already batched to one commit per animation frame. This proves
// the same batching for an arbitrary merge/commit pair without depending on React or the DOM:
// requestAnimationFrame/cancelAnimationFrame are injected as a fake scheduler.

function fakeScheduler() {
  let next = 1;
  const scheduled = new Map();
  return {
    schedule(callback) {
      const handle = next++;
      scheduled.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      scheduled.delete(handle);
    },
    runFrame() {
      const callbacks = [...scheduled.values()];
      scheduled.clear();
      for (const callback of callbacks) callback();
    },
    pendingCount: () => scheduled.size
  };
}

test("a burst of pushes within one frame commits exactly once, with merged values", () => {
  const scheduler = fakeScheduler();
  const commits = [];
  const accumulator = createRafAccumulator(
    (pending, next) => ({
      clientX: next.clientX,
      clientY: next.clientY,
      factor: (pending?.factor ?? 1) * next.factor
    }),
    (value) => commits.push(value),
    scheduler.schedule,
    scheduler.cancel
  );

  // 20 wheel ticks land before the next animation frame paints, exactly what a pinch-zoom does.
  for (let step = 0; step < 20; step++) {
    accumulator.push({ clientX: 100 + step, clientY: 50, factor: 1.01 });
  }
  assert.equal(commits.length, 0, "nothing commits before the frame runs");
  assert.equal(scheduler.pendingCount(), 1, "only one frame is scheduled for the whole burst");

  scheduler.runFrame();
  assert.equal(commits.length, 1, "the whole burst collapses into a single commit");
  assert.equal(commits[0].clientX, 119, "the commit uses the latest pointer position");
  assert.ok(Math.abs(commits[0].factor - Math.pow(1.01, 20)) < 1e-9, "factors compound across the burst");
});

test("pushes after a flushed frame schedule and commit again", () => {
  const scheduler = fakeScheduler();
  const commits = [];
  const accumulator = createRafAccumulator(
    (pending, next) => (pending ?? 0) + next,
    (value) => commits.push(value),
    scheduler.schedule,
    scheduler.cancel
  );

  accumulator.push(1);
  accumulator.push(2);
  scheduler.runFrame();
  assert.deepEqual(commits, [3]);

  accumulator.push(4);
  scheduler.runFrame();
  assert.deepEqual(commits, [3, 4]);
});

test("flush commits immediately and cancels the scheduled frame", () => {
  const scheduler = fakeScheduler();
  const commits = [];
  const accumulator = createRafAccumulator(
    (pending, next) => (pending ?? 0) + next,
    (value) => commits.push(value),
    scheduler.schedule,
    scheduler.cancel
  );

  accumulator.push(5);
  accumulator.flush();
  assert.deepEqual(commits, [5]);
  assert.equal(scheduler.pendingCount(), 0, "the frame is canceled once flushed");

  scheduler.runFrame();
  assert.deepEqual(commits, [5], "no double commit once the (canceled) frame would have run");
});

test("dispose drops the pending value and never commits it", () => {
  const scheduler = fakeScheduler();
  const commits = [];
  const accumulator = createRafAccumulator(
    (pending, next) => (pending ?? 0) + next,
    (value) => commits.push(value),
    scheduler.schedule,
    scheduler.cancel
  );

  accumulator.push(7);
  accumulator.dispose();
  scheduler.runFrame();
  assert.deepEqual(commits, [], "a disposed accumulator commits nothing");
});

test("flush with nothing pending is a no-op", () => {
  const scheduler = fakeScheduler();
  const commits = [];
  const accumulator = createRafAccumulator(
    (pending, next) => (pending ?? 0) + next,
    (value) => commits.push(value),
    scheduler.schedule,
    scheduler.cancel
  );

  accumulator.flush();
  assert.deepEqual(commits, []);
});
