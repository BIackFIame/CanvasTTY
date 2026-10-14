import assert from "node:assert/strict";
import test from "node:test";
import { clearPreservedWebglFrames } from "../src/renderer/src/features/terminal/terminalWebglFrames.ts";

test("transparent frames replace old glyphs while the completed frame remains available for snapshots", () => {
  const pixels = new Set(["old glyph"]);
  const gl = { COLOR_BUFFER_BIT: 16384, clearColor: (...rgba) => assert.deepEqual(rgba, [0, 0, 0, 0]),
    clear: (mask) => { assert.equal(mask, 16384); pixels.clear(); } };
  const renderer = { _gl: gl, renderRows(start, end) { assert.equal(this, renderer); pixels.add(`${start}:${end}`); } };
  assert.equal(clearPreservedWebglFrames({ _renderer: renderer }), true);
  renderer.renderRows(0, 23);
  assert.deepEqual([...pixels], ["0:23"]);
  renderer.renderRows(4, 5);
  assert.deepEqual([...pixels], ["4:5"]);
});

test("a changed xterm renderer contract is refused so the card can fall back to DOM", () => {
  assert.equal(clearPreservedWebglFrames({}), false);
});
