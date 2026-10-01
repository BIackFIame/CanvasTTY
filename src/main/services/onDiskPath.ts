import { readdirSync } from "node:fs";
import { isAbsolute, parse, sep } from "node:path";

/**
 * The path spelled as its folders are stored on disk, without resolving symlinks.
 *
 * macOS file systems accept a name in either Unicode form (NFC "й" or NFD "и" + combining breve) and store the
 * form they were created with; Finder-made names are NFD. A path an agent or a person typed is NFC, so a CLI
 * started there reads its working folder back (getcwd) in another spelling than the one it was given, and a
 * tool that compares the two (OpenCode's project root against the files it globs) treats the project as an
 * external folder. Each non-ASCII part is replaced with the entry of its parent folder that is spelled exactly
 * like it, or else the one entry equal to it after normalization; anything unreadable is left as given.
 */
export function onDiskPath(path: string): string {
  // ASCII has one spelling in every normalization form.
  if (!isAbsolute(path) || /^[\x00-\x7f]*$/u.test(path)) return path;
  const { root } = parse(path);
  const parts = path.slice(root.length).split(sep);
  let current = root;
  const spelled: string[] = [];
  for (const part of parts) {
    let name = part;
    if (part.length > 0 && part !== "." && part !== ".." && !/^[\x00-\x7f]*$/u.test(part)) {
      name = entryNamed(current, part) ?? part;
    }
    spelled.push(name);
    current = current.endsWith(sep) ? `${current}${name}` : `${current}${sep}${name}`;
  }
  return `${root}${spelled.join(sep)}`;
}

function entryNamed(folder: string, name: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(folder);
  } catch {
    return null;
  }
  if (entries.includes(name)) return name;
  const wanted = name.normalize("NFC");
  const matches = entries.filter((entry) => entry.normalize("NFC") === wanted);
  // Two entries that differ only in normalization (possible on Linux) are ambiguous: keep what was given.
  return matches.length === 1 ? matches[0]! : null;
}

/** The other Unicode spellings of a path (NFC, NFD), without the one given; empty for ASCII paths. */
export function otherSpellings(path: string): string[] {
  return [...new Set([path.normalize("NFC"), path.normalize("NFD")])].filter((variant) => variant !== path);
}
