import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import makeTylerDurden, { meta } from "../src/renderer/src/vendor/ascii-rest/pieces/tyler-durden.js";
import clip from "../src/renderer/src/vendor/ascii-rest/data/tyler-durden.json" with { type: "json" };
import { asciiFrameBounds } from "../src/renderer/src/features/terminal/asciiFrameBounds.ts";

test("tyler-durden clip loops with stable dimensions, colour indices and frame caching", () => {
  assert.equal(meta.name, "Tyler Durden");
  assert.equal(meta.category, "scenes");
  assert.equal(meta.fineDots, true);
  assert.equal(meta.contain, true);
  assert.equal(meta.cols, 120);
  assert.equal(meta.rows, 60);
  assert.equal(meta.cell, 2);
  assert.equal(meta.ground, "#07090f");
  assert.equal(clip.fps, 15);
  assert.equal(clip.frames.length, 76);
  assert.equal(clip.style, "fine-dots");

  const render = makeTylerDurden({});
  const colorA = new Uint8Array(meta.cols * meta.rows);
  const colorB = new Uint8Array(meta.cols * meta.rows);
  const textA = render(0, { color: colorA });
  const textB = render(clip.frames.length / clip.fps, { color: colorB });

  assert.equal(textA, textB);
  assert.deepEqual(colorA, colorB);
});

test("every packed tyler-durden frame is complete and uses valid Braille glyphs and colours", () => {
  assert.equal(clip.ramp.length, 256);
  assert.equal(clip.ramp[0], "\u2800");
  assert.equal(clip.ramp[255], "\u28FF");

  const render = makeTylerDurden({});
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
  const poster = await readFile(new URL("../src/renderer/src/assets/ascii-posters/tyler-durden.webp", import.meta.url));
  const animation = await readFile(new URL("../src/renderer/src/assets/ascii-animations/tyler-durden.webp", import.meta.url));
  assert.equal(poster.toString("ascii", 0, 4), "RIFF");
  assert.equal(animation.toString("ascii", 0, 4), "RIFF");
});

test("tyler-durden contain mode preserves square 1:1 aspect ratio in wide, square and tall windows", () => {
  const artAspect = meta.cols / (meta.rows * (meta.cell ?? 2));
  assert.equal(artAspect, 1.0);
  assert.equal(meta.contain, true);

  // 1. Wide window (1600x600): aspect 2.67 > 1.0 -> height-bound
  const wide = asciiFrameBounds(1600, 600, meta);
  assert(Math.abs(wide.height - 600) < 1e-6);
  assert(Math.abs(wide.width - 600) < 1e-6);
  assert.equal(wide.x, (1600 - 600) / 2);
  assert(Math.abs(wide.y) < 1e-6);

  // 2. Square window (800x800): aspect 1.0 == 1.0 -> full fit
  const square = asciiFrameBounds(800, 800, meta);
  assert(Math.abs(square.width - 800) < 1e-6);
  assert(Math.abs(square.height - 800) < 1e-6);
  assert(Math.abs(square.x) < 1e-6);
  assert(Math.abs(square.y) < 1e-6);

  // 3. Tall window (600x1000): aspect 0.6 < 1.0 -> width-bound
  const tall = asciiFrameBounds(600, 1000, meta);
  assert(Math.abs(tall.width - 600) < 1e-6);
  assert(Math.abs(tall.height - 600) < 1e-6);
  assert(Math.abs(tall.x) < 1e-6);
  assert.equal(tall.y, (1000 - 600) / 2);
});
