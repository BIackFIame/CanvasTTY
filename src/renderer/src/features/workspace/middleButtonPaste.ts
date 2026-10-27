/** Chromium can dispatch PRIMARY paste after a cancelled middle-button gesture has ended. */
export function attachMiddleButtonPasteGuard(element: HTMLElement, platform: string): () => void {
  if (platform !== "linux") return () => {};
  // Observe before React's root capture handlers can stop the pointer event.
  const document = element.ownerDocument;
  const capture = { capture: true };
  let middleButton = false;
  const pointer = (event: MouseEvent): void => {
    middleButton = event.button === 1 && element.contains(event.target as Node);
  };
  const explicitPasteIntent = (): void => { middleButton = false; };
  const paste = (event: ClipboardEvent): void => {
    if (!middleButton || !element.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  document.addEventListener("pointerdown", pointer, capture);
  document.addEventListener("mousedown", pointer, capture);
  document.addEventListener("keydown", explicitPasteIntent, capture);
  document.addEventListener("contextmenu", explicitPasteIntent, capture);
  document.addEventListener("paste", paste, capture);
  return () => {
    document.removeEventListener("pointerdown", pointer, capture);
    document.removeEventListener("mousedown", pointer, capture);
    document.removeEventListener("keydown", explicitPasteIntent, capture);
    document.removeEventListener("contextmenu", explicitPasteIntent, capture);
    document.removeEventListener("paste", paste, capture);
  };
}
