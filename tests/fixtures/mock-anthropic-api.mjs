// A deterministic stand-in for the Anthropic Messages API (streaming), for tests that drive the real Claude Code CLI
// without an account: while a request offers the Bash tool it answers with the next queued Bash call, then with
// "DONE". Only 127.0.0.1.
import { createServer } from "node:http";

export async function startMockAnthropicApi(commands) {
  const queue = [...commands];
  const requests = [];
  let serial = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
        response.writeHead(request.url?.includes("count_tokens") ? 200 : 404, { "content-type": "application/json" });
        response.end(request.url?.includes("count_tokens") ? '{"input_tokens":10}' : '{"type":"error","error":{"type":"not_found_error","message":"not here"}}');
        return;
      }
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* answered as text */ }
      requests.push(parsed);
      const id = `msg_mock_${++serial}`;
      const model = parsed.model ?? "claude-mock";
      const offersBash = (parsed.tools ?? []).some((tool) => tool.name === "Bash");
      const command = offersBash ? queue.shift() : undefined;
      const usage = { input_tokens: 10, output_tokens: 5 };
      const start = ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, usage } }];
      const events = command === undefined ? [
        start,
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "DONE" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }],
        ["message_stop", { type: "message_stop" }]
      ] : [
        start,
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_mock_${serial}`, name: "Bash", input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command, description: "test step" }) } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }],
        ["message_stop", { type: "message_stop" }]
      ];
      if (!parsed.stream) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id, type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })
  };
}
