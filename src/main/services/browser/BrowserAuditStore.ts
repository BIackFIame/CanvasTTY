import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { appendFile, mkdir, open, readFile, readdir, rename, stat, truncate, unlink } from "node:fs/promises";
import { canonicalStringify } from "../../../agent-browser/tool-catalog.mjs";
import { hasSensitiveAssignment, isSensitiveName } from "../safety/sensitiveNames.ts";

const AUDIT_VERSION = 1;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const REDACTED = "[REDACTED]";
// Page content an audit record must not carry, on top of the shared sensitive names.
const CONTENT_KEY = /^(?:promptText|text|value|values|page|base64|screenshot)$/i;

export interface BrowserAuditInput {
  timestamp?: number;
  requestId: string;
  actorKind: "human" | "agent";
  actorId: string;
  provider?: string | null;
  terminalSessionId?: string | null;
  operation: string;
  phase: "attempt" | "result";
  tabId?: string | null;
  ok?: boolean;
  errorCode?: string | null;
  origin?: string | null;
  targetHash?: string | null;
  revisionBefore?: number | null;
  revisionAfter?: number | null;
  durationMs?: number | null;
  details?: unknown;
}

export interface BrowserAuditRecord {
  version: typeof AUDIT_VERSION;
  sequence: number;
  timestamp: number;
  requestId: string;
  actorKind: "human" | "agent";
  actorId: string;
  provider: string | null;
  terminalSessionId: string | null;
  operation: string;
  phase: "attempt" | "result";
  tabId: string | null;
  ok: boolean | null;
  errorCode: string | null;
  origin: string | null;
  targetHash: string | null;
  revisionBefore: number | null;
  revisionAfter: number | null;
  durationMs: number | null;
  result: "attempt" | "ok" | "error";
  details: unknown;
  previousHash: string | null;
  hash: string;
}

export interface BrowserAuditStoreOptions {
  maxBytes?: number;
  retentionMs?: number;
  now?: () => number;
}

export class BrowserAuditStore {
  readonly filePath: string;
  private readonly maxBytes: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private writeQueue = Promise.resolve();
  private initialized: Promise<void> | null = null;
  private sequence = 0;
  private previousHash: string | null = null;
  private integrityError: Error | null = null;

