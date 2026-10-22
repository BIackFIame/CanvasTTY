import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Account homes one plugin may name (a pool of subscription accounts); unknown or removed homes free a place. */
export const MAX_PLUGIN_HOMES = 32;
const MAX_HOME_LENGTH = 4_096;
export const UNKNOWN_HOME = "The home is not an account home in this plugin's data folder.";

/** A folder path without trailing separators (`/a/b/` names the same folder as `/a/b`). */
function withoutTrailingSeparator(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  return trimmed === "" || /^[A-Za-z]:$/u.test(trimmed) ? path : trimmed;
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
  const rest = relative(root, home);
  if (rest === "" || rest.startsWith("..") || isAbsolute(rest)) throw new Error(UNKNOWN_HOME);
  try {
    const rootInfo = lstatSync(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("not a real folder");
    let path = root;
    let canonical = realpathSync.native(root);
    for (const segment of rest.split(sep)) {
      path = join(path, segment);
      canonical = join(canonical, segment);
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(path) !== canonical) throw new Error("not a real folder");
    }
    return { home, canonical };
  } catch {
    throw new Error(UNKNOWN_HOME);
  }
}
