import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isPixelSkinSlot,
  isPixelTerminalBorderSkinId,
  PIXEL_SKIN_SLOTS,
  PixelSkinPackRegistry
} from "../src/main/services/PixelSkinPackRegistry.ts";
import { SettingsStore } from "../src/main/services/SettingsStore.ts";
import { DEFAULT_PIXEL_SKIN_APERTURES } from "../src/shared/contracts.ts";
import { testPng } from "./helpers/png.mjs";


function zipFixture(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [path, data] of entries) {
    const name = Buffer.from(path);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30 + name.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    name.copy(header, 30);
    local.push(header, data);
    const record = Buffer.alloc(46 + name.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    name.copy(record, 46);
    central.push(record);
    offset += header.length + data.length;
  }
  const directory = Buffer.concat(central);
  const ending = Buffer.alloc(22);
  ending.writeUInt32LE(0x06054b50, 0);
  ending.writeUInt16LE(entries.length, 8);
  ending.writeUInt16LE(entries.length, 10);
  ending.writeUInt32LE(directory.length, 12);
  ending.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, ending]);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-pixel-skins-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new PixelSkinPackRegistry(root);
  await registry.initialize();
  return { root, registry };
}

test("a ten-PNG pixel pack installs, persists and is readable by slot", async (t) => {
  const { root, registry } = await fixture(t);
  const png = testPng();
  const files = Object.fromEntries(PIXEL_SKIN_SLOTS.map((slot) => [slot, png]));
  let changes = 0;
  registry.onChanged(() => { changes += 1; });
  const installed = await registry.install({ name: "My Sakura", files });
  assert.ok(isPixelTerminalBorderSkinId(installed.id));
  assert.deepEqual(registry.list(), [installed]);
  assert.deepEqual(await registry.readAsset(installed.id, "master_completed"), png);
  assert.equal(changes, 1);

  const reopened = new PixelSkinPackRegistry(root);
  await reopened.initialize();
  assert.deepEqual(reopened.list(), [installed]);
  assert.deepEqual(await reopened.readAsset(installed.id, "background"), png);
});

test("each detail level keeps its own terminal opening and legacy packs still load", async (t) => {
  const { root, registry } = await fixture(t);
  const png = testPng();
  const files = Object.fromEntries(PIXEL_SKIN_SLOTS.map((slot) => [slot, png]));
  const apertures = {
    minimal: { left: 5, right: 5, top: 10, bottom: 8 },
    detailed: { left: 9, right: 9, top: 14, bottom: 12 },
    master: { left: 18, right: 18, top: 22, bottom: 20 }
  };
  const installed = await registry.install({ name: "Three openings", files, apertures });
  assert.deepEqual(installed.apertures, apertures);

  const reopened = new PixelSkinPackRegistry(root);
  await reopened.initialize();
  assert.deepEqual(reopened.list()[0].apertures, apertures);

  const manifestPath = join(root, "pixel-skins", installed.id.slice("pixel:".length), "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  delete manifest.apertures;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const legacy = new PixelSkinPackRegistry(root);
  await legacy.initialize();
  assert.deepEqual(legacy.list()[0].apertures, {
    minimal: installed.aperture,
    detailed: installed.aperture,
    master: installed.aperture
  });
});

test("pack import rejects missing slots and corrupt PNG data before writing", async (t) => {
  const { registry } = await fixture(t);
  const png = testPng();
  const files = Object.fromEntries(PIXEL_SKIN_SLOTS.map((slot) => [slot, png]));
  delete files.master_completed;
  await assert.rejects(registry.install({ name: "Incomplete", files }), /exactly nine/);
  files.master_completed = new Uint8Array([1, 2, 3]);
  await assert.rejects(registry.install({ name: "Corrupt", files }), /PNG/);
  const damaged = Buffer.from(png);
  damaged[damaged.length - 20] ^= 1;
  files.master_completed = damaged;
  await assert.rejects(registry.install({ name: "Checksum mismatch", files }), /checksum/);
  assert.deepEqual(registry.list(), []);
  assert.equal(isPixelSkinSlot("../../manifest.json"), false);
  assert.equal(isPixelTerminalBorderSkinId("pixel:../../foo"), false);
});

test("one ZIP installs all ten named images and rejects missing or duplicate roles", async (t) => {
  const { registry } = await fixture(t);
  const png = testPng();
  const entries = PIXEL_SKIN_SLOTS.map((slot) => [`My Theme/${slot}.png`, png]);
  const installed = await registry.installZip(zipFixture(entries), "ZIP Sakura");
  assert.equal(installed.name, "ZIP Sakura");
  assert.deepEqual(installed.apertures, DEFAULT_PIXEL_SKIN_APERTURES);
  assert.deepEqual(await registry.readAsset(installed.id, "master_completed"), png);
  await assert.rejects(registry.installZip(zipFixture(entries.slice(0, -1)), "Missing"), /needs minimal/);
  await assert.rejects(registry.installZip(zipFixture([...entries, entries[0]]), "Duplicate"), /duplicate/);
  assert.equal(registry.list().length, 1);
});

test("a ten-image pack with distinct frames per state installs and restores as the active skin", async (t) => {
  const { root, registry } = await fixture(t);
  const files = Object.fromEntries(PIXEL_SKIN_SLOTS.map((slot, index) => [slot, testPng({ seed: index + 1 })]));
  const pack = await registry.install({ name: "Cat", files });
  assert.equal(registry.list()[0].id, pack.id);
  assert.notDeepEqual(await registry.readAsset(pack.id, "master_idle"), await registry.readAsset(pack.id, "master_working"));
  assert.notDeepEqual(await registry.readAsset(pack.id, "master_working"), await registry.readAsset(pack.id, "master_completed"));
  assert.deepEqual(await registry.readAsset(pack.id, "background"), files.background);
  const settings = new SettingsStore(root, "en");
  await settings.update({ terminalBorderSkin: pack.id, terminalSkinDetail: "minimal" });
  const restored = await new SettingsStore(root, "en").load();
  assert.equal(restored.terminalBorderSkin, pack.id);
  assert.equal(restored.terminalSkinDetail, "minimal");
});
