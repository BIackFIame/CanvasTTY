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
  const settings = {useScrollWheelToZoom:true,zoomSensitivity:"normal",invertCanvasWheel:false,canvasWheelCaptureMode:"off"};
  const controller = hook.__render(hook.useCanvasWheelNavigation, {
    viewport: {current: viewport}, cameraRef, widgetFocusRef: {current: {id: null}},
    settings,
    commitCamera(next) { commits.push(next); cameraRef.current = next; }
  });
  t.after(() => { hook.__unmount(); Object.assign(globalThis, previous); });
  return { controller, cameraRef, commits, timers, settings, pending: hook.__pending, reads: () => reads,
    frame() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); } };
}

function wheel(h, deltaY, clientX = 501, clientY = 399) {
  h.controller.applyCanvasWheel({clientX,clientY,deltaX:0,deltaY,ctrlKey:false,metaKey:false});
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

for (const [name, zoom, deltaY] of [["minimum",0.2,100],["maximum",1.35,-100]]) {
  test(`reversing the ordinary wheel at the ${name} responds in the same frame after 40 redundant ticks`, async t => {
    const h = await fixture(t, zoom);
    const before = h.cameraRef.current;
    for (let i=0;i<40;i++) wheel(h, deltaY);
    wheel(h, -deltaY);
    assert.equal(h.commits.length, 0, "nothing is painted before the frame");
    h.frame();
    const after = h.cameraRef.current;
    assert.equal(h.commits.length, 1);
    assert.ok(Math.abs(after.zoom - zoom*Math.exp(deltaY*0.0012))<1e-12);
    assert.ok(Math.abs((501-before.x)/before.zoom-(501-after.x)/after.zoom)<1e-9);
    assert.ok(Math.abs((399-before.y)/before.zoom-(399-after.y)/after.zoom)<1e-9);
    assert.equal(h.reads(), 1);
  });
}

test("ordinary wheel events with moving anchors produce the same camera batched or painted separately", async t => {
  const h = await fixture(t, 0.9);
  const before = h.cameraRef.current;
  const events = [[70,200,300],[20,700,200],[-30,350,600]];
  for (const event of events) { wheel(h, ...event); h.frame(); }
  const expected = h.cameraRef.current;
  h.cameraRef.current = before;
  h.commits.length = 0;
  const reads = h.reads();
  for (const event of events) wheel(h, ...event);
  assert.equal(h.commits.length, 0);
  h.frame();
  assert.equal(h.commits.length, 1);
  for (const key of ["x","y","zoom"]) assert.ok(Math.abs(h.cameraRef.current[key]-expected[key])<1e-9, key);
  assert.equal(h.reads()-reads, 1, "the whole burst measures the viewport only once");
});

test("a zoom button flushes preceding ordinary wheel input before applying its own step", async t => {
  const h = await fixture(t, 0.8);
  wheel(h, 100);
  h.controller.zoomBy(1.22);
  assert.ok(Math.abs(h.cameraRef.current.zoom-0.8*Math.exp(-0.12)*1.22)<1e-12);
  assert.equal(h.commits.length, 2);
  h.frame();
  assert.equal(h.commits.length, 2, "the flushed wheel cannot overwrite the button later");
});

test("switching to wheel panning commits preceding zoom input in order", async t => {
  const h = await fixture(t, 0.8);
  wheel(h, 100);
  h.settings.useScrollWheelToZoom = false;
  h.controller.applyCanvasWheel({clientX:501,clientY:399,deltaX:15,deltaY:20,ctrlKey:false,metaKey:false});
  assert.equal(h.commits.length, 1);
  const zoomed = h.cameraRef.current;
  h.frame();
  assert.deepEqual(h.cameraRef.current, {...zoomed,x:zoomed.x-15,y:zoomed.y-20});
});

test("a pending wheel frame cannot overwrite a newer direct camera navigation", async t => {
  const h = await fixture(t, 0.8);
  wheel(h, 100);
  const direct = {x:900,y:-600,zoom:1};
  h.cameraRef.current = direct;
  h.frame();
  assert.equal(h.cameraRef.current, direct);
  assert.equal(h.commits.length, 0);
});
