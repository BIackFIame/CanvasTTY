const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const file = path.join(__dirname, '../host/embedded.cjs');
function fixture({ failLoad = false } = {}) {
  const counters = { listeners: 0, discovery: 0, panels: 0, close: 0, destroy: 0 };
  const handlers = new Map(), timers = new Set(), app = new EventEmitter();
  app.getPath = () => '/unused-test-runtime';
  const target = new EventEmitter(); target.isDestroyed = () => false;
  target.webContents = { mainFrame: {}, executeJavaScript: async () => {}, endFrameSubscription() {} };
  target.getContentSize = () => [1000, 700]; target.getTitle = () => 'Owned fixture';
  let panel, captureHandler;
  class Panel extends EventEmitter {
    constructor() { super(); counters.panels++; panel = this; this.webContents = new EventEmitter(); this.webContents.mainFrame = {}; this.webContents.setWindowOpenHandler = () => {}; }
    isDestroyed() { return !!this.destroyed; }
    destroy() { this.destroyed = true; counters.destroy++; }
    hide() {}
    async loadFile() { if (failLoad) throw Error('fixture-load-failed'); }
  }
  const captureSession = { setPermissionCheckHandler(fn) { this.check = fn; }, setPermissionRequestHandler() {}, setDisplayMediaRequestHandler(fn) { captureHandler = fn; } };
  const electron = { app, BrowserWindow: Panel, nativeImage: {}, session: { fromPartition: () => captureSession }, ipcMain: { handle: (key, fn) => handlers.set(key, fn), on: (key, fn) => handlers.set(key, fn) } };
  const localRequire = createRequire(file);
  const replacements = {
    electron,
    'node:fs': { mkdirSync() {} },
    'node:http': { createServer() { return { requestTimeout: 0, once() {}, listen(port, host, done) { counters.listeners++; done(); }, address: () => ({ port: 3499 }), close() { counters.close++; } }; } },
    './discovery.cjs': { publish() { counters.discovery++; return { destroy() {} }; } }
  };
  const context = { require: name => Object.hasOwn(replacements, name) ? replacements[name] : localRequire(name), module: { exports: {} }, __dirname: path.dirname(file), process, setInterval(fn) { const token = {}; timers.add(token); return token; }, clearInterval(token) { timers.delete(token); } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  context.module.exports.install({ getWindow: () => target });
  const event = { sender: target.webContents, senderFrame: target.webContents.mainFrame };
  return { counters, handlers, event, target, timers, captureSession, get panel() { return panel; }, capture: request => { let result; captureHandler(request, value => result = value); return result; }, state: () => handlers.get('canvaslink-settings:state')(event), command: action => handlers.get('canvaslink-settings:command')(event, action) };
}
test('Installing CanvasLink is inert until an owning settings command enables access', async () => {
  const f = fixture();
  assert.equal(f.state().enabled, false); assert.equal(f.state().pin, '');
  assert.deepEqual(f.counters, { listeners: 0, discovery: 0, panels: 0, close: 0, destroy: 0 });
  assert.equal(f.timers.size, 0);
  await f.command('enable'); assert.equal(f.state().enabled, true);
  assert.equal(f.counters.listeners, 1); assert.equal(f.counters.panels, 1);
  await f.command('enable'); assert.equal(f.counters.listeners, 1);
  await f.command('disable'); assert.equal(f.state().enabled, false); assert.equal(f.timers.size, 0); assert.equal(f.panel.destroyed, true);
});
test('Capture grants only the owned CanvasTTY main frame and stops after disable', async () => {
  const f = fixture(); await f.command('enable');
  assert.equal(f.capture({ frame: f.panel.webContents.mainFrame }).video, f.target.webContents.mainFrame);
  assert.equal(f.capture({ frame: {} }).video, undefined);
  assert.equal(f.captureSession.check({}, 'display-capture'), false);
  assert.equal(f.captureSession.check(f.panel.webContents, 'display-capture'), true);
  assert.equal(f.captureSession.check(f.panel.webContents, 'media'), false);
  await f.command('disable'); assert.equal(f.capture({ frame: f.panel.webContents.mainFrame }).video, undefined);
});
test('A failed capture-worker load closes the listener and allows a clean retry', async () => {
  const f = fixture({ failLoad: true });
  await assert.rejects(f.command('enable'), /fixture-load-failed/);
  assert.equal(f.state().enabled, false); assert.equal(f.counters.close, 1); assert.equal(f.timers.size, 0); assert.equal(f.panel.destroyed, true);
  await assert.rejects(f.command('enable'), /fixture-load-failed/);
  assert.equal(f.counters.listeners, 2); assert.equal(f.counters.close, 2);
});
