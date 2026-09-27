// A CanvasTTY launch policy: newline-delimited JSON-RPC 2.0 over stdin/stdout.
// With `launch.policy: true` CanvasTTY sends canvastty.launch.prepare before every agent launch, with `chosen: false`
// when the person did not pick this plugin's options (this one has none). Such an answer may only refuse; no answer
// within 5 s refuses the launch too.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

function prepare({ profile }) {
  if (profile === "yolo") {
    return { refuse: { reason: "YOLO launches are turned off by the YOLO Guard plugin: start without YOLO, or disable the plugin." } };
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
  if (message.method === "canvastty.launch.prepare" && message.id !== undefined) {
    send({ id: message.id, result: prepare(message.params) });
  } else if (typeof message.method === "string" && message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: `Unknown method: ${message.method}` } });
  }
}).on("close", () => process.exit(0));
