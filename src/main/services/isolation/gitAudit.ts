import { lstat, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * What an isolated agent may have left in a repository under its project that runs a program the next time the
 * person uses git there, outside the layer: config keys (hooksPath, fsmonitor, sshCommand, filter and diff drivers,
 * aliases starting with "!", includes …), hooks and info/attributes. Reported with each key, never changed without
 * the person (neutralizeRepositories).
 */
export type GitRiskItem =
  | { kind: "config"; key: string; value: string }
  | { kind: "hook"; name: string }
  | { kind: "attributes" };

export interface GitRiskRepository {
  /** The repository's .git folder. */
  gitDir: string;
  items: GitRiskItem[];
}

const MAX_DEPTH = 8;
const MAX_FOLDERS = 5_000;
const MAX_CONFIG_BYTES = 1024 * 1024;
const SKIPPED_FOLDERS = new Set(["node_modules", ".venv", "venv", "__pycache__", "target", "dist", "build"]);
const DISABLED_SUFFIX = ".disabled-by-canvastty";
const BOOLEAN = /^(?:true|false|yes|no|on|off|1|0|)$/iu;

/** A git config key (section[.subsection].name, section and name lower case) that makes git run a program. */
function dangerous(section: string, subsection: string | null, name: string, value: string): boolean {
  const key = subsection === null ? `${section}.${name}` : `${section}.*.${name}`;
  switch (key) {
    case "core.hookspath": case "core.sshcommand": case "core.gitproxy": case "core.editor": case "core.pager":
    case "core.askpass": case "sequence.editor": case "gpg.program": case "gpg.*.program": case "credential.helper":
    case "credential.*.helper": case "include.path": case "includeif.*.path": case "filter.*.process": case "filter.*.clean":
    case "filter.*.smudge": case "diff.*.textconv": case "diff.*.command": case "diff.external": case "merge.*.driver":
    case "interactive.difffilter": case "web.browser": case "browser.*.cmd": case "man.*.cmd": case "difftool.*.cmd":
    case "mergetool.*.cmd": case "uploadpack.packobjectshook": case "sendemail.smtpserver": case "sendemail.tocmd":
    case "sendemail.cccmd":
      return true;
    case "core.fsmonitor":
      // true/false select git's own daemon; anything else is a program.
      return !BOOLEAN.test(value.trim());
    default:
      return (subsection === null && section === "alias" && value.trimStart().startsWith("!"))
        || (subsection === null && section === "pager" && !BOOLEAN.test(value.trim()));
  }
}

interface ConfigEntry {
  key: string;
  value: string;
  /** Lines [first, last] the entry spans; `headerEnd` when it shares its first line with a section header. */
  first: number;
  last: number;
  headerEnd?: number;
}

/** Every entry of a git config text, in order, with its lower-cased key (section.subsection.name). */
function configEntries(text: string): ConfigEntry[] {
  const lines = text.split("\n");
  const entries: ConfigEntry[] = [];
  let section = "";
  let subsection: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]!;
    let offset = 0;
    const header = /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/u.exec(line);
    if (header) {
      const [full, rawSection, rawSubsection] = header;
      const dot = rawSection!.indexOf(".");
      if (rawSubsection !== undefined) {
        section = rawSection!.toLowerCase();
        subsection = rawSubsection.replace(/\\(.)/gu, "$1");
      } else if (dot >= 0) {
        // The old [section.subsection] form: its subsection is lower case.
        section = rawSection!.slice(0, dot).toLowerCase();
        subsection = rawSection!.slice(dot + 1).toLowerCase();
      } else {
        section = rawSection!.toLowerCase();
        subsection = null;
      }
      offset = full!.length;
      line = line.slice(offset);
    }
    const assignment = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*(?:=(.*))?$/u.exec(line);
    if (!assignment || !section) continue;
    // A value continues on the next line after an unquoted, unescaped backslash at the end.
    let raw = assignment[2] ?? "";
    let last = index;
    while (/(^|[^\\])(\\\\)*\\$/u.test(raw) && last + 1 < lines.length) {
      raw = raw.slice(0, -1) + lines[++last]!;
    }
    const value = configValue(raw);
    const name = assignment[1]!.toLowerCase();
    if (dangerous(section, subsection, name, value)) {
      entries.push({
        key: subsection === null ? `${section}.${name}` : `${section}.${subsection}.${name}`,
        value,
        first: index,
        last,
        ...(offset > 0 ? { headerEnd: offset } : {})
      });
    }
    index = last;
  }
  return entries;
}

/** A config value as git reads it: quotes removed, escapes resolved, an unquoted comment dropped, trimmed. */
function configValue(raw: string): string {
  let value = "";
  let quoted = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!;
    if (char === "\\" && index + 1 < raw.length) {
      const next = raw[++index]!;
      value += next === "n" ? "\n" : next === "t" ? "\t" : next;
    } else if (char === "\"") quoted = !quoted;
    else if (!quoted && (char === "#" || char === ";")) break;
    else value += char;
  }
  return value.trim();
}

