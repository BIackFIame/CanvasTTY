import assert from "node:assert/strict";
import test from "node:test";
import { terminalLinkTarget } from "../src/renderer/src/features/terminal/terminalLinkTarget.ts";

function bufferLine(text, isWrapped = false) {
  return { isWrapped, translateToString: (_trimRight, start, end) => text.slice(start, end) };
}

function target(uri, visible, options = {}) {
  const {
    columns = 80,
    startX = 1,
    y = 1,
    isWrapped = false,
    endX = startX + visible.length - 1,
    lines = new Map([[y - 1, bufferLine(`${" ".repeat(startX - 1)}${visible}`, isWrapped)]])
  } = options;
  const range = { start: { x: startX, y }, end: { x: endX, y } };
  return terminalLinkTarget(uri, range, { getLine: (index) => lines.get(index) }, columns);
}

test("a complete one-row visible URL wins over a stale or truncated OSC 8 target", () => {
  assert.equal(
    target("https://stuckfunds/", "https://stuckfunds.eth.limo/", { startX: 7 }),
    "https://stuckfunds.eth.limo/"
  );
});

test("descriptive link labels keep their explicit OSC 8 target", () => {
  assert.equal(target("https://example.com/docs", "Open documentation"), "https://example.com/docs");
});

test("row-local pieces of wrapped OSC 8 labels never replace the target", () => {
  const targetUrl = "https://safe.example/";
  assert.equal(
    target(targetUrl, "https://evil.com", { columns: 16, endX: 16 }),
    targetUrl,
    "a first-row fragment touching the right edge is incomplete"
  );
  assert.equal(
    target(targetUrl, ".trusted.com/", { isWrapped: true }),
    targetUrl,
    "a continuation row is incomplete even if its fragment looks URL-like"
  );
});

test("invalid, credentialed, malformed-host, overlength, and unavailable visible labels retain the target", () => {
  const safe = "https://safe.example/";
  for (const visible of [
    "javascript:alert(1)",
    "https://user:secret@example.com/",
    "https://example",
    "https://./",
    "https://../",
    "https://foo../",
    `https://example.com/${"a".repeat(2_100)}`
  ]) {
    assert.equal(target(safe, visible, { columns: 4_096 }), safe, visible);
  }
  assert.equal(
    terminalLinkTarget(
      safe,
      { start: { x: 1, y: 2 }, end: { x: 20, y: 2 } },
      { getLine: () => undefined },
      80
    ),
    safe
  );
});
