import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import { canonicalStringify } from "../../agent-browser/tool-catalog.mjs";

// The file primitives behind every temporary change CanvasTTY makes to another
// program's configuration (Hermes config.yaml, Kimi mcp.json/config.toml, the
// lifecycle hook overlays): a cross-process lock, compare-and-swap writes,
// atomic replacement, backups and their hashes. The recovery journals built on
// them stay provider-specific; their on-disk format is unchanged.

export const CONFIG_FILE_MODE = 0o600;
const CONFIG_DIRECTORY_MODE = 0o700;
const MAX_LOCK_FILE_BYTES = 4 * 1024;
const MAX_STALE_LOCK_RETRIES = 3;

/** A held configuration lock: its open descriptor and the identity it was created with. */
export interface ConfigurationLock {
  descriptor: number;
  nonce: string;
  device: number;
  inode: number;
}

export interface ConfigurationLockHooks {
  /** Test seam: runs after a dead owner's lock was read and before it is removed. */
  beforeReclaim?(path: string, nonce: string): void;
}

interface ConfigurationLockFile {
  version: 1;
  pid: number;
  createdAt: number;
  nonce: string;
}

interface ExistingConfigurationLock {
  value: ConfigurationLockFile;
  raw: string;
  device: number;
  inode: number;
}

/**
 * Takes the lock file at `path` (created exclusively, owner pid and a nonce
 * inside). A lock whose owner is dead is removed only after it was re-read and
 * found byte for byte the same file; a live owner fails at once. `label` names
 * the program in errors ("Hermes", "Kimi").
 */
export function acquireConfigurationLock(path: string, label: string, hooks?: ConfigurationLockHooks): ConfigurationLock {
  for (let attempt = 0; attempt < MAX_STALE_LOCK_RETRIES; attempt += 1) {
    try {
      return createLock(path);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      const existing = readExistingLock(path, label);
      if (lockOwnerState(existing.value.pid, label) === "live") {
        throw new Error(`Another CanvasTTY process is updating ${label} configuration.`);
      }
      hooks?.beforeReclaim?.(path, existing.value.nonce);
      if (!unlinkDeadLock(path, existing, label)) continue;
    }
  }
  throw new Error(`CanvasTTY could not acquire the ${label} configuration lock safely.`);
}

/** Releases a lock this process holds; a lock that was replaced meanwhile is left in place and throws. */
export function releaseConfigurationLock(path: string, lock: ConfigurationLock, label: string): void {
  let descriptorClosed = false;
  try {
    assertLockOwnership(path, lock, label);
    closeSync(lock.descriptor);
    descriptorClosed = true;
    // Verify again immediately before unlinking so a replaced lock is retained.
    assertLockOwnership(path, lock, label);
    unlinkSync(path);
  } finally {
    if (!descriptorClosed) closeSync(lock.descriptor);
  }
}

function createLock(path: string): ConfigurationLock {
  const descriptor = openSync(path, "wx", CONFIG_FILE_MODE);
  const identity = fstatSync(descriptor);
  const nonce = randomBytes(16).toString("hex");
  try {
    writeFileSync(descriptor, `${canonicalStringify({
      version: 1,
      pid: process.pid,
      createdAt: Date.now(),
      nonce
    })}\n`, "utf8");
    fsyncSync(descriptor);
    return { descriptor, nonce, device: identity.dev, inode: identity.ino };
  } catch (error) {
    closeSync(descriptor);
    // A failed write can leave an owned but unverifiable lock. Retaining it is
    // safer than unlinking a path that may have been replaced concurrently.
    throw error;
  }
}

function readExistingLock(path: string, label: string): ExistingConfigurationLock {
  let descriptor: number | null = null;
  try {
    const pathIdentity = lstatSync(path);
    if (!pathIdentity.isFile() || pathIdentity.isSymbolicLink() || pathIdentity.size > MAX_LOCK_FILE_BYTES) {
      throw invalidLockError(label);
    }
    descriptor = openSync(path, "r");
    const descriptorIdentity = fstatSync(descriptor);
    if (
      !descriptorIdentity.isFile()
      || descriptorIdentity.size > MAX_LOCK_FILE_BYTES
      || descriptorIdentity.dev !== pathIdentity.dev
      || descriptorIdentity.ino !== pathIdentity.ino
    ) throw invalidLockError(label);
    const raw = readFileSync(descriptor, "utf8");
    const finalIdentity = lstatSync(path);
    if (
      !finalIdentity.isFile()
      || finalIdentity.isSymbolicLink()
      || finalIdentity.dev !== descriptorIdentity.dev
      || finalIdentity.ino !== descriptorIdentity.ino
    ) throw changedLockError(label);
    return {
      value: parseLockFile(raw, label),
      raw,
      device: descriptorIdentity.dev,
      inode: descriptorIdentity.ino
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) throw changedLockError(label);
    throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function parseLockFile(raw: string, label: string): ConfigurationLockFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidLockError(label);
  }
  if (!isRecord(value)) throw invalidLockError(label);
  if (
    Reflect.ownKeys(value).length !== 4
    || value.version !== 1
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) <= 0
    || typeof value.createdAt !== "number"
    || !Number.isFinite(value.createdAt)
    || typeof value.nonce !== "string"
    || !/^[0-9a-f]{32}$/iu.test(value.nonce)
  ) throw invalidLockError(label);
  return value as unknown as ConfigurationLockFile;
}

