import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";
import { SECRET_PATTERNS } from "./audit-secrets.mjs";

const ARCHIVE_ROOTS = new Set(["out", "node_modules", "package.json", "LICENSE"]);
const PRIVATE_SEGMENTS = new Set([".git", ".codex", ".agents", ".runtime", ".pty-results", "logs"]);
const PRIVATE_FILES = /^(?:\.env(?:\.|$)|(?:auth|credentials?|settings|terminal-sessions|controller|connection)\.json$)|\.(?:pem|key|p12|pfx)$/iu;

function pathIssues(name) {
  const parts = name.replaceAll("\\", "/").split("/");
  const issues = [];
  if (parts.some((part) => PRIVATE_SEGMENTS.has(part))) issues.push("private state directory");
  if (PRIVATE_FILES.test(parts.at(-1)) && parts.at(-1) !== ".env.example") issues.push("sensitive filename");
  if (parts.some((part) => part === "prebuilds") && parts.some((part) => /^darwin-/u.test(part))) {
    issues.push("unpatched Darwin prebuild");
  }
  return issues;
}

function textIssues(content) {
  const hits = [];
  for (const [name, pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) hits.push(name);
    pattern.lastIndex = 0;
  }
  return hits;
}

/** Scan application payload, not the separately downloaded stock Chromium engine. */
export async function auditPtyTestBundle(application) {
  const root = await realpath(application);
  const installedRoots = ["/Applications", join(homedir(), "Applications")];
  assert.ok(!installedRoots.some((directory) => root === directory || root.startsWith(`${directory}/`)),
    "refusing to audit an installed application rather than the separate test build");
  const resources = join(root, "Contents", "Resources");
  const archive = join(resources, "app.asar");
  assert.ok((await lstat(archive)).isFile(), "the actual packaged app.asar must exist");
  const issues = [];
  let filesScanned = 0;
  const record = (path, rules) => { for (const rule of new Set(rules)) issues.push({ path, rule }); };

  for (const raw of asar.listPackage(archive, { isPack: false })) {
    const name = raw.replace(/^[/\\]+/u, "").replaceAll("\\", "/");
    assert.ok(name && !name.split("/").includes(".."), "unsafe ASAR entry");
    const metadata = asar.statFile(archive, name, false);
    record(`app.asar/${name}`, pathIssues(name));
    if (!ARCHIVE_ROOTS.has(name.split("/")[0])) record(`app.asar/${name}`, ["unexpected archive root"]);
    if (metadata.link !== undefined) {
      record(`app.asar/${name}`, ["archive symlink requires review"]);
      continue;
    }
    if (metadata.files || metadata.unpacked) continue;
    assert.ok(Number.isSafeInteger(metadata.size) && metadata.size <= 32 * 1024 * 1024,
      `oversized application archive entry requires review: ${name}`);
    record(`app.asar/${name}`, textIssues(asar.extractFile(archive, name).toString("utf8")));
    filesScanned++;
  }

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const label = relative(root, path).replaceAll("\\", "/");
      if (path === archive) continue;
      record(label, pathIssues(label));
      if (entry.isSymbolicLink()) {
        const target = await realpath(path);
        if (!target.startsWith(`${root}/`)) record(label, ["bundle symlink escapes application"]);
        // Do not follow links or read a file outside the owned test bundle.
        continue;
      }
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        // Includes unpacked addons, extraResources and native helper payload.
        // Stream large model assets; never silently skip a file due to its size.
        const hits = new Set();
        let carry = "";
        for await (const bytes of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
          const text = carry + bytes.toString("utf8");
          for (const rule of textIssues(text)) hits.add(rule);
          carry = text.slice(-8192);
        }
        record(label, [...hits]);
        filesScanned++;
      }
    }
  }
  await walk(resources);
  // The owner's update-helper is application payload too. The stock Electron
  // executable/frameworks are verified by package/signature checks, not by a
  // secret regex that would flag built-in cryptographic parser constants.
  const helper = join(root, "Contents", "MacOS", "canvastty-update-helper");
  if (await lstat(helper).then((item) => item.isFile(), () => false)) {
    let content = "";
    for await (const bytes of createReadStream(helper)) {
      content = content.slice(-8192) + bytes.toString("utf8");
      record("Contents/MacOS/canvastty-update-helper", textIssues(content));
    }
    filesScanned++;
  }
  assert.ok(filesScanned > 0, "an empty scan cannot pass");
  return { filesScanned, issues };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, "usage: node scripts/audit-pty-test-bundle.mjs /path/to/test.app");
  const result = await auditPtyTestBundle(process.argv[2]);
  if (result.issues.length) {
    // Rules and relative paths only; never print a matched credential value.
    for (const issue of result.issues) console.error(`${issue.path}: ${issue.rule}`);
    process.exitCode = 1;
  } else console.log(`Test bundle payload audit passed: ${result.filesScanned} files, no high-confidence secrets/private state or Darwin prebuild fallback.`);
}
