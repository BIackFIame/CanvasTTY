// A CanvasTTY service with an agent tool, a card action and session events:
// newline-delimited JSON-RPC 2.0 over stdin/stdout, bundled single file, no dependencies.
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const run = promisify(execFile);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const pending = new Map();
let nextId = 1;
const callHost = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});

/** Cards CanvasTTY told us about (sessions:events): id -> summary. No screen text. */
const sessions = new Map();

async function diffStat(folder) {
  const { stdout } = await run("git", ["-C", folder, "diff", "--stat"], { timeout: 10_000, maxBuffer: 256 * 1024 });
  return stdout.trim();
}

// Agent tool `collect-demo__diffstat` (orchestrators only, see the manifest).
async function callTool({ tool, caller, input }) {
  if (tool !== "diffstat") throw new Error(`Unknown tool: ${tool}`);
  let target = caller;
  if (input.sessionId !== undefined) {
    target = sessions.get(input.sessionId);
    // Only the caller's own subagents: CanvasTTY passes the caller, the plugin enforces its own rule.
    if (!target || target.parentSessionId !== caller.id) return { content: "That session is not one of your subagents.", isError: true };
  }
  const stat = await diffStat(target.workingDirectory);
  return { content: stat || `No changes in ${target.workingDirectory}.` };
}

// Card action "Show changes" (cards in a worktree environment, see the manifest).
async function invokeCard({ actionId, session }) {
  if (actionId !== "show-changes") throw new Error(`Unknown action: ${actionId}`);
  const stat = await diffStat(session.workingDirectory);
  const files = stat ? stat.split("\n").length - 1 : 0;
  await callHost("cards.setBadge", {
    sessionId: session.id,
    badge: files ? { text: `${files} changed`, tone: "info", tooltip: "Files changed in the worktree" } : null
  });
  return { message: stat || "No changes in the worktree.", tone: "info" };
}

const methods = {
  "canvastty.tools.call": callTool,
  "canvastty.cards.invoke": invokeCard
};

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "canvastty.initialize") {
    // Subscribing also returns the cards that are open now.
    callHost("sessions.subscribe", {}).then(({ sessions: open }) => {
      for (const session of open) sessions.set(session.id, session);
    }, (error) => process.stderr.write(`subscribe failed: ${error.message}\n`));
    return;
  }
  if (message.method === "canvastty.shutdown") process.exit(0);
  if (message.method === "canvastty.sessions.event") {
    const { type, session } = message.params;
    if (type === "closed") sessions.delete(session.id);
    else sessions.set(session.id, session);
    return;
  }
  if (typeof message.method === "string" && message.id !== undefined) {
    const method = methods[message.method];
    Promise.resolve().then(() => {
      if (!method) throw new Error(`Unknown method: ${message.method}`);
      return method(message.params);
    }).then(
      (result) => send({ id: message.id, result }),
      (error) => send({ id: message.id, error: { code: -32000, message: String(error.message).slice(0, 200) } })
    );
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
}).on("close", () => process.exit(0));
