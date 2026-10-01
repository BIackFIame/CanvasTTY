/**
 * The home zone's clock widget shows hour:minute and its limit rows count down in whole
 * minutes (formatResetCountdown), so re-rendering on every second of wall-clock time is wasted
 * work — the widget stays mounted (and keeps re-rendering on that tick) even while the canvas
 * has panned it off screen. This schedules one callback per minute boundary instead of one per
 * second: 60x fewer re-renders for the same on-screen precision.
 */
export interface ClockTimers {
  set(callback: () => void, ms: number): number;
  clear(handle: number): void;
}

const windowTimers: ClockTimers = {
  set: (callback, ms) => window.setTimeout(callback, ms),
  clear: (handle) => window.clearTimeout(handle)
};

/** Milliseconds from `now` to the next minute boundary (at least 1ms, so a tick never busy-loops). */
export function msUntilNextMinute(now: number): number {
  const remainder = 60_000 - (now % 60_000);
  return remainder <= 0 ? 60_000 : remainder;
}

/**
 * Calls `onTick` once now-ish and once per minute boundary after that, until disposed.
 * `timers`/`now` are injectable so the schedule can be unit-tested without real timers.
 */
export function scheduleMinuteTicks(
  onTick: () => void,
  timers: ClockTimers = windowTimers,
  now: () => number = Date.now
): () => void {
  let handle: number;
  const tick = (): void => {
    onTick();
    handle = timers.set(tick, msUntilNextMinute(now()));
  };
  handle = timers.set(tick, msUntilNextMinute(now()));
  return () => timers.clear(handle);
}
