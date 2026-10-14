/** Resize xterm and its PTY together, after Windows layout and the WebGL pool have settled. */
export function terminalFitScheduler(
  fit: () => void,
  delayMs: number,
  schedule: (callback: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
  cancel: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout
): { request(): void; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  return {
    request() {
      if (disposed) return;
      if (timer !== undefined) cancel(timer);
      if (delayMs === 0) { fit(); return; }
      timer = schedule(() => { timer = undefined; if (!disposed) fit(); }, delayMs);
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) cancel(timer);
      timer = undefined;
    }
  };
}
