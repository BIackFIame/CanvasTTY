import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { isCustomTerminalBorderSkinId, SkinRegistry } from "../src/main/services/SkinRegistry.ts";

const validCss = '.terminal-card[data-border-skin="custom:aurora"] { border: 2px solid #8ac; box-shadow: 0 0 12px #7cf; }';

async function makeFixture(t, prepare = async () => undefined, registryOptions = {}) {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-terminal-skins-"));
  const skins = join(userData, "skins");
  await mkdir(skins, { recursive: true });
  await prepare(skins);
  const registry = new SkinRegistry(userData, registryOptions);
  await registry.initialize();
  t.after(async () => {
    registry.dispose();
    await rm(userData, { recursive: true, force: true });
  });
  return { userData, skins, registry };
}

async function writeSkin(skinsRoot, slug, css = validCss, manifest = undefined) {
  const directory = join(skinsRoot, slug);
  await mkdir(directory, { recursive: true });
  const value = manifest ?? { schemaVersion: 1, id: slug, name: "Aurora", kind: "terminal-border" };
  await writeFile(join(directory, "manifest.json"), typeof value === "string" ? value : JSON.stringify(value));
  await writeFile(join(directory, "skin.css"), css);
  return directory;
}

function waitForChange(registry, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for skin registry reload."));
    }, timeoutMs);
    const unsubscribe = registry.onChanged(() => {
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function withTimeout(promise, timeoutMs = 2_000) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Timed out waiting for watcher recovery.")), timeoutMs);
    })
  ]).finally(() => clearTimeout(timeout));
}

test("registry lists and returns a valid local skin without exposing CSS in metadata", async (t) => {
  const { registry } = await makeFixture(t, (skins) => writeSkin(skins, "aurora"));
  const listed = registry.list();
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], {
    id: "custom:aurora",
    name: "Aurora",
    revision: listed[0].revision,
    status: "ready"
  });
  assert.match(listed[0].revision, /^[a-f0-9]{16}$/);
  assert.deepEqual(registry.get("custom:aurora"), {
    id: "custom:aurora",
    name: "Aurora",
    revision: listed[0].revision,
    status: "ready",
    css: validCss
  });
});

test("registry accepts the bundled example skin stylesheet", async (t) => {
  const css = await readFile(new URL("../examples/terminal-skins/foundry-seven/skin.css", import.meta.url), "utf8");
  const { registry } = await makeFixture(t, (skins) => writeSkin(
    skins,
    "foundry-seven",
    css,
    { schemaVersion: 1, id: "foundry-seven", name: "Foundry Seven", kind: "terminal-border" }
  ));
  assert.equal(registry.list()[0].status, "ready");
});

test("registry refuses a symlinked skins root without reading its target", async (t) => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-skin-root-link-"));
  const externalRoot = join(userData, "external-skins");
  await writeSkin(externalRoot, "aurora");
  await symlink(externalRoot, join(userData, "skins"));
  const registry = new SkinRegistry(userData);
  await registry.initialize();
  t.after(() => registry.dispose());

  assert.deepEqual(registry.list(), [{
    id: "custom:skin-registry",
    status: "error",
    error: "The terminal skin directory must be a real directory."
  }]);
  assert.equal(registry.get("custom:aurora").status, "error");
});

test("registry surfaces malformed, mismatched, oversized, and symlinked skin files", async (t) => {
  const { registry } = await makeFixture(t, async (skins) => {
    await writeSkin(skins, "bad-json", validCss, "{");
    await writeSkin(skins, "large-manifest", validCss, " ".repeat(4 * 1024 + 1));
    await writeSkin(skins, "wrong-id", validCss, { schemaVersion: 1, id: "../outside", name: "Wrong", kind: "terminal-border" });
    await writeSkin(skins, "large-css", " ".repeat(64 * 1024 + 1));
    const linked = await writeSkin(skins, "linked-css");
    const externalCss = join(skins, "external.css");
    await writeFile(externalCss, validCss);
    await rm(join(linked, "skin.css"));
    await symlink(externalCss, join(linked, "skin.css"));
    const externalDirectory = join(skins, "..", "outside-directory");
    await mkdir(externalDirectory);
    await writeFile(join(externalDirectory, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: "linked-folder", name: "Linked", kind: "terminal-border" }));
    await writeFile(join(externalDirectory, "skin.css"), validCss);
    await symlink(externalDirectory, join(skins, "linked-folder"));
  });

  const items = registry.list();
  assert.equal(items.length, 6);
  for (const slug of ["bad-json", "large-manifest", "wrong-id", "large-css", "linked-css", "linked-folder"]) {
    const item = items.find((entry) => entry.id === `custom:${slug}`);
    assert.equal(item?.status, "error", `expected ${slug} to be rejected`);
    const result = registry.get(`custom:${slug}`);
    assert.equal(result.status, "error");
    assert.match(result.error, /./);
  }
  assert.throws(() => registry.get("custom:../outside"), /invalid/i);
  assert.equal(isCustomTerminalBorderSkinId("custom:valid-skin"), true);
  assert.equal(isCustomTerminalBorderSkinId("custom:../outside"), false);
});

