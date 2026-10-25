// Real Electron + built preload/host wiring, using hidden disposable windows.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electronSmokeLaunchBlockReason } from './lib/electron-smoke-launch-guard.mjs';
const require = createRequire(import.meta.url), electron = require('electron');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (typeof electron === 'string') {
  const reason = electronSmokeLaunchBlockReason(process.platform, process.env);
  if (reason) throw Error(reason);
  const profile = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'ct-link-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CANVASTTY_') && !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'].includes(name)));
  const log = join(profile, 'electron.log');
  const ownedPids = () => process.platform !== 'darwin' ? [] : spawnSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).stdout.split('\n').flatMap(line => { const match = line.match(/^\s*(\d+)\s+(.*)$/); return match && match[2] === electron ? [Number(match[1])] : []; });
  const before = new Set(ownedPids());
  const args = [fileURLToPath(import.meta.url), `--user-data-dir=${profile}`, '--canvaslink-port', '0'];
  if (process.platform === 'linux' && process.env.CI === 'true') args.push('--no-sandbox');
  try {
    const child = process.platform === 'darwin'
      ? spawn('/usr/bin/open', ['-n', '-W', '-g', '-j', resolve(electron, '../../..'), '--stdout', log, '--stderr', log, '--args', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(electron, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
    const code = await new Promise((done, reject) => { child.on('error', reject); child.on('exit', done); });
    clearTimeout(timer);
    if (process.platform === 'darwin') output += await readFile(log, 'utf8').catch(() => '');
    if (code !== 0 || !output.includes('CANVASTTY_CANVASLINK_SMOKE_OK')) throw Error(`Electron exit=${code}; output: ${output.slice(-5000) || '(no output before timeout)'}`);
    console.log('CANVASTTY_CANVASLINK_SMOKE_OK (real built preload, IPC, enable/revoke/disable, untrusted-window rejection)');
  } finally {
    for (const pid of ownedPids()) if (!before.has(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    await rm(profile, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow } = electron;
  app.setName('CanvasTTY CanvasLink isolated smoke');
  const profileArg = process.argv.find(arg => arg.startsWith('--user-data-dir='));
  assert.ok(profileArg); app.setPath('userData', profileArg.split('=').slice(1).join('='));
  app.on('window-all-closed', () => {});
  let owned;
  const { install } = require(join(root, 'out/main/canvaslink/host/embedded.cjs'));
  install({ getWindow: () => owned });
  try {
    await app.whenReady(); app.dock?.hide();
    const page = join(app.getPath('userData'), 'fixture.html');
    await writeFile(page, '<!doctype html><title>CanvasLink isolated fixture</title><input aria-label="Fixture only">');
    const create = () => new BrowserWindow({ show: false, webPreferences: { preload: join(root, 'out/preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    owned = create(); await owned.loadFile(page);
    const call = script => owned.webContents.executeJavaScript(script);
    assert.equal((await call('window.canvasTTY.canvasLink.state()')).enabled, false);
    let state = await call('window.canvasTTY.canvasLink.command("enable")');
    assert.equal(state.enabled, true); assert.match(state.pin, /^\d{6}$/);
    const stranger = create(); await stranger.loadFile(page);
    const rejected = await stranger.webContents.executeJavaScript('window.canvasTTY.canvasLink.command("disable").then(()=>false,()=>true)');
    assert.equal(rejected, true); stranger.destroy();
    state = await call('window.canvasTTY.canvasLink.command("revoke")');
    assert.equal(state.enabled, true); assert.equal(state.devices.length, 0);
    state = await call('window.canvasTTY.canvasLink.command("disable")');
    assert.equal(state.enabled, false); assert.equal(state.pin, '');
    assert.equal(await call('window.canvasTTY.canvasLink.command("new-code").then(()=>false,()=>true)'), true);
    console.log('CANVASTTY_CANVASLINK_SMOKE_OK');
    owned.destroy(); app.quit();
  } catch (error) { console.error(error); app.exit(1); }
}