function lockOwnerState(pid: number, label: string): "live" | "dead" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    if (hasErrorCode(error, "EPERM")) return "live";
    if (hasErrorCode(error, "ESRCH")) return "dead";
    throw new Error(`CanvasTTY ${label} configuration lock owner status is ambiguous.`);
  }
}

function unlinkDeadLock(path: string, existing: ExistingConfigurationLock, label: string): boolean {
  try {
    const current = readExistingLock(path, label);
    if (
      current.device !== existing.device
      || current.inode !== existing.inode
      || current.raw !== existing.raw
    ) throw changedLockError(label);
    // The path is reopened, read and identity-checked synchronously immediately
    // before unlink. A detected replacement is always retained.
    unlinkSync(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function assertLockOwnership(path: string, lock: ConfigurationLock, label: string): void {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`CanvasTTY ${label} configuration lock ownership cannot be verified.`);
  }
  const identity = statSync(path);
  if (
    !isRecord(value)
    || value.version !== 1
    || value.nonce !== lock.nonce
    || identity.dev !== lock.device
    || identity.ino !== lock.inode
  ) throw new Error(`CanvasTTY ${label} configuration lock ownership changed before release.`);
}

function invalidLockError(label: string): Error {
  return new Error(`CanvasTTY ${label} configuration lock is invalid or foreign.`);
}

function changedLockError(label: string): Error {
  return new Error(`CanvasTTY ${label} configuration lock changed during stale recovery.`);
}

/** Replaces the file only if it still holds exactly `expected` (null: absent). */
export function writeExactWithCas(path: string, expected: string | null, next: string, label: string): void {
  if (readOptional(path) !== expected) throw new Error(`${label} configuration changed concurrently: ${path}`);
  atomicWrite(path, next, existingMode(path));
}

/** Puts the backed-up original back (or removes the file when there was none), after checking the backup's hash. */
export function restoreFromBackup(path: string, originalHash: string | null, backupPath: string, failure: string): void {
  if (originalHash === null) {
    unlinkIfExists(path);
    return;
  }
  const backupContent = readOptional(backupPath);
  if (backupContent === null || hashText(backupContent) !== originalHash) throw new Error(failure);
  atomicWrite(path, backupContent, existingMode(path));
}

export function backupFile(source: string, destination: string): void {
  copyFileSync(source, destination);
  chmodSync(destination, CONFIG_FILE_MODE);
}

/** Creates the directory (and missing parents) for the current user only; an existing one keeps its mode. */
export function ensurePrivateDirectory(path: string): void {
  const existed = existsSync(path);
  mkdirSync(path, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
  if (!existed) chmodSync(path, CONFIG_DIRECTORY_MODE);
}

/** Writes through a new temporary file and a rename, so readers see the old or the new content, never a mix. */
export function atomicWrite(path: string, content: string, mode = CONFIG_FILE_MODE): void {
  ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.canvastty-${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, content, { encoding: "utf8", mode, flag: "wx" });
  chmodSync(temporary, mode);
  try {
    renameSync(temporary, path);
    chmodSync(path, mode);
  } catch (error) {
    unlinkIfExists(temporary);
    throw error;
  }
}

/** The file's permission bits, or the private default for a file that does not exist. */
export function existingMode(path: string): number {
  try {
    return statSync(path).mode & 0o777;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return CONFIG_FILE_MODE;
    throw error;
  }
}

export function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

export function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
}

export function removeEmptyDirectory(path: string): void {
  try {
    rmdirSync(path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTEMPTY")) throw error;
  }
}

export function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashCanonical(value: unknown): string {
  return hashText(canonicalStringify(value));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
