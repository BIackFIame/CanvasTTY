import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GESTURE_SETTLE_MS, createGestureSettle } from "../src/renderer/src/features/workspace/gestureSettle.ts";

// A wheel (trackpad) pan used to leave the scene uncomposited, so every pan frame repainted all
// cards. The scene now carries will-change while a wheel pan or a zoom is active and drops it
// once the wheel has been silent for the settle time.

function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map();
  return {
    timers: {
      set(callback, ms) { const id = next++; pending.set(id, { at: now + ms, callback }); return id; },
      clear(id) { pending.delete(id); }
    },
    advance(ms) {
      now += ms;
      for (const [id, entry] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (entry.at > now) continue;
        pending.delete(id);
        entry.callback();
      }
    },
    pending: () => pending.size
  };
}

test("a gesture reports active once and inactive only after the settle time of silence", () => {
  const clock = fakeTimers();
  const changes = [];
  const gesture = createGestureSettle((active) => changes.push(active), GESTURE_SETTLE_MS, clock.timers);
  gesture.mark();
  for (let step = 0; step < 30; step++) {
    clock.advance(16);
    gesture.mark();
  }
  assert.deepEqual(changes, [true], "continuous steps keep the gesture open without repeated reports");
  clock.advance(GESTURE_SETTLE_MS - 1);
  assert.deepEqual(changes, [true]);
  clock.advance(1);
  assert.deepEqual(changes, [true, false]);
  gesture.mark();
  assert.deepEqual(changes, [true, false, true], "a new gesture after the settle reports again");
  assert.equal(clock.pending(), 1, "one timer at a time");
});

test("dispose drops the pending settle timer", () => {
  const clock = fakeTimers();
  const changes = [];
  const gesture = createGestureSettle((active) => changes.push(active), GESTURE_SETTLE_MS, clock.timers);
  gesture.mark();
  gesture.dispose();
  clock.advance(GESTURE_SETTLE_MS * 2);
  assert.deepEqual(changes, [true]);
  assert.equal(clock.pending(), 0);
});

test("wheel pans mark the pan gesture and the scene is composited while it lasts", async () => {
  const hook = await readFile(new URL("../src/renderer/src/features/workspace/useCanvasWheelNavigation.ts", import.meta.url), "utf8");
  const workspace = await readFile(new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/renderer/src/styles/app.css", import.meta.url), "utf8");
  const panBranch = hook.slice(hook.indexOf('intent.kind === "pan"'), hook.indexOf("flushPan();", hook.indexOf('intent.kind === "pan"')));
  assert.match(panBranch, /panGesture\.mark\(\)/u, "every wheel pan step keeps the pan gesture open");
  assert.match(workspace, /wheelNavigation\.wheelPanning \? "workspace--wheel-panning"/u);
  const rule = styles.match(/([^{}]*)\{\s*will-change:\s*transform;\s*\}/gu)?.find((block) => block.includes(".workspace__scene")) ?? "";
  for (const state of ["workspace--panning", "workspace--wheel-panning", "workspace--zooming"]) {
    assert.ok(rule.includes(`.${state} .workspace__scene`), `${state} composites the scene`);
  }
  const resting = styles.match(/^\.workspace__scene\s*\{[^}]*\}/mu)?.[0] ?? "";
  assert.ok(resting.includes("transform-origin"), "the resting scene rule is found");
  assert.ok(!resting.includes("will-change"), "the resting scene stays uncomposited so a zoom re-rasterizes");
});
