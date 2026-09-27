// A plugin service for tests: on canvastty.initialize it at once subscribes to session events and calls the other
// host APIs a service may use at startup (secrets.get, cards.setBadge), and reports every answer and event it gets
// back as an `event` notification, so the test sees exactly what the service saw.
import { createInterface } from "node:readline";

let nextId = 1;
const waiting = new Map();
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const report = (event, data) => send({ method: "event", params: { event, data } });
const call = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  waiting.set(id, resolve);
  send({ id, method, params });
});

const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && waiting.has(message.id)) {
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    resolve(message.error ? { error: message.error.message } : { result: message.result });
    return;
  }
  if (message.method === "canvastty.initialize") {
    const [subscribe, secret, badge] = await Promise.all([
      call("sessions.subscribe", {}),
      call("secrets.get", { key: "token" }),
      call("cards.setBadge", { sessionId: "none", badge: null })
    ]);
    report("startup", { subscribe, secret, badge });
  } else if (message.method === "canvastty.sessions.event") {
    report("session", { type: message.params.type, id: message.params.session.id });
  }
});
lines.on("close", () => process.exit(0));
