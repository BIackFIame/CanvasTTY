import { createHash } from "node:crypto";
import type { PluginDataClass } from "../../shared/contracts";
import type { SharedReadRoute } from "./PluginManager.ts";

/**
 * Shared reads between plugins (`plugins.request`): one plugin's service reads data another plugin's service chose
 * to share, pair by pair, after the person approved the pair.
 *
 * The host is the only path. It decides from its own registry on every call (never from the request) whether the
 * pair stands, sends the provider a host-only `canvastty.shares.read`, and checks the answer before the consumer
 * sees any of it: JSON, at most 256 KB, and no secret the redaction registry knows or recognises. Reads only: there
 * is no write, no stream and no subscription. Each call is logged under both plugins with hashes, never contents.
 */

export const SHARED_READ_TIMEOUT_MS = 5_000;
export const SHARED_READ_MAX_RESULT_BYTES = 256 * 1024;
export const SHARED_READ_MAX_PARAMS_BYTES = 16 * 1024;
/** Calls per minute one consumer plugin may make to one provider method. */
export const SHARED_READ_PER_MINUTE = 60;
/** Calls one consumer plugin may have open at once to one provider method. */
export const SHARED_READ_CONCURRENT_PER_PAIR = 4;
/** Calls one provider may be answering at once, across all consumers. */
export const SHARED_READ_CONCURRENT_PER_PROVIDER = 8;

export type SharedReadReason =
  | "invalid_request"
  | "consumer_unavailable"
  | "not_declared"
  | "not_shared"
  | "not_approved"
  | "approval_changed"
  | "provider_unavailable"
  | "rate_limited"
  | "busy"
  | "timeout"
  | "provider_error"
  | "not_json"
  | "too_large"
  | "secret_in_response";

const REASON_TEXT: Record<SharedReadReason, string> = {
  invalid_request: "The request must name a plugin and a method, with JSON params of at most 16 KB.",
  consumer_unavailable: "This plugin is not enabled with its native code trusted.",
  not_declared: "This plugin does not declare that read in its manifest's uses.",
  not_shared: "The other plugin is not installed or does not share that method.",
  not_approved: "The person has not approved this plugin reading that data.",
  approval_changed: "The other plugin changed what it shares; the person has to approve the read again.",
  provider_unavailable: "The other plugin is disabled, not trusted or its service is not running.",
  rate_limited: `At most ${SHARED_READ_PER_MINUTE} reads per minute per pair.`,
  busy: "Too many reads are waiting for the other plugin.",
  timeout: `The other plugin did not answer within ${SHARED_READ_TIMEOUT_MS / 1000} s.`,
  provider_error: "The other plugin answered with an error.",
  not_json: "The other plugin's answer is not plain JSON.",
  too_large: `The other plugin's answer is larger than ${SHARED_READ_MAX_RESULT_BYTES / 1024} KB.`,
  secret_in_response: "The other plugin's answer contained a secret; nothing was passed on."
};

/** A refusal the service sees as a JSON-RPC error with `data: { reason }`. */
export class SharedReadError extends Error {
  readonly reason: SharedReadReason;
  constructor(reason: SharedReadReason) {
    super(`${reason}: ${REASON_TEXT[reason]}`);
    this.reason = reason;
  }
}

export interface SharedReadResult {
  plugin: string;
  method: string;
  dataClass?: PluginDataClass;
  data: unknown;
}

export interface PluginSharedReadsDeps {
  /** Where the pair goes now, from the host registry (PluginManager.sharedReadRoute). */
  route(consumerId: string, provider: string, method: string): SharedReadRoute;
  /** The provider service is running. */
  running(pluginId: string, serviceId: string): boolean;
  /** A host-only call to the provider's service (`canvastty.shares.read`). */
  call(pluginId: string, serviceId: string, params: unknown, timeoutMs: number): Promise<unknown>;
  /** True when the text holds a value the redaction registry would mask. */
  containsSecret(text: string): boolean;
  /** A line in a plugin's bounded service log (shown under the plugin in Settings). */
  audit(pluginId: string, serviceId: string, level: "info" | "warn", message: string): void;
  now?(): number;
}

export class PluginSharedReads {
  private readonly deps: PluginSharedReadsDeps;
  private readonly now: () => number;
  /** `<consumer> <provider> <method>` -> start times of the calls in the last minute. */
  private readonly recent = new Map<string, number[]>();
  private readonly openPerPair = new Map<string, number>();
  private readonly openPerProvider = new Map<string, number>();
  /** Pairs whose rate-limit refusal was logged this minute: one line, not one per refused call. */
  private readonly limitLogged = new Map<string, number>();

