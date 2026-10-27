import assert from "node:assert/strict";
import test from "node:test";
import { attachMiddleButtonPasteGuard } from "../src/renderer/src/features/workspace/middleButtonPaste.ts";

function event(type, button) {
  return Object.assign(new Event(type, {cancelable:true}), button === undefined ? {} : {button});
}

function fixture() {
  const element = new EventTarget();
  element.ownerDocument = element;
  element.contains = target => target === element;
  return element;
}

test("middle-button paste is blocked after release, including repeated paste delivery", () => {
  const element = fixture();
  const detach = attachMiddleButtonPasteGuard(element, "linux");
  let delivered = 0;
  element.addEventListener("paste", () => delivered++);
  element.dispatchEvent(event("pointerdown", 1));
  element.dispatchEvent(event("pointerup", 1));
  element.dispatchEvent(event("auxclick", 1));
  for (let i=0;i<2;i++) {
    const paste = event("paste");
    element.dispatchEvent(paste);
    assert.equal(paste.defaultPrevented, true);
  }
  assert.equal(delivered, 0);
  detach();
  element.dispatchEvent(event("paste"));
  assert.equal(delivered, 1, "cleanup removes the guard");
});

for (const intent of [event("keydown"),event("contextmenu"),event("pointerdown",0),event("mousedown",2)]) {
  test(`${intent.type}/${intent.button ?? "keyboard"} preserves explicit paste after a middle click`, () => {
    const element = fixture();
    const detach = attachMiddleButtonPasteGuard(element, "linux");
    element.dispatchEvent(event("pointerdown", 1));
    element.dispatchEvent(intent);
    const paste = event("paste");
    element.dispatchEvent(paste);
    assert.equal(paste.defaultPrevented, false);
    detach();
  });
}

test("ordinary paste is available before any middle-button gesture", () => {
  const element = fixture();
  const detach = attachMiddleButtonPasteGuard(element, "linux");
  const paste = event("paste");
  element.dispatchEvent(paste);
  assert.equal(paste.defaultPrevented, false);
  detach();
});

for (const platform of ["darwin", "win32"]) {
  test(`${platform} preserves native menu paste after a middle click`, () => {
    const element = fixture();
    const detach = attachMiddleButtonPasteGuard(element, platform);
    let delivered = 0;
    element.addEventListener("paste", () => delivered++);
    element.dispatchEvent(event("pointerdown", 1));
    element.dispatchEvent(event("mousedown", 1));
    element.dispatchEvent(event("pointerup", 1));
    const paste = event("paste");
    element.dispatchEvent(paste);
    assert.equal(paste.defaultPrevented, false);
    assert.equal(delivered, 1);
    detach();
  });
}
