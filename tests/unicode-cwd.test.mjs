import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { onDiskPath, otherSpellings } from "../src/main/services/onDiskPath.ts";
import { openCodeProjectFolderEnvironment } from "../src/main/services/openCodeConfig.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

// "й" has a composed (NFC) and a decomposed (NFD) spelling; Finder stores the NFD one.
const NFC = "тестовый проект".normalize("NFC");
const NFD = NFC.normalize("NFD");

async function projectRoot(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-unicode-cwd-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Created in NFD, as Finder would; the path is then typed in NFC.
  await mkdir(join(root, NFD, "src"), { recursive: true });
  return root;
}

test("onDiskPath spells each folder as the disk stores it and keeps symlinks and unknown parts", async (t) => {
  assert.notEqual(NFC, NFD);
  const root = await projectRoot(t);
  assert.equal(onDiskPath(join(root, NFC)), join(root, NFD));
  assert.equal(onDiskPath(join(root, NFC, "src")), join(root, NFD, "src"));
  assert.equal(onDiskPath(join(root, NFD)), join(root, NFD));
  assert.equal(onDiskPath(join(root, "plain")), join(root, "plain"));
  assert.equal(onDiskPath(join(root, NFC, "missing-й")), join(root, NFD, "missing-й"));
  assert.equal(onDiskPath("relative/й"), "relative/й");
  await symlink(join(root, NFD), join(root, "link-й".normalize("NFD")));
  assert.equal(onDiskPath(join(root, "link-й".normalize("NFC"))), join(root, "link-й".normalize("NFD")));
  assert.deepEqual(otherSpellings(join(root, NFD)), [join(root, NFC)]);
  assert.deepEqual(otherSpellings("/ascii/only"), []);
});

test("OpenCode allows its own project folder in its other spelling, and only that", () => {
  const folder = `/projects/downloads/${NFD}`;
  const config = JSON.parse(openCodeProjectFolderEnvironment({
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { canvastty_browser_: "allow", external_directory: "ask" }, model: "x" })
  }, folder).OPENCODE_CONFIG_CONTENT);
  const nfc = `/projects/downloads/${NFC}`;
  assert.equal(config.model, "x");
  assert.equal(config.permission.canvastty_browser_, "allow");
  assert.deepEqual(config.permission.external_directory, { "*": "ask", [nfc]: "allow", [`${nfc}/**`]: "allow" });
  assert.deepEqual(openCodeProjectFolderEnvironment({}, "/projects/plain"), {});
  assert.deepEqual(openCodeProjectFolderEnvironment({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: "allow" }) }, folder), {});
  assert.deepEqual(openCodeProjectFolderEnvironment({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { external_directory: "allow" } }) }, folder), {});
});

function manager(calls) {
  return new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
}

test("a subagent spawned with an NFC path runs in the on-disk folder, with a matching PWD", async (t) => {
  const root = await projectRoot(t);
  const calls = [];
  const terminals = manager(calls);
  t.after(() => terminals.disposeAll());
  const orchestrator = terminals.create({ provider: "codex", cwd: join(root, NFC), profile: "normal", position: { x: 0, y: 0 }, role: "orchestrator" });
  assert.equal(orchestrator.cwd, join(root, NFD));
  const control = new AgentControlService(terminals);
  for (const provider of ["opencode", "claude", "codex", "qwen", "grok"]) {
    const child = await control.spawn({ parentSessionId: orchestrator.id, provider, cwd: join(root, NFC) });
    assert.equal(child.cwd, join(root, NFD), provider);
    const spawned = calls.at(-1);
    assert.equal(spawned.options.cwd, join(root, NFD), provider);
    assert.equal(spawned.options.env.PWD, join(root, NFD), provider);
    if (provider === "opencode") {
      const config = JSON.parse(spawned.options.env.OPENCODE_CONFIG_CONTENT);
      assert.deepEqual(config.permission.external_directory, {
        [join(root, NFC)]: "allow", [`${join(root, NFC)}/**`]: "allow"
      });
    }
  }
});

test("an ASCII project folder launches exactly as before, apart from PWD", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-ascii-cwd-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const terminals = manager(calls);
  t.after(() => terminals.disposeAll());
  const session = terminals.create({ provider: "opencode", cwd: root, profile: "normal", position: { x: 0, y: 0 } });
  assert.equal(session.cwd, root);
  assert.equal(calls[0].options.env.PWD, root);
  const inline = calls[0].options.env.OPENCODE_CONFIG_CONTENT;
  assert.ok(inline === undefined || !JSON.parse(inline).permission?.external_directory);
});
