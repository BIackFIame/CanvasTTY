import { mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { creatableInside } from "./bubblewrap.ts";
import type { IsolationPaths } from "./isolationPaths.ts";

type Kind = "file" | "directory" | null;

export interface HostPathFs {
  kind(path: string): Kind;
  mkdir(path: string): void;
  /** Creates `path` with `content`; fails when it exists. */
  create(path: string, content: string): void;
  read(path: string): string | null;
  unlink(path: string): void;
  /** Removes an empty folder; fails when it is not empty. */
  rmdir(path: string): void;
}

const realFs: HostPathFs = {
  kind(path) {
    try { const stat = statSync(path); return stat.isDirectory() ? "directory" : stat.isFile() ? "file" : null; } catch { return null; }
  },
  mkdir(path) { mkdirSync(path, { mode: 0o700 }); },
  create(path, content) { writeFileSync(path, content, { mode: 0o600, flag: "wx" }); },
  read(path) { try { return readFileSync(path, "utf8"); } catch { return null; } },
  unlink(path) { unlinkSync(path); },
  rmdir(path) { rmdirSync(path); }
};

/** What a missing protected file holds while an isolated agent runs: the same meaning as no file at all. */
export function placeholderContent(path: string): string {
  return [".json", ".jsonc"].includes(extname(path).toLowerCase()) ? "{}\n" : "";
}

interface Held { count: number; kind: "folder" | "placeholder"; content: string }

/**
 * Linux only: what bubblewrap needs on the host before an isolated launch. bubblewrap binds only paths that exist and
 * nothing can be mounted once the agent runs, while macOS's seatbelt rules also cover paths that do not exist yet:
 * - the CLI's own folders that do not exist yet (a fresh HOME) are created, with the missing folders on the way that
 *   `creatableFolders` allows (the ones seatbelt lets the agent create), so the CLI's first run has somewhere to write;
 * - a protected file (the CLI's permission settings) that is missing inside a writable folder gets a placeholder that
 *   means the same as no file (`{}` for JSON, empty otherwise), which is then mounted read-only: the agent can
 *   neither create nor change it, and its folder stays writable for everything else.
 * Both are shared between concurrent launches and removed when the last one ends: folders only when still empty,
 * placeholders only when they still hold what CanvasTTY wrote (a person who edited one keeps the edit).
 */
export class LinuxHostPaths {
  private readonly held = new Map<string, Held>();
  private readonly fs: HostPathFs;

  constructor(fs: HostPathFs = realFs) {
    this.fs = fs;
  }

  /** Prepares the host for one launch; the returned function undoes it when that launch ends. */
  prepare(paths: IsolationPaths): () => void {
    const taken: string[] = [];
    const take = (path: string, kind: Held["kind"], content = ""): void => {
      const current = this.held.get(path);
      if (current) current.count += 1;
      else this.held.set(path, { count: 1, kind, content });
      taken.push(path);
    };
    const release = (): void => {
      for (const path of taken.splice(0).reverse()) this.release(path);
    };
    try {
      const creatable = new Set(paths.creatableFolders);
      for (const folder of paths.writable) {
        const missing: string[] = [];
        let current = folder;
        let allowed = true;
        for (let i = 0; i < 128 && !this.fs.kind(current); i++) {
          if (current !== folder && !creatable.has(current)) { allowed = false; break; }
          missing.push(current);
          const parent = dirname(current);
          if (parent === current) { allowed = false; break; }
          current = parent;
        }
        if (this.held.has(folder)) take(folder, "folder");
        if (!allowed || missing.length === 0 || this.fs.kind(current) !== "directory") continue;
        for (const path of missing.reverse()) {
          if (this.fs.kind(path)) continue;
          this.fs.mkdir(path);
          take(path, "folder");
        }
      }
      const writable = paths.writable.filter((path) => this.fs.kind(path) === "directory");
      for (const path of paths.protectedWrites) {
        if (path.endsWith(".lock")) continue;
        if (this.held.has(path)) { take(path, "placeholder"); continue; }
        if (this.fs.kind(path) || !creatableInside(path, writable, (candidate) => this.fs.kind(candidate))) continue;
        const parents: string[] = [];
        for (let current = dirname(path); !this.fs.kind(current); current = dirname(current)) parents.push(current);
        for (const parent of parents.reverse()) {
          this.fs.mkdir(parent);
          take(parent, "folder");
        }
        const content = placeholderContent(path);
        this.fs.create(path, content);
        take(path, "placeholder", content);
      }
    } catch (error) {
      release();
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  private release(path: string): void {
    const held = this.held.get(path);
    if (!held) return;
    held.count -= 1;
    if (held.count > 0) return;
    this.held.delete(path);
    try {
      if (held.kind === "placeholder") {
        if (this.fs.read(path) === held.content) this.fs.unlink(path);
      } else {
        this.fs.rmdir(path);
      }
    } catch {
      // Not empty any more, or already gone: it is kept as it is.
    }
  }
}
