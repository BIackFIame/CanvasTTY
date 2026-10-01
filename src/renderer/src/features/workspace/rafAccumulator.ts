/**
 * Coalesces many same-frame values into one commit. `push` merges each incoming value into
 * whatever is pending and schedules a single flush; a burst of pushes within one frame (a
 * trackpad pan or a pinch-zoom firing dozens of wheel events between paints) still reaches
 * `commit` once. `schedule`/`cancel` default to requestAnimationFrame/cancelAnimationFrame but
 * are injectable so the accumulation logic can be unit-tested without a DOM.
 */
export interface RafAccumulator<T> {
  push(value: T): void;
  /** Flushes a pending value immediately (and cancels the scheduled frame) if there is one. */
  flush(): void;
  /** Drops any pending value and cancels the scheduled frame without committing. */
  dispose(): void;
}

export function createRafAccumulator<T>(
  merge: (pending: T | null, next: T) => T,
  commit: (value: T) => void,
  schedule: (callback: () => void) => number = requestAnimationFrame,
  cancel: (handle: number) => void = cancelAnimationFrame
): RafAccumulator<T> {
  let frame: number | null = null;
  let pending: T | null = null;

  const flush = (): void => {
    if (frame !== null) {
      cancel(frame);
      frame = null;
    }
    if (pending === null) return;
    const value = pending;
    pending = null;
    commit(value);
  };

  return {
    push(value: T): void {
      pending = merge(pending, value);
      if (frame === null) frame = schedule(flush);
    },
    flush,
    dispose(): void {
      if (frame !== null) cancel(frame);
      frame = null;
      pending = null;
    }
  };
}
