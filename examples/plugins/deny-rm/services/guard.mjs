// A CanvasTTY decision service: newline-delimited JSON-RPC 2.0 over stdin/stdout.
// Before an agent's shell command or file write runs, CanvasTTY calls canvastty.decide and waits
// at most 3 s. Answer { verdict: "deny" | "ask" | "allow", reason } or null for no opinion.
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

/** Denies `rm` with -r and -f when a target is the working folder itself or directly inside it. */
function decide({ tool, cwd, agentCwd }) {
  if (tool.kind !== "shell" || typeof tool.command !== "string") return null;
  const here = agentCwd ?? cwd;
  for (const part of tool.command.split(/&&|\|\||[;|\n]/u)) {
    const words = part.trim().split(/\s+/u).filter(Boolean);
    const at = words.findIndex((word) => word === "rm" || word.endsWith("/rm"));
    if (at < 0) continue;
    const args = words.slice(at + 1);
    const short = args.filter((word) => /^-[^-]/u.test(word)).join("");
    const recursive = /[rR]/u.test(short) || args.includes("--recursive");
    const force = /f/u.test(short) || args.includes("--force");
    if (!recursive || !force) continue;
    const topLevel = args.filter((word) => !word.startsWith("-")).some((target) => {
      const path = resolve(here, target.replace(/[*?].*$/u, "") || ".");
      return path === resolve(cwd) || dirname(path) === resolve(cwd);
    });
    if (topLevel) {
      return { verdict: "deny", reason: "rm -rf at the top of the working folder is blocked by the Deny rm -rf plugin; delete specific files instead" };
    }
  }
  return null;
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "canvastty.shutdown") process.exit(0);
  if (message.method === "canvastty.decide" && message.id !== undefined) {
    try {
      send({ id: message.id, result: decide(message.params) });
    } catch (error) {
      send({ id: message.id, error: { code: -32000, message: error.message } });
    }
  } else if (typeof message.method === "string" && message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: `Unknown method: ${message.method}` } });
  }
}).on("close", () => process.exit(0));
