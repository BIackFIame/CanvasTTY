import assert from "node:assert/strict";
import test from "node:test";
import { STOP_POLLING, pollWhileOpen } from "../src/renderer/src/features/settings/settingsPolling.ts";

// Settings sections poll (plugin service reports every 3 s, Even G2 state every 1.5 s, the GitHub device
// flow status) only while Settings is open. A fake clock counts the ticks.

function fakeClock() {
  let now = 0;
  const timers = new Map();
  let next = 1;
  return {
    timers: {
      setTimeout(callback, ms) {
        const handle = next++;
        timers.set(handle, { at: now + ms, callback });
        return handle;
      },
      clearTimeout(handle) {
        timers.delete(handle);
      }
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        for (let index = 0; index < 5; index += 1) await Promise.resolve();
      }
      now = end;
    },
    get pending() {
      return timers.size;
    }
  };
}

const flush = async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); };

test("closed Settings polls nothing", async () => {
  const clock = fakeClock();
  let ticks = 0;
  const stop = pollWhileOpen(false, 1500, () => { ticks += 1; }, { timers: clock.timers });
  await clock.advance(60_000);
  assert.equal(ticks, 0);
  assert.equal(clock.pending, 0, "not even a timer is armed");
  stop();
});

test("open Settings polls on its interval, and closing (the effect cleanup) stops it", async () => {
  const clock = fakeClock();
  let ticks = 0;
  const stop = pollWhileOpen(true, 1500, () => { ticks += 1; }, { timers: clock.timers });
  await flush();
  await clock.advance(9_000);
  assert.equal(ticks, 7, "one immediate read, then one every 1.5 s");
  stop();
  await clock.advance(60_000);
  assert.equal(ticks, 7);
  assert.equal(clock.pending, 0);
});

test("a slow read is never overlapped by the next one", async () => {
  const clock = fakeClock();
  let running = 0;
  let maxRunning = 0;
  let release;
  const stop = pollWhileOpen(true, 1000, () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    return new Promise((resolve) => { release = () => { running -= 1; resolve(); }; });
  }, { timers: clock.timers });
  await clock.advance(10_000);
  assert.equal(maxRunning, 1);
  assert.equal(clock.pending, 0, "no next tick while the read is still running");
  release();
  await flush();
  assert.equal(clock.pending, 1);
  stop();
});

test("a failing read is retried; STOP_POLLING ends the poll; the first tick can wait one interval", async () => {
  const clock = fakeClock();
  let ticks = 0;
  const stop = pollWhileOpen(true, 1000, () => {
    ticks += 1;
    if (ticks === 1) throw new Error("transient");
    return ticks === 3 ? STOP_POLLING : undefined;
  }, { timers: clock.timers, immediate: false });
  await flush();
  assert.equal(ticks, 0);
  await clock.advance(10_000);
  assert.equal(ticks, 3);
  assert.equal(clock.pending, 0);
  stop();
});
