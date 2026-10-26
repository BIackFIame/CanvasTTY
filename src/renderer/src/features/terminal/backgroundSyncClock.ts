export interface BackgroundSyncClock { origin: number; time: number; speed: number }

const clocks = new Map<string, BackgroundSyncClock>();

export function getBackgroundSyncClock(scene: string, speed: number, previous: BackgroundSyncClock | null): BackgroundSyncClock {
  const key = JSON.stringify([scene, speed]);
  let clock = clocks.get(key);
  if (!clock) {
    const now = performance.timeOrigin + performance.now();
    clock = { origin: now, time: previous ? previous.time + Math.max(0, now - previous.origin) / 1000 * previous.speed : 0, speed };
    clocks.set(key, clock);
  }
  return clock;
}

export function synchronizedBackgroundTime(clock: BackgroundSyncClock, now: number, fps: number): number {
  const period = 1000 / fps;
  return clock.time + Math.floor(Math.max(0, now - clock.origin) / period + 1e-8) * period / 1000 * clock.speed;
}

export function synchronizedBackgroundDelay(clock: BackgroundSyncClock, now: number, fps: number, minimumDelay: number): number {
  const period = 1000 / fps;
  const next = clock.origin + (Math.floor((now + Math.max(0, minimumDelay) - clock.origin) / period + 1e-8) + 1) * period;
  return Math.max(1, next - now);
}
