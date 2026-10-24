import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import headless from "@xterm/headless";
import { terminalEmulatorOptions, terminalPtyOptions } from "../src/shared/terminalCompatibility.ts";
import { terminalFitScheduler } from "../src/renderer/src/features/terminal/terminalFitScheduler.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { TerminalSessionStore } from "../src/main/services/TerminalSessionStore.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";
import packHooks from "../scripts/after-pack-updates.cjs";
import { Arch } from "builder-util";

const { Terminal } = headless;

test("packaging restores matching ConPTY runtime files beside the rebuilt native module", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctty-conpty-pack-"));
  try {
    for (const architecture of ["x64", "arm64"]) {
      const source = join(root, "node_modules/node-pty/third_party/conpty/1.23.251008001", `win10-${architecture}`);
      await mkdir(source, { recursive: true });
      for (const file of ["conpty.dll", "OpenConsole.exe"]) await writeFile(join(source, file), `${architecture}:${file}`);
      const appOutDir = join(root, architecture);
      await packHooks.default({ electronPlatformName: "win32", arch: Arch[architecture], appOutDir, packager: { projectDir: root } });
      for (const file of ["conpty.dll", "OpenConsole.exe"]) {
        assert.equal(await readFile(join(appOutDir, "resources/app.asar.unpacked/node_modules/node-pty/build/Release/conpty", file), "utf8"), `${architecture}:${file}`);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bundled ConPTY uses modern wrap markers without enabling unsupported cursor-line reflow", () => {
  assert.deepEqual(terminalPtyOptions("win32"), { useConpty: true, useConptyDll: true });
  assert.deepEqual(terminalEmulatorOptions("win32"), { windowsPty: { backend: "conpty" } });
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(terminalPtyOptions(platform), {});
    assert.deepEqual(terminalEmulatorOptions(platform), {});
  }
});

test("ConPTY row growth does not pull old history into the viewport before the host repaint", async () => {
  const terminal = new Terminal({ ...terminalEmulatorOptions("win32"), cols: 40, rows: 5, allowProposedApi: true });
  try {
    await new Promise(resolve => terminal.write(Array.from({ length: 12 }, (_, n) => `row-${n}\r\n`).join(""), resolve));
    const top = terminal.buffer.active.baseY;
    assert.ok(top > 0);
    terminal.resize(40, 9);
    assert.equal(terminal.buffer.active.baseY, top, "ConPTY keeps old scrollback above its viewport");
    assert.equal(terminal.buffer.active.getLine(top).translateToString(true), "row-8");
  } finally { terminal.dispose(); }
});

test("Windows fit requests coalesce renderer transitions and cannot fire after a card closes", () => {
  let current = 0;
  let callback;
  const cancelled = [];
  const fitted = [];
  const scheduler = terminalFitScheduler(() => fitted.push(current), 250,
    (fn, delay) => { assert.equal(delay, 250); callback = fn; return ++current; },
    timer => cancelled.push(timer));
  scheduler.request();
  scheduler.request();
  assert.deepEqual(fitted, []);
  assert.deepEqual(cancelled, [1]);
  callback();
  assert.deepEqual(fitted, [2]);
  scheduler.request();
  const late = callback;
  scheduler.dispose();
  late();
  scheduler.request();
  assert.deepEqual(fitted, [2]);
  assert.deepEqual(cancelled, [1, 3]);
});

test("other platforms keep immediate fitting", () => {
  let fits = 0;
  const scheduler = terminalFitScheduler(() => fits++, 0, () => assert.fail("no timer"));
  scheduler.request();
  scheduler.request();
  assert.equal(fits, 2);
  scheduler.dispose();
});

test("measured startup covers create, restart, restore and plain Windows shells", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ctty-windows-grid-"));
  const calls = [];
  const manager = new TerminalManager(() => {}, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  manager.configureMeasuredStartup(true);
  manager.configureSessionPersistence(new TerminalSessionStore(directory), "continue");
  try {
    const session = manager.create({ provider: "codex", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 } });
    assert.equal(calls.length, 0);
    manager.resize(session.id, 93, 31);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.cols, 93);
    assert.equal(calls[0].options.rows, 31);
    calls[0].process.emitExit(0);
    manager.restart(session.id);
    assert.equal(calls.length, 1);
    manager.resize(session.id, 102, 28);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.cols, 102);
    const shell = manager.create({ provider: "terminal", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 } });
    assert.equal(calls.length, 2);
    manager.resize(shell.id, 100, 30);
    assert.equal(calls.length, 3);
    manager.dispose(shell.id);
    await manager.shutdown();

    const restoredCalls = [];
    const restored = new TerminalManager(() => {}, availableRegistry(), undefined, undefined, true, fakeSpawner(restoredCalls));
    restored.configureMeasuredStartup(true);
    restored.configureSessionPersistence(new TerminalSessionStore(directory), "continue");
    try {
      await restored.restorePersistedSessions();
      assert.equal(restoredCalls.length, 0);
      restored.resize(session.id, 88, 26);
      assert.equal(restoredCalls.length, 1);
      assert.equal(restoredCalls[0].options.cols, 88);
      assert.equal(restoredCalls[0].options.rows, 26);
    } finally { await restored.shutdown(); }
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
