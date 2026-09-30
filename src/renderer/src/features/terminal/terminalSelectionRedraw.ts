import type { Terminal } from "@xterm/xterm";

type SelectionPoint = [number, number] | undefined;

interface XtermRenderServiceSelection {
  _selectionState?: { start: SelectionPoint; end: SelectionPoint; columnSelectMode: boolean };
  handleSelectionChanged?(start: SelectionPoint, end: SelectionPoint, columnSelectMode: boolean): void;
}

/**
 * Skip xterm's selection redraw when there is no selection before or after it.
 *
 * xterm 6 refreshes the selection on every scroll (one animation frame per output burst), and the DOM
 * renderer answers each refresh by rebuilding every row, even while the card is off-screen and its render
 * service is paused; the WebGL renderer answers with a full viewport redraw. Under steady output that was
 * most of the renderer's work for cards that draw on DOM (off-screen cards and cards beyond the WebGL pool).
 * With no selection before and none after, the call changes nothing on screen, so it is dropped; any
 * real selection change (made, extended, cleared) goes through unchanged. Uses xterm internals, like
 * terminalViewport.ts; if they are missing the terminal is left as it is.
 */
export function skipEmptySelectionRedraws(terminal: Terminal): () => void {
  const service = (terminal as Terminal & { _core?: { _renderService?: XtermRenderServiceSelection } })._core?._renderService;
  const original = service?.handleSelectionChanged;
  const state = service?._selectionState;
  if (!service || typeof original !== "function" || !state) return () => undefined;
  const guarded = function (this: XtermRenderServiceSelection, start: SelectionPoint, end: SelectionPoint, columnSelectMode: boolean): void {
    if (!start && !end && !state.start && !state.end) {
      state.columnSelectMode = columnSelectMode;
      return;
    }
    original.call(this, start, end, columnSelectMode);
  };
  service.handleSelectionChanged = guarded;
  return () => {
    if (service.handleSelectionChanged === guarded) service.handleSelectionChanged = original;
  };
}
