import type { Terminal } from "@xterm/xterm";

type SelectionPoint = [number, number] | undefined;

interface XtermRenderServiceSelection {
  _selectionState?: { start: SelectionPoint; end: SelectionPoint; columnSelectMode: boolean };
  _isPaused?: boolean;
  _needsSelectionRefresh?: boolean;
  _needsFullRefresh?: boolean;
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
 * real selection change (made, extended, cleared) goes through unchanged while visible. While rendering is
 * paused, keep the latest selection and request one full refresh on resume: xterm's selection handler otherwise
 * bypasses its pause and rebuilds hidden DOM rows on every scroll. Uses xterm internals, like
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
    if (this._isPaused === true && typeof this._needsSelectionRefresh === "boolean"
      && typeof this._needsFullRefresh === "boolean") {
      state.start = start;
      state.end = end;
      state.columnSelectMode = columnSelectMode;
      this._needsSelectionRefresh = true;
      // A selection cleared without output must still repaint when the surface returns.
      this._needsFullRefresh = true;
      return;
    }
    original.call(this, start, end, columnSelectMode);
  };
  service.handleSelectionChanged = guarded;
  return () => {
    if (service.handleSelectionChanged === guarded) service.handleSelectionChanged = original;
  };
}
