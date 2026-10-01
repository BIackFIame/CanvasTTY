// Standalone real Electron/xterm proof without app imports or focus. Linux CI uses an inactive Xvfb window.
// npm run smoke:terminal-hidden
// npm run bench:terminal-hidden-renderer -- [cards=5] [seconds=10] [Ki UTF-16 units/s=1024] [runs=3]
// Smoke CPU timings are diagnostic only. Use the separate serial benchmark for comparisons.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(join(REPO, "package.json"));
const electron = require("electron");
const self = fileURLToPath(import.meta.url);
const benchmarkIndex = process.argv.indexOf("--benchmark");
const benchmark = benchmarkIndex < 0 ? undefined : parseBenchmark(process.argv.slice(benchmarkIndex + 1));
// A short random path also avoids macOS's Unix-domain-socket path limit.
const TEMP_ROOT = process.platform === "win32" ? tmpdir() : "/tmp";
const SUCCESS_MARKER = benchmark ? "CANVASTTY_HIDDEN_RENDERER_BENCH_OK" : "CANVASTTY_HIDDEN_DOM_PROBE_OK";

if (typeof electron === "string") {
  const userData = await mkdtemp(join(TEMP_ROOT, "cth-"));
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const electronArgs = [self, ...(benchmark ? ["--benchmark", ...benchmark.args] : []), `--user-data-dir=${userData}`];
  // Hosted Linux CI cannot install a root-owned chrome-sandbox. Only this isolated
  // local fixture disables Electron's outer sandbox; production code is not loaded.
  if (process.platform === "linux" && process.env.CI === "true") electronArgs.push("--no-sandbox");
  const child = spawn(electron, electronArgs, {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const launch = { at: new Date().toISOString(), nodePid: process.pid, nodeParentPid: process.ppid, electronPid: child.pid };
  console.log("CANVASTTY_HIDDEN_DOM_PROBE_LAUNCH " + JSON.stringify(launch));
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; process.stdout.write(chunk); });
  child.stderr.on("data", chunk => { process.stderr.write(chunk); });
  const timeoutMs = benchmark ? Math.ceil(benchmark.seconds * benchmark.runs * 2 * 1000 + 60_000) : 60_000;
  const deadline = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(result.signal, null, `Electron probe terminated with signal ${result.signal}`);
    assert.equal(result.code, 0, "Electron probe failed");
    assert.ok(output.includes(SUCCESS_MARKER), "Electron exited without completing the checks");
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(userData, { recursive: true, force: true });
  }
} else {
  // Electron must finish evaluating the entry module before it can emit ready.
  // Awaiting app.whenReady at the entry module's top level deadlocks that bootstrap.
  void runElectronProbe();
}

function parseBenchmark(args) {
  const values = [5, 10, 1024, 3].map((fallback, index) => {
    const argument = args[index];
    return argument === undefined || argument.startsWith("--") ? fallback : Number(argument);
  });
  const [cards, seconds, kiloCharactersPerSecond, runs] = values;
  assert.ok(Number.isInteger(cards) && cards >= 1 && cards <= 5, "cards must be an integer from 1 to 5");
  assert.ok(Number.isFinite(seconds) && seconds > 0 && seconds <= 60, "seconds must be from 0 to 60");
  assert.ok(Number.isFinite(kiloCharactersPerSecond) && kiloCharactersPerSecond > 0 && kiloCharactersPerSecond <= 8192,
    "rate must be from 0 to 8192 Ki UTF-16 units/s/card");
  assert.ok(Number.isInteger(runs) && runs >= 1 && runs <= 10, "runs must be an integer from 1 to 10");
  return { cards, seconds, kiloCharactersPerSecond, runs, args: values.map(String) };
}

