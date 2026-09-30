import { dirname } from "node:path";
import type { IsolationPaths } from "./isolationPaths.ts";

/**
 * The bubblewrap arguments of one isolated agent on Linux: the whole file system read-only, the project, this
 * launch's temporary folder and the CLI's own folders writable, an empty tmpfs over every folder it must not read (and
 * /dev/null over such files), its own PID namespace (it cannot signal the person's processes) and the person's user
 * runtime folder hidden (the systemd user manager, D-Bus session bus, SSH agent and Podman sockets live there).
 *
 * Linux cannot filter which Unix sockets a process connects to, so a socket outside those hidden folders (a system
 * Docker socket the person's account may use) stays reachable; docs/installing-and-security.md says so. `exists`
 * decides what is bound: bubblewrap refuses to bind a missing path.
 */
export function bubblewrapArguments(
  paths: IsolationPaths,
  launch: { command: string; args: readonly string[]; cwd: string; runtimeDir?: string },
  exists: (path: string) => "file" | "directory" | null
): string[] {
  const args = [
    "--die-with-parent",
    "--unshare-pid",
    "--unshare-ipc",
    "--ro-bind", "/", "/",
    "--dev-bind", "/dev", "/dev",
    "--proc", "/proc"
  ];
  const seen = new Set<string>();
  for (const path of paths.writable) {
    if (seen.has(path) || exists(path) !== "directory") continue;
    seen.add(path);
    args.push("--bind", path, path);
  }
  for (const path of paths.writableFiles) {
    if (exists(path) === "file") args.push("--bind", path, path);
  }
  for (const path of [...paths.gitHooks, ...paths.protectedWrites]) {
    const kind = exists(path);
    if (kind) args.push("--ro-bind", path, path);
  }
  // A mount needs its path to exist, and nothing can be mounted once the agent runs: a protected file that is missing
  // but could be created inside a writable folder cannot be protected here. The caller puts a neutral placeholder
  // there first (LinuxHostPaths); if one is still missing, the launch is refused rather than left unprotected.
  // A `.lock` sibling needs no mount: the rename over the read-only file it guards fails anyway.
  for (const path of paths.protectedWrites) {
    if (path.endsWith(".lock") || exists(path)) continue;
    if (creatableInside(path, [...seen], exists)) {
      throw new Error(`${path} would be writable for the agent (it does not exist yet, so it cannot be mounted read-only).`);
    }
  }
  for (const path of paths.unreadable) {
    const kind = exists(path);
    if (kind === "directory") args.push("--tmpfs", path);
    else if (kind === "file") args.push("--ro-bind", "/dev/null", path);
  }
  for (const path of paths.readableAgain) {
    if (exists(path)) args.push("--bind", path, path);
  }
  if (launch.runtimeDir && exists(launch.runtimeDir) === "directory") args.push("--tmpfs", launch.runtimeDir);
  // CanvasTTY's gateway sockets may sit in the hidden runtime folder or in /tmp; bind their folders back.
  for (const path of paths.socketFolders) {
    if (exists(path) === "directory" && !seen.has(path)) args.push("--bind", path, path);
  }
  args.push("--chdir", launch.cwd, "--", launch.command, ...launch.args);
  return args;
}

/** A missing `path` whose nearest existing ancestor is one of the writable folders (or inside one). */
export function creatableInside(path: string, writable: readonly string[], exists: (path: string) => "file" | "directory" | null): boolean {
  let current = dirname(path);
  for (let i = 0; i < 128 && !exists(current); i++) {
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return exists(current) === "directory" && writable.some((folder) => current === folder || current.startsWith(`${folder.replace(/\/+$/u, "")}/`));
}
