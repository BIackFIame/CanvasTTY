import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MaterialService } from "../src/main/services/materials/MaterialService.ts";
import { materialUrl } from "../src/shared/materials.ts";

function pngBytes(width, height, extra = 0) {
  const bytes = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function fakeWatch() {
  const listeners = new Map();
  return {
    factory(directory, listener) {
      listeners.set(directory, listener);
      return { close: () => listeners.delete(directory) };
    },
    fire(directory) {
      listeners.get(directory)?.();
    },
    directories: () => [...listeners.keys()]
  };
}

async function withMaterials(run, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-materials-"));
  const work = join(root, "work");
  await mkdir(work);
  const userData = join(root, "user-data");
  const watch = fakeWatch();
  const snapshots = [];
  let persist = options.persist ?? true;
  const services = [];
  const create = async () => {
    const service = new MaterialService({
      userDataPath: userData,
      persist: () => persist,
      emit: (snapshot) => snapshots.push(snapshot),
      watchFactory: watch.factory,
      pollIntervalMs: 0,
      ...(options.storageLimitBytes ? { storageLimitBytes: options.storageLimitBytes } : {})
    });
    await service.load();
    services.push(service);
    return service;
  };
  try {
    await run({
      root,
      work: await realpath(work),
      userData,
      watch,
      snapshots,
      service: await create(),
      create,
      setPersist: (value) => {
        persist = value;
      }
    });
  } finally {
    for (const service of services) await service.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

async function until(read, predicate, timeoutMs = 3_000) {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (predicate(value)) return value;
    if (Date.now() - started > timeoutMs) assert.fail(`condition not reached: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function only(service) {
  const { materials } = service.snapshot();
  assert.equal(materials.length, 1);
  return materials[0];
}

async function body(response) {
  return Buffer.from(await response.arrayBuffer());
}

test("dropped files become cards at the drop point; folders, missing and relative paths are refused", async () => {
  await withMaterials(async ({ work, service }) => {
    const hero = join(work, "hero.png");
    const notes = join(work, "notes.md");
    await writeFile(hero, pngBytes(1920, 1080, 16));
    await writeFile(notes, "# Brief\n");
    await mkdir(join(work, "assets"));
    const result = await service.addPaths([hero, notes, join(work, "assets"), join(work, "gone.png"), "relative.png", 7], { x: 500, y: 300 });
    assert.equal(result.added.length, 2);
    assert.deepEqual(result.rejected.map((entry) => entry.reason), ["not-a-file", "unreadable", "unreadable", "unreadable"]);
    const [image, text] = service.snapshot().materials;
    assert.deepEqual({ kind: image.kind, name: image.name, location: image.location, state: image.state },
      { kind: "image", name: "hero.png", location: hero, state: "ready" });
    assert.deepEqual(image.size, { width: 440, height: 302 });
    assert.equal(text.kind, "text");
    assert.deepEqual(image.position, { x: 500, y: 300 });
    assert.deepEqual(text.position, { x: 500 + 440 + 24, y: 300 });
    assert.deepEqual(await readFile(hero), pngBytes(1920, 1080, 16));
  });
});

test("the same file, dropped again or through a symlink, points at the existing card", async () => {
  await withMaterials(async ({ work, service }) => {
    const hero = join(work, "hero.png");
    await writeFile(hero, pngBytes(10, 10));
    await symlink(hero, join(work, "alias.png"));
    const first = await service.addPaths([hero], { x: 0, y: 0 });
    const again = await service.addPaths([join(work, "alias.png"), hero], { x: 0, y: 0 });
    assert.deepEqual(again, { added: [], existing: [first.added[0]], rejected: [] });
    assert.equal(service.snapshot().materials.length, 1);
  });
});

test("a symlink disguised as an image is typed by its real target", async () => {
  await withMaterials(async ({ work, service }) => {
    const secret = join(work, "id_ed25519");
    await writeFile(secret, "PRIVATE KEY");
    await symlink(secret, join(work, "avatar.png"));
    await service.addPaths([join(work, "avatar.png")], { x: 0, y: 0 });
    const material = only(service);
    assert.equal(material.kind, "file");
    assert.equal(material.mimeType, "application/octet-stream");
    assert.equal(material.location, secret);
  });
});

test("the live file streams byte ranges with sandbox headers; unknown ids get nothing", async () => {
  await withMaterials(async ({ work, service }) => {
    const hero = join(work, "hero.png");
    await writeFile(hero, pngBytes(4, 4, 6));
    await service.addPaths([hero], { x: 0, y: 0 });
    const material = only(service);
    const response = await service.protocolResponse(new Request(materialUrl(material.id, null, 1), {
      headers: { range: "bytes=1-3" }
    }));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("content-range"), "bytes 1-3/39");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("content-security-policy"), /sandbox/);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.deepEqual([...await body(response)], [0x50, 0x4e, 0x47]);
    const unknown = await service.protocolResponse(new Request(materialUrl("99999999-9999-4999-8999-999999999999", null)));
    assert.equal(unknown.status, 404);
    const other = await service.protocolResponse(new Request("canvastty-media://x/y"));
    assert.equal(other.status, 400);
  });
});

test("a working file replaced by a symlink is no longer served", async () => {
  await withMaterials(async ({ work, service, watch }) => {
    const hero = join(work, "hero.png");
    await writeFile(hero, pngBytes(4, 4));
    await writeFile(join(work, "secret.txt"), "secret");
    await service.addPaths([hero], { x: 0, y: 0 });
    const material = only(service);
    await unlink(hero);
    await symlink(join(work, "secret.txt"), hero);
    const response = await service.protocolResponse(new Request(materialUrl(material.id, null, 2)));
    assert.equal(response.status, 404);
    watch.fire(work);
    await until(() => only(service).state, (state) => state === "unreadable");
  });
});

test("live changes bump the revision; deletion and a rename in the same folder have their own states", async () => {
  await withMaterials(async ({ work, service, watch }) => {
    const hero = join(work, "hero.png");
    await writeFile(hero, pngBytes(4, 4));
    await service.addPaths([hero], { x: 0, y: 0 });
    assert.deepEqual(watch.directories(), [work]);
    const before = only(service).liveRevision;
    await new Promise((resolve) => setTimeout(resolve, 15));
    await writeFile(hero, pngBytes(8, 8, 32));
    watch.fire(work);
    await until(() => only(service).liveRevision, (revision) => revision > before);
    assert.equal(only(service).byteSize, 65);

    await rename(hero, join(work, "hero-final.png"));
    watch.fire(work);
    const moved = await until(() => only(service), (material) => material.state === "moved");
    assert.equal(moved.movedTo, join(work, "hero-final.png"));
    assert.deepEqual(await service.acceptMove(moved.id), { ok: true });
    const relinked = only(service);
    assert.deepEqual({ state: relinked.state, name: relinked.name, location: relinked.location },
      { state: "ready", name: "hero-final.png", location: join(work, "hero-final.png") });

    await unlink(join(work, "hero-final.png"));
    watch.fire(work);
    await until(() => only(service).state, (state) => state === "missing");
    assert.equal(only(service).movedTo, null);
  });
});

test("relinking needs a readable file of the same kind that is not already on the canvas", async () => {
  await withMaterials(async ({ work, service }) => {
    await writeFile(join(work, "a.png"), pngBytes(4, 4));
    await writeFile(join(work, "b.png"), pngBytes(4, 4));
    await writeFile(join(work, "c.md"), "text");
    await service.addPaths([join(work, "a.png"), join(work, "b.png")], { x: 0, y: 0 });
    const [first] = service.snapshot().materials;
    assert.deepEqual(await service.relink(first.id, join(work, "c.md")), { ok: false, reason: "kind-mismatch" });
    assert.deepEqual(await service.relink(first.id, join(work, "b.png")), { ok: false, reason: "already-on-canvas" });
    assert.deepEqual(await service.relink(first.id, join(work, "none.png")), { ok: false, reason: "unreadable" });
    assert.deepEqual(await service.relink(first.id, work), { ok: false, reason: "not-a-file" });
  });
});

test("a pinned version keeps its bytes after the working file changes; identical content reuses it", async () => {
  await withMaterials(async ({ work, service, userData }) => {
    const hero = join(work, "hero.png");
    await writeFile(hero, pngBytes(4, 4, 1));
    await service.addPaths([hero], { x: 0, y: 0 });
    const id = only(service).id;
    const first = await service.pinVersion(id);
    assert.equal(first.ok, true);
    assert.equal(first.version.number, 1);
    const same = await service.pinVersion(id);
    assert.equal(same.version.id, first.version.id);

    await writeFile(hero, pngBytes(9, 9, 2));
    const second = await service.pinVersion(id);
    assert.equal(second.version.number, 2);
    const old = await service.protocolResponse(new Request(materialUrl(id, first.version.id)));
    assert.deepEqual(await body(old), pngBytes(4, 4, 1));
    const live = await service.protocolResponse(new Request(materialUrl(id, null, 5)));
    assert.deepEqual(await body(live), pngBytes(9, 9, 2));
    assert.equal((await readdir(join(userData, "materials", "versions"))).length, 2);
    assert.equal(service.snapshot().storage.usedBytes, 34 + 35);
  });
});

test("version storage is bounded and reports a full store instead of evicting", async () => {
  await withMaterials(async ({ work, service }) => {
    const big = join(work, "big.png");
    await writeFile(big, pngBytes(4, 4, 200));
    await service.addPaths([big], { x: 0, y: 0 });
    assert.deepEqual(await service.pinVersion(only(service).id), { ok: false, reason: "quota" });
    assert.equal(only(service).versions.length, 0);
  }, { storageLimitBytes: 100 });
});

test("a missing working file cannot be pinned", async () => {
  await withMaterials(async ({ work, service }) => {
    const hero = join(work, "hero.png");
    await writeFile(hero, pngBytes(4, 4));
    await service.addPaths([hero], { x: 0, y: 0 });
    await unlink(hero);
    assert.deepEqual(await service.pinVersion(only(service).id), { ok: false, reason: "unavailable" });
  });
});

test("clipboard captures live only in CanvasTTY storage and are served from it", async () => {
  await withMaterials(async ({ service }) => {
    const bytes = pngBytes(640, 480, 5);
    const id = await service.addCapture({
      bytes,
      name: "clipboard-1.png",
      mimeType: "image/png",
      origin: { kind: "clipboard" },
      point: { x: 0, y: 0 },
      natural: { width: 640, height: 480 }
    });
    const material = only(service);
    assert.equal(material.id, id);
    assert.deepEqual({ location: material.location, state: material.state, versions: material.versions.map((v) => v.reason) },
      { location: null, state: "ready", versions: ["capture"] });
    assert.deepEqual(await body(await service.protocolResponse(new Request(materialUrl(id, null)))), bytes);
    assert.equal((await service.pinVersion(id)).version.reason, "capture");
  });
});

test("removing a card never touches the original and collects its versions", async () => {
  await withMaterials(async ({ work, service, userData, watch }) => {
    const hero = join(work, "hero.png");
    await writeFile(hero, pngBytes(4, 4));
    await service.addPaths([hero], { x: 0, y: 0 });
    await service.pinVersion(only(service).id);
    await service.remove(only(service).id);
    assert.equal(service.snapshot().materials.length, 0);
    assert.equal((await stat(hero)).isFile(), true);
    assert.deepEqual(await readdir(join(userData, "materials", "versions")), []);
    assert.deepEqual(watch.directories(), []);
  });
});

test("cards, bounds and versions survive a restart; with saving off the next start is empty", async () => {
  await withMaterials(async ({ work, service, create, setPersist }) => {
    const hero = join(work, "hero.png");
    await writeFile(hero, pngBytes(4, 4));
    await service.addPaths([hero], { x: 0, y: 0 });
    const id = only(service).id;
    service.setBounds(id, { position: { x: 12, y: 34 }, size: { width: 5, height: 5000 } });
    await service.pinVersion(id);
    await service.flush();

    const restored = await create();
    const material = only(restored);
    assert.deepEqual(material.position, { x: 12, y: 34 });
    assert.deepEqual(material.size, { width: 220, height: 1_800 });
    assert.equal(material.versions.length, 1);
    assert.equal(material.state, "ready");

    setPersist(false);
    await restored.flush();
    const empty = await create();
    assert.equal(empty.snapshot().materials.length, 0);
  });
});

test("bounds from the renderer are validated before they are stored", async () => {
  await withMaterials(async ({ work, service }) => {
    await writeFile(join(work, "a.png"), pngBytes(4, 4));
    await service.addPaths([join(work, "a.png")], { x: 0, y: 0 });
    const before = only(service);
    service.setBounds(before.id, { position: { x: Number.NaN, y: 0 }, size: { width: 300, height: 300 } });
    service.setBounds(before.id, "garbage");
    service.setBounds("unknown", { position: { x: 0, y: 0 }, size: { width: 300, height: 300 } });
    assert.deepEqual(only(service).position, before.position);
  });
});
