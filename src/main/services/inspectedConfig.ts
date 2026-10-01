import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const MAX_INSPECTED_CONFIG_BYTES = 1024 * 1024;

export type InspectedFile =
  | { kind: "text"; text: string }
  | { kind: "absent" }
  | { kind: "uninspectable" };

export type OpenCodeConfigSource =
  | { kind: "json"; path: string }
  | { kind: "agentDirectory"; directory: string };

/** Enumerate OpenCode's local file sources once so inspection and launch protection share the same paths and order. */
export function openCodeConfigPaths(
  environment: Readonly<Record<string, string | undefined>>,
  cwd?: string
): { jsonFiles: string[]; agentDirectories: string[]; orderedSources: OpenCodeConfigSource[] } {
  const base = resolve(cwd ?? process.cwd());
  const home = environment.HOME ?? "";
  const configHome = environment.XDG_CONFIG_HOME || (home ? join(home, ".config") : "");
  const globalDir = configHome ? resolve(base, configHome, "opencode") : "";
  const includeProject = !isTruthyFlag(environment.OPENCODE_DISABLE_PROJECT_CONFIG);
  const projectDirsRootToCwd: string[] = [];
  if (cwd && includeProject) {
    let current = resolve(cwd);
    for (let index = 0; index < 64; index++) {
      projectDirsRootToCwd.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    projectDirsRootToCwd.reverse();
  }
  const projectConfigDirsCwdToRoot = [...projectDirsRootToCwd].reverse().map((dir) => join(dir, ".opencode"));
  const homeConfigDir = home ? resolve(base, home, ".opencode") : "";
  const customConfigDir = environment.OPENCODE_CONFIG_DIR ? resolve(base, environment.OPENCODE_CONFIG_DIR) : "";
  const agentDirectories = uniquePaths([
    ...(globalDir ? [globalDir] : []),
    ...projectConfigDirsCwdToRoot,
    ...(homeConfigDir ? [homeConfigDir] : []),
    ...(customConfigDir ? [customConfigDir] : [])
  ]);
  const orderedSources: OpenCodeConfigSource[] = [];
  const json = (path: string): void => { orderedSources.push({ kind: "json", path: resolve(path) }); };
  if (globalDir) {
    for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) json(join(globalDir, name));
  }
  if (environment.OPENCODE_CONFIG) json(resolve(base, environment.OPENCODE_CONFIG));
  for (const dir of projectDirsRootToCwd) {
    for (const name of ["opencode.json", "opencode.jsonc"]) json(join(dir, name));
  }
  for (const directory of agentDirectories) {
    if (directory.endsWith(".opencode") || directory === customConfigDir) {
      for (const name of ["opencode.json", "opencode.jsonc"]) json(join(directory, name));
    }
    orderedSources.push({ kind: "agentDirectory", directory });
  }
  const jsonFiles = orderedSources.flatMap((source) => source.kind === "json" ? [source.path] : []);
  return { jsonFiles, agentDirectories, orderedSources };
}

function isTruthyFlag(value: string | undefined): boolean {
  const normalized = value?.toLowerCase();
  return normalized === "true" || normalized === "1";
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

/** Parse JSONC without interpreting comment markers inside strings, preserving separators and rejecting open comments. */
export function parseJsonc(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    // Only allocate the scanner buffers for JSONC or invalid input.
  }
  const uncommented: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    const next = text[index + 1];
    if (inString) {
      uncommented.push(char);
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      uncommented.push(char);
      continue;
    }
    if (char !== "/" || (next !== "/" && next !== "*")) {
      uncommented.push(char);
      continue;
    }
    if (next === "/") {
      uncommented.push(" ", " ");
      index++;
      while (index + 1 < text.length && text[index + 1] !== "\n" && text[index + 1] !== "\r") {
        uncommented.push(" ");
        index++;
      }
      continue;
    }
    const end = text.indexOf("*/", index + 2);
    if (end < 0) return { ok: false };
    for (let cursor = index; cursor < end + 2; cursor++) {
      const commentChar = text[cursor]!;
      uncommented.push(commentChar === "\n" || commentChar === "\r" ? commentChar : " ");
    }
    index = end + 1;
  }
  if (inString) return { ok: false };

  const withoutTrailingCommas: string[] = [];
  inString = false;
  escaped = false;
  for (let index = 0; index < uncommented.length; index++) {
    const char = uncommented[index]!;
    if (inString) {
      withoutTrailingCommas.push(char);
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      withoutTrailingCommas.push(char);
      continue;
    }
    if (char === ",") {
      let next = index + 1;
      while (next < uncommented.length && /\s/u.test(uncommented[next]!)) next++;
      if (uncommented[next] === "}" || uncommented[next] === "]") {
        withoutTrailingCommas.push(" ");
        continue;
      }
    }
    withoutTrailingCommas.push(char);
  }
  try {
    return { ok: true, value: JSON.parse(withoutTrailingCommas.join("")) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Read only bounded regular files. Nonblocking open makes FIFO/device candidates safe to inspect. */
export function readInspectedFile(path: string, maxBytes = MAX_INSPECTED_CONFIG_BYTES): InspectedFile {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "absent" } : { kind: "uninspectable" };
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) return { kind: "uninspectable" };
    const chunks: Buffer[] = [];
    const chunkSize = Math.min(64 * 1024, maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(chunkSize, maxBytes + 1 - bytesRead));
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      bytesRead += count;
    }
    if (bytesRead > maxBytes) return { kind: "uninspectable" };
    return { kind: "text", text: Buffer.concat(chunks, bytesRead).toString("utf8") };
  } catch {
    return { kind: "uninspectable" };
  } finally {
    closeSync(fd);
  }
}
