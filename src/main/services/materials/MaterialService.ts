import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type {
  CanvasMaterial,
  MaterialCreateResult,
  MaterialFailure,
  MaterialOrigin,
  MaterialResult,
  MaterialsAddResult,
  MaterialsSnapshot,
  MaterialState,
  Point,
  SessionBounds,
  Size
} from "../../../shared/contracts.ts";
import {
  clampSize,
  MATERIAL_LIMIT,
  MATERIAL_SCHEME,
  materialCardSize,
  materialsAtPoint,
  materialType
} from "../../../shared/materials.ts";
import { streamFile, textResponse } from "../fileResponse.ts";
import { IMAGE_HEADER_BYTES, imageDimensions } from "./imageDimensions.ts";
import {
  emptyMaterialState,
  MATERIAL_STATE_VERSION,
  restoreMaterialState,
  type StoredMaterial
} from "./materialState.ts";
import { DirectoryWatchSet, nodeWatchFactory, type WatchFactory } from "./materialWatch.ts";
import { MaterialBlobError, MaterialBlobs } from "./MaterialBlobs.ts";

const MAX_PATHS_PER_ADD = 64;
const MAX_NAME = 255;
const MATERIAL_CAPTURE_MAX_BYTES = 32 * 1024 * 1024;
const MATERIAL_STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024;
const PERSIST_DELAY_MS = 250;
const REFRESH_DELAY_MS = 150;
const POLL_INTERVAL_MS = 10_000;
const RENAME_SCAN_LIMIT = 5_000;
const RESPONSE_HEADERS = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "x-content-type-options": "nosniff"
};

export interface MaterialServiceOptions {
  userDataPath: string;
  persist(): boolean;
  emit(snapshot: MaterialsSnapshot): void;
  watchFactory?: WatchFactory;
  now?(): number;
  pollIntervalMs?: number;
  storageLimitBytes?: number;
}

interface LiveState {
  state: MaterialState;
  signature: string | null;
  byteSize: number | null;
  modifiedAt: number | null;
  revision: number;
  movedTo: string | null;
}

interface MaterialCaptureInput {
  bytes: Uint8Array;
  name: string;
  mimeType: string;
  origin: MaterialOrigin;
  point: Point;
  natural?: Size | null;
}

export class MaterialService {
  private readonly options: MaterialServiceOptions;
  private readonly root: string;
  private readonly statePath: string;
  private readonly blobs: MaterialBlobs;
  private readonly materials = new Map<string, StoredMaterial>();
  private readonly live = new Map<string, LiveState>();
  private readonly watchers: DirectoryWatchSet;
  private readonly pendingRefresh = new Set<string>();
  private revision = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private writeQueue: Promise<void> = Promise.resolve();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private loading: Promise<void> | null = null;
  private disposing: Promise<void> | null = null;
  private writable = false;
  private loadError: "unreadable" | undefined;
  private disposed = false;

  constructor(options: MaterialServiceOptions) {
    this.options = options;
    this.root = join(options.userDataPath, "materials");
    this.statePath = join(this.root, "state.json");
    this.blobs = new MaterialBlobs(join(this.root, "versions"));
    this.watchers = new DirectoryWatchSet(options.watchFactory ?? nodeWatchFactory, (ids) => this.scheduleRefresh(ids));
  }

  load(): Promise<void> {
    this.loading ??= this.restore();
    return this.loading;
  }

