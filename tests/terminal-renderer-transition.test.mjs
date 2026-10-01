import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";

// Execute the current transition with a clock whose animation frames can stop independently of timers.
const card = await readFile(new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url), "utf8");
const transitionSource = card.slice(card.indexOf("  const rendererTransitionRef ="), card.indexOf("  const lifecycle ="));

function fixture({ render = true, reducedMotion = false } = {}) {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const frames = new Map();
  const document = new EventTarget();
  document.hidden = false;
  const window = new EventTarget();
  Object.assign(window, {
    document,
    setTimeout(callback, ms) { const id = ++nextId; timers.set(id, { at: now + ms, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    matchMedia: () => ({ matches: reducedMotion })
  });
  document.defaultView = window;
  let renders = new Set();
  const terminal = {
    rows: 24,
    onRender(callback) { renders.add(callback); return { dispose() { renders.delete(callback); } }; },
    refresh() { if (render) for (const callback of [...renders]) callback(); }
  };
  const snapshot = {
    ownerDocument: document,
    isConnected: true,
    animation: null,
    remove() { this.isConnected = false; },
    animate() {
      this.animation = { onfinish: null, canceled: false, cancel() { this.canceled = true; } };
      return this.animation;
    }
  };
  const { start, cancel } = runInNewContext(stripTypeScriptTypes(`${transitionSource}
    const onVisibilityChange = () => { if (document.hidden) restoreRendererTransition(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    rendererTransitionRef.current = {
      snapshot, frame: null, render: null,
      fallback: window.setTimeout(restoreRendererTransition, 250),
      animation: null,
      visibilityCleanup: () => document.removeEventListener("visibilitychange", onVisibilityChange)
    };
    ({ start: () => revealRendererTransition(terminal, snapshot), cancel: restoreRendererTransition });`), {
    useRef: () => ({ current: null }), snapshot, terminal, window, document,
    requestAnimationFrame: window.requestAnimationFrame, cancelAnimationFrame: window.cancelAnimationFrame
  });
  const advance = ms => {
    const until = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].callback();
    }
    now = until;
  };
  const frame = () => {
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback();
  };
  return { snapshot, document, start, cancel, advance, frame,
    pending: () => timers.size + frames.size + renders.size,
    counts: () => ({ timers: timers.size, frames: frames.size, renders: renders.size }) };
}

test("a visible transition fades only after the new render and two paint frames", () => {
  const h = fixture();
  h.start();
  assert.equal(h.snapshot.animation, null);
  h.frame();
  assert.equal(h.snapshot.animation, null);
  h.frame();
  assert.ok(h.snapshot.animation);
  assert.equal(h.snapshot.isConnected, true);
  h.snapshot.animation.onfinish();
  assert.equal(h.snapshot.isConnected, false);
  assert.deepEqual(h.counts(), { timers: 0, frames: 0, renders: 0 });
});

for (const render of [false, true]) {
  test(`the cleanup deadline removes the snapshot without animation frames (render=${render})`, () => {
    const h = fixture({ render });
    h.start(); h.advance(249);
    assert.equal(h.snapshot.isConnected, true);
    h.advance(1);
    assert.equal(h.snapshot.isConnected, false);
    assert.deepEqual(h.counts(), { timers: 0, frames: 0, renders: 0 });
    h.frame();
    assert.equal(h.snapshot.animation, null);
  });
}

test("hiding the document removes the snapshot before any suspended frames or timers run", () => {
  const h = fixture();
  h.start();
  h.document.hidden = true;
  h.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(h.snapshot.isConnected, false);
  assert.deepEqual(h.counts(), { timers: 0, frames: 0, renders: 0 });
});

test("teardown cancels a pending render, frames and an active fade", () => {
  for (const phase of ["render", "frame", "fade"]) {
    const h = fixture({ render: phase !== "render" });
    h.start();
    if (phase === "fade") { h.frame(); h.frame(); }
    h.cancel(); h.cancel();
    assert.equal(h.snapshot.isConnected, false);
    assert.deepEqual(h.counts(), { timers: 0, frames: 0, renders: 0 });
    if (h.snapshot.animation) assert.equal(h.snapshot.animation.canceled, true);
    h.advance(1_000); h.frame();
    assert.equal(h.snapshot.isConnected, false);
  }
});

test("reduced motion removes the snapshot after paint without starting an animation", () => {
  const h = fixture({ reducedMotion: true });
  h.start(); h.frame(); h.frame();
  assert.equal(h.snapshot.isConnected, false);
  assert.equal(h.snapshot.animation, null);
  assert.deepEqual(h.counts(), { timers: 0, frames: 0, renders: 0 });
});
