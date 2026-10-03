// A fake contributed browser engine for tests: a real WebSocket CDP endpoint on 127.0.0.1 (a minimal RFC 6455 server,
// no dependencies) that behaves like Lightpanda where CanvasTTY cares: one page per connection created with
// Target.createTarget, flat sessions, an accessibility tree, synthetic (useless) box models, element.click() through
// Runtime.callFunctionOn, and no DOM.getFlattenedDocument. Pages come from a fixture map keyed by URL.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * pages: { [url]: { title, texts?: string[], buttons?: Array<{ name, id, opens? }>, htmlChars?, status?, challenge?,
 * unsupported?: string[] } }
 */
export async function startFakeCdpEngine({ pages }) {
  const sockets = new Set();
  const calls = [];
  const clicks = [];
  let connections = 0;
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    const accept = createHash("sha1").update(`${key}${GUID}`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
    const page = { url: "about:blank", history: ["about:blank"], index: 0 };
    let buffer = Buffer.alloc(0);
    const send = (message) => {
      if (socket.destroyed) return;
      const payload = Buffer.from(JSON.stringify(message));
      const header = payload.length < 126
        ? Buffer.from([0x81, payload.length])
        : payload.length < 65_536
          ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
          : Buffer.concat([Buffer.from([0x81, 127, 0, 0, 0, 0]), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(payload.length); return b; })()]);
      socket.write(Buffer.concat([header, payload]));
    };
    const event = (method, params) => send({ method, params, sessionId: "session-1" });
    const current = () => pages[page.url] ?? { title: "", texts: [] };
    const load = (url, record = true) => {
      page.url = url;
      if (record) {
        page.history = [...page.history.slice(0, page.index + 1), url];
        page.index = page.history.length - 1;
      }
      const fixture = current();
      setImmediate(() => {
        event("Page.frameStartedLoading", { frameId: "frame-1" });
        event("Network.requestWillBeSent", { requestId: "doc", type: "Document", request: { url } });
        event("Network.responseReceived", { requestId: "doc", type: "Document", response: { url, status: fixture.status ?? 200 } });
        event("Network.loadingFinished", { requestId: "doc" });
        if (fixture.challenge) {
          event("Network.requestWillBeSent", { requestId: "cf", request: { url: `${new URL(url).origin}/cdn-cgi/challenge-platform/h/b/orchestrate` } });
          event("Network.loadingFinished", { requestId: "cf" });
        }
        event("Page.frameNavigated", { frame: { id: "frame-1", url } });
        event("Page.loadEventFired", { timestamp: 1 });
        event("Page.frameStoppedLoading", { frameId: "frame-1" });
      });
    };
    const axTree = () => {
      const fixture = current();
      const nodes = [{ nodeId: "1", role: { value: "RootWebArea" }, name: { value: fixture.title ?? "" }, backendDOMNodeId: 1 }];
      let id = 10;
      for (const text of fixture.texts ?? []) nodes.push({ nodeId: String(id), role: { value: "StaticText" }, name: { value: text }, backendDOMNodeId: id++ });
      for (const button of fixture.buttons ?? []) nodes.push({ nodeId: String(button.id), role: { value: "button" }, name: { value: button.name }, backendDOMNodeId: button.id });
      return nodes;
    };
    const handle = (message) => {
      const { id, method, params = {}, sessionId } = message;
      calls.push({ method, params, sessionId: sessionId ?? null });
      const ok = (result = {}) => send({ id, result, ...(sessionId ? { sessionId } : {}) });
      const fail = (code, text) => send({ id, error: { code, message: text }, ...(sessionId ? { sessionId } : {}) });
      if ((current().unsupported ?? []).includes(method)) return fail(-32601, `'${method}' wasn't found`);
      switch (method) {
        case "Target.createTarget": return ok({ targetId: "target-1" });
        case "Target.attachToTarget": return ok({ sessionId: "session-1" });
        case "Target.closeTarget": return ok({ success: true });
        case "Page.enable": case "DOM.enable": case "Runtime.enable": case "Accessibility.enable": case "Network.enable":
          return ok();
        case "Page.navigate":
          if (!pages[params.url]) return ok({ frameId: "frame-1", errorText: "net::ERR_NAME_NOT_RESOLVED" });
          ok({ frameId: "frame-1", loaderId: "loader" });
          return load(params.url);
        case "Page.reload": ok(); return load(page.url, false);
        case "Page.getNavigationHistory":
          return ok({ currentIndex: page.index, entries: page.history.map((url, index) => ({ id: index + 1, url, title: "" })) });
        case "Page.navigateToHistoryEntry":
          page.index = params.entryId - 1; ok(); return load(page.history[page.index], false);
        case "Page.getFrameTree": return ok({ frameTree: { frame: { id: "frame-1", url: page.url } } });
        case "Page.getLayoutMetrics":
          return ok({ cssLayoutViewport: { clientWidth: 1920, clientHeight: 1080 }, cssVisualViewport: { clientWidth: 1920, clientHeight: 1080 } });
        case "Accessibility.getFullAXTree": return ok({ nodes: axTree() });
        case "DOM.describeNode": return ok({ node: { nodeName: "BUTTON", attributes: [] } });
        // Lightpanda answers with a synthetic box far outside the viewport.
        case "DOM.getBoxModel": return ok({ model: { border: [0, 7985, 5, 7985, 5, 7990, 0, 7990] } });
        case "DOM.resolveNode": return ok({ object: { objectId: `node-${params.backendNodeId}` } });
        case "DOM.focus": return ok();
        case "Runtime.callFunctionOn": {
          const nodeId = Number(String(params.objectId).replace("node-", ""));
          if (String(params.functionDeclaration).includes("this.click()")) {
            clicks.push(nodeId);
            const button = (current().buttons ?? []).find((candidate) => candidate.id === nodeId);
            if (button?.opens) load(button.opens);
          }
          return ok({ result: { type: "undefined" } });
        }
        case "Runtime.evaluate": {
          const expression = String(params.expression);
          if (expression === "document.title") return ok({ result: { type: "string", value: current().title ?? "" } });
          if (expression.includes("outerHTML.length")) return ok({ result: { type: "number", value: current().htmlChars ?? 2_000 } });
          return ok({ result: { type: "undefined" } });
        }
        case "Input.insertText": case "Input.dispatchKeyEvent": case "Input.dispatchMouseEvent": return ok();
        default: return fail(-32601, `'${method}' wasn't found`);
      }
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        const masked = (buffer[1] & 0x80) !== 0;
        const mask = masked ? buffer.subarray(offset, offset + 4) : null;
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        buffer = buffer.subarray(offset + length);
        if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
        if (opcode === 0x8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
        if (opcode === 0x1) handle(JSON.parse(payload.toString("utf8")));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `ws://127.0.0.1:${port}/`,
    calls,
    clicks,
    get connections() { return connections; },
    get openSockets() { return sockets.size; },
    /** The engine process dies: every connection drops at once. */
    crash() { for (const socket of sockets) socket.destroy(); },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
