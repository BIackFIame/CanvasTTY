import { constants as fsConstants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** Platforms where `/dev/fd/<n>` names a file this process already opened as descriptor <n>. */
const DEV_FD = process.platform === "darwin" || process.platform === "linux";

/**
 * Opens a regular file for reading. With `noFollow` the last step may not be a symbolic link: it is checked with lstat,
 * opened with O_NOFOLLOW where the platform has it, and the open file must be the one checked (same device and inode),
 * so a path swapped in between is refused. Errors carry ENOENT for anything that is not a plain file. Account-home
 * credential reads (LimitsService) and OpenCode usage reads (opencodeUsage) both open through this.
 */
export async function openPlainFile(
  path: string,
  noFollow: boolean,
  /** Tests only: runs between the check and the open. */
  afterCheck?: () => Promise<void>
): Promise<{ handle: FileHandle; dev: number; ino: number }> {
  const notPlain = (): Error => Object.assign(new Error("not a plain file"), { code: "ENOENT" });
  const checked = noFollow ? await lstat(path) : null;
  if (checked && !checked.isFile()) throw notPlain();
  await afterCheck?.();
  const handle = await open(path, fsConstants.O_RDONLY | (noFollow ? fsConstants.O_NOFOLLOW ?? 0 : 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || (checked && (checked.dev !== info.dev || checked.ino !== info.ino))) throw notPlain();
    return { handle, dev: info.dev, ino: info.ino };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * A read-only, `immutable` SQLite URI for a database without WAL frames: through `/dev/fd/<n>` (the descriptor
 * openPlainFile returned, so the read is bound to the file that was checked; no lock, no side file) where the
 * platform has it, otherwise by path.
 */
export function immutableSqliteTarget(handle: FileHandle, database: string): string {
  return DEV_FD ? `file:/dev/fd/${handle.fd}?mode=ro&immutable=1` : `${pathToFileURL(database).href}?mode=ro&immutable=1`;
}
