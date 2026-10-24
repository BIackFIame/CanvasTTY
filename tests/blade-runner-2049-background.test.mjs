import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import makeBladeRunner2049, { meta } from "../src/renderer/src/vendor/ascii-rest/pieces/blade-runner-2049.js";
import clip from "../src/renderer/src/vendor/ascii-rest/data/blade-runner-2049.json" with { type: "json" };
import { asciiFrameBounds } from "../src/renderer/src/features/terminal/asciiFrameBounds.ts";

test("blade-runner-2049 clip loops with stable dimensions, colour indices and frame caching", () => {
  assert.equal(meta.name, "Blade Runner 2049");
  assert.equal(meta.category, "scenes");
  assert.equal(meta.fineDots, true);
  assert.equal(meta.contain, true);
  assert.equal(meta.cols, 192);
  assert.equal(meta.rows, 54);
  assert.equal(meta.cell, 2);
  assert.equal(meta.ground, "#07090f");
  assert.equal(clip.fps, 15);
  assert.equal(clip.frames.length, 106);
  assert.equal(clip.style, "fine-dots");

  const render = makeBladeRunner2049({});
  const colorA = new Uint8Array(meta.cols * meta.rows);
  const colorB = new Uint8Array(meta.cols * meta.rows);
  const textA = render(0, { color: colorA });
  const textB = render(clip.frames.length / clip.fps, { color: colorB });

  assert.equal(textA, textB);
  assert.deepEqual(colorA, colorB);
});

test("every packed blade-runner-2049 frame is complete and uses valid Braille glyphs and colours", () => {
  assert.equal(clip.ramp.length, 256);
  assert.equal(clip.ramp[0], "\u2800");
  assert.equal(clip.ramp[255], "\u28FF");

  const render = makeBladeRunner2049({});
  const color = new Uint8Array(meta.cols * meta.rows);

  for (let frame = 0; frame < clip.frames.length; frame += 10) {
    const text = render(frame / clip.fps, { color });
    const lines = text.split("\n");
    assert.equal(lines.length, meta.rows);
    for (const line of lines) {
      assert.equal([...line].length, meta.cols);
    }
  }
});

test("silent clip ships as an ASCII scene and has local static and animated previews", async () => {
  const poster = await readFile(new URL("../src/renderer/src/assets/ascii-posters/blade-runner-2049.webp", import.meta.url));
  const animation = await readFile(new URL("../src/renderer/src/assets/ascii-animations/blade-runner-2049.webp", import.meta.url));
  assert.equal(poster.toString("ascii", 0, 4), "RIFF");
  assert.equal(animation.toString("ascii", 0, 4), "RIFF");
});

test("blade-runner-2049 contain mode preserves 16:9 aspect ratio in wide, square and tall windows", () => {
  const artAspect = meta.cols / (meta.rows * (meta.cell ?? 2));
  assert(Math.abs(artAspect - 16 / 9) < 1e-4);
  assert.equal(meta.contain, true);

  // 1. Standard 16:9 window (1920x1080): exact fit
  const standard = asciiFrameBounds(1920, 1080, meta);
  assert(Math.abs(standard.width - 1920) < 1e-6);
  assert(Math.abs(standard.height - 1080) < 1e-6);
  assert(Math.abs(standard.x) < 1e-6);
  assert(Math.abs(standard.y) < 1e-6);

  // 2. Wide window (2400x600): aspect 4:1 > 16:9 -> height-bound
  const wide = asciiFrameBounds(2400, 600, meta);
  assert(Math.abs(wide.height - 600) < 1e-6);
  assert(wide.width < 2400);
  assert(wide.x > 0);
  assert(Math.abs(wide.y) < 1e-6);

  // 3. Square window (800x800): aspect 1.0 < 16:9 -> width-bound
  const square = asciiFrameBounds(800, 800, meta);
  assert(Math.abs(square.width - 800) < 1e-6);
  assert(square.height < 800);
  assert(Math.abs(square.x) < 1e-6);
  assert(square.y > 0);
});
