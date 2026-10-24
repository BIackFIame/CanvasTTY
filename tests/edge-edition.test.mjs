import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
import { BUILD_COMMIT, EDITION, editionLabel } from "../src/shared/edition.ts";
import { EdgeUpdateAdapter } from "../src/main/services/updates/EdgeUpdateAdapter.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Edge packages as a separate app: its own name and bundle id, no publish target or Sparkle files", async () => {
  const builder = parse(await read("electron-builder.yml"));
  assert.equal(builder.productName, EDITION.name);
  assert.equal(builder.appId, EDITION.bundleId);
  assert.notEqual(builder.appId, "io.github.howdeploy.canvastty");
  assert.equal(builder.publish, null);
  assert.equal(builder.mac.extraFiles, undefined);
  assert.match(builder.artifactName, /^CanvasTTY-Edge-/);
  const manifest = JSON.parse(await read("package.json"));
  assert.doesNotMatch(manifest.scripts["package:mac"], /build:mac-updater/);
});

test("Edge keeps its own data folder and never the official profile's", async () => {
  assert.equal(EDITION.dataFolder, "canvastty-edge");
  assert.notEqual(EDITION.dataFolder, JSON.parse(await read("package.json")).name);
  const main = await read("src/main/index.ts");
  const setName = main.indexOf("app.setName(EDITION.name);");
  const setPath = main.indexOf('app.setPath("userData", join(app.getPath("appData"), EDITION.dataFolder));');
  assert.ok(setName > 0 && setPath > setName, "the name and folder are set before anything reads userData");
  assert.ok(setPath < main.indexOf('new DiagnosticLog(join(app.getPath("userData"), "logs"))'));
});

test("Edge never checks, downloads or installs official updates", async () => {
  assert.equal(EDITION.selfUpdates, false);
  const adapter = new EdgeUpdateAdapter();
  for (const step of [() => adapter.check(), () => adapter.download(), () => adapter.install()]) {
    await assert.rejects(step(), /does not update itself/);
  }
  const main = await read("src/main/index.ts");
  assert.match(main, /if \(app\.isPackaged && EDITION\.selfUpdates\) \{\n\s+updateTimer = setTimeout/);
});

test("the edition label names Edge, the version and the build commit", () => {
  assert.equal(editionLabel("1.8.2"), `CanvasTTY Edge 1.8.2 (${BUILD_COMMIT})`);
});
