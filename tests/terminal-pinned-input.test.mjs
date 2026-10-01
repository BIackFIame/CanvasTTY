import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { limitPinnedTerminalInput, pinnedTerminalInput } from "../src/renderer/src/features/terminal/terminalPinnedInput.ts";

function buffer(overrides = {}) {
  const lines = new Map([[12, { text: "  ask something   ", isWrapped: false }]]);
  return {
    type: "normal",
    baseY: 10,
    viewportY: 3,
    cursorY: 2,
    cursorX: 15,
    getLine(index) {
      const line = lines.get(index);
      return line === undefined ? undefined : {
        isWrapped: line.isWrapped,
        translateToString: (trimRight) => trimRight ? line.text.trimEnd() : line.text
      };
    },
    ...overrides
  };
}

function wrappedBuffer() {
  const lines = new Map([
    [10, { text: "prompt> abcdef", isWrapped: false }],
    [11, { text: "ghijklmnop", isWrapped: true }],
    [12, { text: "qrstuv   ", isWrapped: true }]
  ]);
  return buffer({
    baseY: 10,
    cursorY: 1,
    cursorX: 4,
    getLine(index) {
      const line = lines.get(index);
      return line === undefined ? undefined : {
        isWrapped: line.isWrapped,
        translateToString: (trimRight) => trimRight ? line.text.trimEnd() : line.text
      };
    }
  });
}

test("a scrolled normal terminal pins its complete live cursor line", () => {
  assert.deepEqual(pinnedTerminalInput(buffer()), {
    rows: ["  ask something"], cursorRow: 0, cursorColumn: 15
  });
});

test("wrapped input keeps every physical row and the cursor's row and column", () => {
  assert.deepEqual(pinnedTerminalInput(wrappedBuffer()), {
    rows: ["prompt> abcdef", "ghijklmnop", "qrstuv"],
    cursorRow: 1,
    cursorColumn: 4
  });
});

test("long wrapped input is bounded while keeping the cursor and nearby rows visible", () => {
  const input = {
    rows: Array.from({ length: 20 }, (_, index) => `row-${index}`),
    cursorRow: 17,
    cursorColumn: 6
  };
  assert.deepEqual(limitPinnedTerminalInput(input, 5), {
    rows: ["row-15", "row-16", "row-17", "row-18", "row-19"],
    cursorRow: 2,
    cursorColumn: 6
  });
});

test("the pinned row disappears at the live bottom and in alternate-screen TUIs", () => {
  assert.equal(pinnedTerminalInput(buffer({ viewportY: 10 })), null);
  assert.equal(pinnedTerminalInput(buffer({ type: "alternate" })), null);
});

test("a missing cursor row does not leave a stale pinned input", () => {
  assert.equal(pinnedTerminalInput(buffer({ getLine: () => undefined })), null);
});

test("TerminalCard refreshes and reserves room for the pinned logical line", async () => {
  const source = await readFile(new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url), "utf8");
  assert.match(source, /scrollOnUserInput:\s*false/);
  assert.match(source, /pinnedTerminalInput\(terminal\.buffer\.active\)/);
  assert.match(source, /limitPinnedTerminalInput\(completePinned, maxPinnedRows\)/);
  assert.match(source, /host\.clientHeight[^\n]*\/\s*2/);
  assert.match(source, /host\.append\(pinnedInput\)/);
  assert.match(source, /terminal-card__surface--pinned-input/);
  assert.match(source, /--pinned-input-height/);
  assert.match(source, /--pinned-cursor-column/);
  assert.match(source, /terminal\.onScroll\(updatePinnedInput\)/);
  assert.match(source, /terminal\.onCursorMove\(updatePinnedInput\)/);
  assert.match(source, /terminal\.onWriteParsed\(updatePinnedInput\)/);
});

test("the pinned input uses reserved terminal space and does not intercept selection", async () => {
  const css = await readFile(new URL("../src/renderer/src/styles/app.css", import.meta.url), "utf8");
  assert.match(css, /\.terminal-card__surface\.terminal-card__surface--pinned-input \.xterm\s*\{[^}]*height:\s*calc\(100%\s*-\s*var\(--pinned-input-height/s);
  assert.match(css, /\.terminal-card__pinned-input\s*\{[^}]*position:\s*absolute;[^}]*bottom:\s*0;[^}]*pointer-events:\s*none;/s);
  assert.match(css, /\.terminal-card__pinned-input-row--cursor::after\s*\{[^}]*left:\s*calc\(var\(--pinned-cursor-column\)[^}]*width:\s*calc\(100%\s*\/\s*var\(--pinned-terminal-columns\)/s);
  assert.match(css, /font-variant-ligatures:\s*none/);
});
