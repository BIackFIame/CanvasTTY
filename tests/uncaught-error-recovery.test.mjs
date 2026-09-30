import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// An uncaught render error unmounts the React root but leaves the renderer process alive, so the main
// process's render-process-gone reload never fires and the window stays black. The root recovers itself.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../src/renderer/src/lib/uncaughtErrorRecovery.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false
});
const {
  recoverFromUncaughtError,
  UNCAUGHT_ERROR_RELOAD_COOLDOWN_MS
} = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`);

function host({ now, last = null, remembers = true }) {
  const calls = [];
  return {
    calls,
    now: () => now,
    readLastReloadAt: () => last,
    writeLastReloadAt: (at) => { calls.push(`write ${at}`); return remembers; },
    reload: () => calls.push("reload"),
    showRecoveryPage: () => calls.push("page")
  };
}

test("the first uncaught render error reloads the application surface", () => {
  const h = host({ now: 1_000_000 });
  assert.equal(recoverFromUncaughtError(h), "reload");
  assert.deepEqual(h.calls, ["write 1000000", "reload"]);
});

test("a second uncaught render error inside the cooldown shows the recovery page instead of looping", () => {
  const h = host({ now: 1_000_000, last: 1_000_000 - UNCAUGHT_ERROR_RELOAD_COOLDOWN_MS + 1 });
  assert.equal(recoverFromUncaughtError(h), "recovery-page");
  assert.deepEqual(h.calls, ["page"]);
});

test("an error after the cooldown reloads again", () => {
  const h = host({ now: 1_000_000, last: 1_000_000 - UNCAUGHT_ERROR_RELOAD_COOLDOWN_MS });
  assert.equal(recoverFromUncaughtError(h), "reload");
});

test("a reload time in the future (clock change) does not block the reload", () => {
  const h = host({ now: 1_000_000, last: 2_000_000 });
  assert.equal(recoverFromUncaughtError(h), "reload");
});

test("without storage for the reload time the recovery page is shown, never an unbounded reload loop", () => {
  const h = host({ now: 1_000_000, remembers: false });
  assert.equal(recoverFromUncaughtError(h), "recovery-page");
  assert.deepEqual(h.calls, ["write 1000000", "page"]);
});

test("the React root routes uncaught render errors to the recovery", async () => {
  const source = await readFile(new URL("../src/renderer/src/main.tsx", import.meta.url), "utf8");
  assert.match(source, /createRoot\(container, \{\s*[^}]*onUncaughtError: \(error, errorInfo\) => handleUncaughtRenderError\(container, error/su);
});
