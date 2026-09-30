import assert from "node:assert/strict";
import test from "node:test";
import { createEdgePanLoop, edgePanVelocity } from "../src/renderer/src/features/workspace/edgePan.ts";

// Edge-pan runs its own animation-frame loop off the last pointer position alone, not off a pointer-down
// gesture. Window blur (wired to the canvas's cancelPointerGesture) must stop it: blur produces no
// pointerleave, so without stop() a pointer resting at the edge when the window lost focus kept the loop
// requesting frames and moving the camera in the background indefinitely. Driven with a fake frame clock.

function frameClock() {
  const pending = new Map();
  let next = 1;
  let time = 0;
  return {
    requestFrame(callback) {
      const handle = next++;
      pending.set(handle, callback);
      return handle;
    },
    cancelFrame(handle) {
      pending.delete(handle);
    },
    /** Runs `count` animation frames, 16 ms apart. */
    run(count) {
      for (let index = 0; index < count; index += 1) {
        time += 16;
        const callbacks = [...pending.values()];
        pending.clear();
        for (const callback of callbacks) callback(time);
      }
    },
    get pending() {
      return pending.size;
    }
  };
}

const viewport = { left: 0, top: 0, width: 1000, height: 800 };

function edgePanHarness() {
  const clock = frameClock();
  const commits = [];
  const loop = createEdgePanLoop({
    requestFrame: clock.requestFrame,
    cancelFrame: clock.cancelFrame,
    velocity: (pointer) => edgePanVelocity(pointer, viewport),
    commit: (velocity, dt) => commits.push({ velocity, dt })
  });
  return { clock, commits, loop };
}

test("a pointer resting at the edge pans every frame until something stops the loop", () => {
  const { clock, commits, loop } = edgePanHarness();
  loop.move({ x: 2, y: 400 });
  clock.run(30);
  assert.equal(commits.length, 30, "one camera commit per frame");
  assert.ok(commits.at(-1).velocity.x > 0, "the left edge pans the camera right");
  assert.equal(clock.pending, 1, "and the loop keeps a frame requested");
});

test("window blur (stop) cancels the pending frame: no more frames, no more camera commits", () => {
  const { clock, commits, loop } = edgePanHarness();
  loop.move({ x: 2, y: 400 });
  clock.run(5);
  loop.stop();
  const committed = commits.length;
  assert.equal(clock.pending, 0, "no frame stays requested after blur");
  assert.equal(loop.running, false);
  clock.run(120);
  assert.equal(commits.length, committed, "the camera does not move in the background");
});

test("after blur a fresh hover starts panning again from a zero time step", () => {
  const { clock, commits, loop } = edgePanHarness();
  loop.move({ x: 2, y: 400 });
  clock.run(3);
  loop.stop();
  loop.move({ x: 998, y: 400 });
  clock.run(2);
  assert.equal(commits.at(-2).dt, 0, "no jump for the time the window was blurred");
  assert.ok(commits.at(-1).velocity.x < 0, "the right edge pans the camera left");
});

test("leaving the canvas or moving off the edge ends the loop by itself", () => {
  const { clock, commits, loop } = edgePanHarness();
  loop.move({ x: 2, y: 400 });
  clock.run(2);
  loop.leave();
  clock.run(10);
  assert.equal(commits.length, 2);
  assert.equal(clock.pending, 0);
  loop.move({ x: 500, y: 400 });
  clock.run(10);
  assert.equal(commits.length, 2, "the middle of the canvas does not pan");
  assert.equal(clock.pending, 0);
});