test("registry rejects remote URLs, executable CSS, out-of-scope selectors, and unsafe properties", async (t) => {
  const rejectedCss = [
    '@import "https://example.invalid/skin.css"; .terminal-card { border: 1px solid red; }',
    '.terminal-card { background: url(file:///etc/passwd); }',
    '.terminal-card { background-image: url(https://example.invalid/a.png); }',
    '.terminal-card { background: expression(alert(1)); }',
    '.terminal-card { --paint: u\\72l(https://example.invalid/a); border: 1px solid red; }',
    '.terminal-card { --markup: \\3c script>alert(1); }',
    'body { border: 1px solid red; }',
    '.terminal-card + body { border: 1px solid red; }',
    '.terminal-card || body { border: 1px solid red; }',
    '.terminal-card { position: fixed; }',
    '.terminal-card { behavior: url(#default#VML); }'
  ];
  const { registry } = await makeFixture(t, async (skins) => {
    for (const [index, css] of rejectedCss.entries()) await writeSkin(skins, `unsafe-${index}`, css);
  });

  assert.equal(registry.list().length, rejectedCss.length);
  assert.ok(registry.list().every((item) => item.status === "error"));
});

test("watcher reloads valid edits and preserves last-good CSS after an invalid edit", async (t) => {
  let directory = "";
  const { registry: watched } = await makeFixture(t, async (skins) => {
    directory = await writeSkin(skins, "aurora");
  });

  const updatedCss = '.terminal-card[data-border-skin="custom:aurora"] { border: 3px solid #fa0; }';
  let changed = waitForChange(watched);
  await writeFile(join(directory, "skin.css"), updatedCss);
  await changed;
  assert.equal(watched.get("custom:aurora").css, updatedCss);

  changed = waitForChange(watched);
  await writeFile(join(directory, "skin.css"), 'body { background: url(https://example.invalid); }');
  await changed;
  assert.equal(watched.list()[0].status, "error");
  assert.equal(watched.get("custom:aurora").css, updatedCss);
});

test("root watcher retries install failures, rescans after errors, and sees later folder changes", async (t) => {
  const firstWatcherReady = deferred();
  const recoveredWatcherReady = deferred();
  const watchers = [];
  let installAttempts = 0;
  const rootWatcherFactory = (_path, onChange, onError) => {
    installAttempts += 1;
    if (installAttempts === 1) throw new Error("simulated root watcher install failure");
    const watcher = {
      closed: false,
      close() { this.closed = true; },
      onChange,
      onError
    };
    watchers.push(watcher);
    if (watchers.length === 1) firstWatcherReady.resolve(watcher);
    if (watchers.length === 2) recoveredWatcherReady.resolve(watcher);
    return watcher;
  };
  const { registry, skins, userData } = await makeFixture(t, undefined, {
    rootWatcherFactory,
    rootRetryBaseMs: 10,
    rootRetryMaxMs: 20
  });

  const added = waitForChange(registry);
  await writeSkin(skins, "added-while-unwatched");
  const firstWatcher = await withTimeout(firstWatcherReady.promise);
  await added;
  assert.equal(registry.list().find((item) => item.id === "custom:added-while-unwatched")?.status, "ready");

  const removed = waitForChange(registry);
  firstWatcher.onError(new Error("simulated root watcher runtime failure"));
  await rename(join(skins, "added-while-unwatched"), join(userData, "moved-skin-fixture"));
  const recoveredWatcher = await withTimeout(recoveredWatcherReady.promise);
  await removed;
  assert.equal(firstWatcher.closed, true);
  assert.equal(registry.list().some((item) => item.id === "custom:added-while-unwatched"), false);

  const laterChange = waitForChange(registry);
  await writeSkin(skins, "seen-after-recovery");
  recoveredWatcher.onChange();
  await laterChange;
  assert.equal(registry.list().find((item) => item.id === "custom:seen-after-recovery")?.status, "ready");
  assert.ok(installAttempts >= 3, "the watcher factory should be retried after both failures");
});
