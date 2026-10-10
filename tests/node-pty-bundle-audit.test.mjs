import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import asar from "@electron/asar";
import { auditPtyTestBundle } from "../scripts/audit-pty-test-bundle.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-payload-audit-"));
  try {
    const input = join(root, "input");
    const app = join(root, "Test.app");
    const resources = join(app, "Contents", "Resources");
    await mkdir(join(input, "out"), { recursive: true });
    await mkdir(resources, { recursive: true });
    await writeFile(join(input, "out", "index.js"), "export const fixture = true;\n");
    await writeFile(join(input, "package.json"), '{"name":"synthetic-audit-fixture"}\n');
    await asar.createPackage(input, join(resources, "app.asar"));
    await run({ root, input, app, resources });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("payload audit scans a real synthetic ASAR and unpacked/extra resources without launching an application", async () => {
  await fixture(async ({ app, resources }) => {
    await mkdir(join(resources, "app.asar.unpacked", "node_modules", "node-pty", "build", "Release"), { recursive: true });
    await writeFile(join(resources, "app.asar.unpacked", "node_modules", "node-pty", "build", "Release", "pty.node"), "synthetic binary bytes");
    await writeFile(join(resources, "safe-helper.mjs"), "export const helper = true;");
    const result = await auditPtyTestBundle(app);
    assert.equal(result.issues.length, 0);
    assert.ok(result.filesScanned >= 4);
  });
});

test("payload audit detects credential-like bytes in extraResources without reporting their value", async () => {
  await fixture(async ({ app, resources }) => {
    // A synthetic pattern, not a real token or a user credential.
    const token = "gh" + "p_" + "A".repeat(32);
    await writeFile(join(resources, "unsafe-helper.mjs"), `export const injected = "${token}";`);
    const result = await auditPtyTestBundle(app);
    assert.ok(result.issues.some((item) => item.rule === "GitHub token"));
    assert.ok(!JSON.stringify(result).includes(token));
  });
});

test("payload audit rejects private state and pristine Darwin fallback modules", async () => {
  await fixture(async ({ app, resources }) => {
    await writeFile(join(resources, "auth.json"), "{}");
    const directory = join(resources, "app.asar.unpacked", "node_modules", "node-pty", "prebuilds", "darwin-arm64");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "pty.node"), "pristine fixture");
    const result = await auditPtyTestBundle(app);
    assert.ok(result.issues.some((item) => item.rule === "sensitive filename"));
    assert.ok(result.issues.some((item) => item.rule === "unpatched Darwin prebuild"));
  });
});

test("payload audit cannot claim success when the package is absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-missing-payload-"));
  try { await assert.rejects(auditPtyTestBundle(directory)); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
