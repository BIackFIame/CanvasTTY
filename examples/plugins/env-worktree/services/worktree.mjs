// A CanvasTTY session environment: newline-delimited JSON-RPC 2.0 over stdin/stdout.
// Each card started in "Git worktree" gets `git worktree add` in this plugin's data folder.
// CanvasTTY keeps the ref and the PTY; this service only prepares, wraps (sets the folder),
// resumes, describes and releases.
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const run = promisify(execFile);
const git = async (cwd, ...args) => (await run("git", ["-C", cwd, ...args], { timeout: 10_000 })).stdout.trim();
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let worktreesRoot = null;

/** Only folders this plugin created are ever touched, whatever a saved ref says. */
function ownedRef(ref) {
  const dir = typeof ref?.dir === "string" ? resolve(ref.dir) : "";
  if (!worktreesRoot || !dir.startsWith(worktreesRoot + sep)) throw new Error("This worktree does not belong to the plugin.");
  return { ...ref, dir };
}

async function prepare({ sessionId, cwd, options }) {
  const repo = await git(cwd, "rev-parse", "--show-toplevel").catch(() => null);
  if (!repo) return { refuse: { reason: `${cwd} is not inside a git repository.` } };
  const branch = options.branch?.trim() || `canvastty/${sessionId.slice(0, 8)}`;
  if (!await git(repo, "check-ref-format", "--branch", branch).catch(() => null)) {
    return { refuse: { reason: `${branch} is not a valid branch name.` } };
  }
  const dir = join(worktreesRoot, `${basename(repo)}-${sessionId.slice(0, 8)}`);
  const exists = await git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).then(() => true, () => false);
  try {
    await git(repo, "worktree", "add", ...(exists ? [dir, branch] : ["-b", branch, dir]));
  } catch (error) {
    return { refuse: { reason: `git worktree add failed: ${String(error.stderr || error.message).trim().slice(0, 200)}` } };
  }
  // The card's folder inside the repository (git reports real paths, so compare real paths).
  const inside = relative(repo, realpathSync(cwd));
  const sub = inside.startsWith("..") ? "" : inside;
  return { ref: { repo, dir, branch, createdBranch: !exists, sub }, label: `worktree ${branch}`, cwd: join(dir, sub) };
}

async function resume({ ref }) {
  const { dir } = ownedRef(ref);
  if (!existsSync(dir)) return { stopped: { reason: `The worktree folder ${dir} no longer exists.` } };
  const inside = await git(dir, "rev-parse", "--is-inside-work-tree").catch(() => "");
  return inside === "true" ? { ok: true } : { stopped: { reason: `${dir} is no longer a git worktree.` } };
}

function wrap({ ref, command, args }) {
  const { dir, sub } = ownedRef(ref);
  // Same program and arguments; only the folder changes.
  return { command, args, cwd: join(dir, sub ?? "") };
}

async function release({ ref, keepData }) {
  if (keepData) return {};
  const { repo, dir, branch, createdBranch } = ownedRef(ref);
  await git(repo, "worktree", "remove", "--force", dir);
  if (createdBranch) await git(repo, "branch", "-D", branch).catch(() => undefined);
  return {};
}

async function describe({ ref }) {
  const { dir } = ownedRef(ref);
  const branch = await git(dir, "rev-parse", "--abbrev-ref", "HEAD").catch(() => ref.branch);
  return { label: `worktree ${branch}`, detail: dir };
}

const methods = {
  "canvastty.environment.prepare": prepare,
  "canvastty.environment.resume": resume,
  "canvastty.environment.wrap": wrap,
  "canvastty.environment.release": release,
  "canvastty.environment.describe": describe
};

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "canvastty.initialize") {
    worktreesRoot = resolve(message.params.dataDir, "worktrees");
    return;
  }
  if (message.method === "canvastty.shutdown") process.exit(0);
  if (typeof message.method !== "string" || message.id === undefined) return;
  const method = methods[message.method];
  if (!method) {
    send({ id: message.id, error: { code: -32601, message: `Unknown method: ${message.method}` } });
    return;
  }
  Promise.resolve().then(() => method(message.params)).then(
    (result) => send({ id: message.id, result }),
    (error) => send({ id: message.id, error: { code: -32000, message: error.message } })
  );
}).on("close", () => process.exit(0));
