import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import test from "node:test";

import {
  BrowserPolicyService,
  DEFAULT_BROWSER_URL,
  MAX_BROWSER_TABS,
  MAX_BROWSER_URL_LENGTH,
  MAX_STAGED_UPLOAD_DIRS,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_FILES,
  isSafeBrowserUrl
} from "../src/main/services/browser/BrowserPolicyService.ts";
import {
  BROWSER_STORE_VERSION,
  BrowserStore,
  activeTabAmong,
  normalizePersistedBrowserState
} from "../src/main/services/browser/BrowserStore.ts";

async function fixture(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function assertBrowserError(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

test("BrowserPolicyService only accepts canonical HTTP(S) navigation URLs", async (t) => {
  const root = await fixture(t, "canvastty-policy-url-");
  const policy = new BrowserPolicyService({ downloadRoot: join(root, "downloads") });

  assert.equal(policy.assertNavigationUrl("https://example.com/a/../b?q=1#two"), "https://example.com/b?q=1#two");
  assert.equal(policy.assertNavigationUrl("http://127.0.0.1:3000/path"), "http://127.0.0.1:3000/path");
  assert.equal(isSafeBrowserUrl("https://example.com"), true);
  assert.equal(isSafeBrowserUrl("http://localhost:8080"), true);

  for (const value of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hello",
    "ftp://example.com/file",
    "chrome://settings",
    "devtools://devtools/bundled/inspector.html",
    "about:blank",
    "blob:https://example.com/id",
    "https://user:password@example.com/"
  ]) {
    assert.equal(isSafeBrowserUrl(value), false, `${value} must not be considered safe`);
    assert.throws(() => policy.assertNavigationUrl(value), assertBrowserError("NAVIGATION_BLOCKED"));
  }

  assert.throws(() => policy.assertNavigationUrl("not a URL"), assertBrowserError("INVALID_URL"));
  assert.throws(
    () => policy.assertNavigationUrl(`https://example.com/${"a".repeat(MAX_BROWSER_URL_LENGTH)}`),
    assertBrowserError("INVALID_URL")
  );
});

test("BrowserPolicyService normalizes human input without promoting privileged schemes", async (t) => {
  const root = await fixture(t, "canvastty-policy-input-");
  const policy = new BrowserPolicyService({ downloadRoot: join(root, "downloads") });

  assert.equal(policy.normalizeHumanInput("  "), DEFAULT_BROWSER_URL);
  assert.equal(policy.normalizeHumanInput("example.com/docs"), "https://example.com/docs");
  assert.equal(policy.normalizeHumanInput("http://localhost:5173"), "http://localhost:5173/");
  assert.equal(policy.normalizeHumanInput("canvas tty browser"), "https://duckduckgo.com/?q=canvas%20tty%20browser");
  assert.equal(
    policy.normalizeHumanInput("file:///etc/passwd"),
    "https://duckduckgo.com/?q=file%3A%2F%2F%2Fetc%2Fpasswd"
  );
  assert.equal(
    policy.normalizeHumanInput("javascript:alert(1)"),
    "https://duckduckgo.com/?q=javascript%3Aalert(1)"
  );
});

test("BrowserPolicyService confines download names to its managed root", async (t) => {
  const root = await fixture(t, "canvastty-policy-download-");
  const downloadRoot = join(root, "downloads");
  const policy = new BrowserPolicyService({ downloadRoot });

  const target = policy.resolveDownloadPath("../bad/id", "../../.ssh/id_rsa");
  assert.equal(dirname(target), downloadRoot);
  assert.equal(relative(downloadRoot, target).startsWith(".."), false);
  assert.match(basename(target), /^badid-id_rsa$/);
});

test("BrowserPolicyService rejects traversal and symlink escapes from upload roots", async (t) => {
  const root = await fixture(t, "canvastty-policy-upload-");
  const allowed = join(root, "allowed");
  const outside = join(root, "outside");
  await Promise.all([mkdir(allowed), mkdir(outside)]);
  const insideFile = join(allowed, "inside.txt");
  const outsideFile = join(outside, "secret.txt");
  const escapedLink = join(allowed, "escaped-link.txt");
  await writeFile(insideFile, "inside");
  await writeFile(outsideFile, "outside");
  await symlink(outsideFile, escapedLink);
  const policy = new BrowserPolicyService({
    downloadRoot: join(root, "downloads"),
    uploadRoots: [allowed]
  });

  const [stagedInside] = await policy.validateUploadPaths([insideFile]);
  assert.notEqual(stagedInside, await realpath(insideFile));
  assert.equal(basename(stagedInside), basename(insideFile));
  assert.equal(await readFile(stagedInside, "utf8"), "inside");
  assert.equal(relative(policy.uploadStagingRoot, stagedInside).startsWith(".."), false);
  await assert.rejects(
    policy.validateUploadPaths([join(allowed, "..", "outside", "secret.txt")]),
    assertBrowserError("PATH_DENIED")
  );
  await assert.rejects(policy.validateUploadPaths([escapedLink]), assertBrowserError("PATH_DENIED"));
  await assert.rejects(policy.validateUploadPaths(["relative.txt"]), assertBrowserError("PATH_DENIED"));
  await assert.rejects(policy.validateUploadPaths([outsideFile], ["relative-root"]), assertBrowserError("PATH_DENIED"));
});

test("BrowserPolicyService enforces the 20-file and 100 MB upload boundaries", async (t) => {
  const root = await fixture(t, "canvastty-policy-limits-");
  const allowed = join(root, "allowed");
  await mkdir(allowed);
  const files = [];
  for (let index = 0; index < MAX_UPLOAD_FILES; index += 1) {
    const path = join(allowed, `${index}.txt`);
    await writeFile(path, "");
    files.push(path);
  }
  const policy = new BrowserPolicyService({
    downloadRoot: join(root, "downloads"),
    uploadRoots: [allowed]
  });

  assert.equal((await policy.validateUploadPaths(files)).length, MAX_UPLOAD_FILES);
  await assert.rejects(
    policy.validateUploadPaths([...files, files[0]]),
    assertBrowserError("PATH_DENIED")
  );

  const boundary = join(allowed, "boundary.bin");
  await writeFile(boundary, "");
  await truncate(boundary, MAX_UPLOAD_FILE_BYTES);
  const [stagedBoundary] = await policy.validateUploadPaths([boundary]);
  assert.equal((await stat(stagedBoundary)).size, MAX_UPLOAD_FILE_BYTES);
  await truncate(boundary, MAX_UPLOAD_FILE_BYTES + 1);
  await assert.rejects(policy.validateUploadPaths([boundary]), assertBrowserError("PAYLOAD_TOO_LARGE"));
});

test("a rejected multi-file upload leaves no staged copies behind", async (t) => {
  const root = await fixture(t, "canvastty-policy-partial-");
  const allowed = join(root, "allowed");
  await mkdir(allowed);
  const ok = join(allowed, "ok.txt");
  await writeFile(ok, "ok");
  const policy = new BrowserPolicyService({
    downloadRoot: join(root, "downloads"),
    uploadRoots: [allowed]
  });

  // The second path does not exist, so the whole request fails after the first
  // file has already been copied into the staging directory.
  await assert.rejects(
    policy.validateUploadPaths([ok, join(allowed, "missing.txt")]),
    assertBrowserError("PATH_DENIED")
  );

  const staged = await readdir(policy.uploadStagingRoot, { withFileTypes: true }).catch(() => []);
  assert.deepEqual(staged.filter((entry) => entry.isDirectory()), [], "no staging directories from the failed request should remain");
});

test("staged upload directories are bounded across many requests", async (t) => {
  const root = await fixture(t, "canvastty-policy-bounded-");
  const allowed = join(root, "allowed");
  await mkdir(allowed);
  const file = join(allowed, "small.txt");
  await writeFile(file, "x");
  const policy = new BrowserPolicyService({
    downloadRoot: join(root, "downloads"),
    uploadRoots: [allowed]
  });

  for (let index = 0; index < MAX_STAGED_UPLOAD_DIRS + 10; index += 1) {
    await policy.validateUploadPaths([file]);
  }

  const staged = await readdir(policy.uploadStagingRoot, { withFileTypes: true });
  const directories = staged.filter((entry) => entry.isDirectory());
  assert.ok(
    directories.length <= MAX_STAGED_UPLOAD_DIRS,
    `${directories.length} staged upload directories retained, expected at most ${MAX_STAGED_UPLOAD_DIRS}`
  );
});

test("normalizePersistedBrowserState preserves safe order, uniqueness, and a valid active tab", () => {
  const normalized = normalizePersistedBrowserState({
    version: BROWSER_STORE_VERSION,
    tabs: [
      { id: "second", url: "https://two.example/path" },
      { id: "bad-scheme", url: "file:///etc/passwd" },
      { id: "second", url: "https://duplicate.example/" },
      { id: "bad id", url: "https://invalid-id.example/" },
      { id: "first", url: "http://one.example" }
    ],
    activeTabId: "missing"
  });

  assert.deepEqual(normalized, {
    version: BROWSER_STORE_VERSION,
    tabs: [
      { id: "second", url: "https://two.example/path" },
      { id: "first", url: "http://one.example/" }
    ],
    activeTabId: "second"
  });

  const manyTabs = Array.from({ length: MAX_BROWSER_TABS + 5 }, (_, index) => ({
    id: `tab-${index}`,
    url: `https://${index}.example/`
  }));
  const capped = normalizePersistedBrowserState({
    version: BROWSER_STORE_VERSION,
    tabs: manyTabs,
    activeTabId: `tab-${MAX_BROWSER_TABS - 1}`
  });
  assert.equal(capped.tabs.length, MAX_BROWSER_TABS);
  assert.equal(capped.tabs.at(-1).id, `tab-${MAX_BROWSER_TABS - 1}`);
  assert.equal(capped.activeTabId, `tab-${MAX_BROWSER_TABS - 1}`);
});

test("BrowserStore safely restores, atomically normalizes, and persists only the last ordered state", async (t) => {
  const root = await fixture(t, "canvastty-store-");
  const store = new BrowserStore(root);

  assert.deepEqual(await store.load(), { version: BROWSER_STORE_VERSION, tabs: [], activeTabId: null });
  if (process.platform !== "win32") {
    assert.equal((await stat(store.filePath)).mode & 0o777, 0o600);
  }

  const replacements = Array.from({ length: 12 }, (_, index) => store.replace([
    { id: `tab-${index}-a`, url: `https://${index}.example/a` },
    { id: "unsafe", url: "javascript:alert(1)" },
    { id: `tab-${index}-b`, url: `https://${index}.example/b` }
  ], `tab-${index}-b`));
  await Promise.all(replacements);

  const expected = {
    version: BROWSER_STORE_VERSION,
    tabs: [
      { id: "tab-11-a", url: "https://11.example/a" },
      { id: "tab-11-b", url: "https://11.example/b" }
    ],
    activeTabId: "tab-11-b"
  };
  assert.deepEqual(JSON.parse(await readFile(store.filePath, "utf8")), expected);
  assert.deepEqual(await new BrowserStore(root).load(), expected);
  assert.equal((await readdir(root)).some((name) => name.endsWith(".tmp")), false);
});

test("BrowserStore recovers after one failed write instead of rejecting every later save", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const root = await fixture(t, "canvastty-store-fail-");
  const dataDir = join(root, "data");
  await mkdir(dataDir);
  const store = new BrowserStore(dataDir);
  await store.load();

  await chmod(dataDir, 0o500);
  try {
    await assert.rejects(store.replace([{ id: "tab-a", url: "https://a.example/" }], "tab-a"));
  } finally {
    await chmod(dataDir, 0o700);
  }
  // The in-memory state keeps the change the caller asked for.
  assert.equal(store.get().activeTabId, "tab-a");

  const next = await store.replace([{ id: "tab-b", url: "https://b.example/" }], "tab-b");
  assert.equal(next.activeTabId, "tab-b");
  assert.deepEqual(JSON.parse(await readFile(store.filePath, "utf8")).tabs, [{ id: "tab-b", url: "https://b.example/" }]);
  await store.clear();
  assert.deepEqual(JSON.parse(await readFile(store.filePath, "utf8")).tabs, []);
});