  private async restore(): Promise<void> {
    let state = emptyMaterialState();
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      state = restoreMaterialState(JSON.parse(await readFile(this.statePath, "utf8")));
    } catch (error) {
      const newStore = Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        && await this.blobs.usedBytes().then((bytes) => bytes === 0, () => false);
      if (!newStore) {
        console.warn("CanvasTTY materials could not be loaded and are left on disk as they are.", error);
        this.loadError = "unreadable";
        this.changed(false);
        return;
      }
    }
    if (!this.options.persist()) state = emptyMaterialState();
    for (const material of state.materials) {
      this.materials.set(material.id, material);
    }
    this.writable = true;
    await this.collect();
    if (this.disposed) return;
    for (const material of this.materials.values()) {
      await this.refreshLive(material);
      if (this.disposed) return;
      this.watchers.track(material.id, material.path);
    }
    const interval = this.options.pollIntervalMs ?? POLL_INTERVAL_MS;
    if (interval > 0) {
      this.pollTimer = setInterval(() => {
        this.watchers.retry();
        this.scheduleRefresh([...this.materials.keys()]);
      }, interval);
      this.pollTimer.unref?.();
    }
    this.changed(false);
  }

  snapshot(): MaterialsSnapshot {
    return {
      revision: this.revision,
      ...(this.loadError ? { loadError: this.loadError } : {}),
      materials: [...this.materials.values()].map((material) => this.publicMaterial(material))
    };
  }

  location(id: string): string | null {
    return this.materials.get(id)?.path ?? null;
  }

  addPaths(paths: readonly unknown[], point: unknown): Promise<MaterialsAddResult> {
    return this.serial(async () => {
      const result: MaterialsAddResult = { added: [], existing: [], rejected: [] };
      if (!this.writable) {
        result.rejected = paths.slice(0, MAX_PATHS_PER_ADD).map((path) => ({
          name: typeof path === "string" ? displayName(path) : "file", reason: "unreadable"
        }));
        return result;
      }
      const fresh: StoredMaterial[] = [];
      const infos = new Map<string, Stats>();
      for (const candidate of paths.slice(0, MAX_PATHS_PER_ADD)) {
        const name = typeof candidate === "string" ? displayName(candidate) : "file";
        if (typeof candidate !== "string" || !isAbsolute(candidate) || candidate.includes("\0")) {
          result.rejected.push({ name, reason: "unreadable" });
          continue;
        }
        let resolved: string;
        let info: Stats;
        try {
          resolved = await realpath(candidate);
          info = await stat(resolved);
        } catch {
          result.rejected.push({ name, reason: "unreadable" });
          continue;
        }
        if (!info.isFile()) {
          result.rejected.push({ name, reason: "not-a-file" });
          continue;
        }
        const existing = this.findByPath(resolved) ?? fresh.find((material) => material.path === resolved);
        if (existing) {
          if (!result.existing.includes(existing.id)) result.existing.push(existing.id);
          continue;
        }
        if (this.materials.size + fresh.length >= MATERIAL_LIMIT) {
          result.rejected.push({ name, reason: "limit" });
          continue;
        }
        const type = materialType(basename(resolved));
        const kind = type.kind === "image" ? "image" : "file";
        const natural = kind === "image" ? await readImageDimensions(resolved) : null;
        const material: StoredMaterial = {
          id: randomUUID(),
          kind,
          name,
          mimeType: kind === "image" ? type.mimeType : "application/octet-stream",
          position: { x: 0, y: 0 },
          size: materialCardSize(kind, natural),
          path: resolved,
          identity: { dev: Number(info.dev), ino: Number(info.ino) },
          origin: null,
          createdAt: this.now(),
          versions: [],
          nextVersion: 1
        };
        fresh.push(material);
        infos.set(material.id, info);
      }
      const placed = materialsAtPoint(fresh.map((material) => material.size), finitePoint(point));
      fresh.forEach((material, index) => {
        material.position = placed[index].position;
        this.materials.set(material.id, material);
        const info = infos.get(material.id)!;
        this.live.set(material.id, {
          state: "ready",
          signature: signatureOf(info),
          byteSize: Number(info.size),
          modifiedAt: Number(info.mtimeMs),
          revision: 1,
          movedTo: null
        });
        this.watchers.track(material.id, material.path);
        result.added.push(material.id);
      });
      if (fresh.length > 0) this.changed();
      return result;
    });
  }

  addCapture(input: MaterialCaptureInput): Promise<MaterialCreateResult> {
    return this.serial(async () => {
      if (!this.writable) return failure("unreadable");
      if (this.materials.size >= MATERIAL_LIMIT) return failure("material-limit");
      let blob;
      try {
        blob = await this.blobs.writeFromBytes(input.bytes, MATERIAL_CAPTURE_MAX_BYTES, await this.availableBytes());
      } catch (error) {
        return failure(blobFailure(error));
      }
      const type = materialType(input.name);
      const createdAt = this.now();
      const size = materialCardSize(type.kind, input.natural ?? null);
      const [placed] = materialsAtPoint([size], finitePoint(input.point));
      const material: StoredMaterial = {
        id: randomUUID(),
        kind: type.kind,
        name: displayName(input.name),
        mimeType: input.mimeType,
        position: placed.position,
        size,
        path: null,
        identity: null,
        origin: input.origin,
        createdAt,
        versions: [{
          id: randomUUID(),
          number: 1,
          sha256: blob.sha256,
          byteSize: blob.byteSize,
          mimeType: input.mimeType,
          createdAt,
          reason: "capture"
        }],
        nextVersion: 2
      };
      this.materials.set(material.id, material);
      await this.refreshLive(material);
      this.changed();
      return { ok: true, materialId: material.id };
    });
  }

  setBounds(id: string, bounds: unknown): void {
    if (!this.writable || this.disposed) return;
    const material = this.materials.get(id);
    if (!material || !isBounds(bounds)) return;
    material.position = { x: bounds.position.x, y: bounds.position.y };
    material.size = clampSize(bounds.size);
    this.changed();
  }

  setBoundsBatch(entries: unknown): void {
    if (!this.writable || this.disposed) return;
    if (!Array.isArray(entries)) return;
    let any = false;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const { id, bounds } = entry as { id?: unknown; bounds?: unknown };
      const material = typeof id === "string" ? this.materials.get(id) : undefined;
      if (!material || !isBounds(bounds)) continue;
      material.position = { x: bounds.position.x, y: bounds.position.y };
      material.size = clampSize(bounds.size);
      any = true;
    }
    if (any) this.changed();
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      if (!this.materials.delete(id)) return;
      this.live.delete(id);
      this.pendingRefresh.delete(id);
      this.watchers.untrack(id);
      this.changed();
      await this.collect();
    });
  }

  relink(id: string, candidate: unknown): Promise<MaterialResult> {
    return this.serial(async () => {
      const material = this.materials.get(id);
      if (!material || material.path === null) return failure("unavailable");
      if (typeof candidate !== "string" || !isAbsolute(candidate) || candidate.includes("\0")) return failure("unreadable");
      let resolved: string;
      let info: Stats;
      try {
        resolved = await realpath(candidate);
        info = await stat(resolved);
      } catch {
        return failure("unreadable");
      }
      if (!info.isFile()) return failure("not-a-file");
      const other = this.findByPath(resolved);
      if (other && other.id !== id) return failure("already-on-canvas");
      const name = displayName(candidate);
      const type = materialType(basename(resolved));
      const kind = type.kind === "image" ? "image" : "file";
      if (kind !== material.kind) return failure("kind-mismatch");
      material.path = resolved;
      material.name = name;
      material.mimeType = kind === "image" ? type.mimeType : "application/octet-stream";
      material.identity = { dev: Number(info.dev), ino: Number(info.ino) };
      this.watchers.track(id, resolved);
      await this.refreshLive(material, true);
      this.changed();
      return { ok: true };
    });
  }

  acceptMove(id: string): Promise<MaterialResult> {
    const movedTo = this.live.get(id)?.movedTo;
    return movedTo ? this.relink(id, movedTo) : Promise.resolve(failure("unavailable"));
  }

  async protocolResponse(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.protocol !== `${MATERIAL_SCHEME}:`) return textResponse("Unsupported protocol.", 400);
      const material = this.materials.get(decodeURIComponent(url.hostname));
      if (!material) return textResponse("Material is unavailable.", 404);
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (parts[0] === "live" && parts.length === 1) {
        if (material.path === null) {
          const latest = material.versions.at(-1);
          return latest
            ? await streamFile(request, this.blobs.pathOf(latest.sha256), latest.mimeType, RESPONSE_HEADERS)
            : textResponse("Material is unavailable.", 404);
        }
        const resolved = await realpath(material.path);
        const info = await stat(resolved);
        if (resolved !== material.path || !info.isFile()) return textResponse("Material is unavailable.", 404);
        return await streamFile(request, resolved, material.mimeType, RESPONSE_HEADERS);
      }
      return textResponse("Material is unavailable.", 404);
    } catch {
      return textResponse("Material is unavailable.", 404);
    }
  }

  async flush(strict = false): Promise<void> {
    await this.loading;
    await this.queue;
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.writeState(strict);
  }

  dispose(): Promise<void> {
    this.disposing ??= this.close();
    return this.disposing;
  }

  private async close(): Promise<void> {
    this.disposed = true;
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    await this.flush();
    this.watchers.close();
    if (this.writable && !this.options.persist()) await this.collect();
  }

  private scheduleRefresh(ids: readonly string[]): void {
    if (this.disposed) return;
    for (const id of ids) this.pendingRefresh.add(id);
    if (this.refreshTimer !== null) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      const pending = [...this.pendingRefresh];
      this.pendingRefresh.clear();
      void this.serial(async () => {
        let any = false;
        for (const id of pending) {
          const material = this.materials.get(id);
          if (material && await this.refreshLive(material)) any = true;
        }
        if (any) this.changed(false);
      });
    }, REFRESH_DELAY_MS);
    this.refreshTimer.unref?.();
  }

  private async refreshLive(material: StoredMaterial, forceRevision = false): Promise<boolean> {
    const previous = this.live.get(material.id);
    const next = material.path === null
      ? await this.blobs.has(material.versions.at(-1)?.sha256 ?? "")
        ? captureLive(material)
        : unavailable("unreadable", previous)
      : await inspectWorkingFile(material, previous);
    const changedContent = next.signature !== (previous?.signature ?? null);
    const revision = previous
      ? previous.revision + (changedContent || forceRevision ? 1 : 0)
      : Math.max(1, next.revision);
    const updated: LiveState = { ...next, revision };
    if (next.state === "ready" && material.path !== null && next.identity) material.identity = next.identity;
    this.live.set(material.id, updated);
    return !previous
      || previous.state !== updated.state
      || previous.revision !== updated.revision
      || previous.movedTo !== updated.movedTo;
  }

  private publicMaterial(material: StoredMaterial): CanvasMaterial {
    const live = this.live.get(material.id);
    return {
      id: material.id,
      kind: material.kind,
      name: material.name,
      mimeType: material.mimeType,
      position: { ...material.position },
      size: { ...material.size },
      location: material.path,
      state: live?.state ?? "unreadable",
      movedTo: live?.movedTo ?? null,
      liveRevision: live?.revision ?? 1,
      byteSize: live?.byteSize ?? null,
      modifiedAt: live?.modifiedAt ?? null,
      origin: material.origin ? structuredClone(material.origin) : null,
      versions: [],
      createdAt: material.createdAt
    };
  }

  private findByPath(path: string): StoredMaterial | undefined {
    for (const material of this.materials.values()) if (material.path === path) return material;
    return undefined;
  }

  private changed(persist = true): void {
    this.revision += 1;
    if (persist) this.schedulePersist();
    this.options.emit(this.snapshot());
  }

  private schedulePersist(): void {
    if (this.disposed || !this.writable) return;
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.writeState();
    }, PERSIST_DELAY_MS);
    this.persistTimer.unref?.();
  }

  private writeState(strict = false): Promise<void> {
    if (!this.writable) return strict ? Promise.reject(new Error("CanvasTTY materials state is not writable.")) : this.writeQueue;
    const state = this.options.persist()
      ? { version: MATERIAL_STATE_VERSION, materials: [...this.materials.values()] }
      : emptyMaterialState();
    const snapshot = JSON.stringify(state);
    const temporary = `${this.statePath}.tmp`;
    const write = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.statePath);
    });
    this.writeQueue = write.catch((error) => {
      console.warn("CanvasTTY materials could not be saved.", error);
    });
    return strict ? write : this.writeQueue;
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("CanvasTTY materials are closed."));
    const run = this.queue.catch(() => undefined).then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async availableBytes(): Promise<number> {
    return Math.max(0, (this.options.storageLimitBytes ?? MATERIAL_STORAGE_LIMIT_BYTES) - await this.blobs.usedBytes());
  }

  private async collect(): Promise<void> {
    try {
      await this.writeState(true);
    } catch {
      return;
    }
    await this.blobs.collect(this.disposed && !this.options.persist() ? new Set() : this.referencedHashes());
  }

  private referencedHashes(): Set<string> {
    const hashes = new Set<string>();
    for (const material of this.materials.values()) {
      for (const version of material.versions) hashes.add(version.sha256);
    }
    return hashes;
  }
}

