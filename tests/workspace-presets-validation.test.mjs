import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceArchive } from "../src/main/services/WorkspaceArchive.ts";

const descriptor = (cwd, id) => ({
  id,
  provider: "codex",
  profile: "normal",
  role: "orchestrator",
  title: id,
  titleCustomized: true,
  cwd,
  position: { x: 10, y: 20 },
  size: { width: 700, height: 430 },
  lastState: "running",
  restore: true,
});

const snapshot = (cwd, id, extra = {}) => JSON.stringify({
  format: "canvastty-workspace",
  version: 1,
  sessions: [{ ...descriptor(cwd, id), ...extra }],
});

test("one invalid saved workspace preset is isolated from valid presets", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-preset-isolation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = new WorkspaceArchive(directory, {
    descriptors: () => [],
    create: (request) => ({ ...request, id: "created", size: request.size }),
    setBounds: () => {},
    available: () => true,
    redact: (text) => text,
  });
  const file = join(directory, "workspace-presets.json");
  const first = { id: "daily", name: "Daily", snapshot: snapshot(directory, "first") };
  const second = { id: "review", name: "Review", snapshot: snapshot(directory, "second") };
  const malformed = { id: "broken", name: "Broken", snapshot: "{not valid JSON" };
  const invalidName = { id: "blank-name", name: "  ", snapshot: snapshot(directory, "third") };
  await writeFile(file, JSON.stringify([first, malformed, second, invalidName]));
  const warnings = [];
  t.mock.method(console, "warn", (...args) => { warnings.push(args.join(" ")); });

  assert.deepEqual((await archive.presets()).map(({ id, name }) => ({ id, name })), [
    { id: "daily", name: "Daily" },
    { id: "review", name: "Review" },
  ]);
  assert.equal(warnings.length, 1, "skipped presets are reported once per read");
  assert.match(warnings[0], /2 damaged workspace presets/u);
  assert.doesNotMatch(warnings[0], /Broken|first|second/u, "the warning names no preset contents");

  await archive.savePreset({ id: "new", name: "New", snapshot: snapshot(directory, "new") });
  const afterSave = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(afterSave.map(({ id }) => id), ["daily", "review", "new"]);
  assert.ok(afterSave.every(({ snapshot: value }) => JSON.parse(value).format === "canvastty-workspace"));

  await archive.deletePreset("daily");
  assert.deepEqual((await archive.presets()).map(({ id }) => id), ["review", "new"]);
});
