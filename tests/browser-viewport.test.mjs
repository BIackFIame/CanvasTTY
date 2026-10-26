import assert from "node:assert/strict";
import test from "node:test";
import {
  browserCanvasEventToCss,
  clipBrowserViewportBounds,
  normalizeBrowserViewportBounds,
  sameBrowserViewport
} from "../src/main/services/browser/BrowserViewport.ts";

test("renderer zoom converts CSS viewport and clip edges to native DIPs before rounding", () => {
  const viewport = normalizeBrowserViewportBounds({
    x: 10.4, y: 20.6, width: 100.2, height: 50.1, surface: "native", canvasScale: 0.5,
    clipBounds: { x: 0.2, y: 12.2, width: 300.6, height: 200.4 }
  }, 0.8);
  assert.deepEqual(viewport, {
    x: 8, y: 16, width: 81, height: 41, surface: "native", canvasScale: 0.4,
    clipBounds: { x: 1, y: 10, width: 239, height: 160 }, showAgentPresence: false
  });
  assert.deepEqual(clipBrowserViewportBounds(viewport, { width: 100, height: 40 }), {
    x: 8, y: 16, width: 81, height: 24
  });
});

test("saved negative renderer zoom and enlarged renderer zoom scale the native page along with its slot", () => {
  for (const zoom of [1.2 ** -0.5, 1.25]) {
    const viewport = normalizeBrowserViewportBounds({
      x: 200, y: 160, width: 420, height: 260, surface: "native", canvasScale: 1.4
    }, zoom);
    assert.equal(viewport.x, Math.floor(200 * zoom));
    assert.equal(viewport.width, Math.ceil(620 * zoom) - Math.floor(200 * zoom));
    assert.equal(viewport.canvasScale, 1.4 * zoom);
    assert.equal(normalizeBrowserViewportBounds({
      x: 0, y: 0, width: 420, height: 260, surface: "native"
    }, zoom).canvasScale, zoom);
  }
  for (const zoom of [0, -1, Infinity, NaN]) {
    assert.equal(normalizeBrowserViewportBounds({ x: 0, y: 0, width: 1, height: 1, surface: "native" }, zoom), null);
  }
});

test("native pointer and wheel anchors return in renderer CSS pixels without changing wheel deltas", () => {
  const event = { tabId: "tab", clientX: 250, clientY: 200, deltaX: 2, deltaY: 18, type: "down" };
  assert.deepEqual(browserCanvasEventToCss(event, 1.25), {
    ...event, clientX: 200, clientY: 160
  });
  assert.equal(event.clientX, 250);
});

test("browser viewport expands fractional edges instead of exposing compositor gaps", () => {
  assert.deepEqual(normalizeBrowserViewportBounds({
    x: 10.4,
    y: 20.6,
    width: 100.2,
    height: 50.1,
    surface: "native",
    canvasScale: 0.92,
    showAgentPresence: true
  }), {
    x: 10,
    y: 20,
    width: 101,
    height: 51,
    surface: "native",
    canvasScale: 0.92,
    showAgentPresence: true
  });
});

test("browser viewport rejects invalid geometry and clamps negative sizes", () => {
  assert.equal(normalizeBrowserViewportBounds(null), null);
  assert.equal(normalizeBrowserViewportBounds({ x: 0, y: 0, width: Number.NaN, height: 10 }), null);
  assert.deepEqual(normalizeBrowserViewportBounds({
    x: -2.2,
    y: 3.8,
    width: -20,
    height: -10,
    surface: "hidden"
  }), {
    x: -3,
    y: 3,
    width: 0,
    height: 0,
    surface: "hidden",
    showAgentPresence: false
  });
});

test("browser viewport keeps page scaling inside Chromium's supported range", () => {
  assert.equal(normalizeBrowserViewportBounds({
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    surface: "placeholder",
    canvasScale: 0.2
  })?.canvasScale, 0.5);
  assert.equal(normalizeBrowserViewportBounds({
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    surface: "native",
    canvasScale: 8
  })?.canvasScale, 3);
});

test("browser viewport rejects invalid surface state", () => {
  assert.equal(normalizeBrowserViewportBounds({
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    surface: "invalid"
  }), null);
});

test("browser viewport stays below trusted window chrome when the card leaves the workspace", () => {
  const bounds = normalizeBrowserViewportBounds({
    x: 489,
    y: -20,
    width: 540,
    height: 420,
    surface: "native",
    clipBounds: { x: 0, y: 44, width: 786, height: 623 }
  });

  assert.ok(bounds);
  assert.deepEqual(clipBrowserViewportBounds(bounds, { width: 786, height: 667 }), {
    x: 489,
    y: 44,
    width: 297,
    height: 356
  });
});

test("browser viewport contracts fractional trusted clip edges and rejects malformed clips", () => {
  assert.deepEqual(normalizeBrowserViewportBounds({
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    surface: "native",
    clipBounds: { x: 0.2, y: 43.2, width: 785.6, height: 556.8 }
  })?.clipBounds, {
    x: 1,
    y: 44,
    width: 784,
    height: 556
  });
  assert.equal(normalizeBrowserViewportBounds({
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    surface: "native",
    clipBounds: { x: 0, y: Number.NaN, width: 800, height: 556 }
  }), null);
});

test("sub-pixel reports that round to the same placement are the same viewport; any real change is not", () => {
  const at = (x, extra = {}) => normalizeBrowserViewportBounds({ x, y: 20.2, width: 300.4, height: 200.2, surface: "native",
    clipBounds: { x: 0, y: 0, width: 1200, height: 800 }, canvasScale: 1, showAgentPresence: false, ...extra });
  assert.equal(sameBrowserViewport(at(10.1), at(10.3)), true);
  assert.equal(sameBrowserViewport(at(10.1), at(11.1)), false);
  assert.equal(sameBrowserViewport(at(10.1), at(10.1, { canvasScale: 1.1 })), false);
  assert.equal(sameBrowserViewport(at(10.1), at(10.1, { surface: "placeholder" })), false);
  assert.equal(sameBrowserViewport(at(10.1), at(10.1, { clipBounds: undefined })), false);
  assert.equal(sameBrowserViewport(at(10.1), at(10.1, { clipBounds: { x: 0, y: 0, width: 1200, height: 801 } })), false);
  assert.equal(sameBrowserViewport(at(10.1), at(10.1, { showAgentPresence: true })), false);
});