interface InspectedLive extends Omit<LiveState, "revision"> {
  revision: number;
  identity?: { dev: number; ino: number };
}

async function inspectWorkingFile(material: StoredMaterial, previous: LiveState | undefined): Promise<InspectedLive> {
  const path = material.path!;
  try {
    const resolved = await realpath(path);
    const info = await stat(resolved);
    if (resolved !== path || !info.isFile()) return unavailable("unreadable", previous);
    return {
      state: "ready",
      signature: signatureOf(info),
      byteSize: Number(info.size),
      modifiedAt: Number(info.mtimeMs),
      revision: 1,
      movedTo: null,
      identity: { dev: Number(info.dev), ino: Number(info.ino) }
    };
  } catch (error) {
    if (!isMissing(error)) return unavailable("unreadable", previous);
    const movedTo = await renamedTo(material, previous);
    return { ...unavailable(movedTo ? "moved" : "missing", previous), movedTo };
  }
}

async function renamedTo(material: StoredMaterial, previous: LiveState | undefined): Promise<string | null> {
  if (!material.identity) return null;
  if (previous?.state === "moved" && previous.movedTo) {
    try {
      const info = await stat(previous.movedTo);
      if (info.isFile() && Number(info.ino) === material.identity.ino && Number(info.dev) === material.identity.dev) {
        return previous.movedTo;
      }
    } catch {
      return null;
    }
    return null;
  }
  if (previous && previous.state !== "ready") return null;
  return findRenamed(dirname(material.path!), material.identity);
}

