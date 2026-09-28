import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isPathInside } from "../src/agent-runtime/path-inside.mjs";

const table = (platform, root, rows) => {
  for (const [candidate, inside, options = {}] of rows) {
    assert.equal(isPathInside(root, candidate, { platform, ...options }), inside, `${platform}: ${candidate} in ${root}`);
  }
};

test("POSIX: `..`, prefix siblings, dot-named children and the root itself", () => {
  table("linux", "/srv/root", [
    ["/srv/root", true],
    ["/srv/root", false, { allowRoot: false }],
    ["/srv/root/", true],
    ["/srv/root/a/b", true],
    ["/srv/root/a/../b", true],
    ["/srv/root/..cache/x", true],
    ["/srv/root/...", true],
    ["/srv/root/..", false],
    ["/srv/root/../root2/x", false],
    ["/srv/root2", false],
    ["/srv/root2/x", false],
    ["/srv/ro", false],
    ["/srv", false],
    ["/", false],
    ["/srv/Root/a", false]
  ]);
  table("linux", "/", [["/anything", true], ["/", false, { allowRoot: false }]]);
  table("linux", "/srv/root/./sub/..", [["/srv/root/x", true], ["/srv/rootx", false]]);
});

test("macOS compares exactly: a differently cased path is outside until realpath gives the stored case", () => {
  table("darwin", "/Volumes/Work/Project", [
    ["/Volumes/Work/Project/src", true],
    ["/volumes/work/project/src", false],
    ["/Volumes/Work/Project2", false]
  ]);
});

test("Windows compares case-insensitively and never across drives or shares", () => {
  table("win32", "C:\\Work\\Project", [
    ["C:\\Work\\Project", true],
    ["c:\\work\\project\\src", true],
    ["C:/Work/Project/src", true],
    ["C:\\Work\\Project2", false],
    ["C:\\Work\\Project\\..\\Other", false],
    ["C:\\Work\\Project\\..cache", true],
    ["D:\\Work\\Project\\src", false],
    ["\\\\server\\share\\Project", false]
  ]);
});

test("on the real file system a link out of the root is outside once resolved", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "ctty-inside-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "Root");
  await mkdir(join(root, "Sub"), { recursive: true });
  await mkdir(join(base, "outside"));
  await writeFile(join(base, "outside", "secret"), "");
  await symlink(join(base, "outside"), join(root, "link"));
  const linked = join(root, "link", "secret");
  assert.equal(isPathInside(root, linked), true, "lexically the link is inside");
  assert.equal(isPathInside(root, await realpath(linked)), false, "resolved, it is not");
  await symlink(join(root, "Sub"), join(base, "into"));
  assert.equal(isPathInside(root, await realpath(join(base, "into"))), true);
  // A case-insensitive volume (the macOS and Windows default): realpath returns the stored case.
  const miscased = join(base, "root", "sub");
  if (existsSync(miscased)) {
    assert.equal(isPathInside(root, miscased), process.platform === "win32");
    assert.equal(isPathInside(root, await realpath(miscased)), true);
  }
});
