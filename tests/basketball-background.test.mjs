import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import clip from "../src/renderer/src/vendor/ascii-rest/data/basketball-neon.json" with { type: "json" };
import make, { meta } from "../src/renderer/src/vendor/ascii-rest/pieces/basketball-neon.js";
import glockClip from "../src/renderer/src/vendor/ascii-rest/data/glock-spin.json" with { type: "json" };
import makeGlock, { meta as glockMeta } from "../src/renderer/src/vendor/ascii-rest/pieces/glock-spin.js";
import { asciiFrameBounds } from "../src/renderer/src/features/terminal/asciiFrameBounds.ts";

for (const scene of [
  { id: "basketball-neon", clip, make, meta, expectedFrames: 110 },
  { id: "glock-spin", clip: glockClip, make: makeGlock, meta: glockMeta, expectedFrames: 48 },
]) {
const { id, clip, make, meta, expectedFrames } = scene;

test(id + " loops with stable dimensions, colour indices and frame caching", () => {
  const frame = make({});
  const color = new Uint8Array(meta.cols * meta.rows);
  const first = frame(0, { color });
  const firstColors = color.slice();
  const second = frame(1.5, { color });
  assert.equal(first.split("\n").length, meta.rows);
  assert(first.split("\n").every(line => line.length === meta.cols));
  assert([...first.replaceAll("\n", "")].every(char => char.charCodeAt(0) >= 0x2800 && char.charCodeAt(0) <= 0x28ff));
  assert.notEqual(first, second);
  assert(color.some((value, index) => value !== firstColors[index]));
  assert(color.every(value => value < meta.palette.length));
  assert.equal(frame(clip.frames.length / clip.fps, { color }), first);
  assert.deepEqual(color, firstColors);
  assert.equal(frame(-1 / clip.fps, { color }), frame((clip.frames.length - 1) / clip.fps, { color }));
  assert.equal(frame(1.5, { color }), second);
  color.fill(0);
  assert.equal(frame(1.5, { color }), second);
  assert(color.some(value => value !== 0), "cached frames still populate each caller's colour buffer");
});

test(id + " packed frames are complete and use valid glyphs and colours", () => {
  assert.equal(clip.frames.length, expectedFrames);
  assert.equal(clip.fps, 12);
  assert.equal(clip.style, "fine-dots");
  assert.equal(meta.fineDots, true);
  assert.equal(clip.ramp.length, 256);
  assert([...clip.ramp].every(char => char.charCodeAt(0) >= 0x2800 && char.charCodeAt(0) <= 0x28ff));
  for (const packed of clip.frames) {
    const bytes = Buffer.from(packed.slice(1), "base64");
    let cells = 0;
    if (packed[0] === "r") {
      assert.equal(bytes.length % 3, 0);
      for (let pos = 0; pos < bytes.length; pos += 3) {
        assert(bytes[pos] > 0);
        assert(bytes[pos + 1] < clip.ramp.length);
        assert(bytes[pos + 2] < clip.palette.length);
        cells += bytes[pos];
      }
    } else {
      assert.equal(packed[0], "p");
      assert.equal(bytes.length % 2, 0);
      cells = bytes.length / 2;
      for (let pos = 0; pos < bytes.length; pos += 2) assert(bytes[pos] < clip.ramp.length);
    }
    assert.equal(cells, meta.cols * meta.rows);
  }
});

test(id + " ships with local previews and decodes within its frame budget", async () => {
  for (const kind of ["ascii-posters", "ascii-animations"]) {
    const bytes = await readFile(new URL(`../src/renderer/src/assets/${kind}/${id}.webp`, import.meta.url));
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.toString("ascii", 8, 12), "WEBP");
  }
  const frame = make({});
  const color = new Uint8Array(meta.cols * meta.rows);
  const start = performance.now();
  for (let index = 0; index < clip.frames.length; index++) frame(index / meta.fps, { color });
  const average = (performance.now() - start) / clip.frames.length;
  assert(average < 50, "precomputed frames should leave most of the 83ms worker frame budget free");
});
}

test("Glock preserves its square scene proportions in wide and tall terminals", () => {
  for (const [width, height] of [[1400, 500], [400, 1000], [800, 800]]) {
    const bounds = asciiFrameBounds(width, height, glockMeta);
    assert.equal(bounds.width, bounds.height);
    assert(bounds.width <= width && bounds.height <= height);
    assert.equal(bounds.x * 2 + bounds.width, width);
    assert.equal(bounds.y * 2 + bounds.height, height);
  }
});
