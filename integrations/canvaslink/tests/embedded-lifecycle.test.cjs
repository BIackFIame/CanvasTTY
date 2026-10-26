const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const crypto = require('node:crypto');
const srp = require('secure-remote-password/client');
const { seal, open, USER } = require('../host/security.cjs');
const file = path.join(__dirname, '../host/embedded.cjs');
function fixture({ failLoad = false } = {}) {
  const counters = { listeners: 0, discovery: 0, panels: 0, close: 0, destroy: 0 };
  const handlers = new Map(), timers = new Set(), app = new EventEmitter();
  app.getPath = () => '/unused-test-runtime';
  const target = new EventEmitter(); target.isDestroyed = () => false;
  target.webContents = { mainFrame: {}, executeJavaScript: async () => {}, endFrameSubscription() {} };
  target.getContentSize = () => [1000, 700]; target.getTitle = () => 'Owned fixture';
  let panel, captureHandler, pairing, serve;
  const events = [];
  class Panel extends EventEmitter {
    constructor() { super(); counters.panels++; panel = this; this.webContents = new EventEmitter(); this.webContents.mainFrame = {}; this.webContents.setWindowOpenHandler = () => {}; this.webContents.send = (channel, value) => events.push(value); }
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
    'node:http': { createServer(handler) { serve=handler;return { requestTimeout: 0, once() {}, listen(port, host, done) { counters.listeners++; done(); }, address: () => ({ port: 3499 }), close() { counters.close++; } }; } },
    './discovery.cjs': { publish() { counters.discovery++; return { destroy() {} }; } },
    './security.cjs': { ...localRequire('./security.cjs'), Pairing: class extends localRequire('./security.cjs').Pairing { constructor(options) { super(options); pairing = this; } } }
  };
  const context = { require: name => Object.hasOwn(replacements, name) ? replacements[name] : localRequire(name), module: { exports: {} }, __dirname: path.dirname(file), process, Buffer, setInterval(fn) { const token = { fn }; timers.add(token); return token; }, clearInterval(token) { timers.delete(token); } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  context.module.exports.install({ getWindow: () => target });
  const event = { sender: target.webContents, senderFrame: target.webContents.mainFrame };
  const request=async ({route='/channel',method='POST',address='192.168.2.23',headers={},body={}}={})=>{
    const req=Readable.from([Buffer.from(typeof body==='string'?body:JSON.stringify(body))]);
    Object.assign(req,{method,url:route,socket:{remoteAddress:address},headers:{'content-type':'application/json',...headers}});
    const result={};await serve(req,{headersSent:false,writeHead(status,headers){result.status=status;result.headers=headers;},end(body){result.body=JSON.parse(body);}});return result;
  };
  return { counters, handlers, event, target, timers, captureSession, events, request, get pairing() { return pairing; }, get panel() { return panel; }, capture: request => { let result; captureHandler(request, value => result = value); return result; }, state: () => handlers.get('canvaslink-settings:state')(event), command: action => handlers.get('canvaslink-settings:command')(event, action) };
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
test('The host revokes an expired video session even when the client sends nothing', async () => {
  const f=fixture();await f.command('enable');
  f.pairing.sessions.set('expired',{id:'expired',name:'Silent peer',expires:0,queue:[]});
  for(const timer of f.timers)await timer.fn();
  assert.equal(f.pairing.sessions.has('expired'),false);
  assert.equal(f.events.filter(e=>e.type==='revoke'&&e.id==='expired').length,1);
  for(const timer of f.timers)await timer.fn();
  assert.equal(f.events.filter(e=>e.type==='revoke').length,1);
  await f.command('disable');
});
test('The HTTP boundary rejects browser origins, public peers, unsupported routes and oversized bodies',async()=>{
  const f=fixture();await f.command('enable');
  for(const options of [{address:'8.8.8.8'},{headers:{origin:'https://attacker.invalid'}},{headers:{origin:'null'}},{method:'GET'},{route:'/exec'},{body:'{'},{body:' '.repeat(131073)}]){
    const response=await f.request(options);assert.equal(response.status,403,JSON.stringify(options).slice(0,150));
    assert.equal(response.headers['Cache-Control'],'no-store');
  }
  assert.equal((await f.request({headers:{'content-type':'text/plain'}})).status,415);
  assert.equal(f.events.length,0);assert.equal(f.pairing.sessions.size,0);await f.command('disable');
});
test('Only mutually authenticated, fresh and address-bound HTTP signals reach the renderer',async()=>{
  const f=fixture();await f.command('enable');
  const a=srp.generateEphemeral(),challenge=(await f.request({route:'/pair/start',body:{A:a.public,name:'Synthetic security test'}})).body;
  const session=srp.deriveSession(a.secret,challenge.B,challenge.salt,USER,srp.derivePrivateKey(challenge.salt,USER,f.pairing.pin));
  const finish=await f.request({route:'/pair/finish',body:{id:challenge.id,proof:session.proof}});assert.equal(finish.status,200);srp.verifySession(a.public,session,finish.body.proof);
  const id=finish.body.id,key=crypto.createHash('sha256').update(Buffer.from(session.key,'hex')).update('CanvasLink/channel/1').digest();
  const signal=seq=>seal(key,id,seq,'request',{type:'signal',message:{type:'ping'}});
  const first=signal(1);assert.equal((await f.request({body:first,address:'192.168.2.24'})).status,403);
  const response=await f.request({body:first});assert.equal(response.status,200);assert.deepEqual(open(key,id,response.body,'response'),{ok:true});
  assert.equal((await f.request({body:first})).status,403);
  assert.equal((await f.request({body:{...signal(2),data:Buffer.alloc(32).toString('base64')}})).status,403);
  assert.equal((await f.request({body:seal(key,id,2,'request',{type:'signal',message:{type:'exec',command:'must-not-run'}})})).status,403);
  assert.equal(f.events.filter(e=>e.type==='signal').length,1);
  await f.command('revoke');assert.equal((await f.request({body:signal(3)})).status,403);
  assert.equal(f.events.filter(e=>e.type==='signal').length,1);await f.command('disable');
});
