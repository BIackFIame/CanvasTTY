#!/usr/bin/env node
// Startup readiness of the built app on a fixed restored profile: three shell cards, one browser card (a page served
// from 127.0.0.1 by this script) and one plugin canvas card (examples/plugins/studio-kit), session restore on.
//
//   npx electron-vite build
//   node --experimental-strip-types scripts/bench/startup.mjs [--cold 5] [--warm 10] [--json report.json] [--frames]
//
// Cold: every launch gets a fresh copy of the seeded profile without Chromium's caches (code cache, GPU cache).
// Warm: one copy is reused; a first, discarded launch fills its caches. Launches run one after another. Every launch
// gets a fresh short HOME (GROK_HOME, CODEX_HOME, CLAUDE_CONFIG_DIR, XDG_* inside); windows are hidden, off-screen
// and unfocusable; the keychain is refused (scripts/bench-runtime/app).
//
// Marks (ms since the Electron process started; median and p90 across launches):
//   main      appReady, windowCreateStart, windowCreated, criticalServicesReady / coreServicesReady (the IPC groups
//             the first frame needs, where the build registers them in groups), servicesReady (every service up),
//             applicationLoadStart, applicationLoaded (surface did-finish-load), allSurfacesMounted (the three
//             terminals, the plugin and the browser card in the DOM, observed by the harness)
//   renderer  rendererFirstPaint, firstStableFrame (no loader, real data), homeActionable,
//             restoredTerminalInteractive (first restored xterm forwards input)
import { spawn, execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HERE = join(ROOT, "scripts", "bench");
const TEMP = realpathSync("/tmp");
const CHROMIUM_CACHES = ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Shared Dictionary",
  "blob_storage", "Session Storage", "Partitions"];

function options(argv) {
  const result = { cold: 5, warm: 10, json: null, frames: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--cold") result.cold = Number(argv[++i]);
    else if (flag === "--warm") result.warm = Number(argv[++i]);
    else if (flag === "--json") result.json = resolve(argv[++i]);
    else if (flag === "--frames") result.frames = true;
    else throw new Error(`Unknown option ${flag}`);
  }
  return result;
}

function appFolder(folder) {
  mkdirSync(join(folder, "src"), { recursive: true });
  mkdirSync(join(folder, "scripts"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "canvastty-bench-startup", private: true, main: "startup.cjs", type: "commonjs" }));
  cpSync(join(HERE, "app", "startup.cjs"), join(folder, "startup.cjs"));
  cpSync(join(ROOT, "src", "agent-runtime"), join(folder, "src", "agent-runtime"), { recursive: true });
  cpSync(join(ROOT, "src", "agent-browser"), join(folder, "src", "agent-browser"), { recursive: true });
  cpSync(join(ROOT, "scripts", "canvastty-control.mjs"), join(folder, "scripts", "canvastty-control.mjs"));
  if (existsSync(join(ROOT, "build", "native-helpers"))) {
    mkdirSync(join(folder, "build"), { recursive: true });
    symlinkSync(join(ROOT, "build", "native-helpers"), join(folder, "build", "native-helpers"));
  }
}

