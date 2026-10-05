import assert from "node:assert/strict";
import test from "node:test";
import { subagentWorktreeResolver } from "../src/main/services/SubagentWorktreeResolver.ts";

const request = { parentSessionId: "root", projectRoot: "/trusted-project", cwd: "/trusted-project/src", liveChildren: 0 };
const provider = { pluginId: "environments", pluginName: "Environments", serviceId: "env", kinds: [{ kind: "worktree", label: "Worktree" }], secrets: false };

test("the first and subsequent workers choose separate worktrees from the trusted project", async () => {
  const roots = [];
  const resolve = subagentWorktreeResolver({
    isGitProject: async root => { roots.push(root); return true; },
    providers: () => [provider]
  });
  const choice = { pluginId: "environments", kind: "worktree" };
  assert.deepEqual(await resolve(request), choice);
  assert.deepEqual(await resolve({ ...request, liveChildren: 1 }), choice);
  assert.deepEqual(roots, [request.projectRoot, request.projectRoot]);
});

test("without a trusted worktree provider or Git project selection stays local", async () => {
  const unavailable = subagentWorktreeResolver({ isGitProject: async () => true, providers: () => [] });
  assert.equal(await unavailable({ ...request, isolate: "worktree" }), null);
  const noGit = subagentWorktreeResolver({ isGitProject: async () => false, providers: () => [provider] });
  assert.equal(await noGit({ ...request, isolate: "worktree" }), null);
});
