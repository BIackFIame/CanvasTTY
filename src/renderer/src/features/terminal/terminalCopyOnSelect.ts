/** Copy only completed mouse gestures that xterm confirmed as selection changes. */
export function attachTerminalCopyOnSelect(
  screen: HTMLElement,
  getSelection: () => string,
  isEnabled: () => boolean,
  copy: (text: string) => void,
  subscribeSelectionChange: (listener: () => void) => () => void = () => () => undefined
): () => void {
  const ownerDocument = screen.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) return () => undefined;
  let selecting = false;
  let selectionChanged = false;
  let pendingCopy: number | undefined;

  const onSelectionChange = (): void => {
    if (selecting || pendingCopy !== undefined) selectionChanged = true;
  };
  const detachSelectionChange = subscribeSelectionChange(onSelectionChange);

  const cancel = (): void => {
    selecting = false;
    selectionChanged = false;
    if (pendingCopy !== undefined) ownerWindow.clearTimeout(pendingCopy);
    pendingCopy = undefined;
  };
  const start = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    cancel();
    selecting = true;
  };
  const finish = (event: MouseEvent): void => {
    if (event.button !== 0 || !selecting) return;
    selecting = false;
    // xterm finalizes selection in its document mouseup listener. Read after it,
    // including when the coordinate adapter redispatches a scaled mouse event.
    pendingCopy = ownerWindow.setTimeout(() => {
      pendingCopy = undefined;
      if (!isEnabled() || !selectionChanged) {
        selectionChanged = false;
        return;
      }
      selectionChanged = false;
      const text = getSelection();
      if (text.length > 0) copy(text);
    }, 0);
  };

  screen.addEventListener("mousedown", start, true);
  ownerDocument.addEventListener("mouseup", finish, true);
  ownerDocument.addEventListener("pointercancel", cancel, true);
  ownerWindow.addEventListener("blur", cancel);
  return () => {
    cancel();
    screen.removeEventListener("mousedown", start, true);
    ownerDocument.removeEventListener("mouseup", finish, true);
    ownerDocument.removeEventListener("pointercancel", cancel, true);
    ownerWindow.removeEventListener("blur", cancel);
    detachSelectionChange();
  };
}