/** The entries of a git config text that make git run a program. */
export function dangerousConfigEntries(text: string): Array<{ key: string; value: string }> {
  return configEntries(text).map(({ key, value }) => ({ key, value }));
}

/** The config text without the dangerous entries whose keys are listed (every occurrence); the rest as it was. */
export function removeConfigEntries(text: string, keys: readonly string[]): string {
  const wanted = new Set(keys);
  const lines = text.split("\n");
  const drop = new Set<number>();
  for (const entry of configEntries(text)) {
    if (!wanted.has(entry.key)) continue;
    if (entry.headerEnd !== undefined) lines[entry.first] = lines[entry.first]!.slice(0, entry.headerEnd);
    else drop.add(entry.first);
    for (let index = entry.first + 1; index <= entry.last; index++) drop.add(index);
  }
  return lines.filter((_line, index) => !drop.has(index)).join("\n");
}

/** Whether `path` changed (created, written, renamed, chmod) at or after `since`. */
async function changedSince(path: string, since: number): Promise<boolean> {
  try {
    const info = await lstat(path);
    return Math.max(info.ctimeMs, info.mtimeMs, info.birthtimeMs || 0) >= since;
  } catch {
    return false;
  }
}

/** The .git folders under `root` (bounded; symbolic links and dependency folders are not followed). */
async function repositories(root: string): Promise<string[]> {
  const found: string[] = [];
  let queue: Array<{ folder: string; depth: number }> = [{ folder: root, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_FOLDERS) {
    const next: typeof queue = [];
    for (const { folder, depth } of queue) {
      if (++visited > MAX_FOLDERS) break;
      let entries;
      try { entries = await readdir(folder, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === ".git") found.push(join(folder, entry.name));
        else if (depth < MAX_DEPTH && !SKIPPED_FOLDERS.has(entry.name)) next.push({ folder: join(folder, entry.name), depth: depth + 1 });
      }
    }
    queue = next;
  }
  return found;
}

/**
 * The repositories under `root` whose git folder was created or changed at or after `since`, with what in them
 * makes git run a program: dangerous config keys (all of them, when the config changed), hooks written since, and
 * info/attributes written since.
 */
export async function auditRepositories(root: string, since: number): Promise<GitRiskRepository[]> {
  const report: GitRiskRepository[] = [];
  for (const gitDir of await repositories(root)) {
    const items: GitRiskItem[] = [];
    for (const name of ["config", "config.worktree"]) {
      const path = join(gitDir, name);
      if (!await changedSince(path, since)) continue;
      const text = await readSmall(path);
      if (text === null) continue;
      for (const entry of dangerousConfigEntries(text)) {
        if (!items.some((item) => item.kind === "config" && item.key === entry.key)) items.push({ kind: "config", ...entry });
      }
    }
    let hooks: string[] = [];
    try { hooks = (await readdir(join(gitDir, "hooks"))).sort(); } catch { /* none */ }
    for (const name of hooks) {
      if (name.endsWith(".sample") || name.endsWith(DISABLED_SUFFIX)) continue;
      if (await changedSince(join(gitDir, "hooks", name), since)) items.push({ kind: "hook", name });
    }
    if (await changedSince(join(gitDir, "info", "attributes"), since)) items.push({ kind: "attributes" });
    if (items.length > 0) report.push({ gitDir, items });
  }
  return report;
}

async function readSmall(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Removes what was reported, when the person chose to: the config keys (every occurrence, the rest of the file as it
 * was), and hooks and info/attributes renamed to `<name>.disabled-by-canvastty` (git never runs or reads them there).
 */
export async function neutralizeRepositories(report: readonly GitRiskRepository[]): Promise<void> {
  for (const { gitDir, items } of report) {
    const keys = items.flatMap((item) => item.kind === "config" ? [item.key] : []);
    if (keys.length > 0) {
      for (const name of ["config", "config.worktree"]) {
        const path = join(gitDir, name);
        const text = await readSmall(path);
        if (text === null) continue;
        const cleaned = removeConfigEntries(text, keys);
        if (cleaned !== text) await replaceFile(path, cleaned);
      }
    }
    for (const item of items) {
      if (item.kind === "hook") await disable(join(gitDir, "hooks", item.name));
      else if (item.kind === "attributes") await disable(join(gitDir, "info", "attributes"));
    }
  }
}

async function disable(path: string): Promise<void> {
  try { await rename(path, `${path}${DISABLED_SUFFIX}`); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function replaceFile(path: string, text: string): Promise<void> {
  const temporary = join(dirname(path), `.config.${randomBytes(6).toString("hex")}.canvastty`);
  try {
    await writeFile(temporary, text, { flag: "wx", mode: 0o644 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
