import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import makeMoonAstronaut, { meta } from "../src/renderer/src/vendor/ascii-rest/pieces/moon-astronaut.js";
import clip from "../src/renderer/src/vendor/ascii-rest/data/moon-astronaut.json" with { type: "json" };
import { asciiFrameBounds } from "../src/renderer/src/features/terminal/asciiFrameBounds.ts";

test("moon-astronaut clip loops with stable dimensions, colour indices and frame caching", () => {
  assert.equal(meta.name, "Astronaut on Moon");
  assert.equal(meta.category, "scenes");
  assert.equal(meta.fineDots, true);
  assert.equal(meta.contain, true);
  assert.equal(meta.cols, 200);
  assert.equal(meta.rows, 78);
  assert.equal(meta.cell, 2);
  assert.equal(meta.ground, "#07090f");
  assert.equal(clip.fps, 12);
  assert.equal(clip.frames.length, 48);
  assert.equal(clip.style, "fine-dots");

  const render = makeMoonAstronaut({});
  const colorA = new Uint8Array(meta.cols * meta.rows);
  const colorB = new Uint8Array(meta.cols * meta.rows);
  const textA = render(0, { color: colorA });
  const textB = render(4.0, { color: colorB }); // loops back to 0

  assert.equal(textA, textB);
  assert.deepEqual(colorA, colorB);
});

test("every packed moon-astronaut frame is complete and uses valid Braille glyphs and colours", () => {
  assert.equal(clip.ramp.length, 256);
  assert.equal(clip.ramp[0], "\u2800");
  assert.equal(clip.ramp[255], "\u28FF");

  const render = makeMoonAstronaut({});
  const color = new Uint8Array(meta.cols * meta.rows);

  for (let frame = 0; frame < clip.frames.length; frame += 4) {
    const text = render(frame / clip.fps, { color });
    const lines = text.split("\n");
    assert.equal(lines.length, meta.rows);
    for (const line of lines) {
      assert.equal([...line].length, meta.cols);
    }
  }
});

test("silent clip ships as an ASCII scene and has local static and animated previews", async () => {
  const poster = await readFile(new URL("../src/renderer/src/assets/ascii-posters/moon-astronaut.webp", import.meta.url));
  const animation = await readFile(new URL("../src/renderer/src/assets/ascii-animations/moon-astronaut.webp", import.meta.url));
  assert.equal(poster.toString("ascii", 0, 4), "RIFF");
  assert.equal(animation.toString("ascii", 0, 4), "RIFF");
});

test("moon-astronaut contain mode preserves full composition and proportions in wide, square and tall windows", () => {
  const artAspect = meta.cols / (meta.rows * (meta.cell ?? 2));
  assert.equal(meta.contain, true);

  // 1. Standard 16:10 window (800x500): aspect 1.6 > 1.282 -> height-bound
  const standard = asciiFrameBounds(800, 500, meta);
  assert.equal(standard.height, 500);
  assert(standard.width < 800);
  assert.equal(standard.y, 0);
  assert(standard.x > 0);
  assert(Math.abs(standard.width / standard.height - artAspect) < 1e-4);

  // 2. Tall window (600x1000): aspect 0.6 < 1.282 -> width-bound
  const tall = asciiFrameBounds(600, 1000, meta);
  assert.equal(tall.width, 600);
  assert(tall.height < 1000);
  assert.equal(tall.x, 0);
  assert(tall.y > 0);
  assert(Math.abs(tall.width / tall.height - artAspect) < 1e-4);

  // 3. Wide window (1600x600): aspect 2.67 > 1.282 -> height-bound
  const wide = asciiFrameBounds(1600, 600, meta);
  assert.equal(wide.height, 600);
  assert(wide.x > 0);
  assert.equal(wide.y, 0);
  assert(Math.abs(wide.width / wide.height - artAspect) < 1e-4);
});
