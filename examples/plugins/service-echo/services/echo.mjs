// A CanvasTTY plugin service: newline-delimited JSON-RPC 2.0 over stdin/stdout.
// Bundled single file, no dependencies. Anything written to stderr ends up in the plugin log.
import { createInterface } from "node:readline";

const pending = new Map();
let nextId = 1;
let context = null;

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const callHost = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});

async function handle(method, params) {
  if (method === "echo") {
    const count = ((await callHost("storage.get", { key: "count" })) ?? 0) + 1;
    await callHost("storage.set", { key: "count", value: count });
    send({ method: "event", params: { event: "echoed", data: { count } } });
    return { echo: params, count, serviceId: context?.serviceId ?? null };
  }
  if (method === "token") {
    // The service reads the plugin's own secret (needs the secrets permission).
    // Never send it back to a page: answer only whether it is set.
    const token = await callHost("secrets.get", { key: "token" });
    return { set: typeof token === "string" && token.length > 0 };
  }
  throw new Error(`Unknown method: ${method}`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "canvastty.initialize") {
    context = message.params;
    send({ method: "log", params: { level: "info", message: `echo ready for ${context.pluginId}` } });
    return;
  }
  if (message.method === "canvastty.shutdown") process.exit(0);
  if (typeof message.method === "string" && message.id !== undefined) {
    handle(message.method, message.params).then(
      (result) => send({ id: message.id, result }),
      (error) => send({ id: message.id, error: { code: -32000, message: error.message } })
    );
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
}).on("close", () => process.exit(0));
