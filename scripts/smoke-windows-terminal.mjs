import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { terminalEmulatorOptions, terminalPtyOptions, CONPTY_DEVICE_ATTRIBUTES } from "../src/shared/terminalCompatibility.ts";

if (process.platform !== "win32") throw new Error("The packaged ConPTY smoke requires Windows.");

if (process.argv[2] !== "--probe") {
  const app = resolve("release/win-unpacked/CanvasTTY.exe");
  const result = spawnSync(app, [fileURLToPath(import.meta.url), "--probe", resolve("release/win-unpacked"), process.execPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true
  });
  if (result.error) throw new Error(`${result.error.message}\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /CANVASTTY_CONPTY_SMOKE_OK/);
  console.log(result.stdout.trim());
} else {
  let phase = "loading the packaged native module";
  const watchdog = setTimeout(() => { console.error(`ConPTY probe timed out while ${phase}`); process.exit(1); }, 25_000);
  // Load the packaged native module under its Electron ABI, without opening an application window.
  const require = createRequire(import.meta.url);
  const pty = require(join(process.argv[3], "resources/app.asar/node_modules/node-pty"));
  const { Terminal } = require("@xterm/headless");
  const terminal = new Terminal({ ...terminalEmulatorOptions("win32"), cols: 40, rows: 10, allowProposedApi: true });
  phase = "starting the PTY";
  const child = pty.spawn(process.argv[4], ["-e", `
    const draw = () => process.stdout.write('\\x1b[2J\\x1b[H\\x1b[31mFRAME:' + process.stdout.columns + 'x' + process.stdout.rows + '\\x1b[0m\\r\\nROW:one\\r\\n\\x1b[7mSELECTED:two\\x1b[0m');
    process.stdin.setRawMode(true);
    process.stdin.on('data', data => { if (data.includes(113)) process.exit(0); else draw(); });
    draw();
  `], { ...terminalPtyOptions("win32"), cols: 40, rows: 10, cwd: process.cwd(), env: { ...process.env } });
  let failure;
  const exited = new Promise(resolve => child.onExit(({ exitCode }) => resolve(exitCode)));
  const changed = new Set();
  terminal.parser.registerCsiHandler({ final: "c" }, () => { child.write(CONPTY_DEVICE_ATTRIBUTES); return true; });
  terminal.onData(data => child.write(data));
  child.onData(data => terminal.write(data, () => { for (const check of [...changed]) check(); }));
  const row = n => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + n)?.translateToString(true) ?? "";
  const waitFor = text => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { changed.delete(check); reject(new Error(`Missing ${text}; screen: ${row(0)} / ${row(1)} / ${row(2)}`)); }, 5000);
    const check = () => {
      if (!row(0).startsWith(text)) return;
      clearTimeout(timer); changed.delete(check); resolve();
    };
    changed.add(check); check();
  });
  try {
    phase = "waiting for the initial frame";
    await waitFor("FRAME:40x10");
    for (const [cols, rows] of [[72, 18], [32, 8], [60, 15]]) {
      phase = `redrawing at ${cols}x${rows}`;
      terminal.resize(cols, rows);
      child.resize(cols, rows);
      await new Promise(resolve => setTimeout(resolve, 150));
      child.write("r");
      await waitFor(`FRAME:${cols}x${rows}`);
      assert.equal(row(1), "ROW:one");
      assert.equal(row(2), "SELECTED:two");
    }
    child.write("q");
    phase = "waiting for the child to exit";
    assert.equal(await exited, 0);
    console.log("CANVASTTY_CONPTY_SMOKE_OK: packaged DLL, DA1, colors, redraw and three resizes");
  } catch (error) { failure = error; }
  finally { clearTimeout(watchdog); try { child.kill(); } catch {} terminal.dispose(); }
  if (failure) console.error(failure);
  // node-pty's Windows workers can outlive the PTY; this disposable probe must terminate them too.
  process.exit(failure ? 1 : 0);
}
