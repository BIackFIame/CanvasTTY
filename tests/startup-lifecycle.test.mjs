import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { startupPageUrl } from "../src/main/startupPage.ts";

const mainPath = new URL("../src/main/index.ts", import.meta.url);

test("closing during service startup stops renderer loading without a failure dialog", async () => {
  const source = await readFile(mainPath, "utf8");
  const start = source.slice(source.indexOf("async function startApplication"), source.indexOf("function buildProviderCliRegistry"));
  let loads = 0;
  let failures = 0;
  const context = {
    startupRunning: false,
    shutdownRunning: false,
    shutdownComplete: false,
    servicesReady: false,
    mainWindow: { isDestroyed: () => false },
    process: { env: {} },
    shellWindowGone: () => false,
    initializeServices: async () => { context.shutdownRunning = true; },
    loadApplication: async () => { loads += 1; },
    showStartupFailure: async () => { failures += 1; }
  };
  const startApplication = runInNewContext(`${stripTypeScriptTypes(start)}; startApplication`, context);
  await startApplication();
  assert.equal(loads, 0);
  assert.equal(failures, 0);
  assert.equal(context.startupRunning, false);

  context.shutdownRunning = false;
  context.initializeServices = async () => { throw new Error("real startup error"); };
  await startApplication();
  assert.equal(failures, 1, "a real error on a live window still reaches the failure page");
});

test("services start while the startup page loads, and the application surface waits until the page settled", async () => {
  const source = await readFile(mainPath, "utf8");
  const start = source.slice(source.indexOf("async function startApplication"), source.indexOf("function buildProviderCliRegistry"));
  const events = [];
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  let settlePage;
  // The startup page load as createWindow hands it over: it settles with the error to report, or null.
  const pendingPage = () => new Promise((resolve) => { settlePage = resolve; });
  let gone = false;
  const context = {
    startupRunning: false,
    shutdownRunning: false,
    shutdownComplete: false,
    servicesReady: false,
    mainWindow: null,
    process: { env: {} },
    shellWindowGone: () => gone,
    createWindow: () => { events.push("window"); return { window: {}, startupPage: pendingPage() }; },
    initializeServices: async () => { events.push("services"); },
    initializeUpdater: () => events.push("updater"),
    markMainBoot: () => undefined,
    loadApplication: async () => { events.push("app"); },
    showStartupFailure: async (_window, error) => { events.push(`failure ${error.message}`); }
  };
  const startApplication = runInNewContext(`${stripTypeScriptTypes(start)}; startApplication`, context);

  // Services do not wait for the page. The application surface does: a page replaced while it is still loading
  // reports its ERR_ABORTED late, and Electron's loadFile promise takes that failure as its own.
  let startup = startApplication();
  await turn();
  assert.deepEqual(events, ["window", "services"]);
  events.push("page settled");
  settlePage(null);
  await startup;
  assert.deepEqual(events, ["window", "services", "page settled", "updater", "app"]);

  // A real page error on a live window fails startup.
  events.length = 0;
  context.createWindow = () => { events.push("window"); return { window: {}, startupPage: Promise.resolve(new Error("startup page failed")) }; };
  await startApplication();
  assert.deepEqual(events, ["window", "services", "failure startup page failed"]);

  // A close while the page is still loading ends startup quietly once the page settles.
  events.length = 0;
  context.createWindow = () => { events.push("window"); return { window: {}, startupPage: pendingPage() }; };
  startup = startApplication();
  await turn();
  gone = true;
  settlePage(null);
  await startup;
  assert.deepEqual(events, ["window", "services"]);
  assert.equal(context.startupRunning, false);
});

test("dependencies only some paths need are not imported when the main process starts", async () => {
  // Each costs its import time on every launch (electron-updater about 30 ms): they load
  // through lazyRequire on first use. The smoke runners are test code behind env flags.
  const lazy = ["electron-updater", "yaml", "secure-remote-password/client.js", "secure-remote-password/server.js", "@xterm/headless"];
  const root = new URL("../src/main/", import.meta.url);
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".ts"));
  const staticImports = [];
  for (const file of files) {
    const source = await readFile(new URL(file, root), "utf8");
    for (const match of source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gmu)) {
      if (lazy.includes(match[1]) || /ElectronSmoke$/u.test(match[1])) staticImports.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(staticImports, []);
});

test("main process acquires the single-instance lock before readiness", async () => {
  const source = await readFile(mainPath, "utf8");
  const lock = source.indexOf("app.requestSingleInstanceLock()");
  const ready = source.indexOf("app.whenReady()");

  assert.notEqual(lock, -1);
  assert.notEqual(ready, -1);
  assert.ok(lock < ready);
  // R4: a rejected second launch raises the window of the running instance
  // instead of exiting silently.
  const handlerStart = source.indexOf('app.on("second-instance"');
  assert.notEqual(handlerStart, -1);
  const secondInstance = source.slice(handlerStart, source.indexOf('app.on("before-quit"'));
  assert.match(secondInstance, /\.restore\(\)/);
  assert.match(secondInstance, /\.show\(\)/);
  assert.match(secondInstance, /\.focus\(\)/);
});

test("background plugin requests never activate the desktop window", async () => {
  const source = await readFile(mainPath, "utf8");
  const launcher = source.slice(
    source.indexOf("function requestPluginLauncher"),
    source.indexOf("function requestPluginCanvas")
  );
  const canvas = source.slice(
    source.indexOf("function requestPluginCanvas"),
    source.indexOf("function broadcastPluginStorageChange")
  );

  for (const route of [launcher, canvas]) {
    assert.match(route, /webContents\.send/);
    assert.doesNotMatch(route, /\.focus\(\)|\.show\(\)|\.restore\(\)/);
  }
});

test("startup window is visible immediately and failures remain visible", async () => {
  const source = await readFile(mainPath, "utf8");

  assert.match(source, /show: true/);
  assert.match(source, /startupPageUrl\(\{ locale: app\.getLocale\(\), isMacOS: process\.platform === "darwin" \}\)/);
  assert.match(source, /showStartupFailure/);
  assert.doesNotMatch(source, /ready-to-show/);
});

test("startup failure page escapes diagnostic text", () => {
  const url = startupPageUrl({ locale: "ru", isMacOS: false, error: '<script>alert("x")</script>' });
  const html = decodeURIComponent(url.slice(url.indexOf(",") + 1));

  assert.match(html, /CanvasTTY не удалось запустить/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
});

test("macOS startup page reserves space for native traffic lights", () => {
  const url = startupPageUrl({ locale: "en", isMacOS: true });
  const html = decodeURIComponent(url.slice(url.indexOf(",") + 1));

  assert.match(html, /--titlebar-height: 32px;/);
  assert.match(html, /grid-template-rows: var\(--titlebar-height\) 1fr/);
  assert.match(html, /padding-left: 78px/);
  assert.doesNotMatch(html, /traffic-light/);
});
