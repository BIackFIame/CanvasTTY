import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

test("speed changes the scene clock continuously without more redraws or waking paused backgrounds", async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/renderer/src/features/terminal/asciiBackground.worker.ts', import.meta.url))],
    bundle: true, write: false, format: 'iife', platform: 'browser',
    plugins: [{ name: 'scene-clock-probe', setup(build) {
      build.onLoad({ filter: /pieces[\\/]donut\.js$/ }, () => ({
        contents: 'export const meta={cols:1,rows:1,cell:1,fps:12};export default ()=>time=>{recordFrameTime(time);return "X";}',
        loader: 'js',
      }));
    } }],
  });
  let clock = 0, next = 0;
  const times = [], transforms = [], timers = new Map(), self = {};
  const canvas = { width: 80, height: 40 };
  const ctx = new Proxy({ canvas, setTransform: (...args) => transforms.push(args) }, { get: (target, key) => key in target ? target[key] : () => {} });
  canvas.getContext = kind => kind === '2d' ? ctx : null;
  vm.runInNewContext(bundle.outputFiles[0].text, {
    self, console, performance: { now: () => clock }, recordFrameTime: value => times.push(value),
    setTimeout: (callback, delay) => { timers.set(++next, { callback, delay }); return next; },
    clearTimeout: id => timers.delete(id),
  });
  const send = data => self.onmessage({ data });
  const tickAt = now => {
    clock = now;
    const [id, timer] = [...timers][0];
    timers.delete(id);
    timer.callback();
    assert.equal(timers.size, 1);
    assert(Math.abs([...timers.values()][0].delay - 1000 / 12) < 1e-8);
  };
  await send({ type: 'init', canvas, scene: 'donut' });
  await send({ type: 'playing', value: true });
  tickAt(100);
  assert(Math.abs(times.at(-1) - 0.1) < 1e-8);
  clock = 150;
  await send({ type: 'speed', value: 2 });
  assert.equal(times.length, 2, 'changing speed does not redraw or restart the scene');
  tickAt(200);
  assert(Math.abs(times.at(-1) - 0.25) < 1e-8);
  clock = 250;
  await send({ type: 'speed', value: 0.25 });
  tickAt(300);
  assert(Math.abs(times.at(-1) - 0.3625) < 1e-8);
  await send({ type: 'playing', value: false });
  const framesBeforeTransform = times.length;
  await send({ type: 'transform', value: { scale: 200, offsetX: 25, offsetY: -20 } });
  assert.equal(times.length, framesBeforeTransform, 'moving a paused background reuses its current frame');
  assert.equal(timers.size, 0, 'moving does not unpause the scene');
  assert.deepEqual(transforms.at(-1), [160 / 6, 0, 0, 80 / 6, -20, -28]);
  const paintsBeforeSameTransform = transforms.length;
  await send({ type: 'transform', value: { scale: 200, offsetX: 25, offsetY: -20 } });
  assert.equal(transforms.length, paintsBeforeSameTransform, 'unchanged settings do not trigger a redraw');
  clock = 10000;
  await send({ type: 'speed', value: 2 });
  assert.equal(timers.size, 0, 'speed changes keep paused scenes paused');
  await send({ type: 'playing', value: true });
  tickAt(10100);
  assert(Math.abs(times.at(-1) - 0.5625) < 1e-8, 'paused time never advances the animation');
});

test("background worker draws independently, budgets expensive frames and stops without queued work", async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/renderer/src/features/terminal/asciiBackground.worker.ts', import.meta.url))],
    bundle: true, write: false, format: 'iife', platform: 'browser',
  });
  let clock = 0, paints = 0, next = 0;
  const timers = new Map();
  const canvas = { width: 1200, height: 600 };
  const ctx = new Proxy({ canvas }, {
    get(target, key) {
      return key in target ? target[key] : () => { clock += 0.02; if (key === 'fillText') paints++; };
    },
  });
  canvas.getContext = (kind) => kind === '2d' ? ctx : null;
  const self = {};
  vm.runInNewContext(bundle.outputFiles[0].text, {
    self, console, performance: { now: () => clock },
    setTimeout: (callback, delay) => { timers.set(++next, { callback, delay }); return next; },
    clearTimeout: (id) => timers.delete(id),
  });
  await self.onmessage({ data: { type: 'init', canvas, scene: 'aurora-fjord' } });
  assert(paints > 0);
  assert.equal(timers.size, 0, 'starts with a still frame');
  await self.onmessage({ data: { type: 'playing', value: true } });
  assert.equal(timers.size, 1);
  const [id, { callback }] = [...timers][0];
  timers.delete(id);
  const start = clock;
  callback();
  const cost = clock - start;
  assert.equal(timers.size, 1, 'only one next frame is scheduled');
  assert([...timers.values()][0].delay >= cost * 3 - 0.001, 'expensive frames leave at least 75% idle time');
  await self.onmessage({ data: { type: 'playing', value: false } });
  assert.equal(timers.size, 0);
  await self.onmessage({ data: { type: 'resize', width: 800, height: 400 } });
  assert.equal(canvas.width, 800);
  assert.equal(canvas.height, 400);
  assert.equal(timers.size, 0, 'resize preserves pause');
});
