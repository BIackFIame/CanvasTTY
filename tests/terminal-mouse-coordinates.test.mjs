import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { attachTerminalScrollbarCoordinateAdapter, remapTerminalMouseCoordinates } from "../src/renderer/src/features/terminal/terminalMouseCoordinates.ts";

test("installed xterm scrollbar drag follows layout distance at every canvas scale", async (t) => {
  const { outputFiles } = await build({
    stdin: {
      contents: 'export { VerticalScrollbar } from "vs/base/browser/ui/scrollbar/verticalScrollbar"; export { ScrollbarState } from "vs/base/browser/ui/scrollbar/scrollbarState";',
      resolveDir: fileURLToPath(new URL("..", import.meta.url))
    },
    nodePaths: [fileURLToPath(new URL("../node_modules/@xterm/xterm/src", import.meta.url))],
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    bundle: true, platform: "node", format: "esm", write: false
  });
  const { VerticalScrollbar, ScrollbarState } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`);
  const originalElement = globalThis.Element;
  globalThis.Element = class {};
  t.after(() => { globalThis.Element = originalElement; });

  for (const scale of [0.5, 0.7, 1, 1.5, 2]) {
    const scrollbar = Object.create(VerticalScrollbar.prototype);
    scrollbar._scrollbarState = new ScrollbarState(0, 14, 0, 400, 4000, 1000);
    scrollbar.slider = { toggleClassName() {} };
    scrollbar._host = { onDragStart() {}, onDragEnd() {} };
    let move;
    scrollbar._pointerMoveMonitor = { startMonitoring(_target, _id, _buttons, listener) { move = listener; } };
    let scrollTop;
    scrollbar._scrollable = { setScrollPositionNow(position) { scrollTop = position.scrollTop; } };
    const original = scrollbar._sliderPointerPosition;
    const detach = attachTerminalScrollbarCoordinateAdapter({
      element: { offsetHeight: 400, getBoundingClientRect: () => ({ height: 400 * scale }) },
      _core: { _viewport: { _scrollableElement: { _verticalScrollbar: scrollbar } } }
    });
    scrollbar._sliderPointerDown({ target: new Element(), pageX: 50, pageY: 100, pointerId: 1, buttons: 1 });
    move({ pageX: 50, pageY: 100 + 100 * scale });
    assert.equal(scrollTop, 2000, `scale ${scale}`);
    move({ pageX: 50, pageY: 100 - 50 * scale });
    assert.equal(scrollTop, 500, `upwards at scale ${scale}`);
    detach();
    assert.equal(scrollbar._sliderPointerPosition, original);
  }
});

test("keeps terminal coordinates unchanged at one-to-one scale", () => {
  assert.deepEqual(
    remapTerminalMouseCoordinates(
      { x: 190, y: 240 },
      { left: 100, top: 100, width: 700, height: 400 },
      { width: 700, height: 400 }
    ),
    { x: 190, y: 240 }
  );
});

test("maps visual coordinates back into xterm layout coordinates when zoomed out", () => {
  assert.deepEqual(
    remapTerminalMouseCoordinates(
      { x: 170, y: 170 },
      { left: 100, top: 100, width: 490, height: 280 },
      { width: 700, height: 400 }
    ),
    { x: 200, y: 200 }
  );
});

test("maps visual coordinates back into xterm layout coordinates when zoomed in", () => {
  assert.deepEqual(
    remapTerminalMouseCoordinates(
      { x: 240, y: 240 },
      { left: 100, top: 100, width: 840, height: 480 },
      { width: 700, height: 400 }
    ),
    { x: 216.66666666666669, y: 216.66666666666669 }
  );
});

/** A document that records its listeners, and a screen (scaled to half its layout size) with one child. */
function fakeCards(count) {
  const listeners = new Map();
  const doc = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    count: (type) => listeners.get(type)?.size ?? 0,
    /** Capture on the document: every document listener sees the event first. */
    fire(type, target, clientX, clientY, button = 0) {
      const event = { type, target, clientX, clientY, button, buttons: 1, detail: 0, preventDefault() {}, stopImmediatePropagation() {} };
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    }
  };
  class FakeNode extends EventTarget {
    constructor(parent = null) { super(); this.parent = parent; }
  }
  class FakeMouseEvent extends Event {
    constructor(type, init) { super(type, init); this.clientX = init.clientX; this.clientY = init.clientY; }
  }
  const cards = Array.from({ length: count }, () => {
    const screen = new FakeNode();
    Object.assign(screen, {
      ownerDocument: doc, offsetWidth: 700, offsetHeight: 400, contains(node) {
        for (let current = node; current; current = current.parent) if (current === screen) return true;
        return false;
      },
      getBoundingClientRect: () => ({ left: 100, top: 100, width: 350, height: 200 }),
      matches: () => false
    });
    const child = new FakeNode(screen);
    const received = [];
    child.addEventListener("mousemove", (event) => received.push([event.clientX, event.clientY]));
    child.addEventListener("mouseup", (event) => received.push(["up", event.clientX, event.clientY]));
    return { screen, child, received };
  });
  return { doc, cards, FakeNode, FakeMouseEvent };
}

test("mouse moves anywhere cost nothing for cards the pointer is not over; a hovered or dragged card still remaps", async (t) => {
  const { attachTerminalMouseCoordinateAdapter } = await import("../src/renderer/src/features/terminal/terminalMouseCoordinates.ts");
  const { doc, cards, FakeNode, FakeMouseEvent } = fakeCards(5);
  const originals = { Node: globalThis.Node, MouseEvent: globalThis.MouseEvent };
  globalThis.Node = FakeNode;
  globalThis.MouseEvent = FakeMouseEvent;
  t.after(() => Object.assign(globalThis, originals));
  const detach = cards.map(({ screen }) => attachTerminalMouseCoordinateAdapter(screen));

  assert.equal(doc.count("mousemove"), 0, "no card listens to every mouse move in the window");
  const [first] = cards;
  first.screen.dispatchEvent(new Event("mouseenter"));
  assert.equal(doc.count("mousemove"), 1, "only the hovered card listens");
  doc.fire("mousemove", first.child, 135, 135);
  assert.deepEqual(first.received, [[170, 170]], "a move over the hovered card is remapped");

  doc.fire("mousedown", first.child, 135, 135);
  first.screen.dispatchEvent(new Event("mouseleave"));
  const outside = new FakeNode();
  const outsideMoves = [];
  outside.addEventListener("mousemove", (event) => outsideMoves.push([event.clientX, event.clientY]));
  doc.fire("mousemove", outside, 600, 400);
  assert.deepEqual(outsideMoves, [[1100, 700]], "a drag that left the card is still followed");
  doc.fire("mouseup", outside, 600, 400);
  assert.equal(doc.count("mousemove"), 0, "the drag ended outside: nothing listens any more");
  assert.equal(doc.count("mousedown"), 0);

  for (const stop of detach) stop();
  assert.equal(doc.count("mouseup"), 0);
});
