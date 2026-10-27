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
  const makeClassList = (initial = []) => {
    const values = new Set(initial);
    return {
      add(...names) { names.forEach(name => values.add(name)); },
      [Symbol.iterator]() { return values[Symbol.iterator](); }
    };
  };
  const snapshot = {
    ownerDocument: document,
    isConnected: false,
    animation: null,
    classList: makeClassList(),
    style: {},
    setAttribute() {},
    querySelectorAll() { return []; },
    remove() { this.isConnected = false; },
    animate() {
      this.animation = { onfinish: null, canceled: false, cancel() { this.canceled = true; } };
      return this.animation;
    }
  };
  const screen = {
    style: {
      opacity: "0.85",
      get visibility() { return "inherit"; },
      set visibility(value) {
        // Browsers blur inputs whose ancestor becomes visibility:hidden.
        if (value === "hidden") document.activeElement = null;
      }
    },
    offsetLeft: 0,
    offsetTop: 0,
    checkVisibility() { return true; },
    querySelectorAll() { return []; },
    cloneNode() { return snapshot; }
  };
  const element = {
    dataset: { renderer: "dom" },
    classList: makeClassList(),
    querySelector() { return screen; },
    append(node) { node.isConnected = true; }
  };
  const terminal = {
    element,
    rows: 24,
    onRender(callback) { renders.add(callback); return { dispose() { renders.delete(callback); } }; },
    refresh() { if (render) for (const callback of [...renders]) callback(); }
  };
  const input = {};
  document.activeElement = input;
  const { begin, reveal, cancel } = runInNewContext(stripTypeScriptTypes(`${transitionSource}
    ({ begin: beginRendererTransition, reveal: revealRendererTransition, cancel: restoreRendererTransition });`), {
    useRef: () => ({ current: null }), snapshot, terminal, window, document,
    requestAnimationFrame: window.requestAnimationFrame, cancelAnimationFrame: window.cancelAnimationFrame
  });
  const start = () => {
    const transitionSnapshot = begin(terminal);
    assert.equal(transitionSnapshot, snapshot);
    reveal(terminal, transitionSnapshot);
  };
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
  return { snapshot, screen, document, input, start, cancel, advance, frame,
    pending: () => timers.size + frames.size + renders.size,
    counts: () => ({ timers: timers.size, frames: frames.size, renders: renders.size }) };
}

test("the opaque snapshot is removed after the new render and two paint frames without blending text", () => {
  const h = fixture();
  h.start();
  assert.equal(h.screen.style.opacity, "0", "the new renderer cannot show through a transparent snapshot");
  assert.equal(h.snapshot.animation, null);
  h.frame();
  assert.equal(h.snapshot.animation, null);
  h.frame();
  assert.equal(h.snapshot.animation, null);
  assert.equal(h.snapshot.isConnected, false);
  assert.equal(h.screen.style.opacity, "0.85");
  assert.deepEqual(h.counts(), { timers: 0, frames: 0, renders: 0 });
});

for (const render of [false, true]) {
  test(`the cleanup deadline removes the snapshot without animation frames (render=${render})`, () => {
    const h = fixture({ render });
    h.start(); h.advance(249);
    assert.equal(h.snapshot.isConnected, true);
    h.advance(1);
    assert.equal(h.snapshot.isConnected, false);
    assert.equal(h.screen.style.opacity, "0.85");
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
  assert.equal(h.screen.style.opacity, "0.85");
  assert.deepEqual(h.counts(), { timers: 0, frames: 0, renders: 0 });
});

test("teardown cancels a pending render or frames and is harmless after paint", () => {
  for (const phase of ["render", "frame", "paint"]) {
    const h = fixture({ render: phase !== "render" });
    h.start();
    if (phase === "paint") { h.frame(); h.frame(); }
    h.cancel(); h.cancel();
    assert.equal(h.snapshot.isConnected, false);
    assert.equal(h.screen.style.opacity, "0.85");
    assert.deepEqual(h.counts(), { timers: 0, frames: 0, renders: 0 });
    if (h.snapshot.animation) assert.equal(h.snapshot.animation.canceled, true);
    h.advance(1_000); h.frame();
    assert.equal(h.snapshot.isConnected, false);
    assert.equal(h.screen.style.opacity, "0.85");
  }
});

test("40 renderer transitions leave no snapshots, animations or pending work", () => {
  const h = fixture();
  for (let cycle = 0; cycle < 40; cycle++) {
    h.start(); h.frame(); h.frame();
    assert.equal(h.snapshot.animation, null);
    assert.equal(h.snapshot.isConnected, false);
    assert.deepEqual(h.counts(), { timers: 0, frames: 0, renders: 0 });
  }
});

test("renderer transitions preserve input focus on paint and timeout without stealing it back", () => {
  for (const render of [false, true]) {
    const h = fixture({ render });
    h.start();
    assert.equal(h.document.activeElement, h.input);
    h.frame(); h.frame(); h.advance(250);
    assert.equal(h.document.activeElement, h.input);
    h.start();
    const otherInput = {};
    h.document.activeElement = otherInput;
    h.frame(); h.frame(); h.advance(250);
    assert.equal(h.document.activeElement, otherInput);
  }
});

test("reduced motion removes the snapshot after paint without starting an animation", () => {
  const h = fixture({ reducedMotion: true });
  h.start(); h.frame(); h.frame();
  assert.equal(h.snapshot.isConnected, false);
  assert.equal(h.snapshot.animation, null);
  assert.deepEqual(h.counts(), { timers: 0, frames: 0, renders: 0 });
});
