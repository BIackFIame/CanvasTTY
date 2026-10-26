import assert from "node:assert/strict";
import test from "node:test";
import { importWithFakeReact } from "./helpers/fake-react.mjs";

async function fixture(t, zoom) {
  const previous = { window: globalThis.window, requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame };
  const frames = new Map(), timers = new Map();
  let id = 0, reads = 0;
  const window = Object.assign(new EventTarget(), {
    setTimeout: callback => { timers.set(++id, callback); return id; },
    clearTimeout: handle => timers.delete(handle),
    canvasTTY: {
      canvasNavigation: { armOwnerWheelSequence() {}, setPointerBindingState() {}, onOverrideState: () => () => {} },
      browser: { onCanvasWheel: () => () => {} }
    }
  });
  Object.assign(globalThis, { window,
    requestAnimationFrame: callback => { frames.set(++id, callback); return id; },
    cancelAnimationFrame: handle => frames.delete(handle) });
  const hook = await importWithFakeReact("src/renderer/src/features/workspace/useCanvasWheelNavigation.ts", "useCanvasWheelNavigation");
  const cameraRef = { current: { x: -123.45, y: 67.89, zoom } };
  const commits = [];
  const viewport = Object.assign(new EventTarget(), {
    classList: { toggle() {} },
    getBoundingClientRect() { reads++; return {left:0,top:0,width:1000,height:800}; }
  });
  const controller = hook.__render(hook.useCanvasWheelNavigation, {
    viewport: {current: viewport}, cameraRef, widgetFocusRef: {current: {id: null}},
    settings: {useScrollWheelToZoom:true,zoomSensitivity:"normal",invertCanvasWheel:false,canvasWheelCaptureMode:"off"},
    commitCamera(next) { commits.push(next); cameraRef.current = next; }
  });
  t.after(() => { hook.__unmount(); Object.assign(globalThis, previous); });
  return { controller, cameraRef, commits, timers, pending: hook.__pending, reads: () => reads,
    frame() { for (const callback of [...frames.values()]) callback(); } };
}

for (const [name, zoom, factor, deltaY] of [["minimum",0.2,0.82,100],["maximum",1.35,1.22,-100]]) {
  test(`40 button presses at the ${name} zoom do not move or re-rasterize the scene`, async t => {
    const h = await fixture(t, zoom);
    const before = h.cameraRef.current;
    for (let i=0;i<40;i++) h.controller.zoomBy(factor);
    assert.equal(h.cameraRef.current, before);
    assert.equal(h.commits.length, 0);
    assert.equal(h.reads(), 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.pending(), 0, "no zoom-gesture state change");
  });
  test(`40 wheel events at the ${name} zoom do not move or re-rasterize the scene`, async t => {
    const h = await fixture(t, zoom);
    for(let i=0;i<40;i++) h.controller.applyCanvasWheel({clientX:501,clientY:399,deltaX:0,deltaY,ctrlKey:false,metaKey:false});
    h.frame();
    assert.equal(h.commits.length, 0);
    assert.equal(h.reads(), 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.pending(), 0, "no zoom-gesture state change");
  });
}

test("zoom still moves normally and keeps the centre anchored below a limit", async t => {
  const h = await fixture(t, 0.92);
  const before = h.cameraRef.current;
  h.controller.zoomBy(1.22);
  assert.equal(h.commits.length, 1);
  const after = h.cameraRef.current;
  assert.equal(after.zoom, before.zoom*1.22);
  assert.ok(Math.abs((500-before.x)/before.zoom-(500-after.x)/after.zoom)<1e-9);
  assert.ok(Math.abs((400-before.y)/before.zoom-(400-after.y)/after.zoom)<1e-9);
});
