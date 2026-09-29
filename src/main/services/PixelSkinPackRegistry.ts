import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_PIXEL_SKIN_APERTURES } from "../../shared/contracts.ts";
import type {
  PixelSkinAperture,
  PixelSkinApertures,
  PixelSkinPackInstallRequest,
  PixelSkinPackSummary,
  PixelSkinSlot,
  PixelTerminalBorderSkinId
} from "../../shared/contracts";

export const PIXEL_SKIN_SLOTS = [
  "minimal_idle", "minimal_working", "minimal_completed",
  "detailed_idle", "detailed_working", "detailed_completed",
  "master_idle", "master_working", "master_completed", "background"
] as const satisfies readonly PixelSkinSlot[];

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_PIXEL_SKIN_ARCHIVE_BYTES = 150 * 1024 * 1024;
const MAX_PACK_BYTES = MAX_PIXEL_SKIN_ARCHIVE_BYTES;
const MAX_PACKS = 100;
const MAX_ARCHIVE_ENTRIES = 100;
const ID_PATTERN = /^pixel:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const require = createRequire(import.meta.url);
const unzipper = require("unzipper") as {
  Open: { buffer(data: Buffer): Promise<{ files: Array<{
    path: string;
    type: string;
    uncompressedSize: number;
    stream(): AsyncIterable<Buffer>;
  }> }> };
};

function pngChunkCrc(bytes: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) crc = CRC_TABLE[(crc ^ bytes[offset]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface PackManifest {
  schemaVersion: 1;
  id: PixelTerminalBorderSkinId;
  name: string;
  width: number;
  height: number;
  aperture: PixelSkinAperture;
  apertures: PixelSkinApertures;
}

const DEFAULT_APERTURE: PixelSkinAperture = { left: 8, right: 8, top: 17, bottom: 13 };

function validApertures(value: unknown, fallback: PixelSkinAperture): PixelSkinApertures {
  if (value === undefined) return { minimal: fallback, detailed: fallback, master: fallback };
  if (!value || typeof value !== "object") throw new Error("Terminal apertures are invalid.");
  const apertures = value as Record<string, unknown>;
  if (Object.keys(apertures).length !== 3 || ["minimal", "detailed", "master"].some((level) => !(level in apertures))) {
    throw new Error("Terminal apertures are invalid.");
  }
  return {
    minimal: validAperture(apertures.minimal),
    detailed: validAperture(apertures.detailed),
    master: validAperture(apertures.master)
  };
}

function validAperture(value: unknown): PixelSkinAperture {
  if (value === undefined) return DEFAULT_APERTURE;
  if (!value || typeof value !== "object") throw new Error("Terminal aperture is invalid.");
  const aperture = value as Record<string, unknown>;
  for (const edge of ["left", "right", "top", "bottom"] as const) {
    if (typeof aperture[edge] !== "number" || !Number.isFinite(aperture[edge])
      || aperture[edge] < 2 || aperture[edge] > 35) throw new Error("Terminal aperture is invalid.");
  }
  if ((aperture.left as number) + (aperture.right as number) > 55
    || (aperture.top as number) + (aperture.bottom as number) > 55) {
    throw new Error("Terminal aperture leaves too little room for output.");
  }
  return aperture as unknown as PixelSkinAperture;
}

export function isPixelTerminalBorderSkinId(value: unknown): value is PixelTerminalBorderSkinId {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function isPixelSkinSlot(value: unknown): value is PixelSkinSlot {
  return typeof value === "string" && (PIXEL_SKIN_SLOTS as readonly string[]).includes(value);
}

function parsePng(data: Uint8Array): { width: number; height: number } {
  if (!(data instanceof Uint8Array) || data.byteLength < 57 || data.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("PNG file size is invalid.");
  }
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Only PNG images are accepted.");
  let offset = 8;
  let width = 0;
  let height = 0;
  let hasImageData = false;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > MAX_IMAGE_BYTES || end > bytes.length) throw new Error("PNG chunks are malformed.");
    if (pngChunkCrc(bytes, offset + 4, offset + 8 + length) !== bytes.readUInt32BE(offset + 8 + length)) {
      throw new Error("PNG checksum is invalid.");
    }
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (offset === 8) {
      if (kind !== "IHDR" || length !== 13) throw new Error("PNG header is malformed.");
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      if (width < 320 || height < 200 || width > 4096 || height > 4096) {
        throw new Error("PNG dimensions must be between 320x200 and 4096x4096.");
      }
    }
    if (kind === "IDAT") hasImageData = true;
    if (kind === "IEND") {
      if (length !== 0 || end !== bytes.length) throw new Error("PNG ending is malformed.");
      ended = true;
      break;
    }
    offset = end;
  }
  if (!hasImageData || !ended) throw new Error("PNG image data is incomplete.");
  return { width, height };
}

function validName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Theme name is required.");
  const name = value.trim();
  if (!name || name.length > 64 || /[\x00-\x1f\x7f]/.test(name)) throw new Error("Theme name is invalid.");
  return name;
}

export class PixelSkinPackRegistry {
  private readonly root: string;
  private readonly packs = new Map<PixelTerminalBorderSkinId, PackManifest>();
  private readonly listeners = new Set<() => void>();

