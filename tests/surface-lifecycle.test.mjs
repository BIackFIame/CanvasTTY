import assert from "node:assert/strict";
import test from "node:test";
import {
  createSurfaceGate,
  surfaceIsLive,
  surfaceLifecycle,
  surfaceOffscreen
} from "../src/renderer/src/features/workspace/surfaceLifecycle.ts";

// One lifecycle for every canvas surface: mounted / visible / active / suspended.

test("any reason not to draw suspends a surface; otherwise focus decides visible or active", () => {
  assert.equal(surfaceLifecycle({}), "visible");
  assert.equal(surfaceLifecycle({ focused: true }), "active");
  for (const reason of ["summary", "hidden", "offscreen", "windowHidden", "closed"]) {
    assert.equal(surfaceLifecycle({ [reason]: true }), "suspended", reason);
    assert.equal(surfaceLifecycle({ [reason]: true, focused: true }), "suspended", `${reason} + focus`);
  }
  assert.deepEqual(["mounted", "visible", "active", "suspended"].map(surfaceIsLive), [false, true, true, false]);
});

test("the gate applies the first state, then only liveness changes, and a live surface once on dispose", () => {
  const applied = [];
  const gate = createSurfaceGate((live) => applied.push(live));
  assert.equal(gate.state, "mounted");
  gate.set("mounted");
  assert.deepEqual(applied, [], "mounted is not a decision");
  for (const state of ["visible", "active", "visible", "suspended", "suspended", "active"]) gate.set(state);
  assert.deepEqual(applied, [true, false, true]);
  gate.dispose();
  gate.dispose();
  gate.set("visible");
  assert.deepEqual(applied, [true, false, true, false], "dispose ends liveness once; later sets are ignored");
});

test("a surface that starts suspended applies it (the producer defaults to live) and disposes silently", () => {
  const applied = [];
  const gate = createSurfaceGate((live) => applied.push(live));
  gate.set("suspended");
  gate.dispose();
  assert.deepEqual(applied, [false]);
});

test("off-screen is geometry under the camera, with a margin around the viewport", () => {
  const viewport = { width: 1000, height: 800 };
  const card = { position: { x: 100, y: 100 }, size: { width: 400, height: 300 } };
  assert.equal(surfaceOffscreen(card, { x: 0, y: 0, zoom: 1 }, viewport), false);
  // Just past the right edge but inside the 25% margin.
  assert.equal(surfaceOffscreen(card, { x: 1000, y: 0, zoom: 1 }, viewport), false);
  assert.equal(surfaceOffscreen(card, { x: 1200, y: 0, zoom: 1 }, viewport), true);
  assert.equal(surfaceOffscreen(card, { x: -800, y: 0, zoom: 1 }, viewport), true);
  assert.equal(surfaceOffscreen(card, { x: 0, y: -700, zoom: 1 }, viewport), true);
  // Zoom scales both the position and the size.
  assert.equal(surfaceOffscreen(card, { x: 0, y: 0, zoom: 12 }, viewport), true);
  assert.equal(surfaceOffscreen(card, { x: 0, y: 0, zoom: 0.1 }, viewport), false);
  // No measured viewport yet: never treat a card as off-screen.
  assert.equal(surfaceOffscreen(card, { x: 99_999, y: 0, zoom: 1 }, { width: 0, height: 0 }), false);
});