test("BrowserService keeps tab state when saving fails and settings do not leave the save unhandled", async () => {
  const service = await readFile(new URL("../src/main/services/BrowserService.ts", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
  const persistRuntime = service.slice(service.indexOf("private async persistRuntime"), service.indexOf("private destroyRuntimeTabs"));
  assert.match(persistRuntime, /try \{[\s\S]*this\.store\.replace[\s\S]*\} catch/);
  assert.match(persistRuntime, /this\.persisted = this\.store\.get\(\)/);
  const clearSaved = service.slice(service.indexOf("private async clearSavedTabs"), service.indexOf("private destroyRuntimeTabs"));
  assert.match(clearSaved, /try \{\s*await this\.store\.clear\(\);\s*\} catch/);
  assert.equal(service.match(/this\.store\.clear\(\)/g).length, 1, "every clear goes through clearSavedTabs");
  assert.match(main, /browserService\?\.setRestoreTabs\(next\.browserRestoreTabs\)\.catch\(/);
});

test("BrowserStore treats corrupt persisted input as an empty safe session", async (t) => {
  const root = await fixture(t, "canvastty-store-corrupt-");
  const path = join(root, "browser-state.json");
  await writeFile(path, "{not-json", { mode: 0o600 });
  const store = new BrowserStore(root);
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    assert.deepEqual(await store.load(), { version: BROWSER_STORE_VERSION, tabs: [], activeTabId: null });
  } finally {
    console.warn = originalWarn;
  }
});

test("a removed active tab hands the active slot to a remaining tab, never to a missing one", () => {
  const tabs = new Map([["a", {}], ["c", {}]]);
  assert.equal(activeTabAmong(tabs, "b"), "a", "the active tab is gone: the first remaining one");
  assert.equal(activeTabAmong(tabs, "c"), "c", "still there: unchanged");
  assert.equal(activeTabAmong(new Map(), "b"), null);
  assert.equal(activeTabAmong(tabs, null), null, "no active tab stays none");
});
