import { createServer } from "node:http";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const directory = resolve(process.env.REPORTS_DIRECTORY || "./diagnostic-reports");
const port = Number(process.env.PORT || 8787);
const MAX_BODY = 5 * 1024 * 1024;
const MAX_INFLATED = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const STORAGE_BYTES = 512 * 1024 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REPORTS = 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const buckets = new Map();
let active = 0;
let storageQueue = Promise.resolve();

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
await mkdir(directory, { recursive: true, mode: 0o700 });

function serialized(task) {
  const result = storageQueue.then(task);
  storageQueue = result.catch(error => console.error("Report storage failed:", error.code || error.name));
  return result;
}

async function prune(reserveBytes = 0, reserveCount = 0) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json.gz") || !UUID.test(entry.name.slice(0, -8))) continue;
    const path = join(directory, entry.name);
    const info = await stat(path);
    files.push({ path, size: info.size, modified: info.mtimeMs });
  }
  files.sort((a, b) => a.modified - b.modified);
  let bytes = files.reduce((sum, file) => sum + file.size, 0);
  let count = files.length;
  for (const file of files) {
    if (Date.now() - file.modified < RETENTION_MS && bytes + reserveBytes <= STORAGE_BYTES && count + reserveCount <= MAX_REPORTS) break;
    await rm(file.path);
    bytes -= file.size;
    count -= 1;
  }
}

await serialized(() => prune());
setInterval(() => {
  for (const [ip, bucket] of buckets) if (Date.now() - bucket.since > 60_000) buckets.delete(ip);
  void serialized(() => prune()).catch(() => undefined);
}, 60_000).unref();

function reply(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(value));
}

function limited(ip) {
  let bucket = buckets.get(ip);
  if (!bucket || Date.now() - bucket.since > 60_000) {
    if (!bucket && buckets.size >= 10_000) return true;
    bucket = { since: Date.now(), count: 0 };
    buckets.set(ip, bucket);
  }
  return ++bucket.count > 5;
}

function validAttachment(image) {
  if (image === undefined) return true;
  if (!image || typeof image !== "object" || Array.isArray(image)
    || (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg") || typeof image.base64 !== "string"
    || image.base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return false;
  const bytes = Buffer.from(image.base64, "base64");
  const signature = image.mimeType === "image/png" ? Buffer.from("89504e470d0a1a0a", "hex") : Buffer.from("ffd8ff", "hex");
  return bytes.length <= MAX_IMAGE_BYTES && bytes.toString("base64") === image.base64
    && bytes.subarray(0, signature.length).equals(signature);
}

function validReport(report) {
  return report && typeof report === "object" && report.formatVersion === 1 && typeof report.reportId === "string" && UUID.test(report.reportId)
    && typeof report.description === "string" && report.description.trim().length >= 5 && report.description.length <= 8000
    && report.context && typeof report.context === "object" && !Array.isArray(report.context)
    && Array.isArray(report.logs) && report.logs.length <= 4 && report.logs.every(log => log
      && typeof log.name === "string" && /^application(?:\.[0-3])?\.jsonl$/.test(log.name)
      && typeof log.content === "string" && Buffer.byteLength(log.content) <= 2 * 1024 * 1024)
    && validAttachment(report.attachment);
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") return reply(response, 200, { ok: true });
  if (request.method !== "POST" || request.url !== "/reports") return reply(response, 404, { error: "Not found" });
  // The HTTPS proxy must overwrite X-Real-IP. This listener is never exposed directly.
  const ip = String(request.headers["x-real-ip"] || request.socket.remoteAddress).slice(0, 128);
  if (limited(ip)) return reply(response, 429, { error: "Too many reports" });
  if (active >= 2) return reply(response, 503, { error: "Please retry later" });
  if (request.headers.origin || request.headers["content-type"] !== "application/json"
    || request.headers["content-encoding"] !== "gzip" || request.headers["x-canvastty-report-version"] !== "1") {
    return reply(response, 415, { error: "Unsupported report format" });
  }
  if (Number(request.headers["content-length"]) > MAX_BODY) return reply(response, 413, { error: "Report too large" });
  active += 1;
  try {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > MAX_BODY) {
        reply(response, 413, { error: "Report too large" });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    }
    let report;
    try {
      const decoded = await decompress(Buffer.concat(chunks), { maxOutputLength: MAX_INFLATED });
      report = JSON.parse(decoded.toString("utf8"));
    } catch { return reply(response, 400, { error: "Invalid or oversized report" }); }
    if (!validReport(report)) return reply(response, 400, { error: "Invalid report" });
    const payload = await compress(Buffer.from(JSON.stringify({ receivedAt: new Date().toISOString(), report })));
    await serialized(async () => {
      const path = join(directory, `${report.reportId}.json.gz`);
      const existing = await readFile(path).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (existing) {
        const saved = JSON.parse((await decompress(existing, { maxOutputLength: MAX_INFLATED + 1024 })).toString("utf8"));
        if (JSON.stringify(saved.report) !== JSON.stringify(report)) throw Object.assign(new Error("Duplicate report identifier"), { code: "EEXIST" });
        return;
      }
      await prune(payload.length, 1);
      await writeFile(path, payload, { flag: "wx", mode: 0o600 });
    });
    console.info("Diagnostic report accepted:", report.reportId);
    reply(response, 201, { reportId: report.reportId });
  } catch (error) {
    console.error("Diagnostic report failed:", error.code || error.name);
    if (!response.writableEnded && !response.destroyed) reply(response, error.code === "EEXIST" ? 409 : 500, { error: "Could not store report" });
  } finally { active -= 1; }
});

server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(port, "127.0.0.1", () => console.info(`CanvasTTY report collector: 127.0.0.1:${port}`));