  constructor(userDataPath: string, options: BrowserAuditStoreOptions = {}) {
    this.filePath = join(userDataPath, "browser", "audit", "browser-audit.jsonl");
    this.maxBytes = Math.max(1_024, options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.retentionMs = Math.max(1_000, options.retentionMs ?? DEFAULT_RETENTION_MS);
    this.now = options.now ?? Date.now;
  }

  async append(input: BrowserAuditInput): Promise<BrowserAuditRecord> {
    const result = this.writeQueue.then(async () => {
      await this.ensureInitialized();
      if (this.integrityError) throw this.integrityError;
      const recordBase = {
        version: AUDIT_VERSION,
        sequence: this.sequence + 1,
        timestamp: Number.isFinite(input.timestamp) ? input.timestamp! : this.now(),
        requestId: safeString(input.requestId, 128),
        actorKind: input.actorKind,
        actorId: safeString(input.actorId, 160),
        provider: input.provider ? safeString(input.provider, 40) : null,
        terminalSessionId: input.terminalSessionId ? safeString(input.terminalSessionId, 160) : null,
        operation: safeString(input.operation, 80),
        phase: input.phase,
        tabId: input.tabId ? safeString(input.tabId, 128) : null,
        ok: typeof input.ok === "boolean" ? input.ok : null,
        errorCode: input.errorCode ? safeString(input.errorCode, 80) : null,
        origin: input.origin ? redactUrl(input.origin) : null,
        targetHash: input.targetHash ? safeString(input.targetHash, 128) : null,
        revisionBefore: finiteInteger(input.revisionBefore),
        revisionAfter: finiteInteger(input.revisionAfter),
        durationMs: finiteNumber(input.durationMs),
        result: input.phase === "attempt" ? "attempt" : input.ok ? "ok" : "error",
        details: redactAuditValue(input.details ?? null),
        previousHash: this.previousHash
      } satisfies Omit<BrowserAuditRecord, "hash">;
      const hash = hashRecord(recordBase);
      const record: BrowserAuditRecord = { ...recordBase, hash };
      const line = `${JSON.stringify(record)}\n`;
      await this.rotateIfNeeded(Buffer.byteLength(line));
      await mkdir(dirname(this.filePath), { recursive: true });
      const handle = await open(this.filePath, "a", 0o600);
      try {
        const sizeBefore = (await handle.stat()).size;
        try {
          await handle.writeFile(line, "utf8");
          await handle.sync();
        } catch (error) {
          // A partial append (ENOSPC) would merge with the next record and break
          // the chain for good; cut the file back to the last whole record.
          await handle.truncate(sizeBefore).catch(() => undefined);
          throw error;
        }
      } finally {
        await handle.close();
      }
      this.sequence = record.sequence;
      this.previousHash = record.hash;
      return structuredClone(record);
    });
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async verify(): Promise<{ valid: boolean; records: number; lastHash: string | null }> {
    await this.ensureInitialized();
    const files = await this.auditFiles();
    let previousHash: string | null = null;
    let records = 0;
    for (const path of files) {
      const content = await readFile(path, "utf8").catch(() => "");
      for (const line of content.split("\n")) {
        if (!line) continue;
        let record: BrowserAuditRecord;
        try {
          record = JSON.parse(line) as BrowserAuditRecord;
        } catch {
          return { valid: false, records, lastHash: previousHash };
        }
        const { hash, ...base } = record;
        if ((records > 0 && record.previousHash !== previousHash) || !recordHashMatches(base, hash)) {
          return { valid: false, records, lastHash: previousHash };
        }
        previousHash = hash;
        records += 1;
      }
    }
    return { valid: true, records, lastHash: previousHash };
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initialized) this.initialized = this.initialize();
    return this.initialized;
  }

  private async initialize(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await this.repairTornTail();
    await this.pruneExpired();
    const files = await this.auditFiles();
    let previousHash: string | null = null;
    let sequence = 0;
    let records = 0;
    for (const path of files) {
      const content = await readFile(path, "utf8").catch(() => "");
      for (const line of content.split("\n")) {
        if (!line) continue;
        try {
          const record = JSON.parse(line) as BrowserAuditRecord;
          const { hash, ...base } = record;
          if ((records > 0 && record.previousHash !== previousHash) || !recordHashMatches(base, hash)) {
            throw new Error("Browser audit hash chain is invalid.");
          }
          previousHash = hash;
          sequence = Math.max(sequence, record.sequence);
          records += 1;
        } catch (error) {
          this.integrityError = error instanceof Error ? error : new Error("Browser audit log is invalid.");
          return;
        }
      }
    }
    this.previousHash = previousHash;
    this.sequence = sequence;
  }

  /**
   * Every append ends with a newline, so an active file without one was cut
   * during a write (crash, full disk). A last record that is whole only gets
   * its newline back; a partial one is removed. Anything else that does not
   * verify still fails closed.
   */
  private async repairTornTail(): Promise<void> {
    let content: Buffer;
    try {
      content = await readFile(this.filePath);
    } catch {
      return;
    }
    if (content.length === 0 || content[content.length - 1] === 0x0a) return;
    const lineStart = content.lastIndexOf(0x0a) + 1;
    const tail = content.subarray(lineStart).toString("utf8");
    let whole = false;
    try {
      const { hash, ...base } = JSON.parse(tail) as BrowserAuditRecord;
      whole = recordHashMatches(base, hash);
    } catch {
      whole = false;
    }
    if (whole) {
      await appendFile(this.filePath, "\n", { mode: 0o600 });
      return;
    }
    console.warn(`CanvasTTY removed a browser audit record cut off during a write (${content.length - lineStart} bytes).`);
    await truncate(this.filePath, lineStart);
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    let currentBytes = 0;
    try {
      currentBytes = (await stat(this.filePath)).size;
    } catch {
      currentBytes = 0;
    }
    if (currentBytes === 0 || currentBytes + incomingBytes <= this.maxBytes) return;
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
    const rotated = join(dirname(this.filePath), `browser-audit-${stamp}-${this.sequence}.jsonl`);
    await rename(this.filePath, rotated);
    await this.pruneExpired();
  }

  private async pruneExpired(): Promise<void> {
    const directory = dirname(this.filePath);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const cutoff = this.now() - this.retentionMs;
    for (const entry of entries) {
      if (!entry.isFile() || !/^browser-audit-.+\.jsonl$/.test(entry.name)) continue;
      const path = join(directory, entry.name);
      const metadata = await stat(path).catch(() => null);
      if (metadata && metadata.mtimeMs < cutoff) await unlink(path).catch(() => undefined);
    }
  }

  private async auditFiles(): Promise<string[]> {
    const directory = dirname(this.filePath);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const rotated = entries
      .filter((entry) => entry.isFile() && /^browser-audit-.+\.jsonl$/.test(entry.name))
      .map((entry) => join(directory, entry.name))
      .sort((left, right) => byCodeUnit(basename(left), basename(right)));
    try {
      await stat(this.filePath);
      rotated.push(this.filePath);
    } catch {
      // The active file is created on the first append.
    }
    return rotated;
  }
}

export function redactAuditValue(value: unknown, key = "", depth = 0): unknown {
  if (CONTENT_KEY.test(key) || isSensitiveName(key)) return REDACTED;
  if (depth > 6) return "[TRUNCATED]";
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) return redactUrl(value);
    if (/^(?:bearer|basic)\s+/i.test(value) || hasSensitiveAssignment(value)) return REDACTED;
    return value.slice(0, 2_048);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => redactAuditValue(item, key, depth + 1));
  if (!value || typeof value !== "object") return String(value ?? "");
  const result: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value).slice(0, 64)) {
    result[entryKey] = redactAuditValue(entryValue, entryKey, depth + 1);
  }
  return result;
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return REDACTED;
  }
}

function hashRecord(record: Omit<BrowserAuditRecord, "hash">): string {
  return createHash("sha256").update(canonicalStringify(record, { lenient: true })).digest("hex");
}

/**
 * Records written before keys were sorted by code unit were hashed with
 * localeCompare, whose order follows the system locale. They are still
 * accepted when they verify under the current locale, as they did before.
 */
function recordHashMatches(record: Omit<BrowserAuditRecord, "hash">, hash: unknown): boolean {
  if (typeof hash !== "string") return false;
  return hashRecord(record) === hash
    || createHash("sha256").update(canonicalStringify(record, { lenient: true, compareKeys: byLocale })).digest("hex") === hash;
}

const byCodeUnit = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const byLocale = (left: string, right: string): number => left.localeCompare(right);

function safeString(value: string, max: number): string {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}

function finiteInteger(value: number | null | undefined): number | null {
  return Number.isInteger(value) ? value! : null;
}

function finiteNumber(value: number | null | undefined): number | null {
  return Number.isFinite(value) ? Math.max(0, value!) : null;
}
