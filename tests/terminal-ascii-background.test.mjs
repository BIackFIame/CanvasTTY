import assert from "node:assert/strict";
import test from "node:test";
import { readdir } from "node:fs/promises";
import { TERMINAL_BACKGROUNDS, TERMINAL_BACKGROUND_CATALOG, isTerminalBackgroundId } from "../src/shared/terminalBackground.ts";
import { asciiFrameSvg } from "../src/renderer/src/features/terminal/asciiFrameSvg.ts";
import { drawAsciiFrame } from "../src/renderer/src/features/terminal/asciiFrameCanvas.ts";
import { asciiFrameBounds } from "../src/renderer/src/features/terminal/asciiFrameBounds.ts";

test("manual zoom and offsets apply equally to full scenes and objects while defaults stay unchanged", () => {
  for (const meta of [{ cols: 200, rows: 100, cell: 1 }, { cols: 46, rows: 28 }]) {
    const base = asciiFrameBounds(800, 600, meta, 2);
    assert.deepEqual(asciiFrameBounds(800, 600, meta, 2, { scale: 100, offsetX: 0, offsetY: 0 }), base);
    const zoom = asciiFrameBounds(800, 600, meta, 2, { scale: 200, offsetX: 25, offsetY: -20 });
    assert.equal(zoom.width, base.width * 2);
    assert.equal(zoom.height, base.height * 2);
    assert.equal(zoom.x + zoom.width / 2, 600);
    assert.equal(zoom.y + zoom.height / 2, 180);
    const small = asciiFrameBounds(800, 600, meta, 2, { scale: 25, offsetX: 0, offsetY: 0 });
    assert.equal(small.width, base.width / 4);
    assert.equal(small.height, base.height / 4);
  }
});

test("Apple and other character art keep equal horizontal and vertical scale in wide and tall terminals", () => {
  const meta = { cols: 46, rows: 28 };
  for (const [width, height] of [[760, 440], [300, 900], [1400, 801]]) {
    const bounds = asciiFrameBounds(width, height, meta);
    assert(Math.abs(bounds.width / (46 * 6) - bounds.height / (28 * 12)) < 1e-10);
    assert(bounds.width <= width && bounds.height <= height);
    assert.equal(bounds.x * 2 + bounds.width, width);
    assert.equal(bounds.y * 2 + bounds.height, height);
  }
  assert.deepEqual(asciiFrameBounds(760, 440, { cols: 200, rows: 100, cell: 1 }), { x: 0, y: 0, width: 760, height: 440 });
});

test("3D backgrounds keep fine character size as terminals grow, including HiDPI displays", () => {
  for (const meta of [{ cols: 40, rows: 22 }, { cols: 64, rows: 20 }]) {
    const regular = asciiFrameBounds(1060, 710, meta);
    const enlarged = asciiFrameBounds(1800, 1100, meta);
    const hidpi = asciiFrameBounds(2120, 1420, meta, 2);
    assert.equal(regular.width, enlarged.width, 'larger terminals must not enlarge the ASCII characters');
    assert.equal(regular.height, enlarged.height);
    assert.equal(regular.width / meta.cols, 7.5);
    assert.equal(hidpi.width / 2, regular.width, 'CSS size stays the same on HiDPI');
    assert.equal(hidpi.height / 2, regular.height);
    const compact = asciiFrameBounds(120, 90, meta);
    assert(compact.width <= 96 && compact.height <= 72);
  }
});

test("the 2D fallback clears each frame without retaining clipping regions or old pixels", () => {
  const calls = [];
  const ctx = new Proxy({ canvas: { width: 800, height: 600 } }, {
    get(target, key) { return key in target ? target[key] : (...args) => calls.push([key, ...args]); },
  });
  const meta = { cols: 2, rows: 2, cell: 1, palette: ['#ff0000', '#00ff00'] };
  drawAsciiFrame(ctx, 'AA\nBB', meta, new Uint8Array([0, 0, 1, 1]));
  drawAsciiFrame(ctx, '', meta);
  assert.equal(calls.filter(([key]) => key === 'fillRect').length, 2);
  assert.equal(calls.filter(([key]) => key === 'fillText').length, 2);
  assert.equal(calls.filter(([key]) => key === 'save').length, calls.filter(([key]) => key === 'restore').length);
  assert(calls.some((call) => JSON.stringify(call) === JSON.stringify(['fillText', 'BB', 0, 9, 12])));
});

test("vector frames keep cell alignment, escape text and fill arbitrary terminal dimensions", () => {
  const svg = asciiFrameSvg('<&\nAB', { cols: 2, rows: 2, cell: 1, palette: ['#ff0000', '#00ff00'] }, new Uint8Array([0, 1, 1, 1]));
  assert(svg.includes('viewBox="0 0 12 12" preserveAspectRatio="none"'));
  assert(svg.includes('textLength="12" lengthAdjust="spacingAndGlyphs"'));
  assert(svg.includes('fill="#00ff00">AB</text>'));
  assert(svg.includes('&lt;</text>'));
  assert(svg.includes('&amp;</text>'));
  assert(!svg.includes('<canvas'));
});

test("the complete catalogue has a local selectable module for each of its 217 pieces", async () => {
  const files = await readdir(new URL("../node_modules/ascii.rest/dist/pieces/", import.meta.url));
  assert.equal(TERMINAL_BACKGROUNDS.length, 217);
  assert.equal(new Set(TERMINAL_BACKGROUNDS).size, 217);
  assert.equal(new Set(TERMINAL_BACKGROUND_CATALOG.map((piece) => piece.category)).size, 15);
  for (const id of TERMINAL_BACKGROUNDS) {
    assert(files.includes(`${id}.js`), id);
    assert(isTerminalBackgroundId(id), id);
  }
  assert(!isTerminalBackgroundId("../remote"));
});

test("every bundled animation renders and coloured scenes produce valid changing frames", async () => {
  for (const scene of TERMINAL_BACKGROUNDS) {
    const { meta, default: make } = await import(`ascii.rest/pieces/${scene}`);
    const frame = make({});
    const color = new Uint8Array((meta.cols ?? 80) * (meta.rows ?? 24));
    const env = { paper: false, color };
    const first = frame(0, env);
    const firstColor = color.slice();
    const second = frame(1, env);
    const svg = asciiFrameSvg(second, meta, color);
    assert(svg.startsWith('<svg xmlns='), scene);
    assert(!svg.includes('NaN') && !svg.includes('undefined'), scene);
    assert.equal(typeof first, "string", scene);
    assert.equal(typeof second, "string", scene);
    assert(first.length > 0 || second.length > 0, scene);
    if (meta.palette) assert(color.every((index) => index < meta.palette.length), scene);
    if (meta.category === "scenes") {
      assert.equal(first.split("\n").length, meta.rows, scene);
      assert(first.split("\n").every((row) => [...row].length === meta.cols), scene);
      assert(first !== second || !firstColor.every((value, index) => value === color[index]), `${scene} must animate`);
    }
  }
});
