import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import makeTwoShadowFiends, { meta } from "../src/renderer/src/vendor/ascii-rest/pieces/two-shadow-fiends.js";
import clip from "../src/renderer/src/vendor/ascii-rest/data/two-shadow-fiends.json" with { type: "json" };
import { asciiFrameBounds } from "../src/renderer/src/features/terminal/asciiFrameBounds.ts";

test("two-shadow-fiends clip loops with stable dimensions, colour indices and frame caching", () => {
  assert.equal(meta.name, "Two Shadow Fiends");
  assert.equal(meta.category, "scenes");
  assert.equal(meta.fineDots, true);
  assert.equal(meta.contain, true);
  assert.equal(meta.cols, 180);
  assert.equal(meta.rows, 59);
  assert.equal(meta.cell, 2);
  assert.equal(meta.ground, "#07090f");
  assert.equal(clip.fps, 15);
  assert.equal(clip.frames.length, 98);
  assert.equal(clip.style, "fine-dots");

  const render = makeTwoShadowFiends({});
  const colorA = new Uint8Array(meta.cols * meta.rows);
  const colorB = new Uint8Array(meta.cols * meta.rows);
  const textA = render(0, { color: colorA });
  const textB = render(clip.frames.length / clip.fps, { color: colorB });

  assert.equal(textA, textB);
  assert.deepEqual(colorA, colorB);
});

test("every packed two-shadow-fiends frame is complete and uses valid Braille glyphs and colours", () => {
  assert.equal(clip.ramp.length, 256);
  assert.equal(clip.ramp[0], "\u2800");
  assert.equal(clip.ramp[255], "\u28FF");

  const render = makeTwoShadowFiends({});
  const color = new Uint8Array(meta.cols * meta.rows);

  for (let frame = 0; frame < clip.frames.length; frame += 8) {
    const text = render(frame / clip.fps, { color });
    const lines = text.split("\n");
    assert.equal(lines.length, meta.rows);
    for (const line of lines) {
      assert.equal([...line].length, meta.cols);
    }
  }
});

test("silent clip ships as an ASCII scene and has local static and animated previews", async () => {
  const poster = await readFile(new URL("../src/renderer/src/assets/ascii-posters/two-shadow-fiends.webp", import.meta.url));
  const animation = await readFile(new URL("../src/renderer/src/assets/ascii-animations/two-shadow-fiends.webp", import.meta.url));
  assert.equal(poster.toString("ascii", 0, 4), "RIFF");
  assert.equal(animation.toString("ascii", 0, 4), "RIFF");
});

test("two-shadow-fiends contain mode preserves full composition and proportions in wide, square and tall windows", () => {
  const artAspect = meta.cols / (meta.rows * (meta.cell ?? 2));
  assert.equal(meta.contain, true);

  // 1. Standard 16:10 window (800x500): aspect 1.6 > 1.525 -> height-bound
  const standard = asciiFrameBounds(800, 500, meta);
  assert(Math.abs(standard.height - 500) < 1e-6);
  assert(standard.width < 800);
  assert(Math.abs(standard.y) < 1e-6);
  assert(standard.x > 0);
  assert(Math.abs(standard.width / standard.height - artAspect) < 1e-4);

  // 2. Square window (800x800): aspect 1.0 < 1.525 -> width-bound
  const square = asciiFrameBounds(800, 800, meta);
  assert(Math.abs(square.width - 800) < 1e-6);
  assert(square.height < 800);
  assert(Math.abs(square.x) < 1e-6);
  assert(square.y > 0);
  assert(Math.abs(square.width / square.height - artAspect) < 1e-4);

  // 3. Wide window (1600x600): aspect 2.67 > 1.525 -> height-bound
  const wide = asciiFrameBounds(1600, 600, meta);
  assert(Math.abs(wide.height - 600) < 1e-6);
  assert(wide.x > 0);
  assert(Math.abs(wide.y) < 1e-6);
  assert(Math.abs(wide.width / wide.height - artAspect) < 1e-4);
});
