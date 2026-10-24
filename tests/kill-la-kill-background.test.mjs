import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import clip from "../src/renderer/src/vendor/ascii-rest/data/kill-la-kill.json" with { type: "json" };
import make, { meta } from "../src/renderer/src/vendor/ascii-rest/pieces/kill-la-kill.js";

test("kill-la-kill clip loops with stable dimensions, colour indices and frame caching", () => {
  const frame = make({});
  const color = new Uint8Array(meta.cols * meta.rows);
  const first = frame(0, { color });
  const firstColors = color.slice();
  const second = frame(1.5, { color });
  assert.equal(first.split("\n").length, meta.rows);
  assert(first.split("\n").every(line => line.length === meta.cols));
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

test("every packed kill-la-kill frame is complete and uses valid glyphs and colours", () => {
  assert.equal(clip.frames.length, 92);
  assert.equal(clip.fps, 14);
  const kinds = new Set();
  for (const packed of clip.frames) {
    kinds.add(packed[0]);
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

test("silent clip ships as an ASCII scene and has local static and animated previews", async () => {
  for (const kind of ["ascii-posters", "ascii-animations"]) {
    const bytes = await readFile(new URL(`../src/renderer/src/assets/${kind}/kill-la-kill.webp`, import.meta.url));
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

import { asciiFrameBounds } from "../src/renderer/src/features/terminal/asciiFrameBounds.ts";

test("kill-la-kill contain mode preserves full composition and proportions without cropping or stretching in wide, square and tall windows", () => {
  const artAspect = meta.cols / (meta.rows * (meta.cell ?? 2));
  assert.equal(meta.contain, true);

  // 1. Wide window (4:1): spans 100% height, horizontally centered, no cropping or distortion
  const wide = asciiFrameBounds(2400, 600, meta);
  assert(wide.x >= 0 && wide.x + wide.width <= 2400, "fits within width without clipping");
  assert.equal(wide.height, 600, "spans 100% height");
  assert(Math.abs(wide.width / wide.height - artAspect) < 1e-4, "preserves aspect ratio without stretching");
  assert(wide.x > 0, "centered horizontally");
  assert.equal(wide.y, 0, "aligns to height bounds");

  // 2. Square window (1:1): spans 100% width, vertically centered, no cropping or distortion
  const square = asciiFrameBounds(800, 800, meta);
  assert(square.y >= 0 && square.y + square.height <= 800, "fits within height without clipping");
  assert.equal(square.width, 800, "spans 100% width");
  assert(Math.abs(square.width / square.height - artAspect) < 1e-4, "preserves aspect ratio without stretching");
  assert.equal(square.x, 0, "spans edge to edge horizontally");
  assert(square.y > 0, "centered vertically");

  // 3. Tall window (portrait 1:2): spans 100% width, vertically centered, no cropping or distortion
  const tall = asciiFrameBounds(600, 1200, meta);
  assert(tall.y >= 0 && tall.y + tall.height <= 1200, "fits within height without clipping");
  assert.equal(tall.width, 600, "spans 100% width");
  assert(Math.abs(tall.width / tall.height - artAspect) < 1e-4, "preserves aspect ratio without stretching");
  assert.equal(tall.x, 0, "spans edge to edge horizontally");
  assert(tall.y > 0, "centered vertically");

  // 4. Standard 16:9 terminal (1920x1080): spans 100% width, vertically centered, no cropping or distortion
  const standard = asciiFrameBounds(1920, 1080, meta);
  assert.equal(standard.width, 1920, "spans 100% width");
  assert(standard.y > 0, "centered vertically with ground color fill");
  assert(Math.abs(standard.width / standard.height - artAspect) < 1e-4, "preserves aspect ratio");

  // 5. Transform scale and offset work correctly
  const baseline = asciiFrameBounds(1000, 500, meta);
  const zoomed = asciiFrameBounds(1000, 500, meta, 1, { scale: 150, offsetX: 10, offsetY: -5 });
  assert.equal(Math.round(zoomed.width), Math.round(baseline.width * 1.5));
  assert.equal(Math.round(zoomed.height), Math.round(baseline.height * 1.5));
  assert.notEqual(zoomed.x, baseline.x);
  assert.notEqual(zoomed.y, baseline.y);
});

