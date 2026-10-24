import { createServer, request as httpRequest } from "node:http";

/**
 * A fake model provider on 127.0.0.1 for brokered-request tests. It never forwards anything anywhere. The behaviour
 * comes from the request's `model` (or the path for GET): it records every request with its headers so tests can
 * check exactly what the host sent, and some behaviours echo the auth header back to prove it gets masked.
 */
export async function startFakeModelUpstream() {
  const requests = [];
  const open = new Set();
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      const entry = { method: request.method, url: request.url, headers: { ...request.headers }, body, closed: false };
      requests.push(entry);
      open.add(response);
      response.on("close", () => { entry.closed = true; open.delete(response); });
      const auth = request.headers.authorization ?? request.headers["x-api-key"] ?? "";
      const key = String(auth).replace(/^Bearer /, "");
      const model = body && typeof body === "object" ? body.model : null;
      if (request.method === "GET" && request.url.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json", "x-upstream-secret-header": key, "set-cookie": "s=1" });
        response.end(JSON.stringify({ data: [{ id: "glm-4.6" }] }));
        return;
      }
      if (request.url.endsWith("/elsewhere")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{\"reached\":true}");
        return;
      }
      switch (model) {
        case "m-stream": {
          response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "up-123", "x-key-echo": key });
          const frames = [
            { choices: [{ delta: { content: "Hello " } }] },
            { choices: [{ delta: { content: `the key is ${key} ok` } }] },
            { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } } }
          ];
          // The key is cut in the middle across two writes.
          const all = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
          const cut = all.indexOf(key) + Math.floor(key.length / 2);
          response.write(all.slice(0, cut));
          setTimeout(() => response.end(all.slice(cut)), 20);
          return;
        }
        case "m-anthropic": {
          response.writeHead(200, { "content-type": "text/event-stream" });
          const events = [
            ["message_start", { type: "message_start", message: { usage: { input_tokens: 21, cache_read_input_tokens: 5, output_tokens: 1 } } }],
            ["content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } }],
            ["message_delta", { type: "message_delta", usage: { output_tokens: 9 } }],
            ["message_stop", { type: "message_stop" }]
          ];
          response.end(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""));
          return;
        }
        case "m-json":
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ choices: [{ message: { content: `echo ${key}` } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }));
          return;
        case "m-429":
          response.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
          response.end(JSON.stringify({ error: { message: `rate limited for ${key} ${"x".repeat(2000)}` } }));
          return;
        case "m-500":
          response.writeHead(503, { "content-type": "text/plain" });
          response.end("overloaded");
          return;
        case "m-redirect":
          response.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/elsewhere` });
          response.end();
          return;
        case "m-big":
          response.writeHead(200, { "content-type": "application/json" });
          response.end("y".repeat(4096));
          return;
        case "m-hang":
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "first" } }] })}\n\n`);
          return; // never ends
        default:
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: `unknown model ${model}` } }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  /**
   * A broker transport for tests: the host's request for an https offer (say https://models.example.test) is delivered
   * to this fake server instead, with exactly the method, path, headers and body the host built. The real transport's
   * TLS and address rules are tested on their own.
   */
  const transport = (request) => new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      host: "127.0.0.1", port, method: request.method, path: `${request.url.pathname}${request.url.search}`, agent: false, signal: request.signal,
      headers: { ...request.headers, ...(request.body ? { "content-length": String(request.body.length) } : {}) }
    }, (response) => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response }));
    outgoing.on("error", reject);
    outgoing.end(request.body);
  });
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    transport,
    requests,
    async close() {
      for (const response of open) response.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
