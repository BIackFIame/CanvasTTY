import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMaterialState } from "../src/main/services/materials/materialState.ts";

const SHA = "a".repeat(64);

function material(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "image",
    name: "hero.png",
    mimeType: "image/png",
    position: { x: 10, y: 20 },
    size: { width: 400, height: 300 },
    path: "/work/site/hero.png",
    identity: { dev: 1, ino: 2 },
    origin: null,
    createdAt: 1,
    versions: [],
    nextVersion: 1,
    ...overrides
  };
}

function version(overrides = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    number: 1,
    sha256: SHA,
    byteSize: 10,
    mimeType: "image/png",
    createdAt: 2,
    reason: "pinned",
    ...overrides
  };
}

test("a valid state round-trips and keeps versions ordered", () => {
  const state = normalizeMaterialState({
    version: 1,
    materials: [material({
      versions: [version({ id: "33333333-3333-4333-8333-333333333333", number: 3 }), version()],
      nextVersion: 2
    })]
  });
  assert.equal(state.materials.length, 1);
  assert.deepEqual(state.materials[0].versions.map((entry) => entry.number), [1, 3]);
  assert.equal(state.materials[0].nextVersion, 4);
});

test("an unknown schema or malformed file starts empty", () => {
  assert.deepEqual(normalizeMaterialState(null).materials, []);
  assert.deepEqual(normalizeMaterialState({ version: 2, materials: [material()] }).materials, []);
  assert.deepEqual(normalizeMaterialState({ version: 1, materials: "x" }).materials, []);
});

test("invalid rows are dropped instead of repaired", () => {
  const state = normalizeMaterialState({
    version: 1,
    materials: [
      material({ id: "not-a-uuid" }),
      material({ id: "44444444-4444-4444-8444-444444444444", kind: "spreadsheet" }),
      material({ id: "55555555-5555-4555-8555-555555555555", path: "relative/file.png" }),
      material({ id: "66666666-6666-4666-8666-666666666666", path: "/nul\0byte.png" }),
      material({ id: "77777777-7777-4777-8777-777777777777", position: { x: Infinity, y: 0 } }),
      material({ id: "88888888-8888-4888-8888-888888888888", path: null }),
      material({ id: "99999999-9999-4999-8999-999999999999", mimeType: "Image/PNG; charset=x" }),
      material()
    ]
  });
  assert.deepEqual(state.materials.map((entry) => entry.id), ["11111111-1111-4111-8111-111111111111"]);
});

test("duplicate ids and duplicate working files keep only the first card", () => {
  const state = normalizeMaterialState({
    version: 1,
    materials: [
      material(),
      material({ position: { x: 99, y: 99 } }),
      material({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })
    ]
  });
  assert.equal(state.materials.length, 1);
  assert.deepEqual(state.materials[0].position, { x: 10, y: 20 });
});

test("a capture needs at least one valid version and sizes are clamped", () => {
  const state = normalizeMaterialState({
    version: 1,
    materials: [
      material({ path: null, identity: null, versions: [version({ sha256: "bad" })] }),
      material({
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        path: null,
        identity: null,
        size: { width: 5, height: 99_999 },
        origin: { kind: "browser", url: "http://localhost:5173/", title: "Today", viewport: { width: 1280, height: 800 } },
        versions: [version({ reason: "capture" })]
      })
    ]
  });
  assert.equal(state.materials.length, 1);
  assert.deepEqual(state.materials[0].size, { width: 220, height: 1_800 });
  assert.equal(state.materials[0].origin.kind, "browser");
});

test("the material count is bounded", () => {
  const many = Array.from({ length: 300 }, (_, index) => material({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    path: `/work/${index}.png`
  }));
  assert.equal(normalizeMaterialState({ version: 1, materials: many }).materials.length, 256);
});
