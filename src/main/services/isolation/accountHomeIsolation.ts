import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProviderId } from "../../../shared/contracts.ts";
import { PLUGIN_DATA_FOLDER, providerHomeVariables } from "./isolationPaths.ts";

/** The path segments of `path` below `root`, or null when it is not strictly inside. */
function segmentsBelow(root: string, path: string): string[] | null {
  const rest = relative(root, path);
  if (rest === "" || rest.startsWith("..") || isAbsolute(rest)) return null;
  return rest.split(sep);
}

/**
 * The CLI home a launch contributor handed this launch inside its own data folder: the value of the provider's own
 * home variable (CODEX_HOME, CLAUDE_CONFIG_DIR, GROK_HOME, …) when it is an exact absolute path strictly below the
 * contributor's data folder. `dataDir` comes from the host's contributor record, never from the plugin's answer, so a
 * plugin can only point at a folder of its own data, and only the one the CLI is actually started with.
 */
export function contributedAccountHome(
  provider: ProviderId,
  dataDir: string | undefined,
  key: string,
  value: string
): string | undefined {
  if (!dataDir || !isAbsolute(dataDir) || !providerHomeVariables(provider).includes(key)) return undefined;
  if (!isAbsolute(value) || resolve(value) !== value) return undefined;
  return segmentsBelow(resolve(dataDir), value) ? value : undefined;
}

/**
 * Checks a contributed account home again when the isolation layer is built. Nothing is reopened when the launch no
 * longer starts the CLI with it (an environment replaced the variable). Otherwise it must be a real folder strictly
 * inside one plugin's data folder, reached without a symbolic link at any step from `<userData>/plugin-data`: the
 * path to reopen is returned, and anything else throws (the launch is refused).
 */
export function validateAccountHome(
  userDataPath: string,
  provider: ProviderId,
  candidate: string,
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  if (!providerHomeVariables(provider).some((name) => env[name] === candidate)) return undefined;
  if (!isAbsolute(candidate) || resolve(candidate) !== candidate) {
    throw new Error("The selected account home must be an exact absolute folder.");
  }
  const pluginData = join(resolve(userDataPath), PLUGIN_DATA_FOLDER);
  const segments = segmentsBelow(pluginData, candidate);
  // <pluginId>/<at least one folder>: never all of plugin data, never a whole plugin's data folder.
  if (!segments || segments.length < 2) {
    throw new Error("The selected account home must be a folder inside one plugin's data.");
  }
  try {
    const canonicalRoot = join(realpathSync.native(resolve(userDataPath)), PLUGIN_DATA_FOLDER);
    let path = pluginData;
    let canonical = canonicalRoot;
    for (const segment of ["", ...segments]) {
      if (segment) {
        path = join(path, segment);
        canonical = join(canonical, segment);
      }
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(path) !== canonical) throw new Error("not a real folder");
    }
  } catch {
    throw new Error("The selected account home is missing or crosses a symbolic link.");
  }
  return candidate;
}
