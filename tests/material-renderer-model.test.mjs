import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptMaterialsSnapshot,
  EMPTY_MATERIALS_SNAPSHOT,
  withPendingBounds
} from "../src/renderer/src/features/materials/materialSnapshot.ts";
import {
  addResultNeedsNotice,
  formatBytes,
  materialFailureKey,
  materialFolder,
  materialRejectionKey,
  materialRemovalLosesData
} from "../src/renderer/src/features/materials/materialCardModel.ts";

const bounds = (x, y, width = 300, height = 200) => ({ position: { x, y }, size: { width, height } });

function material(id, x, y, overrides = {}) {
  return { id, ...bounds(x, y), location: `/work/${id}.png`, versions: [], ...overrides };
}

test("a late snapshot never replaces a newer one", () => {
  const newer = { ...EMPTY_MATERIALS_SNAPSHOT, revision: 5 };
  const older = { ...EMPTY_MATERIALS_SNAPSHOT, revision: 4 };
  assert.equal(acceptMaterialsSnapshot(newer, older), newer);
  assert.equal(acceptMaterialsSnapshot(older, newer), newer);
});

test("a group drag keeps every moved card in place until main echoes its bounds", () => {
  const pending = new Map([["a", bounds(50, 50)], ["b", bounds(60, 60)]]);
  const echoedFirst = [material("a", 50, 50), material("b", 0, 0)];
  const shown = withPendingBounds(echoedFirst, pending);
  assert.deepEqual(shown.map((entry) => entry.position), [{ x: 50, y: 50 }, { x: 60, y: 60 }]);
  assert.deepEqual([...pending.keys()], ["b"]);
  withPendingBounds([material("a", 50, 50), material("b", 60, 60)], pending);
  assert.equal(pending.size, 0);
});

test("pending bounds of a removed card are dropped", () => {
  const pending = new Map([["gone", bounds(1, 1)]]);
  assert.deepEqual(withPendingBounds([material("a", 0, 0)], pending).map((entry) => entry.id), ["a"]);
  assert.equal(pending.size, 0);
});

test("byte sizes and folders are formatted for the card", () => {
  assert.equal(formatBytes(512, "en"), "512 B");
  assert.equal(formatBytes(1536, "en"), "1.5 KB");
  assert.equal(formatBytes(1536, "ru"), "1,5 КБ");
  assert.equal(formatBytes(25 * 1024 * 1024, "en"), "25 MB");
  assert.equal(formatBytes(null, "en"), "");
  assert.equal(materialFolder("/work/site/hero.png"), "/work/site");
  assert.equal(materialFolder("C:\\work\\hero.png"), "C:\\work");
  assert.equal(materialFolder(null), null);
});

test("removal asks first only when CanvasTTY holds data the file on disk does not", () => {
  assert.equal(materialRemovalLosesData(material("a", 0, 0)), false);
  assert.equal(materialRemovalLosesData(material("a", 0, 0, { versions: [{ id: "v" }] })), true);
  assert.equal(materialRemovalLosesData(material("a", 0, 0, { location: null })), true);
});

test("failures and rejections map to explained messages; cancelling says nothing", () => {
  assert.equal(materialFailureKey("quota"), "materialFailureQuota");
  assert.equal(materialFailureKey("kind-mismatch"), "materialFailureKindMismatch");
  assert.equal(materialFailureKey("cancelled"), null);
  assert.equal(materialRejectionKey("not-a-file"), "materialsNotAFile");
  assert.equal(materialRejectionKey("empty-clipboard"), "materialsEmptyClipboard");
  assert.equal(addResultNeedsNotice({ added: ["a"], existing: [], rejected: [] }), false);
  assert.equal(addResultNeedsNotice({ added: [], existing: ["a"], rejected: [] }), true);
  assert.equal(addResultNeedsNotice({ added: ["a"], existing: [], rejected: [{ name: "x", reason: "limit" }] }), true);
});
