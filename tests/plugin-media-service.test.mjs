import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginMediaService } from "../src/main/services/PluginMediaService.ts";

const PLUGIN_ID = "com.example.player";
const ALLOWED = new Set(["media:library", "playlists:read", "playlists:write"]);

test("grants opaque music libraries, scans tracks, and streams byte ranges", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-plugin-media-"));
  const libraryPath = join(root, "Music");
  try {
    await mkdir(join(libraryPath, "Album"), { recursive: true });
    await writeFile(join(libraryPath, "Album", "track.mp3"), Buffer.from([0, 1, 2, 3, 4, 5]));
    await writeFile(join(libraryPath, "notes.txt"), "ignored");
    const service = await createService(root);
    const library = await service.addLibrary(PLUGIN_ID, libraryPath);

    assert.equal(library.name, "Music");
    assert.equal("rootPath" in library, false);
    assert.deepEqual(service.listLibraries(PLUGIN_ID), [library]);
    const tracks = await service.scanLibrary(PLUGIN_ID, library.id);
    assert.deepEqual(tracks.map(({ name, relativePath, size, mimeType }) => ({ name, relativePath, size, mimeType })), [{
      name: "track",
      relativePath: "Album/track.mp3",
      size: 6,
      mimeType: "audio/mpeg"
    }]);
    assert.match(tracks[0].streamUrl, /^canvastty-media:\/\/com\.example\.player\//);

    const response = await service.protocolResponse(new Request(tracks[0].streamUrl, {
      headers: { range: "bytes=1-3" }
    }));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 1-3/6");
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads discovered playlists and writes bounded files into the library Playlists folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-plugin-playlists-"));
  const libraryPath = join(root, "Music");
  try {
    await mkdir(libraryPath, { recursive: true });
    await writeFile(join(libraryPath, "favorites.m3u8"), "#EXTM3U\ntrack.mp3\n");
    await writeFile(join(libraryPath, "unrelated.json"), "{\"secret\":true}");
    const service = await createService(root);
    const library = await service.addLibrary(PLUGIN_ID, libraryPath);

    const playlists = await service.listPlaylists(PLUGIN_ID, library.id);
    assert.equal(playlists[0].relativePath, "favorites.m3u8");
    assert.equal(playlists.some((playlist) => playlist.relativePath === "unrelated.json"), false);
    assert.equal(await service.readPlaylist(PLUGIN_ID, library.id, playlists[0].id), "#EXTM3U\ntrack.mp3\n");

    const written = await service.writePlaylist(PLUGIN_ID, library.id, "road-trip.m3u8", "#EXTM3U\nAlbum/song.flac\n");
    assert.equal(written.relativePath, "Playlists/road-trip.m3u8");
    assert.equal(await readFile(join(libraryPath, "Playlists", "road-trip.m3u8"), "utf8"), "#EXTM3U\nAlbum/song.flac\n");
    await assert.rejects(
      service.writePlaylist(PLUGIN_ID, library.id, "../escape.m3u8", "bad"),
      /Playlist name is invalid/
    );
    await assert.rejects(
      service.readPlaylist(PLUGIN_ID, library.id, "unrelated.json"),
      /Unsupported playlist format/
    );

    const restored = await createService(root);
    assert.deepEqual(restored.listLibraries(PLUGIN_ID), [library]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createService(userDataPath) {
  const service = new PluginMediaService(userDataPath, (_pluginId, permission) => {
    if (!ALLOWED.has(permission)) throw new Error(`Unexpected permission: ${permission}`);
  });
  await service.load();
  return service;
}

test("a playlist write does not follow a link planted at its temporary name", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-plugin-playlist-link-"));
  const libraryPath = join(root, "Music");
  const outside = join(root, "outside.txt");
  try {
    await mkdir(join(libraryPath, "Playlists"), { recursive: true });
    await writeFile(outside, "untouched");
    const { symlink, readdir } = await import("node:fs/promises");
    await symlink(outside, join(libraryPath, "Playlists", "road-trip.m3u8.tmp"));
    const service = await createService(root);
    const library = await service.addLibrary(PLUGIN_ID, libraryPath);
    const written = await service.writePlaylist(PLUGIN_ID, library.id, "road-trip.m3u8", "#EXTM3U\nsong.flac\n");
    assert.equal(written.relativePath, "Playlists/road-trip.m3u8");
    assert.equal(await readFile(outside, "utf8"), "untouched");
    assert.equal(await readFile(join(libraryPath, "Playlists", "road-trip.m3u8"), "utf8"), "#EXTM3U\nsong.flac\n");
    assert.deepEqual((await readdir(join(libraryPath, "Playlists"))).filter((name) => name.endsWith(".tmp") && name !== "road-trip.m3u8.tmp"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a folder pick that finishes during or after uninstall stores no grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-plugin-media-uninstall-"));
  const libraryPath = join(root, "Music");
  try {
    await mkdir(libraryPath, { recursive: true });
    let installed = true;
    const service = new PluginMediaService(root, () => { if (!installed) throw new Error("Plugin is not installed."); });
    await service.load();
    // The pick answered and the grant is on its way (its folder checks are still running) when uninstall starts.
    const during = service.addLibrary(PLUGIN_ID, libraryPath);
    service.beginRemoval(PLUGIN_ID);
    await service.revokeAll(PLUGIN_ID);
    await assert.rejects(during, /being uninstalled/u);
    // The same with uninstall already over: the plugin is unknown by then.
    const after = service.addLibrary(PLUGIN_ID, libraryPath);
    installed = false;
    service.endRemoval(PLUGIN_ID);
    await assert.rejects(after, /not installed/u);
    installed = true;
    assert.deepEqual(service.listLibraries(PLUGIN_ID), []);
    assert.deepEqual(await (await createService(root)).listLibraries(PLUGIN_ID), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
