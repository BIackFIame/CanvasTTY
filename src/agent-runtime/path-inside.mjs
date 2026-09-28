import { posix, win32 } from "node:path";

/**
 * Whether `candidate` is `root` itself (unless `allowRoot` is false) or lies
 * under it. Lexical: both paths are resolved (so `..` segments count), links
 * are not followed; pass real paths (fs.promises.realpath) when a link must
 * not lead out. A sibling that only shares a prefix (`/root2` for `/root`) is
 * outside, and a child whose name starts with dots (`/root/..cache`) is inside.
 *
 * Windows compares case-insensitively, as its path functions do. Elsewhere the
 * comparison is exact, which is the safe answer on a case-insensitive macOS
 * volume too: a differently cased path counts as outside unless it went
 * through fs.promises.realpath, which returns the case stored on disk.
 */
export function isPathInside(root, candidate, options = {}) {
  const path = (options.platform ?? process.platform) === "win32" ? win32 : posix;
  const relation = path.relative(path.resolve(root), path.resolve(candidate));
  if (relation === "") return options.allowRoot ?? true;
  return relation !== ".." && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation);
}
