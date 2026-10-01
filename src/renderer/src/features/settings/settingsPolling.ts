import { surfaceIsLive, surfaceLifecycle } from "../workspace/surfaceLifecycle.ts";

export interface PollTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SettingsPollOptions {
  /** Run the first tick right away instead of after one interval. */
  immediate?: boolean;
  timers?: PollTimers;
}

/** Returned by a tick to end the poll (the flow it watched finished). */
export const STOP_POLLING = Symbol("stop-polling");

const windowTimers: PollTimers = {
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number)
};

/**
 * A Settings section's polling, bound to the section's surface lifecycle: nothing runs while Settings is
 * closed (the section is suspended), and polling starts again when it opens. The next tick is scheduled
 * only after the previous one settles, so a slow read never overlaps the next one. Returns the stop
 * function for the effect cleanup.
 */
export function pollWhileOpen(
  open: boolean,
  intervalMs: number,
  tick: () => unknown,
  { immediate = true, timers = windowTimers }: SettingsPollOptions = {}
): () => void {
  if (!surfaceIsLive(surfaceLifecycle({ closed: !open }))) return () => undefined;
  let stopped = false;
  let handle: unknown = null;
  const run = async (): Promise<void> => {
    handle = null;
    if (stopped) return;
    let result: unknown;
    try {
      result = await tick();
    } catch {
      // A failed read is retried on the next tick; the section shows its own error state.
    }
    if (stopped || result === STOP_POLLING) return;
    handle = timers.setTimeout(() => void run(), intervalMs);
  };
  if (immediate) void run();
  else handle = timers.setTimeout(() => void run(), intervalMs);
  return () => {
    stopped = true;
    if (handle !== null) timers.clearTimeout(handle);
    handle = null;
  };
}
