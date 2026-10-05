import { isAbsolute } from "node:path";
import type {
  MaterialKind,
  MaterialOrigin,
  MaterialVersionReason,
  Point,
  Size
} from "../../../shared/contracts.ts";
import { clampSize, MATERIAL_LIMIT, MATERIAL_VERSION_LIMIT } from "../../../shared/materials.ts";

export const MATERIAL_STATE_VERSION = 1;

const KINDS: ReadonlySet<MaterialKind> = new Set(["image", "text", "video", "audio", "pdf", "file"]);
const VERSION_REASONS: ReadonlySet<MaterialVersionReason> = new Set(["pinned", "remark", "handoff", "result", "capture"]);
const ID_PATTERN = /^[a-f0-9-]{36}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_NAME = 255;
const MAX_URL = 2_048;
const MAX_TITLE = 300;
const MIME_PATTERN = /^[a-z]+\/[a-z0-9.+-]+$/;

export interface StoredVersion {
  id: string;
  number: number;
  sha256: string;
  byteSize: number;
  mimeType: string;
  createdAt: number;
  reason: MaterialVersionReason;
}

export interface StoredFileIdentity {
  dev: number;
  ino: number;
}

export interface StoredMaterial {
  id: string;
  kind: MaterialKind;
  name: string;
  mimeType: string;
  position: Point;
  size: Size;
  path: string | null;
  identity: StoredFileIdentity | null;
  origin: MaterialOrigin | null;
  createdAt: number;
  versions: StoredVersion[];
  nextVersion: number;
}

export interface StoredMaterialState {
  version: typeof MATERIAL_STATE_VERSION;
  materials: StoredMaterial[];
}

export function emptyMaterialState(): StoredMaterialState {
  return { version: MATERIAL_STATE_VERSION, materials: [] };
}

export function restoreMaterialState(candidate: unknown): StoredMaterialState {
  if (!isRecord(candidate) || candidate.version !== MATERIAL_STATE_VERSION || !Array.isArray(candidate.materials)) {
    throw new Error("Unsupported materials state.");
  }
  const materials = candidate.materials;
  const state = normalizeMaterialState(candidate);
  if (state.materials.length !== materials.length || state.materials.some((material, index) => {
    const stored = materials[index];
    return !isRecord(stored) || !Array.isArray(stored.versions) || stored.versions.length !== material.versions.length;
  })) {
    throw new Error("Invalid materials state.");
  }
  return state;
}

export function normalizeMaterialState(candidate: unknown): StoredMaterialState {
  const state = emptyMaterialState();
  if (!isRecord(candidate) || candidate.version !== MATERIAL_STATE_VERSION || !Array.isArray(candidate.materials)) {
    return state;
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const value of candidate.materials) {
    if (state.materials.length >= MATERIAL_LIMIT) break;
    const material = normalizeMaterial(value);
    if (!material || ids.has(material.id) || (material.path !== null && paths.has(material.path))) continue;
    ids.add(material.id);
    if (material.path !== null) paths.add(material.path);
    state.materials.push(material);
  }
  return state;
}

function normalizeMaterial(value: unknown): StoredMaterial | null {
  if (!isRecord(value)) return null;
  const { id, kind, name, mimeType, position, size, path, identity, origin, createdAt, versions, nextVersion } = value;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  if (typeof kind !== "string" || !KINDS.has(kind as MaterialKind)) return null;
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME) return null;
  if (typeof mimeType !== "string" || !MIME_PATTERN.test(mimeType)) return null;
  if (!isPoint(position) || !isSize(size)) return null;
  if (path !== null && (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))) return null;
  if (!isFiniteNumber(createdAt)) return null;
  const storedVersions = normalizeVersions(versions);
  if (path === null && storedVersions.length === 0) return null;
  const highest = storedVersions.reduce((max, version) => Math.max(max, version.number), 0);
  return {
    id,
    kind: kind as MaterialKind,
    name,
    mimeType,
    position: { x: position.x, y: position.y },
    size: clampSize(size),
    path,
    identity: normalizeIdentity(identity),
    origin: normalizeOrigin(origin),
    createdAt,
    versions: storedVersions,
    nextVersion: Math.max(highest + 1, Number.isInteger(nextVersion) ? nextVersion as number : 1)
  };
}

function normalizeVersions(value: unknown): StoredVersion[] {
  if (!Array.isArray(value)) return [];
  const versions: StoredVersion[] = [];
  const ids = new Set<string>();
  const numbers = new Set<number>();
  for (const candidate of value) {
    if (versions.length >= MATERIAL_VERSION_LIMIT) break;
    if (!isRecord(candidate)) continue;
    const { id, number, sha256, byteSize, mimeType, createdAt, reason } = candidate;
    if (typeof id !== "string" || !ID_PATTERN.test(id) || ids.has(id)) continue;
    if (!Number.isInteger(number) || (number as number) < 1 || numbers.has(number as number)) continue;
    if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) continue;
    if (!Number.isInteger(byteSize) || (byteSize as number) < 0) continue;
    if (typeof mimeType !== "string" || !MIME_PATTERN.test(mimeType)) continue;
    if (!isFiniteNumber(createdAt)) continue;
    if (typeof reason !== "string" || !VERSION_REASONS.has(reason as MaterialVersionReason)) continue;
    ids.add(id);
    numbers.add(number as number);
    versions.push({
      id,
      number: number as number,
      sha256,
      byteSize: byteSize as number,
      mimeType,
      createdAt,
      reason: reason as MaterialVersionReason
    });
  }
  return versions.sort((left, right) => left.number - right.number);
}

function normalizeIdentity(value: unknown): StoredFileIdentity | null {
  if (!isRecord(value) || !isFiniteNumber(value.dev) || !isFiniteNumber(value.ino)) return null;
  return { dev: value.dev, ino: value.ino };
}

export function normalizeOrigin(value: unknown): MaterialOrigin | null {
  if (!isRecord(value)) return null;
  if (value.kind === "clipboard") return { kind: "clipboard" };
  if (value.kind === "watch" && typeof value.folderName === "string" && value.folderName.length <= MAX_NAME) {
    return { kind: "watch", folderName: value.folderName };
  }
  if (value.kind === "browser" && typeof value.url === "string" && value.url.length <= MAX_URL
    && typeof value.title === "string" && isSize(value.viewport)) {
    return {
      kind: "browser",
      url: value.url,
      title: value.title.slice(0, MAX_TITLE),
      viewport: { width: value.viewport.width, height: value.viewport.height }
    };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPoint(value: unknown): value is Point {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function isSize(value: unknown): value is Size {
  return isRecord(value) && isFiniteNumber(value.width) && isFiniteNumber(value.height)
    && value.width > 0 && value.height > 0;
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
}
