/** xterm 0.19 blends a transparent background; a preserved framebuffer needs an explicit clear each frame. */
export function clearPreservedWebglFrames(addon: unknown): boolean {
  const renderer = (addon as { _renderer?: {
    _gl?: Pick<WebGL2RenderingContext, "clearColor" | "clear" | "COLOR_BUFFER_BIT">;
    renderRows(start: number, end: number): void;
  } })._renderer;
  const gl = renderer?._gl;
  if (!renderer || !gl || typeof renderer.renderRows !== "function") return false;
  const render = renderer.renderRows;
  renderer.renderRows = function (start, end): void {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    render.call(this, start, end);
  };
  return true;
}
