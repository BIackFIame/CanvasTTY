// A plugin service for tests: answers `canvastty.decide` with a deny after the delay its session id names
// ("wait-16000" waits 16 s). Nothing else.
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method !== "canvastty.decide" || message.id === undefined) return;
  const delay = Number(/^wait-(\d+)$/u.exec(message.params?.sessionId ?? "")?.[1] ?? 0);
  setTimeout(() => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { verdict: "deny", reason: `denied after ${delay} ms` } })}\n`);
  }, delay);
});
lines.on("close", () => process.exit(0));
