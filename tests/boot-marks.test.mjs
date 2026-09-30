import assert from "node:assert/strict";
import test from "node:test";
import { bootMarks, markBootOnce, resetBootMarksForTest } from "../src/renderer/src/lib/bootMarks.ts";
import { mainBootMarks, markMainBoot } from "../src/main/bootMarks.ts";

// A cheap always-on boot-phase mark list: each named phase should be recorded once, in call order,
// with a non-negative millisecond timestamp, and it must never grow unbounded or install a timer
// (it is compiled into every production build, not just a bench harness).

test("boot marks: first call per name is recorded, later calls for the same name are ignored", () => {
  resetBootMarksForTest();
  markBootOnce("appReady");
  markBootOnce("windowCreated");
  markBootOnce("appReady"); // duplicate: must not add a second entry or move the first
  const marks = bootMarks();
  assert.equal(marks.length, 2);
  assert.deepEqual(marks.map((mark) => mark.name), ["appReady", "windowCreated"]);
});

test("boot marks: timestamps are non-negative and non-decreasing in call order", () => {
  resetBootMarksForTest();
  markBootOnce("first");
  markBootOnce("second");
  const [first, second] = bootMarks();
  assert.ok(first.atMs >= 0);
  assert.ok(second.atMs >= first.atMs);
});

test("boot marks: publishes a snapshot on window for a bench harness to read", () => {
  resetBootMarksForTest();
  const fakeWindow = {};
  const realWindow = globalThis.window;
  globalThis.window = fakeWindow;
  try {
    markBootOnce("phase");
    const [published] = fakeWindow.__canvasTTYBootMarks;
    assert.equal(fakeWindow.__canvasTTYBootMarks.length, 1);
    assert.equal(published.name, "phase");
    assert.ok(Math.abs(published.epochMs - Date.now()) < 5_000, "epochMs is a wall-clock stamp");
  } finally {
    globalThis.window = realWindow;
  }
});

test("boot marks: recording marks installs no timer (no polling)", (t) => {
  resetBootMarksForTest();
  const originalSetInterval = globalThis.setInterval;
  let intervalCalls = 0;
  globalThis.setInterval = (...args) => { intervalCalls += 1; return originalSetInterval(...args); };
  t.after(() => { globalThis.setInterval = originalSetInterval; });
  markBootOnce("a");
  markBootOnce("b");
  markBootOnce("c");
  assert.equal(intervalCalls, 0);
});

test("main boot marks: once per name, in ms since process start, published for an in-process harness", () => {
  markMainBoot("appReady");
  markMainBoot("windowCreated");
  markMainBoot("appReady");
  const marks = mainBootMarks().filter((mark) => mark.name === "appReady" || mark.name === "windowCreated");
  assert.deepEqual(marks.map((mark) => mark.name), ["appReady", "windowCreated"]);
  assert.ok(marks[0].atMs >= 0 && marks[0].atMs <= process.uptime() * 1000 + 50);
  assert.ok(marks[1].atMs >= marks[0].atMs);
  assert.equal(globalThis.__canvasTTYMainBootMarks, mainBootMarks());
});