  constructor(userDataPath: string) {
    this.root = join(userDataPath, "pixel-skins");
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const id = `pixel:${entry.name}`;
      if (!isPixelTerminalBorderSkinId(id)) continue;
      try {
        const path = join(this.root, entry.name);
        const manifestPath = join(path, "manifest.json");
        if (!(await lstat(manifestPath)).isFile()) continue;
        const raw = await readFile(manifestPath);
        if (raw.length > 4096) continue;
        const manifest = JSON.parse(raw.toString("utf8")) as Partial<PackManifest>;
        if (manifest.schemaVersion !== 1 || manifest.id !== id) continue;
        const name = validName(manifest.name);
        const aperture = validAperture(manifest.aperture);
        const apertures = validApertures(manifest.apertures, aperture);
        if (!Number.isInteger(manifest.width) || !Number.isInteger(manifest.height)) continue;
        const files = await Promise.all(PIXEL_SKIN_SLOTS.map(async (slot) => {
          const stat = await lstat(join(path, `${slot}.png`));
          return stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_IMAGE_BYTES;
        }));
        if (files.every(Boolean)) this.packs.set(id, {
          schemaVersion: 1, id, name, aperture, apertures,
          width: manifest.width as number, height: manifest.height as number
        });
      } catch {
        // A malformed user pack is unavailable; it must not prevent app startup.
      }
    }
  }

  list(): PixelSkinPackSummary[] {
    return [...this.packs.values()].map(({ id, name, aperture, apertures }) => ({ id, name, aperture, apertures }));
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async installZip(archive: Uint8Array, name: string, apertures?: PixelSkinApertures): Promise<PixelSkinPackSummary> {
    if (!(archive instanceof Uint8Array) || archive.byteLength < 22 || archive.byteLength > MAX_PACK_BYTES) {
      throw new Error("Theme ZIP file size is invalid.");
    }
    const directory = await unzipper.Open.buffer(Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength));
    if (directory.files.length > MAX_ARCHIVE_ENTRIES) throw new Error("Theme ZIP has too many entries.");
    const entries = new Map<PixelSkinSlot, typeof directory.files[number]>();
    for (const entry of directory.files) {
      if (entry.type !== "File") continue;
      const filename = entry.path.replace(/\\/g, "/").split("/").at(-1) ?? "";
      if (!filename.endsWith(".png")) continue;
      const slot = filename.slice(0, -4);
      if (!isPixelSkinSlot(slot)) continue;
      if (entries.has(slot)) throw new Error(`Theme ZIP contains duplicate ${filename}.`);
      if (entry.uncompressedSize < 1 || entry.uncompressedSize > MAX_IMAGE_BYTES) {
        throw new Error(`${filename} exceeds the PNG size limit.`);
      }
      entries.set(slot, entry);
    }
    if (entries.size !== PIXEL_SKIN_SLOTS.length) {
      throw new Error("Theme ZIP needs minimal/detailed/master idle, working, completed PNGs and background.png.");
    }
    const files = {} as Record<PixelSkinSlot, Uint8Array>;
    let total = 0;
    for (const slot of PIXEL_SKIN_SLOTS) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of entries.get(slot)!.stream()) {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES || total + size > MAX_PACK_BYTES) throw new Error(`${slot}.png exceeds the PNG size limit.`);
        chunks.push(chunk);
      }
      total += size;
      files[slot] = Buffer.concat(chunks, size);
    }
    return this.install({ name, apertures, files });
  }

  async install(request: PixelSkinPackInstallRequest): Promise<PixelSkinPackSummary> {
    if (!request || typeof request !== "object" || !request.files || typeof request.files !== "object") {
      throw new Error("Theme package is invalid.");
    }
    if (this.packs.size >= MAX_PACKS) throw new Error("Too many pixel themes are installed.");
    const name = validName(request.name);
    const aperture = validAperture(request.aperture);
    const apertures = request.apertures
      ? validApertures(request.apertures, aperture)
      : request.aperture
        ? validApertures(undefined, aperture)
        : validApertures(DEFAULT_PIXEL_SKIN_APERTURES, aperture);
    const files = request.files as Record<string, unknown>;
    if (Object.keys(files).length !== PIXEL_SKIN_SLOTS.length
      || Object.keys(files).some((slot) => !isPixelSkinSlot(slot))) {
      throw new Error("A pixel theme needs exactly nine terminal PNGs and one background PNG.");
    }
    let width = 0;
    let height = 0;
    let total = 0;
    for (const slot of PIXEL_SKIN_SLOTS) {
      const data = files[slot];
      if (!(data instanceof Uint8Array)) throw new Error(`${slot} must be a PNG image.`);
      total += data.byteLength;
      if (total > MAX_PACK_BYTES) throw new Error("Theme package is too large.");
      const dimensions = parsePng(data);
      if (slot !== "background") {
        if (!width) ({ width, height } = dimensions);
        else if (width !== dimensions.width || height !== dimensions.height) {
          throw new Error("All nine terminal frames must have the same dimensions.");
        }
      }
    }
    const id = `pixel:${randomUUID()}` as PixelTerminalBorderSkinId;
    const manifest: PackManifest = { schemaVersion: 1, id, name, width, height, aperture, apertures };
    await mkdir(this.root, { recursive: true });
    const temporary = await mkdtemp(join(this.root, ".install-"));
    try {
      for (const slot of PIXEL_SKIN_SLOTS) {
        await writeFile(join(temporary, `${slot}.png`), files[slot] as Uint8Array, { flag: "wx" });
      }
      await writeFile(join(temporary, "manifest.json"), JSON.stringify(manifest), { flag: "wx" });
      await rename(temporary, join(this.root, id.slice("pixel:".length)));
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
    this.packs.set(id, manifest);
    for (const listener of this.listeners) listener();
    return { id, name, aperture, apertures };
  }

  async readAsset(id: PixelTerminalBorderSkinId, slot: PixelSkinSlot): Promise<Uint8Array | null> {
    if (!isPixelTerminalBorderSkinId(id) || !isPixelSkinSlot(slot) || !this.packs.has(id)) return null;
    const path = join(this.root, id.slice("pixel:".length), `${slot}.png`);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_IMAGE_BYTES) return null;
      return await readFile(path);
    } catch {
      return null;
    }
  }
}