function benchmarkHtml({ xtermModule, fitModule, xtermCss, suspensionRule, guardBundle }) {
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' file:; style-src 'unsafe-inline' file:; font-src file:">
    <link rel="stylesheet" href="${xtermCss}">
    <style>html,body{margin:0;width:100%;height:100%;background:#202430;overflow:hidden}
      #surfaces{display:grid;grid-template-columns:repeat(3,700px);gap:16px;padding:16px}
      .terminal-card__surface{width:700px;height:460px;overflow:hidden}
      .xterm{height:100%;padding:0}
      ${suspensionRule}</style></head><body><div id="surfaces"></div>
    <script>${guardBundle}</script><script type="module">
    globalThis.__hiddenDomProbe = (async () => {
      const { Terminal } = await import(${JSON.stringify(xtermModule)});
      const { FitAddon } = await import(${JSON.stringify(fitModule)});
      const config = ${JSON.stringify(benchmark)};
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const root = document.querySelector('#surfaces');
      const tickMs = 16;
      // Matches TerminalManager's hidden-card ring size; both variants get every
      // character, in the same ring-sized batches, including the final partial batch.
      const batchCharacters = 240000;
      const perTick = Math.round(config.kiloCharactersPerSecond * 1024 * tickMs / 1000);
      const ticks = Math.ceil(config.seconds * 1000 / tickMs);
      const line = '\\x1b[32m✔\\x1b[0m \\x1b[1mbuilding\\x1b[0m module \\x1b[36m%\\x1b[0m of 4096 files … \\x1b[2K\\r\\n';
      const repeated = line.repeat(Math.ceil((perTick + line.length) / line.length));
      const hashBuffer = terminal => {
        let hash = 2166136261;
        const add = value => {
          const text = String(value);
          for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
          hash = Math.imul(hash ^ 0xff, 16777619);
        };
        const buffer = terminal.buffer.active;
        add(buffer.length); add(buffer.baseY); add(buffer.viewportY); add(buffer.cursorX); add(buffer.cursorY);
        add(JSON.stringify(terminal.modes));
        for (let row = 0; row < buffer.length; row++) {
          const line = buffer.getLine(row);
          add(line.isWrapped);
          for (let col = 0; col < terminal.cols; col++) {
            const cell = line.getCell(col);
            add(cell.getChars()); add(cell.getWidth()); add(cell.getFgColorMode()); add(cell.getFgColor());
            add(cell.getBgColorMode()); add(cell.getBgColor()); add(cell.isBold()); add(cell.isItalic());
            add(cell.isDim()); add(cell.isUnderline()); add(cell.isBlink()); add(cell.isInverse());
            add(cell.isInvisible()); add(cell.isStrikethrough()); add(cell.isOverline());
          }
        }
        return hash >>> 0;
      };
      const runCase = async mode => {
        console.log('benchmark ' + mode);
        root.replaceChildren();
        const entries = [];
        for (let index = 0; index < config.cards; index++) {
          const host = document.createElement('div');
          host.className = 'terminal-card__surface';
          root.append(host);
          const terminal = new Terminal({cols:80,rows:24,fontSize:14,fontFamily:'monospace',
            lineHeight:1.2,scrollback:5000,cursorBlink:false,allowProposedApi:true});
          const fit = new FitAddon();
          terminal.loadAddon(fit);
          terminal.open(host);
          const restoreGuard = globalThis.__selectionGuardProbe.skipEmptySelectionRedraws(terminal);
          const renders = [];
          const listener = terminal.onRender(event => renders.push({...event}));
          entries.push({host,terminal,fit,restoreGuard,renders,listener});
        }
        await delay(250);
        for (const {fit} of entries) fit.fit();
        await delay(100);
        await Promise.all(entries.map(({terminal}) => new Promise(resolve => terminal.write('BENCHMARK READY\\r\\n', resolve))));
        await delay(80);
        for (const entry of entries) {
          entry.host.style.visibility = 'hidden';
          entry.host.dataset.suspended = String(mode === 'screen-display-none');
        }
        await delay(250);
        for (const entry of entries) entry.renders.length = 0;
        const pending = [];
        let queued = '';
        let streamOffset = 0;
        let deliveredCharacters = 0;
        let deliveryBatches = 0;
        const deliver = text => {
          deliveredCharacters += text.length * config.cards;
          deliveryBatches += config.cards;
          for (const {terminal} of entries) pending.push(new Promise(resolve => terminal.write(text, resolve)));
        };
        const startCpu = process.cpuUsage();
        const started = performance.now();
        for (let tick = 0; tick < ticks; tick++) {
          // Preserve the continuous ANSI stream even when a tick ends inside CSI or text.
          const chunk = repeated.slice(streamOffset, streamOffset + perTick);
          streamOffset = (streamOffset + perTick) % line.length;
          // TerminalManager emits the previous hidden stretch BEFORE the next chunk
          // would push it out of the ring; a single oversized chunk is delivered whole.
          if (queued && queued.length + chunk.length > batchCharacters) { deliver(queued); queued = ''; }
          queued += chunk;
          if (queued.length > batchCharacters) { deliver(queued); queued = ''; }
          await delay(tickMs);
        }
        if (queued) deliver(queued);
        await Promise.all(pending);
        await delay(150);
        const hiddenCpu = process.cpuUsage(startCpu);
        const hiddenElapsed = performance.now() - started;
        const hiddenRenders = entries.reduce((count, entry) => count + entry.renders.length, 0);
        const hiddenRendersPerCard = entries.map(entry => entry.renders.length);
        for (const entry of entries) {
          entry.renders.length = 0;
          entry.host.style.visibility = 'visible';
          entry.host.dataset.suspended = 'false';
        }
        await delay(250);
        for (const {fit} of entries) fit.fit();
        await delay(80);
        const totalCpu = process.cpuUsage(startCpu);
        const elapsed = performance.now() - started;
        const result = {
          hiddenCpuSeconds:(hiddenCpu.user+hiddenCpu.system)/1e6,
          totalCpuSeconds:(totalCpu.user+totalCpu.system)/1e6,
          hiddenWallSeconds:hiddenElapsed/1000,
          totalWallSeconds:elapsed/1000,
          hiddenRenders,hiddenRendersPerCard,
          fullResumeRefreshes:entries.filter(({terminal,renders}) => renders.some(event => event.start === 0 && event.end === terminal.rows - 1)).length,
          grid:entries.map(({terminal}) => ({cols:terminal.cols,rows:terminal.rows})),
          streamCharacters:ticks*perTick*config.cards,
          deliveredCharacters,deliveryBatches,
          stateHashes:entries.map(({terminal}) => hashBuffer(terminal))
        };
        for (const {listener,restoreGuard,terminal} of entries) {
          listener.dispose();restoreGuard();terminal.dispose();
        }
        return result;
      };
      const runs = [];
      for (let index = 0; index < config.runs; index++) {
        // Alternate ordering to avoid giving the same style every cold start.
        const run = {};
        const order = index % 2 === 0 ? ['oldHidden','screenDisplayNone'] : ['screenDisplayNone','oldHidden'];
        for (const mode of order) run[mode] = await runCase(mode === 'oldHidden' ? 'visibility-hidden' : 'screen-display-none');
        runs.push(run);
      }
      const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length/2)];
      const summary = mode => ({
        hiddenCpuSeconds:median(runs.map(run => run[mode].hiddenCpuSeconds)),
        totalCpuSeconds:median(runs.map(run => run[mode].totalCpuSeconds)),
        totalWallSeconds:median(runs.map(run => run[mode].totalWallSeconds)),
        hiddenRenders:median(runs.map(run => run[mode].hiddenRenders))
      });
      return {config:{cards:config.cards,seconds:config.seconds,kiloCharactersPerSecond:config.kiloCharactersPerSecond,runs:config.runs},
        inputCadenceMs:tickMs,batchCharacters,summary:{oldHidden:summary('oldHidden'),screenDisplayNone:summary('screenDisplayNone')},runs};
    })();
    </script></body></html>`;
}

async function runElectronProbe() {
  const { app, BrowserWindow } = electron;
  console.log("CANVASTTY_HIDDEN_DOM_PROBE_STAGE main-entered");
  app.dock?.hide();
  if (process.platform === "darwin") app.setActivationPolicy("prohibited");
  const fixtureDir = await mkdtemp(join(TEMP_ROOT, "cthf-"));
  let window;
  try {
    await app.whenReady();
    console.log("CANVASTTY_HIDDEN_DOM_PROBE_STAGE app-ready");
    window = new BrowserWindow({
      width: benchmark ? 2220 : 940,
      height: benchmark ? 1040 : 740,
      show: false,
      focusable: false,
      skipTaskbar: true,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        offscreen: true,
        backgroundThrottling: false,
        // Only this isolated local test enables Node to measure renderer process CPU.
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false
      }
    });
    window.webContents.on("console-message", event => {
      console.log("CANVASTTY_HIDDEN_DOM_PROBE_RENDER " + event.message);
    });
    const fixturePath = join(fixtureDir, "probe.html");
    await writeFile(fixturePath, fixtureHtml());
    console.log("CANVASTTY_HIDDEN_DOM_PROBE_STAGE fixture-written");
    await window.loadFile(fixturePath);
    console.log("CANVASTTY_HIDDEN_DOM_PROBE_STAGE fixture-loaded");
    // The Linux CI smoke runs under xvfb-run. A native-hidden BrowserWindow
    // globally pauses Chromium's renderer there, invalidating the baseline. Keep
    // this isolated offscreen fixture painting on the virtual display without
    // taking focus; local runs and all benchmarks remain natively hidden.
    const linuxXvfbSmokeWindow = process.platform === "linux" && process.env.CI === "true" && !benchmark;
    if (linuxXvfbSmokeWindow) {
      window.webContents.setFrameRate(60);
      window.webContents.startPainting();
      window.showInactive();
    }
    const result = await window.webContents.executeJavaScript("globalThis.__hiddenDomProbe");
    if (!benchmark) Object.assign(result.diagnostics, {
      nativeWindowVisible: window.isVisible(),
      nativeWindowFocused: window.isFocused(),
      fixtureVisibilityMode: linuxXvfbSmokeWindow ? "xvfb-visible-inactive" : "native-hidden",
      offscreenPainting: window.webContents.isPainting(),
      offscreenFrameRate: window.webContents.getFrameRate()
    });
    if (benchmark) {
      for (const run of result.runs) {
        assert.equal(run.oldHidden.hiddenRenders > 0, true, "hidden-window rendering paused; benchmark baseline is invalid");
        assert.equal(run.oldHidden.hiddenRendersPerCard.every(count => count > 0), true, "some baseline cards did not render; comparison is invalid");
        assert.equal(run.screenDisplayNone.hiddenRenders, 0, "suspended terminal rendered during flood");
        assert.equal(run.screenDisplayNone.fullResumeRefreshes, benchmark.cards);
        assert.equal(run.oldHidden.streamCharacters, run.screenDisplayNone.streamCharacters);
        assert.equal(run.oldHidden.deliveredCharacters, run.oldHidden.streamCharacters);
        assert.equal(run.screenDisplayNone.deliveredCharacters, run.screenDisplayNone.streamCharacters);
        assert.deepEqual(run.oldHidden.grid, run.screenDisplayNone.grid);
        assert.deepEqual(run.oldHidden.stateHashes, run.screenDisplayNone.stateHashes);
      }
      assert.equal(window.isVisible(), false);
      assert.equal(window.isFocused(), false);
      console.log(SUCCESS_MARKER + " " + JSON.stringify({
        ...result,
        windowShown: false,
        nativeWindowFocused: false,
        rendererCpuIncludesAllCards: true,
        excludesMainProcessAndElectronIpc: true,
        includesLosslessParseAndFinalResume: true
      }, null, 2));
      return;
    }
    assert.equal(result.oldHidden.renders > 0, true, "hidden baseline rendered no xterm frames; diagnostics: " + JSON.stringify(result.diagnostics));
    assert.ok(result.oldHidden.renderWarmupEvents > 0, "hidden baseline produced no xterm onRender during warm-up; diagnostics: " + JSON.stringify(result.diagnostics));
    assert.ok(result.oldHidden.rafFramesDuringHidden > 0, "hidden baseline received no animation frames; diagnostics: " + JSON.stringify(result.diagnostics));
    assert.ok(result.screenDisplayNone.rafFramesDuringHidden > 0, "candidate received no animation frames; window-level throttling invalidates comparison: " + JSON.stringify(result.diagnostics));
    assert.equal(result.oldHidden.intersection.isIntersecting, true, "baseline xterm surface did not reach the visible intersection state");
    assert.equal(result.screenDisplayNone.intersection.isIntersecting, false, "candidate xterm screen was not removed from intersection by display:none");
    assert.equal(result.screenDisplayNone.renders, 0, "screen display:none still rendered during hidden output");
    assert.equal(result.screenDisplayNone.resumeFullRefresh, true, "resume did not produce a full viewport refresh");
    assert.deepEqual(result.oldHidden.afterHidden, result.reference.afterHidden);
    assert.deepEqual(result.screenDisplayNone.afterHidden, result.reference.afterHidden);
    assert.deepEqual(result.oldHidden.final, result.reference.final);
    assert.deepEqual(result.screenDisplayNone.final, result.reference.final);
    assert.deepEqual(result.initialScreenHidden.afterHidden, result.initialHiddenReference.afterHidden);
    assert.deepEqual(result.initialScreenHidden.final, result.initialHiddenReference.final);
    assert.equal(result.initialScreenHidden.renders, 0, "initially suspended screen rendered hidden output");
    assert.equal(result.initialScreenHidden.resumeFullRefresh, true);
    assert.equal(result.selectedOldHidden.renders > 0, true, "selected baseline did not render");
    assert.equal(result.selectedScreenHidden.renders, 0);
    assert.equal(result.selectedScreenHidden.rowMutations, 0, "selected hidden terminal still rebuilt DOM rows");
    assert.equal(result.selectedScreenHidden.resumeFullRefresh, true);
    assert.deepEqual(result.selectedScreenHidden.afterHidden, result.selectedOldHidden.afterHidden);
    assert.deepEqual(result.selectedScreenHidden.final, result.selectedOldHidden.final);
    for (const value of Object.entries(result).filter(([key]) => key !== "diagnostics").map(([, value]) => value)) {
      assert.equal(value.fitGridMaintained, true);
      assert.equal(value.stateUnchangedByResume, true);
      assert.equal(value.afterHidden.active.type, value.usedAlternate ? "alternate" : "normal");
      assert.equal(value.final.active.type, "normal");
      assert.equal(value.final.normal.lines.length > value.grid.rows, true);
    }
    assert.equal(window.isVisible(), linuxXvfbSmokeWindow, "native visibility must match the platform fixture mode: " + JSON.stringify(result.diagnostics));
    assert.equal(window.isFocused(), false);
    const compact = value => ({
      rendererCpuMs: value.rendererCpuMs,
      hiddenRenders: value.renders,
      hiddenRowMutations: value.rowMutations,
      resumeRenders: value.resumeRenders,
      resumeFullRefresh: value.resumeFullRefresh,
      grid: value.grid,
      fitGridMaintained: value.fitGridMaintained,
      stateUnchangedByResume: value.stateUnchangedByResume,
      alternateCursor: value.afterHidden.active.cursor,
      alternateModes: value.afterHidden.modes,
      finalNormalHistoryLines: value.final.normal.lines.length,
      finalCursor: value.final.active.cursor,
      finalModes: value.final.modes,
      selectionTextWhileHidden: value.afterHidden.selection,
      streamCharacters: value.streamCharacters,
      rafFramesDuringHidden: value.rafFramesDuringHidden,
      rafWarmupFrames: value.rafWarmupFrames,
      hiddenBaselineRenderWarmupEvents: value.renderWarmupEvents,
      intersection: value.intersection,
      documentVisibilityState: value.documentVisibilityState
    });
    console.log("CANVASTTY_HIDDEN_DOM_PROBE_OK " + JSON.stringify({
      windowShown: window.isVisible(),
      nativeWindowFocused: window.isFocused(),
      fixtureVisibilityMode: linuxXvfbSmokeWindow ? "xvfb-visible-inactive" : "native-hidden",
      offscreenPainting: window.webContents.isPainting(),
      offscreenFrameRate: window.webContents.getFrameRate(),
      documentVisibilityState: result.diagnostics.documentVisibilityState,
      documentHasFocus: result.diagnostics.documentHasFocus,
      publicBufferAndRenderInspection: true,
      actualProductSelectionGuardBundled: true,
      fullBufferCellsHistoryCursorModesEqualToVisibleReference: true,
      reference: compact(result.reference),
      oldHidden: compact(result.oldHidden),
      screenDisplayNone: compact(result.screenDisplayNone),
      initialHiddenReference: compact(result.initialHiddenReference),
      initialScreenHidden: compact(result.initialScreenHidden),
      selectedOldHidden: compact(result.selectedOldHidden),
      selectedScreenHidden: compact(result.selectedScreenHidden)
    }, null, 2));
  } catch (error) {
    console.error("CANVASTTY_HIDDEN_DOM_PROBE_FAILED", error);
    process.exitCode = 1;
  } finally {
    window?.destroy();
    await rm(fixtureDir, { recursive: true, force: true });
    app.exit(process.exitCode ?? 0);
  }
}

function fixtureHtml() {
  const xtermModule = pathToFileURL(join(REPO, "node_modules/@xterm/xterm/lib/xterm.mjs")).href;
  const fitModule = pathToFileURL(join(REPO, "node_modules/@xterm/addon-fit/lib/addon-fit.mjs")).href;
  const xtermCss = pathToFileURL(join(REPO, "node_modules/@xterm/xterm/css/xterm.css")).href;
  const draftCss = readFileSync(join(REPO, "src/renderer/src/styles/app.css"), "utf8");
  const suspensionRule = draftCss.split("\n").find(line => line.includes('.terminal-card__surface[data-suspended="true"] .xterm-screen'));
  assert.ok(suspensionRule, "product suspension rule was not found");
  const guardBundle = require("esbuild").buildSync({
    entryPoints: [join(REPO, "src/renderer/src/features/terminal/terminalSelectionRedraw.ts")],
    bundle: true,
    format: "iife",
    globalName: "__selectionGuardProbe",
    platform: "browser",
    write: false
  }).outputFiles[0].text;
  if (benchmark) return benchmarkHtml({ xtermModule, fitModule, xtermCss, suspensionRule, guardBundle });
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' file:; style-src 'unsafe-inline' file:; font-src file:">
    <link rel="stylesheet" href="${xtermCss}">
    <style>html,body{margin:0;width:100%;height:100%;background:#202430}
      #surface{position:absolute;left:24px;top:24px;width:820px;height:620px;overflow:hidden}
      .xterm{height:100%;padding:0}
      ${suspensionRule}</style></head><body><div id="surface" class="terminal-card__surface"></div>
    <script>${guardBundle}</script><script type="module">
    globalThis.__hiddenDomProbe = (async () => {
      const { Terminal } = await import(${JSON.stringify(xtermModule)});
      const { FitAddon } = await import(${JSON.stringify(fitModule)});
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const rafProbe = {heartbeatFrames:0,pageRafRequests:0,pageRafCallbacks:0};
      const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
      let rafHeartbeatActive = true;
      const heartbeat = () => nativeRequestAnimationFrame(() => {
        rafProbe.heartbeatFrames++;
        if (rafHeartbeatActive) heartbeat();
      });
      heartbeat();
      window.requestAnimationFrame = callback => {
        rafProbe.pageRafRequests++;
        return nativeRequestAnimationFrame(timestamp => {
          rafProbe.pageRafCallbacks++;
          callback(timestamp);
        });
      };
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const waitForAnimationFrames = async (minimum, timeoutMs = 1500) => {
        const start = rafProbe.heartbeatFrames;
        const deadline = performance.now() + timeoutMs;
        while (rafProbe.heartbeatFrames - start < minimum && performance.now() < deadline) await delay(16);
        const received = rafProbe.heartbeatFrames - start;
        check(received >= minimum, "bounded native rAF warm-up got " + received + "/" + minimum
          + "; visibility=" + document.visibilityState + " focused=" + document.hasFocus()
          + " pageCallbacks=" + rafProbe.pageRafCallbacks);
        return received;
      };
      const waitForIntersection = async (probe, expected, timeoutMs = 1500) => {
        const deadline = performance.now() + timeoutMs;
        while (probe.isIntersecting !== expected && performance.now() < deadline) await delay(16);
        check(probe.isIntersecting === expected, "IntersectionObserver did not settle to " + expected
          + "; state=" + JSON.stringify(probe));
      };
      const waitForXtermRender = async (renders, minimum, probe, timeoutMs = 1500) => {
        const deadline = performance.now() + timeoutMs;
        while (renders.length < minimum && performance.now() < deadline) await delay(16);
        check(renders.length >= minimum, "bounded hidden-baseline xterm render warm-up got " + renders.length
          + "/" + minimum + "; visibility=" + document.visibilityState + " IO=" + JSON.stringify(probe)
          + " rAF=" + rafProbe.heartbeatFrames);
      };
      const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const host = document.querySelector('#surface');
      const cellSnapshot = cell => [cell.getChars(), cell.getWidth(), cell.getFgColorMode(), cell.getFgColor(),
        cell.getBgColorMode(), cell.getBgColor(), cell.isBold(), cell.isItalic(), cell.isDim(), cell.isUnderline(),
        cell.isBlink(), cell.isInverse(), cell.isInvisible(), cell.isStrikethrough(), cell.isOverline()];
      const bufferSnapshot = (buffer, cols) => ({
        type: buffer.type,
        cursor: [buffer.cursorX, buffer.cursorY],
        baseY: buffer.baseY,
        viewportY: buffer.viewportY,
        lines: Array.from({length: buffer.length}, (_, row) => {
          const line = buffer.getLine(row);
          return {wrapped: line.isWrapped, cells: Array.from({length: cols}, (_, col) => cellSnapshot(line.getCell(col)))};
        })
      });
      const snapshot = terminal => ({
        cols: terminal.cols,
        rows: terminal.rows,
        active: {type: terminal.buffer.active.type, cursor: [terminal.buffer.active.cursorX, terminal.buffer.active.cursorY]},
        normal: bufferSnapshot(terminal.buffer.normal, terminal.cols),
        alternate: bufferSnapshot(terminal.buffer.alternate, terminal.cols),
        selection: terminal.getSelection(),
        selectionPosition: terminal.getSelectionPosition(),
        modes: {...terminal.modes}
      });
      const seed = Array.from({length: 150}, (_, row) => 'NORMAL HISTORY ' + row + '\\r\\n').join('');
      const enterAlternate = '\\x1b[?1h\\x1b[?2004h\\x1b[?1049h\\x1b[?25l';
      const line = '\\x1b[32m✔\\x1b[0m building hidden modules … \\x1b[2K\\r\\n';
      const burst = line.repeat(12);
      const footer = '\\x1b[3;7H\\x1b[31;44;1mALT FINAL\\x1b[0m';
      const leaveAlternate = '\\x1b[?1049l\\x1b[?1l\\x1b[?2004l\\x1b[?25hAFTER RESUME\\r\\n';
      const runCase = async (mode, {initiallyHidden = false, resizeWhileHidden = false, selected = false} = {}) => {
        console.log('case '+mode+' initial='+initiallyHidden+' resize='+resizeWhileHidden+' selected='+selected);
        host.style.width = '820px';
        host.style.height = '620px';
        host.style.visibility = initiallyHidden ? 'hidden' : 'visible';
        host.dataset.suspended = String(initiallyHidden && mode === 'screen-display-none');
        host.replaceChildren();
        const terminal = new Terminal({cols:80,rows:24,fontSize:14,fontFamily:'monospace',
          lineHeight:1.2,scrollback:5000,cursorBlink:false,allowProposedApi:true});
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(host);
        const restoreGuard = globalThis.__selectionGuardProbe.skipEmptySelectionRedraws(terminal);
        const writes = text => new Promise(resolve => terminal.write(text, resolve));
        const renders = [];
        const listener = terminal.onRender(event => renders.push({...event}));
        const intersection = {callbacks:0,isIntersecting:null,intersectionRatio:null};
        const intersectionObserver = new IntersectionObserver(entries => {
          const entry = entries.at(-1);
          intersection.callbacks++;
          intersection.isIntersecting = entry.isIntersecting;
          intersection.intersectionRatio = entry.intersectionRatio;
        });
        intersectionObserver.observe(terminal.element.querySelector('.xterm-screen'));
        let rowMutations = 0;
        const rowObserver = new MutationObserver(records => { rowMutations += records.length; });
        rowObserver.observe(terminal.element.querySelector('.xterm-rows'),
          {childList:true,subtree:true,characterData:true,attributes:true});
        await delay(250);
        fit.fit();
        await delay(100);
        let grid = {cols:terminal.cols,rows:terminal.rows};
        check(grid.cols > 2 && grid.rows > 1, 'font metrics did not settle');
        await writes(seed);
        await delay(80);
        if (selected) {
          terminal.select(0, terminal.buffer.active.length - 2, 3);
          await delay(80);
          check(terminal.getSelection().length > 0, 'selected baseline has no selection');
        }
        const hostSize = [host.clientWidth, host.clientHeight];
        if (mode !== 'visible-reference') host.style.visibility = 'hidden';
        if (mode === 'screen-display-none') host.dataset.suspended = 'true';
        await waitForIntersection(intersection, mode !== 'screen-display-none');
        fit.fit();
        let fitGridMaintained = terminal.cols === grid.cols && terminal.rows === grid.rows
          && equal(hostSize, [host.clientWidth, host.clientHeight]);
        check(fitGridMaintained, 'FitAddon changed grid or outer host geometry while hidden');
        if (resizeWhileHidden) {
          host.style.width = '880px';
          host.style.height = '640px';
          await delay(80);
          fit.fit();
          const proposed = fit.proposeDimensions();
          fitGridMaintained = fitGridMaintained && proposed.cols === terminal.cols && proposed.rows === terminal.rows
            && host.clientWidth === 880 && host.clientHeight === 640;
          check(fitGridMaintained, 'hidden resize did not preserve FitAddon geometry');
          grid = {cols:terminal.cols,rows:terminal.rows};
          await delay(80);
        }
        const rafWarmupFrames = await waitForAnimationFrames(3);
        const rafStart = rafProbe.heartbeatFrames;
        const beforeCount = renders.length;
        const beforeMutationCount = rowMutations;
        const startCpu = process.cpuUsage();
        if (!selected) await writes(enterAlternate);
        let renderWarmupEvents = 0;
        for (let index = 0; index < 40; index++) {
          const beforeWarmup = renders.length;
          await writes(burst);
          if (mode === 'visibility-hidden' && index === 0) {
            await waitForXtermRender(renders, beforeWarmup + 1, intersection);
            renderWarmupEvents = renders.length - beforeWarmup;
          }
          await delay(4);
        }
        if (!selected) await writes(footer);
        await delay(150);
        const usedCpu = process.cpuUsage(startCpu);
        const rendererCpuMs = (usedCpu.user + usedCpu.system) / 1000;
        const hiddenRenders = renders.length - beforeCount;
        const hiddenRowMutations = rowMutations - beforeMutationCount;
        const rafFramesDuringHidden = rafProbe.heartbeatFrames - rafStart;
        const hiddenIntersection = {...intersection};
        const afterHidden = snapshot(terminal);
        const beforeResume = renders.length;
        host.style.visibility = 'visible';
        host.dataset.suspended = 'false';
        await delay(250);
        fit.fit();
        await delay(80);
        const afterResume = snapshot(terminal);
        const resumeEvents = renders.slice(beforeResume);
        check(equal(afterHidden, afterResume), 'CSS resume changed buffer/history/cursor/modes');
        await writes(leaveAlternate);
        await delay(80);
        const final = snapshot(terminal);
        const result = {grid,fitGridMaintained,rendererCpuMs,renders:hiddenRenders,rowMutations:hiddenRowMutations,usedAlternate:!selected,
          resumeRenders:resumeEvents.length,resumeFullRefresh:resumeEvents.some(event => event.start === 0 && event.end === terminal.rows - 1),
          stateUnchangedByResume:equal(afterHidden,afterResume),afterHidden,final,rafFramesDuringHidden,rafWarmupFrames,
          intersection:hiddenIntersection,documentVisibilityState:document.visibilityState,renderWarmupEvents,
          streamCharacters:seed.length+enterAlternate.length+40*burst.length+footer.length+leaveAlternate.length};
        listener.dispose();
        intersectionObserver.disconnect();
        rowObserver.disconnect();
        restoreGuard();
        terminal.dispose();
        return result;
      };
      const result = {reference:await runCase('visible-reference'),oldHidden:await runCase('visibility-hidden'),
        screenDisplayNone:await runCase('screen-display-none'),
        initialHiddenReference:await runCase('visible-reference', {initiallyHidden:true,resizeWhileHidden:true}),
        initialScreenHidden:await runCase('screen-display-none', {initiallyHidden:true,resizeWhileHidden:true}),
        selectedOldHidden:await runCase('visibility-hidden', {selected:true}),
        selectedScreenHidden:await runCase('screen-display-none', {selected:true})};
      rafHeartbeatActive = false;
      return {...result,diagnostics:{documentVisibilityState:document.visibilityState,documentHasFocus:document.hasFocus(),
        nativeRafHeartbeatFrames:rafProbe.heartbeatFrames,pageRafRequests:rafProbe.pageRafRequests,
        pageRafCallbacks:rafProbe.pageRafCallbacks}};
    })();
    </script></body></html>`;
}
