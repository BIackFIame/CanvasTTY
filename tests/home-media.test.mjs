import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isHomeMediaPath, readHomeMedia } from "../src/main/services/homeMedia.ts";
import { SettingsStore } from "../src/main/services/SettingsStore.ts";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-home-media-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "pictures"));
  await mkdir(join(root, "private"));
  await writeFile(join(root, "pictures", "wall.png"), PNG);
  await writeFile(join(root, "private", "secret.png"), Buffer.from("not yours"));
  return root;
}

test("Home media reads the chosen image and refuses a link that leaves its folder", { skip: process.platform === "win32" }, async (t) => {
  const root = await fixture(t);
  const pictures = join(root, "pictures");
  assert.equal(await readHomeMedia(join(pictures, "wall.png")), `data:image/png;base64,${PNG.toString("base64")}`);

  await symlink(join(pictures, "wall.png"), join(pictures, "same-folder.png"));
  assert.match(await readHomeMedia(join(pictures, "same-folder.png")), /^data:image\/png;base64,/);

  await symlink(join(root, "private", "secret.png"), join(pictures, "escape.png"));
  await assert.rejects(readHomeMedia(join(pictures, "escape.png")), /outside/);

  await symlink(join(root, "private", "secret.png"), join(pictures, "up.png"));
  await assert.rejects(readHomeMedia(join(pictures, "..", "pictures", "up.png")), /outside/);

  await writeFile(join(pictures, "notes.txt"), "text");
  await symlink(join(pictures, "notes.txt"), join(pictures, "renamed.png"));
  await assert.rejects(readHomeMedia(join(pictures, "renamed.png")), /Unsupported media type/);
});

test("settings accept only an absolute image path as Home media", async (t) => {
  const absolute = process.platform === "win32" ? "C:\\Pictures\\wall.png" : "/srv/me/Pictures/wall.png";
  assert.equal(isHomeMediaPath(absolute), true);
  assert.equal(isHomeMediaPath("wall.png"), false);
  assert.equal(isHomeMediaPath("/srv/me/.ssh/id_ed25519"), false);
  assert.equal(isHomeMediaPath(`/srv/me/${"a".repeat(5000)}.png`), false);
  assert.equal(isHomeMediaPath("/srv/me/a\u0000.png"), false);

  const root = await mkdtemp(join(tmpdir(), "canvastty-home-media-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SettingsStore(root, "en");
  await store.load();
  assert.equal((await store.update({ mediaPath: absolute })).mediaPath, absolute);
  assert.equal((await store.update({ mediaPath: "/srv/me/.ssh/id_ed25519" })).mediaPath, absolute);
  assert.equal((await store.update({ mediaPath: "relative.png" })).mediaPath, absolute);
  assert.equal((await store.update({ mediaPath: null })).mediaPath, null);

  await writeFile(join(root, "settings.json"), JSON.stringify({ mediaPath: "/etc/passwd" }));
  assert.equal((await new SettingsStore(root, "en").load()).mediaPath, null);
});
