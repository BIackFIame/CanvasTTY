/** Trail after the last wheel step (zoom or pan) before the gesture is considered over. */
export const GESTURE_SETTLE_MS = 160;

export interface GestureTimers {
  set(callback: () => void, ms: number): number;
  clear(handle: number): void;
}

const windowTimers: GestureTimers = {
  set: (callback, ms) => window.setTimeout(callback, ms),
  clear: (handle) => window.clearTimeout(handle)
};

export interface GestureSettle {
  /** One step of the gesture: reports it active (once) and restarts the trailing timer. */
  mark(): void;
  dispose(): void;
}

/**
 * Trailing edge only: every step restarts the timer, so a continuous wheel or
 * pinch keeps the gesture open and only silence closes it. `onChange` hears
 * each transition once, not every step.
 */
export function createGestureSettle(
  onChange: (active: boolean) => void,
  settleMs = GESTURE_SETTLE_MS,
  timers: GestureTimers = windowTimers
): GestureSettle {
  let timer: number | null = null;
  let active = false;
  return {
    mark() {
      if (!active) {
        active = true;
        onChange(true);
      }
      if (timer !== null) timers.clear(timer);
      timer = timers.set(() => {
        timer = null;
        active = false;
        onChange(false);
      }, settleMs);
    },
    dispose() {
      if (timer !== null) timers.clear(timer);
      timer = null;
    }
  };
}