function run(command, args, env, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stderr = "";
    child.stdout.on("data", () => undefined);
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
    const timer = setTimeout(kill, timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      kill();
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-1500)}`));
    });
  });
}

function reap(marker) {
  const rows = execFileSync("/bin/ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim().split("\n");
  for (const row of rows) {
    const [, pid, command] = /^\s*(\d+)\s+(.*)$/u.exec(row) ?? [];
    if (pid && Number(pid) !== process.pid && command.includes(marker)) {
      try { process.kill(Number(pid), "SIGKILL"); } catch {}
    }
  }
}

/** One launch with a fresh short HOME; returns the harness report. */
async function launch(bench, phase, userData) {
  const electron = createRequire(import.meta.url)("electron");
  const home = mkdtempSync(join(TEMP, "s."));
  writeFileSync(join(home, ".zshrc"), "");
  const out = join(home, "report.json");
  const env = {
    HOME: home, USER: "bench", LOGNAME: "bench", TMPDIR: TEMP, LANG: "en_US.UTF-8",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/zsh",
    GROK_HOME: join(home, ".grok"), CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    BENCH_PHASE: phase, BENCH_ROOT: ROOT, BENCH_OUT: out, BENCH_USERDATA: userData, BENCH_WORK: bench.work,
    BENCH_PAGE_URL: bench.pageUrl,
    ...(bench.frames && phase === "measure" ? { BENCH_FRAMES: "1" } : {})
  };
  try {
    let exit = null;
    await run(electron, [bench.app], env, 120_000).catch((error) => { exit = error; });
    const report = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
    if (!report?.done) throw exit ?? new Error("the startup harness wrote no report");
    if (report.window?.visible || report.window?.focused || report.windowEnd?.visible || report.windowEnd?.focused) {
      throw new Error("the app window was visible or focused");
    }
    return report;
  } finally {
    reap(userData);
    reap(home);
    rmSync(home, { recursive: true, force: true });
  }
}

async function installPlugin(userData) {
  const { PluginManager } = await import(join(ROOT, "src", "main", "services", "PluginManager.ts"));
  const fixture = join(ROOT, "examples", "plugins", "studio-kit");
  const manager = new PluginManager(userData, async (_url, destination) => { await cp(fixture, destination, { recursive: true }); });
  await manager.load();
  const preview = await manager.previewInstall("https://github.com/example/studio-kit");
  await manager.install(preview.token);
}

const pct = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const MARKS = [
  ["main", "windowCreateStart"], ["main", "criticalServicesReady"], ["main", "coreServicesReady"],
  ["main", "appReady"], ["main", "windowCreated"], ["main", "applicationLoadStart"], ["renderer", "rendererFirstPaint"],
  ["main", "servicesReady"], ["main", "applicationLoaded"], ["renderer", "firstStableFrame"], ["renderer", "homeActionable"],
  ["renderer", "restoredTerminalInteractive"], ["main", "allSurfacesMounted"]
];
function summarize(reports) {
  const rows = {};
  for (const [side, name] of MARKS) {
    const values = reports.map((report) => report[side]?.[name]).filter((value) => typeof value === "number");
    rows[name] = { n: values.length, median: pct(values, 50), p90: pct(values, 90) };
  }
  return rows;
}

async function main() {
  const settings = options(process.argv.slice(2));
  const root = mkdtempSync(join(TEMP, "s."));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>bench</title><body style=\"font:16px sans-serif\"><h1>Bench page</h1></body>");
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const bench = { app: join(root, "app"), work: join(root, "w"), pageUrl: `http://127.0.0.1:${server.address().port}/`, frames: settings.frames };
  mkdirSync(bench.work, { recursive: true });
  appFolder(bench.app);
  const template = join(root, "t");
  mkdirSync(template, { recursive: true });
  writeFileSync(join(template, "settings.json"), JSON.stringify({ settingsVersion: 21, locale: "en", sessionRestoreMode: "reopen" }));
  const result = { cold: [], warm: [], errors: [] };
  try {
    await installPlugin(template);
    const seeded = await launch(bench, "seed", template);
    if (seeded.errors.length) throw new Error(`seed: ${seeded.errors.join("; ")}`);
    for (const cache of CHROMIUM_CACHES) await rm(join(template, cache), { recursive: true, force: true });
    const sessions = JSON.parse(await readFile(join(template, "terminal-sessions.json"), "utf8").catch(() => "{}"));
    process.stderr.write(`seeded: ${seeded.seeded} sessions; store: ${sessions.sessions?.length ?? "?"}\n`);

    for (let i = 0; i < settings.cold; i++) {
      const userData = join(root, `c${i}`);
      await cp(template, userData, { recursive: true });
      const report = await launch(bench, "measure", userData);
      result.cold.push(report);
      process.stderr.write(`cold ${i + 1}: ${JSON.stringify({ ...report.main, ...report.renderer })} ${report.errors.join("; ")}\n`);
      await rm(userData, { recursive: true, force: true });
    }
    const warmData = join(root, "wd");
    await cp(template, warmData, { recursive: true });
    await launch(bench, "measure", warmData); // fills Chromium's caches; not counted
    for (let i = 0; i < settings.warm; i++) {
      const report = await launch(bench, "measure", warmData);
      result.warm.push(report);
      process.stderr.write(`warm ${i + 1}: ${JSON.stringify({ ...report.main, ...report.renderer })} ${report.errors.join("; ")}\n`);
    }
  } finally {
    server.close();
    reap(root);
    rmSync(root, { recursive: true, force: true });
  }
  const summary = {
    cold: summarize(result.cold),
    warm: summarize(result.warm),
    errors: [...result.cold, ...result.warm].flatMap((report) => report.errors),
    ...(settings.frames ? { frames: [...result.cold, ...result.warm].map((report) => report.frames ?? []) } : {}),
    rendererErrors: [...new Set([...result.cold, ...result.warm].flatMap((report) => report.rendererErrors))].slice(0, 10)
  };
  if (settings.json) writeFileSync(settings.json, JSON.stringify({ summary, runs: result }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
}

await main();
