import assert from "node:assert/strict";
import test from "node:test";
import { appendFineDots } from "../src/renderer/src/features/terminal/asciiFineDots.ts";
import { drawAsciiFrame } from "../src/renderer/src/features/terminal/asciiFrameCanvas.ts";
import { asciiFrameSvg } from "../src/renderer/src/features/terminal/asciiFrameSvg.ts";
import { createAsciiGpuRenderer } from "../src/renderer/src/features/terminal/asciiFrameGpu.ts";
import { asciiFrameBounds } from "../src/renderer/src/features/terminal/asciiFrameBounds.ts";

test("Fine dots maps Braille bits to eight unclipped circles without font rendering", () => {
  const arcs = [];
  const ctx = { moveTo() {}, arc(...args) { arcs.push(args); } };
  for (const [mask, x, y] of [[1, 1.5, 1.5], [8, 4.5, 1.5], [64, 1.5, 10.5], [128, 4.5, 10.5]]) {
    arcs.length = 0;
    appendFineDots(ctx, String.fromCharCode(0x2800 + mask), 0, 0, 12);
    assert.equal(arcs.length, 1);
    assert.equal(arcs[0][0], x);
    assert.equal(arcs[0][1], y);
    assert(Math.abs(arcs[0][2] - 1.2) < 1e-12);
  }
  arcs.length = 0;
  appendFineDots(ctx, "\u28ff", 0, 0, 12);
  assert.equal(arcs.length, 8);
  appendFineDots(ctx, "\u2800", 0, 0, 12);
  appendFineDots(ctx, "A", 0, 0, 12);
  assert.equal(arcs.length, 8);
});

test("Fine dots SVG and Canvas fallback use the same circles and preserve classic rendering", () => {
  const meta = { cols: 2, rows: 1, cell: 2, fineDots: true, palette: ["#ff0000", "#00ff00"] };
  const svg = asciiFrameSvg("\u2801\u28ff", meta, new Uint8Array([0, 1]));
  assert(!svg.includes("<text"));
  assert.equal((svg.match(/<use /g) ?? []).length, 2);
  assert(svg.includes('href="#dot1" x="0" y="0" fill="#ff0000"'));
  assert(svg.includes('href="#dot255" x="6" y="0" fill="#00ff00"'));
  const calls = [];
  const ctx = new Proxy({ canvas: { width: 800, height: 400 } }, {
    get: (target, key) => key in target ? target[key] : (...args) => calls.push([key, ...args]),
  });
  drawAsciiFrame(ctx, "\u2801\u28ff", meta, new Uint8Array([0, 1]));
  assert.equal(calls.filter(([key]) => key === "arc").length, 9);
  assert.equal(calls.filter(([key]) => key === "fillText").length, 0);
  drawAsciiFrame(ctx, "AB", { ...meta, fineDots: false });
  assert.equal(calls.filter(([key]) => key === "fillText").length, 1);
  assert.deepEqual(asciiFrameBounds(800, 400, { ...meta, fullBleed: true }), { x: 0, y: 0, width: 800, height: 400 });
});

test("Fine dots GPU atlas draws geometry rather than operating-system glyphs", t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
  t.after(() => descriptor ? Object.defineProperty(globalThis, "OffscreenCanvas", descriptor) : delete globalThis.OffscreenCanvas);
  const canvases = [];
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      this.width = width; this.height = height; this.calls = []; canvases.push(this);
    }
    getContext() {
      return new Proxy({}, { get: (_, key) => key === "getImageData"
        ? () => ({ data: new Uint8Array(this.width * this.height * 4).fill(255) })
        : (...args) => this.calls.push([key, ...args]) });
    }
  };
  const gl = new Proxy({}, { get: (_, key) => {
    if (/^[A-Z_0-9]+$/.test(key)) return 1;
    if (key === "getShaderParameter" || key === "getProgramParameter") return () => true;
    return () => ({});
  } });
  const canvas = { width: 800, height: 400, getContext: () => gl };
  const render = createAsciiGpuRenderer(canvas, { cols: 1, rows: 1, cell: 2, fineDots: true });
  render("\u28ff");
  const atlasCalls = canvases[1].calls;
  assert.equal(atlasCalls.filter(([key]) => key === "arc").length, 8);
  assert.equal(atlasCalls.filter(([key]) => key === "fillText").length, 0);
});
