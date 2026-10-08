import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { NativeViewSync } from "../src/main/services/browser/NativeViewSync.ts";

class CountingView {
  calls = [];
  webContents = { setBackgroundThrottling: (allowed) => this.calls.push(["throttling", allowed]) };
  setBounds(bounds) { this.calls.push(["bounds", bounds]); }
  setVisible(visible) { this.calls.push(["visible", visible]); }
  setBorderRadius(radius) { this.calls.push(["radius", radius]); }
}

/** Direct Electron calls, as BrowserService made them before. */
const direct = {
  setBounds: (view, bounds) => view.setBounds(bounds),
  setVisible: (view, visible) => view.setVisible(visible),
  setBorderRadius: (view, radius) => view.setBorderRadius(radius),
  setBackgroundThrottling: (target, allowed) => target.setBackgroundThrottling(allowed)
};

/** The calls one native-surface syncViews makes: other tabs hidden, the active page placed and shown. */
function syncNative(native, clip, tabs, viewport) {
  const [active, ...others] = tabs;
  for (const tab of others) {
    native.setVisible(tab, false);
    native.setBackgroundThrottling(tab.webContents, true);
  }
  native.setBounds(clip, { x: Math.max(viewport.x, 0), y: Math.max(viewport.y, 0), width: 800, height: 600 });
  native.setBounds(active, { x: Math.min(viewport.x, 0), y: Math.min(viewport.y, 0), width: 800, height: 600 });
  native.setBorderRadius(active, 12);
  native.setVisible(active, true);
  native.setBackgroundThrottling(active.webContents, false);
  native.setVisible(clip, true);
}

function run(native) {
  const clip = new CountingView();
  const tabs = [new CountingView(), new CountingView(), new CountingView()];
  // A 100-step canvas pan (every step moves the page), then 50 syncs that change nothing
  // (window moves, gesture ends, a repeated viewport report).
  for (let step = 0; step < 100; step += 1) syncNative(native, clip, tabs, { x: 40 + step, y: 30 });
  for (let step = 0; step < 50; step += 1) syncNative(native, clip, tabs, { x: 139, y: 30 });
  return [clip, ...tabs].reduce((total, view) => total + view.calls.length, 0);
}

test("a sync that changes nothing makes no native view call; a pan only moves the clip", () => {
  const before = run(direct);
  const after = run(new NativeViewSync());
  // Before: 10 calls per sync (2 per hidden tab, bounds x2, radius, visible x2, throttling) x 150 syncs.
  assert.equal(before, 1_500);
  // After: the first sync sets everything (10); each later pan step moves only the clip rectangle (the page keeps
  // its place inside it while the card is fully on screen); the unchanged syncs make no call.
  assert.equal(after, 10 + 99);
});

test("a changed value still reaches the view, and each property is tracked per view", () => {
  const native = new NativeViewSync();
  const view = new CountingView();
  native.setVisible(view, true);
  native.setVisible(view, false);
  native.setVisible(view, false);
  native.setBorderRadius(view, 0);
  native.setBorderRadius(view, 8);
  native.setBounds(view, { x: 1, y: 2, width: 3, height: 4 });
  native.setBounds(view, { x: 1, y: 2, width: 3, height: 5 });
  native.setBackgroundThrottling(view.webContents, false);
  native.setBackgroundThrottling(view.webContents, false);
  assert.deepEqual(view.calls.map(([kind, value]) => [kind, value]), [
    ["visible", true], ["visible", false], ["radius", 0], ["radius", 8],
    ["bounds", { x: 1, y: 2, width: 3, height: 4 }], ["bounds", { x: 1, y: 2, width: 3, height: 5 }],
    ["throttling", false]
  ]);
});

test("BrowserService changes native view state only through its NativeViewSync", async () => {
  const source = await readFile(new URL("../src/main/services/BrowserService.ts", import.meta.url), "utf8");
  // A direct call would leave the recorded state stale, and a later equal value would be skipped wrongly.
  for (const call of [/(?:clipView|\.view)\.setBounds\(/u, /(?:clipView|\.view)\.setVisible\(/u,
    /\.view\.setBorderRadius\(/u, /webContents\.setBackgroundThrottling\(/u]) {
    assert.doesNotMatch(source, call);
  }
});