  constructor(deps: PluginSharedReadsDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** `plugins.request` from a consumer's service; undefined for a method this module does not answer. */
  handle(consumerId: string, consumerServiceId: string, method: string, params: unknown): Promise<SharedReadResult> | undefined {
    if (method !== "plugins.request") return undefined;
    return this.request(consumerId, consumerServiceId, params);
  }

  private async request(consumerId: string, consumerServiceId: string, params: unknown): Promise<SharedReadResult> {
    const request = parseRequest(params);
    if (!request) {
      this.deps.audit(consumerId, consumerServiceId, "warn", "Shared read refused: invalid_request.");
      throw new SharedReadError("invalid_request");
    }
    const { provider, method, paramsText } = request;
    const label = `${method} from ${provider}`;
    const route = this.deps.route(consumerId, provider, method);
    if (!route.ok) {
      this.deps.audit(consumerId, consumerServiceId, "warn", `Shared read ${label} refused: ${route.reason}.`);
      throw new SharedReadError(route.reason);
    }
    if (!this.deps.running(provider, route.serviceId)) {
      this.deps.audit(consumerId, consumerServiceId, "warn", `Shared read ${label} refused: provider_unavailable.`);
      throw new SharedReadError("provider_unavailable");
    }
    const pair = `${consumerId} ${provider} ${method}`;
    const now = this.now();
    const recent = (this.recent.get(pair) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= SHARED_READ_PER_MINUTE) {
      this.recent.set(pair, recent);
      if (now - (this.limitLogged.get(pair) ?? -Infinity) >= 60_000) {
        this.limitLogged.set(pair, now);
        this.deps.audit(consumerId, consumerServiceId, "warn", `Shared read ${label} refused: rate_limited (further refusals this minute are not logged).`);
      }
      throw new SharedReadError("rate_limited");
    }
    if ((this.openPerPair.get(pair) ?? 0) >= SHARED_READ_CONCURRENT_PER_PAIR
      || (this.openPerProvider.get(provider) ?? 0) >= SHARED_READ_CONCURRENT_PER_PROVIDER) {
      this.deps.audit(consumerId, consumerServiceId, "warn", `Shared read ${label} refused: busy.`);
      throw new SharedReadError("busy");
    }
    recent.push(now);
    this.recent.set(pair, recent);
    this.adjust(this.openPerPair, pair, 1);
    this.adjust(this.openPerProvider, provider, 1);
    const started = this.now();
    const paramsHash = shortHash(paramsText);
    const finish = (level: "info" | "warn", outcome: string, answer?: { bytes: number; hash: string }): void => {
      const detail = `${outcome} · ${this.now() - started} ms · params ${paramsHash}${answer ? ` · answer ${answer.bytes} bytes ${answer.hash}` : ""}`;
      this.deps.audit(consumerId, consumerServiceId, level, `Shared read ${label}: ${detail}.`);
      this.deps.audit(provider, route.serviceId, level, `Shared read ${method} by ${consumerId}: ${detail}.`);
    };
    try {
      let answer: unknown;
      try {
        answer = await this.deps.call(provider, route.serviceId, {
          caller: { pluginId: consumerId },
          method,
          params: request.params
        }, SHARED_READ_TIMEOUT_MS);
      } catch (error) {
        const reason: SharedReadReason = /timed out/i.test(error instanceof Error ? error.message : "") ? "timeout"
          : /not running|stopped/i.test(error instanceof Error ? error.message : "") ? "provider_unavailable"
            : /busy/i.test(error instanceof Error ? error.message : "") ? "busy" : "provider_error";
        finish("warn", `refused: ${reason}`);
        throw new SharedReadError(reason);
      }
      let text: string;
      try {
        text = JSON.stringify(answer ?? null);
      } catch {
        finish("warn", "refused: not_json");
        throw new SharedReadError("not_json");
      }
      const bytes = Buffer.byteLength(text, "utf8");
      const hash = shortHash(text);
      if (bytes > SHARED_READ_MAX_RESULT_BYTES) {
        finish("warn", "refused: too_large", { bytes, hash });
        throw new SharedReadError("too_large");
      }
      if (this.deps.containsSecret(text)) {
        finish("warn", "refused: secret_in_response", { bytes, hash });
        throw new SharedReadError("secret_in_response");
      }
      // Recheck after the wait: a pair revoked, or a plugin disabled, while the provider answered gets nothing.
      const still = this.deps.route(consumerId, provider, method);
      if (!still.ok) {
        finish("warn", `refused: ${still.reason}`, { bytes, hash });
        throw new SharedReadError(still.reason);
      }
      finish("info", "ok", { bytes, hash });
      return {
        plugin: provider,
        method,
        ...(still.dataClass ? { dataClass: still.dataClass } : {}),
        data: JSON.parse(text) as unknown
      };
    } finally {
      this.adjust(this.openPerPair, pair, -1);
      this.adjust(this.openPerProvider, provider, -1);
    }
  }

  private adjust(counts: Map<string, number>, key: string, delta: number): void {
    const next = (counts.get(key) ?? 0) + delta;
    if (next <= 0) counts.delete(key);
    else counts.set(key, next);
  }
}

function parseRequest(params: unknown): { provider: string; method: string; params: unknown; paramsText: string } | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const values = params as Record<string, unknown>;
  if (Object.keys(values).some((key) => key !== "plugin" && key !== "method" && key !== "params")) return null;
  if (typeof values.plugin !== "string" || values.plugin.length === 0 || values.plugin.length > 80) return null;
  if (typeof values.method !== "string" || values.method.length === 0 || values.method.length > 64) return null;
  const body = values.params === undefined ? null : values.params;
  let paramsText: string;
  try {
    paramsText = JSON.stringify(body);
  } catch {
    return null;
  }
  if (Buffer.byteLength(paramsText, "utf8") > SHARED_READ_MAX_PARAMS_BYTES) return null;
  return { provider: values.plugin, method: values.method, params: body, paramsText };
}

/** The first 16 hex characters of a SHA-256: enough to match log lines, never the content. */
function shortHash(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}
