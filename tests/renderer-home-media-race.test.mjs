import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";

const appPath = new URL("../src/renderer/src/App.tsx", import.meta.url);

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function extractFunctionSource(app, signature) {
  const start = app.indexOf(signature);
  assert.notEqual(start, -1, `App contains ${signature}`);
  const closing = /(?:\r\n|\n)\}(?=\r\n|\n|$)/g;
  closing.lastIndex = start;
  const match = closing.exec(app);
  assert.ok(match, `App contains the closing brace for ${signature}`);
  return app.slice(start, match.index + match[0].length);
}

async function appMediaReadHelper(app) {
  app ??= await readFile(appPath, "utf8");
  const source = extractFunctionSource(app, "function startHomeMediaRead(");
  return runInNewContext(`${stripTypeScriptTypes(source)}; startHomeMediaRead`, {
    Promise,
    undefined
  });
}

async function appProvidedPathHelper(app) {
  app ??= await readFile(appPath, "utf8");
  const source = extractFunctionSource(app, "function consumeProvidedHomeMediaPath(");
  return runInNewContext(`${stripTypeScriptTypes(source)}; consumeProvidedHomeMediaPath`);
}

test("application helper extraction accepts Windows CRLF source", async () => {
  const app = await readFile(appPath, "utf8");
  const lfApp = app.replace(/\r\n/g, "\n");
  const crlfApp = lfApp.replace(/\n/g, "\r\n");
  const readSource = extractFunctionSource(lfApp, "function startHomeMediaRead(");
  const chooserSource = extractFunctionSource(lfApp, "function consumeProvidedHomeMediaPath(");
  assert.equal(extractFunctionSource(crlfApp, "function startHomeMediaRead(").replace(/\r\n/g, "\n"), readSource);
  assert.equal(extractFunctionSource(crlfApp, "function consumeProvidedHomeMediaPath(").replace(/\r\n/g, "\n"), chooserSource);

  const startHomeMediaRead = await appMediaReadHelper(crlfApp);
  const consumeProvidedHomeMediaPath = await appProvidedPathHelper(crlfApp);
  const read = deferred();
  let active = true;
  const applied = [];
  const stop = startHomeMediaRead("/wallpaper.png", () => read.promise, () => active, (data) => applied.push(data));
  active = false;
  stop();
  read.resolve("stale bytes");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(applied, []);

  const ref = { current: { path: "/picked.png" } };
  assert.equal(consumeProvidedHomeMediaPath("/picked.png", ref), true);
  assert.equal(ref.current, null);
});

test("deferred HOME media reads ignore cleanup and stale generation results", async () => {
  const startHomeMediaRead = await appMediaReadHelper();
  const oldRead = deferred();
  let generation = 1;
  let currentPath = "/wallpaper.png";
  const applied = [];
  const stopOld = startHomeMediaRead(
    "/wallpaper.png",
    (path) => { assert.equal(path, "/wallpaper.png"); return oldRead.promise; },
    () => generation === 1 && currentPath === "/wallpaper.png",
    (data) => applied.push(data)
  );

  // The path was removed then selected again; cleanup must keep the first read stale even though
  // the current path has the same string as when that first request began.
  currentPath = null;
  stopOld();
  currentPath = "/wallpaper.png";
  oldRead.resolve("old bytes");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(applied, []);

  // A chooser can return a data URL while a same-path startup read is pending. Advancing the
  // generation prevents that late read from replacing the chooser's already-applied data.
  const selectedRead = deferred();
  generation = 2;
  const stopSelected = startHomeMediaRead(
    currentPath,
    () => selectedRead.promise,
    () => generation === 2 && currentPath === "/wallpaper.png",
    (data) => applied.push(data)
  );
  generation = 3;
  selectedRead.resolve("late file bytes");
  await Promise.resolve();
  await Promise.resolve();
  stopSelected();
  assert.deepEqual(applied, []);
});

test("chooser-provided HOME media skips a duplicate read for its selected path", async () => {
  const app = await readFile(appPath, "utf8");
  const consumeProvidedHomeMediaPath = await appProvidedPathHelper();
  const providedPathRef = { current: { path: "/picked.png" } };
  assert.equal(consumeProvidedHomeMediaPath("/picked.png", providedPathRef), true);
  assert.equal(providedPathRef.current, null, "the selection marker is consumed once");
  assert.equal(consumeProvidedHomeMediaPath("/picked.png", providedPathRef), false, "later external re-adds can load normally");
  assert.match(app, /if \(consumeProvidedHomeMediaPath\(path, providedMediaRef\)\) return;/);
});

test("HOME media loading stays behind the stable frame and follows the current media path", async () => {
  const app = await readFile(appPath, "utf8");
  const call = app.indexOf("startHomeMediaRead(", app.indexOf("useEffect(() => {", app.indexOf("const unsubscribeSettings")));
  assert.notEqual(call, -1);
  const effectStart = app.lastIndexOf("useEffect(() => {", call);
  const depsStart = app.indexOf("}, [", call);
  const effect = app.slice(effectStart, app.indexOf("]);", depsStart) + 2);
  assert.match(effect, /if \(!surfacesMounted\) return;/);
  assert.match(effect, /settings\.mediaPath/);
  assert.match(effect, /mediaReadGenerationRef\.current/);
  assert.match(app.slice(app.indexOf("const requestMedia"), app.indexOf("const removeMedia")), /mediaReadGenerationRef\.current\s*\+=\s*1/);
  assert.match(effect, /providedMediaRef/);
  assert.doesNotMatch(effect, /browserApi\.open\(\)/, "media path changes do not reopen the browser runtime");
  assert.equal(app.match(/browserApi\.open\(\)/g)?.length, 1, "browser startup remains a single separate deferred operation");
});
