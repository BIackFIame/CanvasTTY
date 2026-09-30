import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Edge-pan runs an independent requestAnimationFrame loop driven only by the last pointermove
// position (edgePointer), not by an active pointer-down gesture. window "blur" is wired to
// cancelPointerGesture to abort in-flight pans/marquees/group-drags, but it used to leave
// edgeFrame/edgePointer untouched: if the pointer was hovering the canvas edge when the window
// lost focus, the RAF loop kept requesting frames and committing camera state indefinitely in
// the background, since neither of the loop's other exits (an active gesture, or a real
// pointerleave clearing edgePointer) fires on blur.

const pointerNavigationPath = new URL(
  "../src/renderer/src/features/workspace/useCanvasPointerNavigation.ts",
  import.meta.url
);

/** The source of one `const name = useCallback(...)` up to the next top-level declaration. */
function hookBody(source, name) {
  const start = source.indexOf(`const ${name} = useCallback`);
  assert.notEqual(start, -1, `${name} is not declared as a useCallback`);
  const rest = source.slice(start + 1);
  const end = Math.min(...["\n  const ", "\n  useEffect", "\n  return {"]
    .map((marker) => {
      const index = rest.indexOf(marker);
      return index === -1 ? Number.POSITIVE_INFINITY : index;
    }));
  return rest.slice(0, end);
}

test("cancelPointerGesture (wired to window blur) also stops the edge-pan RAF loop", async () => {
  const source = await readFile(pointerNavigationPath, "utf8");
  assert.match(source, /window\.addEventListener\("blur",\s*cancelPointerGesture\)/u,
    "blur must still be wired to cancelPointerGesture");
  const body = hookBody(source, "cancelPointerGesture");
  assert.match(body, /cancelAnimationFrame\(edgeFrame\.current\)/u,
    "blur must cancel the pending edge-pan animation frame");
  assert.match(body, /edgePointer\.current\s*=\s*null/u,
    "blur must clear the stale pointer position so the loop cannot reschedule itself");
});
