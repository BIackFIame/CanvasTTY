import assert from "node:assert/strict";
import test from "node:test";
import { msUntilNextMinute, scheduleMinuteTicks } from "../src/renderer/src/features/home/homeClockSchedule.ts";

// HomeZone used to re-render every second (window.setInterval(..., 1_000)) even though its clock
// widget only shows hour:minute and its limit countdowns are minute-granular
// (formatResetCountdown does Math.ceil(.../60_000)). The widget stays mounted while the canvas
// pans it off screen, so every one of those extra 59-out-of-60 renders was pure waste.

function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map();
  return {
    now: () => now,
    timers: {
      set(callback, ms) { const id = next++; pending.set(id, { at: now + ms, callback }); return id; },
      clear(id) { pending.delete(id); }
    },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const due = [...pending].filter(([, entry]) => entry.at <= target).sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        const [id, entry] = due[0];
        pending.delete(id);
        now = entry.at;
        entry.callback();
      }
      now = target;
    },
    pendingCount: () => pending.size
  };
}

test("msUntilNextMinute always lands on the next :00 boundary", () => {
  assert.equal(msUntilNextMinute(0), 60_000);
  assert.equal(msUntilNextMinute(1_000), 59_000);
  assert.equal(msUntilNextMinute(59_999), 1);
  assert.equal(msUntilNextMinute(60_000), 60_000);
});

test("ticking for 3 minutes of wall time fires 3 times, not 180", () => {
  const clock = fakeTimers();
  let ticks = 0;
  const dispose = scheduleMinuteTicks(() => { ticks += 1; }, clock.timers, clock.now);

  clock.advance(3 * 60_000);
  assert.equal(ticks, 3, "one tick per minute boundary crossed, regardless of second-level polling");
  dispose();
});

test("dispose stops further ticks", () => {
  const clock = fakeTimers();
  let ticks = 0;
  const dispose = scheduleMinuteTicks(() => { ticks += 1; }, clock.timers, clock.now);
  clock.advance(60_000);
  assert.equal(ticks, 1);
  dispose();
  clock.advance(5 * 60_000);
  assert.equal(ticks, 1, "no ticks fire after dispose");
  assert.equal(clock.pendingCount(), 0);
});