function unavailable(state: MaterialState, previous: LiveState | undefined): InspectedLive {
  return {
    state,
    signature: null,
    byteSize: null,
    modifiedAt: previous?.modifiedAt ?? null,
    revision: 1,
    movedTo: null
  };
}

async function findRenamed(directory: string, identity: { dev: number; ino: number }): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return null;
  }
  for (const entry of entries.slice(0, RENAME_SCAN_LIMIT)) {
    const candidate = join(directory, entry);
    try {
      const info = await stat(candidate);
      if (info.isFile() && Number(info.ino) === identity.ino && Number(info.dev) === identity.dev) {
        return await realpath(candidate) === candidate ? candidate : null;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function readImageDimensions(path: string): Promise<Size | null> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let handle;
  try {
    handle = await open(path, flags);
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(IMAGE_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return imageDimensions(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function signatureOf(info: Stats): string {
  return `${info.size}:${info.mtimeMs}:${info.ino}`;
}

function displayName(path: string): string {
  return (basename(path) || "file").slice(0, MAX_NAME);
}

function finitePoint(value: unknown): Point {
  if (value && typeof value === "object") {
    const { x, y } = value as Partial<Point>;
    if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  }
  return { x: 0, y: 0 };
}

function isBounds(value: unknown): value is SessionBounds {
  if (!value || typeof value !== "object") return false;
  const { position, size } = value as Partial<SessionBounds>;
  return Boolean(position && size)
    && [position!.x, position!.y, size!.width, size!.height].every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function captureLive(material: StoredMaterial): InspectedLive {
  const latest = material.versions.at(-1);
  return {
    state: latest ? "ready" : "unreadable",
    signature: latest?.sha256 ?? null,
    byteSize: latest?.byteSize ?? null,
    modifiedAt: latest?.createdAt ?? null,
    revision: latest?.number ?? 1,
    movedTo: null
  };
}

function blobFailure(error: unknown): MaterialFailure {
  if (error instanceof MaterialBlobError) {
    if (error.code === "too-large") return "too-large";
    if (error.code === "quota") return "quota";
  }
  return "unreadable";
}

function failure(reason: MaterialFailure): { ok: false; reason: MaterialFailure } {
  return { ok: false, reason };
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"));
}
