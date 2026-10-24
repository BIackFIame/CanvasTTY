import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Account homes one plugin may name (a pool of subscription accounts); unknown or removed homes free a place. */
export const MAX_PLUGIN_HOMES = 32;
const MAX_HOME_LENGTH = 4_096;
export const UNKNOWN_HOME = "The home is not an account home in this plugin's data folder.";

/** A folder path without trailing separators (`/a/b/` names the same folder as `/a/b`); a root stays as it is. */
export function withoutTrailingSeparator(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  return trimmed === "" || /^[A-Za-z]:$/u.test(trimmed) ? path : trimmed;
}

/** The path segments of `path` strictly below `root`, or null when it is not strictly inside. */
export function segmentsBelow(root: string, path: string): string[] | null {
  const rest = relative(root, path);
  if (rest === "" || rest.startsWith("..") || isAbsolute(rest)) return null;
  return rest.split(sep);
}

/**
 * Throws unless `root` and every folder below it down `segments` is a real directory, not a symbolic link, resolving to
 * `canonicalRoot` joined with the same segments (by default the root's own real path). The account-home checks of
 * plugin services, launch overlays and isolation all use this one walk.
 */
export function assertRealFolders(root: string, segments: readonly string[], canonicalRoot = realpathSync.native(root)): void {
  let path = root;
  let canonical = canonicalRoot;
  for (const segment of ["", ...segments]) {
    if (segment) {
      path = join(path, segment);
      canonical = join(canonical, segment);
    }
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(path) !== canonical) throw new Error("not a real folder");
  }
}

/**
 * An account home a service may name: an exact absolute path (no `..`, no relative part) strictly inside `dataDir`
 * (the host's record of the calling plugin's data folder, never a value from the plugin), where the data folder and
 * every folder below it down to the home is a real directory, not a symbolic link, and resolves to the same place.
 * Returns the home as given and its canonical path; anything else throws one generic refusal, so the answer reveals
 * nothing about paths.
 */
export function validatePluginHome(dataDir: string, candidate: unknown): { home: string; canonical: string } {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > MAX_HOME_LENGTH || candidate.includes("\u0000")) {
    throw new Error(UNKNOWN_HOME);
  }
  const home = withoutTrailingSeparator(candidate);
  if (!isAbsolute(dataDir) || !isAbsolute(home) || resolve(home) !== home) throw new Error(UNKNOWN_HOME);
  const root = resolve(dataDir);
  const segments = segmentsBelow(root, home);
  if (!segments) throw new Error(UNKNOWN_HOME);
  try {
    const canonical = realpathSync.native(root);
    assertRealFolders(root, segments, canonical);
    return { home, canonical: join(canonical, ...segments) };
  } catch {
    throw new Error(UNKNOWN_HOME);
  }
}
