import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { BrokerAddressError, createBrokerTransport, type BrokerTransport } from "./brokerTransport.ts";

/**
 * Brokered model requests (`accounts.*`, B6): one plugin's service (the caller, with `accounts:broker`) sends a model
 * request through an account another plugin's service (the owner, a `brokerable` service with `secrets`) offers,
 * without ever seeing the account's key.
 *
 * - The owner offers accounts on `canvastty.broker.offer` (host-only); the host asks again for every request, so an
 *   account the owner stops offering, or an owner that stops running or is no longer trusted, ends at once.
 * - The person grants each caller -> account pair (PluginManager stores it). The grant pins the owner's source and
 *   the account's origin, protocol and auth scheme; a change suspends it until the person allows it again.
 * - The host builds the request itself: POST (GET for /models) to the offer's base URL plus an allowed path, with
 *   only content-type, accept, the auth header and anthropic-version, the key read here in the main process. No
 *   caller header, query, method or destination exists in the request; a model outside the offer is refused.
 * - The answer streams back as `canvastty.accounts.head|chunk|end` notifications with the key masked; only the
 *   status, content type and retry-after reach the caller. The owner admits (quota, budget) and settles each request.
 * - Each request is logged under both plugins with sizes, usage and a hash of the body; never the text.
 */

export const BROKER_PATHS = ["/chat/completions", "/responses", "/messages", "/models"] as const;
export type BrokerPath = typeof BROKER_PATHS[number];

export const BROKER_LIMITS = Object.freeze({
  maxBodyBytes: 8 * 1024 * 1024,
  maxResponseBytes: 64 * 1024 * 1024,
  /** One part of a body sent with `accounts.body` (under the 1 MB message limit). */
  maxPartChars: 768 * 1024,
  maxUploadsPerCaller: 4,
  uploadMs: 60_000,
  openPerPair: 4,
  perMinutePerPair: 60,
  idleMs: 120_000,
  totalMs: 30 * 60_000,
  offerMs: 3_000,
  admitMs: 1_000,
  settleMs: 3_000,
  /** An open request asks the owner's offer again this often; an account dropped meanwhile ends it. */
  recheckMs: 20_000,
  maxOffers: 32,
  errorChars: 300,
  /** Characters per chunk notification: even fully escaped JSON (6 bytes each) stays under the 1 MB frame. */
  chunkChars: 96 * 1024,
  /** A caller that does not read its notifications for this long loses the request. */
  deliverMs: 30_000
});
export type BrokerLimits = typeof BROKER_LIMITS;

export type BrokerReason =
  | "invalid_request"
  | "caller_unavailable"
  | "not_granted"
  | "grant_changed"
  | "owner_unavailable"
  | "account_unknown"
  | "path_refused"
  | "model_refused"
  | "too_large"
  | "rate_limited"
  | "budget_refused"
  | "upstream"
  | "network"
  | "timeout"
  | "cancelled";

const REASON_TEXT: Record<BrokerReason, string> = {
  invalid_request: "The request must be { ref, path, body?, stream?, requestId } with nothing else.",
  caller_unavailable: "This plugin is not enabled with its native code trusted and the accounts:broker permission.",
  not_granted: "The person has not allowed this plugin to use that account.",
  grant_changed: "The account's address, protocol or sign-in changed since the person allowed it; they have to allow it again.",
  owner_unavailable: "The plugin that owns the account is disabled, not trusted, not running, or no longer offers it.",
  account_unknown: "No such account is offered.",
  path_refused: "That path is not offered for this account.",
  model_refused: "That model is not offered for this account.",
  too_large: "The request or the answer is too large.",
  rate_limited: `At most ${BROKER_LIMITS.openPerPair} open and ${BROKER_LIMITS.perMinutePerPair} requests per minute per account.`,
  budget_refused: "The plugin that owns the account refused the request (quota or budget).",
  upstream: "The model provider answered with an error.",
  network: "The model provider could not be reached.",
  timeout: "The model provider did not answer in time.",
  cancelled: "The request was cancelled."
};

/** A refusal the caller's service sees as a JSON-RPC error with `data: { reason }`. */
export class BrokerError extends Error {
  readonly reason: BrokerReason;
  constructor(reason: BrokerReason, detail?: string) {
    super(`${reason}: ${detail ?? REASON_TEXT[reason]}`);
    this.reason = reason;
  }
}

export interface BrokerOffer {
  id: string;
  label: string;
  protocol: "openai" | "anthropic";
  /** Normalized: no trailing slash. */
  baseUrl: string;
  origin: string;
  paths: BrokerPath[];
  models: string[];
  /** The owner's secret holding the key, or null for a keyless account (only those may be on loopback http). */
  secretKey: string | null;
  auth: "bearer" | "x-api-key" | null;
  flatRate: boolean;
  /** http on 127.0.0.1 or [::1]: always keyless, so no credential can reach a process squatting the port. */
  loopback: boolean;
}

/** What a caller and the person see of an offer: never the secret's name or value. */
export interface BrokerAccountView {
  ref: string;
  owner: string;
  ownerName: string;
  id: string;
  label: string;
  protocol: BrokerOffer["protocol"];
  origin: string;
  paths: BrokerPath[];
  models: string[];
  flatRate: boolean;
}

export interface BrokerOwner {
  pluginId: string;
  serviceId: string;
  name: string;
  sourceUrl: string;
}

export interface BrokerCaller {
  pluginId: string;
  name: string;
  /** Enabled, native code trusted and holding accounts:broker. */
  ready: boolean;
}

export interface BrokerUsage {
  input: number;
  output: number;
  cached: number;
}

export interface PluginAccountBrokerDeps {
  /** Owners that may offer now: enabled, trusted, a trusted brokerable service, the secrets permission. */
  owners(): BrokerOwner[];
  /** Plugins that declare accounts:broker (for the person's grant list), with whether they may call now. */
  callers(): BrokerCaller[];
  /** The stored grant fingerprint of a caller -> account pair (PluginManager), if any. */
  grant(callerId: string, ownerId: string, accountId: string): string | undefined;
  /** Stores (or with null removes) a grant; PluginManager checks the caller and the owner itself. */
  saveGrant(callerId: string, ownerId: string, accountId: string, fingerprint: string | null): Promise<void>;
  running(pluginId: string, serviceId: string): boolean;
  call(pluginId: string, serviceId: string, method: `canvastty.${string}`, params: unknown, timeoutMs: number): Promise<unknown>;
  notify(pluginId: string, serviceId: string, method: `canvastty.${string}`, params: unknown): boolean;
  /** The owner's own secret, read in the main process (never sent to any service). */
  secret(ownerId: string, key: string): Promise<string | null>;
  /** Adds the value to the redaction registry (masked in every text agents read). */
  registerSecret(ownerId: string, value: string): void;
  /** The redaction registry's masking. */
  redact(text: string): string;
  audit(pluginId: string, serviceId: string, level: "info" | "warn", message: string): void;
  transport?: BrokerTransport;
  now?(): number;
  limits?: Partial<BrokerLimits>;
}

interface OpenRequest {
  requestId: string;
  callerId: string;
  callerServiceId: string;
  owner: BrokerOwner;
  accountId: string;
  fingerprint: string;
  pair: string;
  controller: AbortController;
  /** Why the request was ended from outside (revoked, cancelled, owner gone); null while it runs. */
  ended: { reason: BrokerReason; notify: boolean } | null;
}

interface Upload {
  parts: string[];
  chars: number;
  timer: NodeJS.Timeout;
}

const KEY_MASK = "[redacted]";
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const ACCOUNT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SECRET_KEY = /^[A-Za-z0-9._-]{1,80}$/;

export class PluginAccountBroker {
  private readonly deps: PluginAccountBrokerDeps;
  private readonly limits: BrokerLimits;
  private readonly now: () => number;
  private readonly transport: BrokerTransport;
  /** `<caller> <requestId>` -> the request. */
  private readonly open = new Map<string, OpenRequest>();
  private readonly openPerPair = new Map<string, number>();
  private readonly recent = new Map<string, number[]>();
  private readonly limitLogged = new Map<string, number>();
  /** `<caller> <requestId>` -> body parts sent with accounts.body. */
  private readonly uploads = new Map<string, Upload>();

  constructor(deps: PluginAccountBrokerDeps) {
    this.deps = deps;
    this.limits = { ...BROKER_LIMITS, ...(deps.limits ?? {}) };
    this.now = deps.now ?? Date.now;
    this.transport = deps.transport ?? createBrokerTransport();
  }

  /** `accounts.*` from a caller's service; undefined for a method this module does not answer. */
  handle(callerId: string, callerServiceId: string, method: string, params: unknown): Promise<unknown> | undefined {
    if (method === "accounts.list") return this.list(callerId);
    if (method === "accounts.request") return this.request(callerId, callerServiceId, params);
    if (method === "accounts.body") return Promise.resolve().then(() => this.body(callerId, params));
    if (method === "accounts.cancel") return Promise.resolve().then(() => this.cancel(callerId, params));
    return undefined;
  }

  /** The granted, currently offered accounts of every owner (never a secret name or value). */
  private async list(callerId: string): Promise<{ accounts: BrokerAccountView[] }> {
    if (!this.callerReady(callerId)) throw new BrokerError("caller_unavailable");
    const accounts: BrokerAccountView[] = [];
    await Promise.all(this.deps.owners().map(async (owner) => {
      const offers = await this.offers(owner).catch(() => [] as BrokerOffer[]);
      for (const offer of offers) {
        if (this.deps.grant(callerId, owner.pluginId, offer.id) === brokerGrantFingerprint(owner.sourceUrl, offer)) {
          accounts.push(viewOf(owner, offer));
        }
      }
    }));
    accounts.sort((left, right) => left.ref.localeCompare(right.ref));
    return { accounts };
  }

  /**
   * For the person's grant list in Settings: what an owner offers now, the plugins that may ask for grants, and
   * each pair's state.
   */
  async ownerAccounts(ownerId: string): Promise<{
    available: boolean;
    accounts: BrokerAccountView[];
    callers: BrokerCaller[];
    grants: Array<{ caller: string; account: string; state: "granted" | "changed" }>;
  }> {
    const owner = this.deps.owners().find((candidate) => candidate.pluginId === ownerId);
    const callers = this.deps.callers().filter((caller) => caller.pluginId !== ownerId);
    if (!owner || !this.deps.running(owner.pluginId, owner.serviceId)) return { available: false, accounts: [], callers, grants: [] };
    const offers = await this.offers(owner).catch(() => null);
    if (!offers) return { available: false, accounts: [], callers, grants: [] };
    const grants: Array<{ caller: string; account: string; state: "granted" | "changed" }> = [];
    for (const caller of callers) {
      for (const offer of offers) {
        const stored = this.deps.grant(caller.pluginId, ownerId, offer.id);
        if (stored) grants.push({ caller: caller.pluginId, account: offer.id, state: stored === brokerGrantFingerprint(owner.sourceUrl, offer) ? "granted" : "changed" });
      }
    }
    return { available: true, accounts: offers.map((offer) => viewOf(owner, offer)), callers, grants };
  }

  /** The person allows (or withdraws) one caller -> account pair; the pin is taken from the offer as it is now. */
  async setGrant(callerId: string, ownerId: string, accountId: string, granted: boolean): Promise<void> {
    if (!granted) {
      await this.deps.saveGrant(callerId, ownerId, accountId, null);
      this.recheck();
      return;
    }
    const owner = this.deps.owners().find((candidate) => candidate.pluginId === ownerId);
    if (!owner || !this.deps.running(owner.pluginId, owner.serviceId)) throw new Error("The plugin that owns the account is not running.");
    const offer = (await this.offers(owner)).find((candidate) => candidate.id === accountId);
    if (!offer) throw new Error("That account is not offered.");
    await this.deps.saveGrant(callerId, ownerId, accountId, brokerGrantFingerprint(owner.sourceUrl, offer));
  }

  /**
   * After any registry change (trust, enable, grants, source): open requests whose pair no longer stands end now,
   * with `not_granted` / `grant_changed` / `owner_unavailable` / `caller_unavailable`.
   */
  recheck(): void {
    for (const open of this.open.values()) {
      const reason = this.standing(open);
      if (reason) this.end(open, reason, reason !== "caller_unavailable");
    }
  }

  /** A service process ended: its requests as a caller end silently, as an owner with owner_unavailable. */
  serviceStopped(pluginId: string, serviceId: string): void {
    for (const open of this.open.values()) {
      if (open.callerId === pluginId && open.callerServiceId === serviceId) this.end(open, "cancelled", false);
      else if (open.owner.pluginId === pluginId && open.owner.serviceId === serviceId) this.end(open, "owner_unavailable", true);
    }
    for (const [key, upload] of this.uploads) {
      if (key.startsWith(`${pluginId} `)) {
        clearTimeout(upload.timer);
        this.uploads.delete(key);
      }
    }
  }

  dispose(): void {
    for (const open of this.open.values()) this.end(open, "cancelled", false);
    for (const upload of this.uploads.values()) clearTimeout(upload.timer);
    this.uploads.clear();
  }

  private callerReady(callerId: string): boolean {
    return this.deps.callers().some((caller) => caller.pluginId === callerId && caller.ready);
  }

  /** Why an open request may not go on (from the registry only), or null. */
  private standing(open: OpenRequest): BrokerReason | null {
    if (!this.callerReady(open.callerId)) return "caller_unavailable";
    const owner = this.deps.owners().find((candidate) => candidate.pluginId === open.owner.pluginId);
    if (!owner || owner.serviceId !== open.owner.serviceId || owner.sourceUrl !== open.owner.sourceUrl) return "owner_unavailable";
    const stored = this.deps.grant(open.callerId, owner.pluginId, open.accountId);
    if (!stored) return "not_granted";
    if (stored !== open.fingerprint) return "grant_changed";
    return null;
  }

  private async offers(owner: BrokerOwner): Promise<BrokerOffer[]> {
    const answer = await this.deps.call(owner.pluginId, owner.serviceId, "canvastty.broker.offer", {}, this.limits.offerMs);
    const entries = Array.isArray(answer) ? answer : isRecord(answer) && Array.isArray(answer.accounts) ? answer.accounts : null;
    if (!entries) throw new Error("The owner's offer is not a list.");
    const offers: BrokerOffer[] = [];
    let dropped = 0;
    for (const entry of entries.slice(0, this.limits.maxOffers)) {
      const offer = validateBrokerOffer(entry);
      // What callers see of an offer must not carry a secret CanvasTTY knows (as for shared reads).
      const shown = offer ? JSON.stringify([offer.label, offer.models]) : "";
      if (offer && this.deps.redact(shown) === shown && !offers.some((existing) => existing.id === offer.id)) offers.push(offer);
      else dropped += 1;
    }
    if (dropped || entries.length > this.limits.maxOffers) {
      this.deps.audit(owner.pluginId, owner.serviceId, "warn", `Broker offer: ${dropped + Math.max(0, entries.length - this.limits.maxOffers)} invalid or extra entries were ignored.`);
    }
    return offers;
  }

  private body(callerId: string, params: unknown): { received: number } {
    if (!this.callerReady(callerId)) throw new BrokerError("caller_unavailable");
    if (!isRecord(params) || Object.keys(params).some((key) => key !== "requestId" && key !== "data")
      || typeof params.requestId !== "string" || !REQUEST_ID.test(params.requestId) || typeof params.data !== "string"
      || params.data.length > this.limits.maxPartChars) {
      throw new BrokerError("invalid_request", "accounts.body takes { requestId, data } with at most 768 K characters of data.");
    }
    const key = `${callerId} ${params.requestId}`;
    let upload = this.uploads.get(key);
    if (!upload) {
      if ([...this.uploads.keys()].filter((candidate) => candidate.startsWith(`${callerId} `)).length >= this.limits.maxUploadsPerCaller) {
        throw new BrokerError("rate_limited", `At most ${this.limits.maxUploadsPerCaller} bodies may be waiting at once.`);
      }
      const timer = setTimeout(() => this.uploads.delete(key), this.limits.uploadMs);
      timer.unref();
      upload = { parts: [], chars: 0, timer };
      this.uploads.set(key, upload);
    }
    upload.parts.push(params.data);
    upload.chars += params.data.length;
    if (Buffer.byteLength(upload.parts.join(""), "utf8") > this.limits.maxBodyBytes) {
      clearTimeout(upload.timer);
      this.uploads.delete(key);
      throw new BrokerError("too_large", `A request body is at most ${this.limits.maxBodyBytes / 1024 / 1024} MB.`);
    }
    return { received: upload.chars };
  }

  private cancel(callerId: string, params: unknown): { cancelled: boolean } {
    if (!isRecord(params) || typeof params.requestId !== "string") throw new BrokerError("invalid_request", "accounts.cancel takes { requestId }.");
    const open = this.open.get(`${callerId} ${params.requestId}`);
    if (open) this.end(open, "cancelled", true);
    const upload = this.uploads.get(`${callerId} ${params.requestId}`);
    if (upload) {
      clearTimeout(upload.timer);
      this.uploads.delete(`${callerId} ${params.requestId}`);
    }
    return { cancelled: Boolean(open) };
  }

  private refuse(callerId: string, serviceId: string, label: string, reason: BrokerReason, detail?: string): never {
    this.deps.audit(callerId, serviceId, "warn", `Brokered request ${label} refused: ${reason}.`);
    throw new BrokerError(reason, detail);
  }

  private async request(callerId: string, callerServiceId: string, params: unknown): Promise<{ requestId: string; accepted: true }> {
    const parsed = parseRequest(params);
    if (!parsed) return this.refuse(callerId, callerServiceId, "", "invalid_request");
    const { requestId, ownerId, accountId, path, stream } = parsed;
    const ref = `${ownerId}:${accountId}`;
    const label = `${ref} ${path}`;
    const uploadKey = `${callerId} ${requestId}`;
    const upload = this.uploads.get(uploadKey);
    if (upload) {
      clearTimeout(upload.timer);
      this.uploads.delete(uploadKey);
    }
    if (!this.callerReady(callerId)) return this.refuse(callerId, callerServiceId, label, "caller_unavailable");
    if (this.open.has(uploadKey)) return this.refuse(callerId, callerServiceId, label, "invalid_request", "That requestId is already open.");
    const owner = this.deps.owners().find((candidate) => candidate.pluginId === ownerId);
    const stored = this.deps.grant(callerId, ownerId, accountId);
    if (!stored) return this.refuse(callerId, callerServiceId, label, owner ? "not_granted" : "account_unknown");
    if (!owner || !this.deps.running(owner.pluginId, owner.serviceId)) return this.refuse(callerId, callerServiceId, label, "owner_unavailable");
    let offers: BrokerOffer[];
    try {
      offers = await this.offers(owner);
    } catch {
      return this.refuse(callerId, callerServiceId, label, "owner_unavailable");
    }
    const offer = offers.find((candidate) => candidate.id === accountId);
    if (!offer) return this.refuse(callerId, callerServiceId, label, "owner_unavailable", "The plugin that owns the account no longer offers it.");
    const fingerprint = brokerGrantFingerprint(owner.sourceUrl, offer);
    if (stored !== fingerprint) return this.refuse(callerId, callerServiceId, label, "grant_changed");
    if (!offer.paths.includes(path)) return this.refuse(callerId, callerServiceId, label, "path_refused");

    // The body: given inline, or sent before in parts (accounts.body).
    const method: "GET" | "POST" = path === "/models" ? "GET" : "POST";
    let bodyText: string | undefined;
    let model = "";
    if (method === "POST") {
      let value: unknown = parsed.body;
      if (value === undefined && upload) {
        try {
          value = JSON.parse(upload.parts.join(""));
        } catch {
          return this.refuse(callerId, callerServiceId, label, "invalid_request", "The body sent with accounts.body is not JSON.");
        }
      }
      if (!isRecord(value)) return this.refuse(callerId, callerServiceId, label, "invalid_request", "A POST needs a JSON object body.");
      try {
        bodyText = JSON.stringify(value);
      } catch {
        return this.refuse(callerId, callerServiceId, label, "invalid_request");
      }
      if (Buffer.byteLength(bodyText, "utf8") > this.limits.maxBodyBytes) return this.refuse(callerId, callerServiceId, label, "too_large");
      if (typeof value.model !== "string" || !offer.models.includes(value.model)) return this.refuse(callerId, callerServiceId, label, "model_refused");
      model = value.model;
    } else if (parsed.body !== undefined || upload) {
      return this.refuse(callerId, callerServiceId, label, "invalid_request", "GET /models takes no body.");
    }

    // Local limits per pair.
    const pair = `${callerId} ${ref}`;
    const now = this.now();
    const recent = (this.recent.get(pair) ?? []).filter((at) => now - at < 60_000);
    this.recent.set(pair, recent);
    if (recent.length >= this.limits.perMinutePerPair || (this.openPerPair.get(pair) ?? 0) >= this.limits.openPerPair) {
      if (now - (this.limitLogged.get(pair) ?? -Infinity) >= 60_000) {
        this.limitLogged.set(pair, now);
        this.deps.audit(callerId, callerServiceId, "warn", `Brokered request ${label} refused: rate_limited (further refusals this minute are not logged).`);
      }
      throw new BrokerError("rate_limited");
    }
    recent.push(now);

    // The key is read (and masked everywhere) before the owner is asked, so nothing the owner says can carry it.
    // A keyless account (a model server on this computer) has none; only such an account may be on loopback http.
    let key: string | null = null;
    if (offer.secretKey !== null) {
      if (offer.loopback || new URL(offer.baseUrl).protocol !== "https:") return this.refuse(callerId, callerServiceId, label, "owner_unavailable", "A key is sent over https only.");
      key = await this.deps.secret(owner.pluginId, offer.secretKey).catch(() => null);
      if (typeof key !== "string" || key.length < 8 || /[\r\n\u0000]/.test(key)) {
        return this.refuse(callerId, callerServiceId, label, "owner_unavailable", "The account's key is not set.");
      }
      this.deps.registerSecret(owner.pluginId, key);
    }
    // The owner admits it (its quota, rotation and budget); a timeout or an error refuses.
    const bodyBytes = bodyText ? Buffer.byteLength(bodyText, "utf8") : 0;
    let admitted: unknown;
    try {
      admitted = await this.deps.call(owner.pluginId, owner.serviceId, "canvastty.broker.admit", {
        ref: accountId, caller: { pluginId: callerId }, model, estimate: { bodyBytes }
      }, this.limits.admitMs);
    } catch {
      return this.refuse(callerId, callerServiceId, label, "budget_refused", "The plugin that owns the account did not admit the request in time.");
    }
    if (admitted !== true && !(isRecord(admitted) && admitted.ok === true)) {
      const said = isRecord(admitted) && typeof admitted.reason === "string"
        ? plainLine(this.deps.redact(key ? admitted.reason.split(key).join(KEY_MASK) : admitted.reason), 200) : "";
      return this.refuse(callerId, callerServiceId, label, "budget_refused", said ? `The owner refused: ${said}` : undefined);
    }

    if ((this.openPerPair.get(pair) ?? 0) >= this.limits.openPerPair) return this.refuse(callerId, callerServiceId, label, "rate_limited");
    if (this.open.has(uploadKey)) return this.refuse(callerId, callerServiceId, label, "invalid_request", "That requestId is already open.");

    const open: OpenRequest = {
      requestId, callerId, callerServiceId, owner, accountId, fingerprint, pair, controller: new AbortController(), ended: null
    };
    // Recheck after every wait above: a grant withdrawn or a plugin turned off meanwhile gets nothing.
    const reason = this.standing(open);
    if (reason) return this.refuse(callerId, callerServiceId, label, reason);
    this.open.set(uploadKey, open);
    this.openPerPair.set(pair, (this.openPerPair.get(pair) ?? 0) + 1);
    // Starts after the answer to this call is written, so the caller sees `accepted` before any notification.
    setImmediate(() => void this.run(open, offer, { path, method, stream, model, key, bodyText, label }));
    return { requestId, accepted: true };
  }

  /** Ends an open request from outside; `notify`: the caller gets `end` with the reason. */
  private end(open: OpenRequest, reason: BrokerReason, notify: boolean): void {
    if (open.ended) return;
    open.ended = { reason, notify };
    open.controller.abort();
  }

  private async run(open: OpenRequest, offer: BrokerOffer, call: {
    path: BrokerPath; method: "GET" | "POST"; stream: boolean; model: string; key: string | null; bodyText?: string; label: string;
  }): Promise<void> {
    const started = this.now();
    const { owner } = open;
    const mask = call.key ? new KeyMask(call.key) : null;
    const scrub = (text: string): string => this.deps.redact(call.key ? text.split(call.key).join(KEY_MASK) : text);
    const usage = new UsageMeter();
    let status = 0;
    let answerBytes = 0;
    let failure: { reason: BrokerReason; status?: number; retryAfter?: number; message?: string } | null = null;
    let idle: NodeJS.Timeout | null = null;
    const touch = (): void => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        failure ??= { reason: "timeout", message: `No data for ${Math.round(this.limits.idleMs / 1000)} s.` };
        open.controller.abort();
      }, this.limits.idleMs);
      idle.unref();
    };
    const total = setTimeout(() => {
      failure ??= { reason: "timeout", message: `The request ran longer than ${Math.round(this.limits.totalMs / 60_000)} min.` };
      open.controller.abort();
    }, this.limits.totalMs);
    total.unref();
    // The owner is asked again while the request runs: an account it stopped offering (or changed) ends it.
    const recheck = setInterval(() => {
      void this.offers(owner).then((offers) => {
        const now = offers.find((candidate) => candidate.id === open.accountId);
        if (!now) this.end(open, "owner_unavailable", true);
        else if (brokerGrantFingerprint(owner.sourceUrl, now) !== open.fingerprint) this.end(open, "grant_changed", true);
      }, () => this.end(open, "owner_unavailable", true));
    }, this.limits.recheckMs);
    recheck.unref();
    const deliver = async (method: `canvastty.accounts.${string}`, params: Record<string, unknown>): Promise<boolean> => {
      const until = this.now() + this.limits.deliverMs;
      for (;;) {
        if (this.deps.notify(open.callerId, open.callerServiceId, method, params)) return true;
        if (!this.deps.running(open.callerId, open.callerServiceId) || this.now() > until || open.controller.signal.aborted) return false;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    touch();
    try {
      const url = new URL(`${offer.baseUrl}${call.path}`);
      if (url.origin !== offer.origin) throw new BrokerAddressError("The destination left the offered origin.");
      const headers: Record<string, string> = { accept: call.stream ? "text/event-stream" : "application/json" };
      if (call.bodyText !== undefined) headers["content-type"] = "application/json";
      if (call.key !== null) {
        // Fail closed: a credential goes over TLS only, never to a plain-http (loopback) destination.
        if (url.protocol !== "https:" || offer.loopback) throw new BrokerAddressError("A key is sent over https only.");
        if (offer.auth === "x-api-key") headers["x-api-key"] = call.key;
        else headers.authorization = `Bearer ${call.key}`;
      }
      if (offer.protocol === "anthropic") headers["anthropic-version"] = "2023-06-01";
      const response = await this.transport({
        url, method: call.method, headers,
        ...(call.bodyText !== undefined ? { body: Buffer.from(call.bodyText, "utf8") } : {}),
        signal: open.controller.signal,
        loopback: offer.loopback
      });
      status = response.status;
      touch();
      const retryAfter = retryAfterSeconds(response.headers["retry-after"]);
      if (status >= 300 && status < 400) {
        failure = { reason: "network", status, message: "The model provider answered with a redirect; redirects are not followed." };
        await drain(response.body, 0);
      } else if (status < 200 || status >= 300) {
        const text = await drain(response.body, 16 * 1024);
        failure = {
          reason: "upstream", status, ...(retryAfter !== undefined ? { retryAfter } : {}),
          message: plainLine(scrub(text), this.limits.errorChars)
        };
      } else {
        const contentType = plainLine(scrub(String(firstHeader(response.headers["content-type"]) ?? "")), 120);
        const sse = /event-stream/i.test(contentType);
        if (!await deliver("canvastty.accounts.head", { requestId: open.requestId, status, contentType, ...(retryAfter !== undefined ? { retryAfter } : {}) })) {
          throw new DeliveryError();
        }
        const decoder = new StringDecoder("utf8");
        const jsonParts: string[] = [];
        let jsonChars = 0;
        let lineRest = "";
        const emit = async (text: string): Promise<void> => {
          if (!text) return;
          const safe = this.deps.redact(text);
          for (let at = 0; at < safe.length; at += this.limits.chunkChars) {
            if (!await deliver("canvastty.accounts.chunk", { requestId: open.requestId, data: safe.slice(at, at + this.limits.chunkChars) })) throw new DeliveryError();
          }
        };
        for await (const piece of response.body) {
          touch();
          answerBytes += piece.length;
          if (answerBytes > this.limits.maxResponseBytes) {
            failure = { reason: "too_large", message: `The answer is larger than ${this.limits.maxResponseBytes / 1024 / 1024} MB.` };
            open.controller.abort();
            break;
          }
          const text = decoder.write(piece);
          if (sse) {
            const lines = (lineRest + text).split("\n");
            lineRest = lines.pop() ?? "";
            if (lineRest.length > 1024 * 1024) lineRest = "";
            for (const line of lines) usage.sseLine(line);
          } else if (jsonChars < this.limits.maxBodyBytes) {
            jsonParts.push(text);
            jsonChars += text.length;
          }
          await emit(mask ? mask.push(text) : text);
        }
        if (!failure && !open.ended) {
          const rest = decoder.end();
          if (sse) for (const line of (lineRest + rest).split("\n")) usage.sseLine(line);
          else if (jsonChars < this.limits.maxBodyBytes) usage.json([...jsonParts, rest].join(""));
          await emit(mask ? mask.push(rest) + mask.flush() : rest);
        }
      }
    } catch (error) {
      if (!failure && !open.ended) {
        failure = error instanceof DeliveryError ? { reason: "cancelled", message: "The caller did not take the answer." }
          : error instanceof BrokerAddressError ? { reason: "network", message: error.message }
            : { reason: "network", message: plainLine(scrub(error instanceof Error ? error.message : String(error)), this.limits.errorChars) };
      }
    } finally {
      if (idle) clearTimeout(idle);
      clearTimeout(total);
      clearInterval(recheck);
      this.open.delete(`${open.callerId} ${open.requestId}`);
      const left = (this.openPerPair.get(open.pair) ?? 1) - 1;
      if (left <= 0) this.openPerPair.delete(open.pair);
      else this.openPerPair.set(open.pair, left);
    }
    if (open.ended) failure = { reason: open.ended.reason, message: REASON_TEXT[open.ended.reason] };
    const measured = usage.value();
    const outcome = failure ? `${failure.reason}${failure.status ? ` ${failure.status}` : ""}` : `ok ${status}`;
    if (!open.ended || open.ended.notify) {
      await deliver("canvastty.accounts.end", {
        requestId: open.requestId,
        status,
        usage: measured,
        ...(failure ? {
          error: {
            reason: failure.reason,
            ...(failure.status ? { status: failure.status } : {}),
            ...(failure.retryAfter !== undefined ? { retryAfter: failure.retryAfter } : {}),
            message: plainLine(scrub(failure.message ?? REASON_TEXT[failure.reason]), this.limits.errorChars)
          }
        } : {})
      }).catch(() => false);
    }
    const detail = `${outcome} · ${this.now() - started} ms · body ${call.bodyText ? Buffer.byteLength(call.bodyText, "utf8") : 0} bytes ${shortHash(call.bodyText ?? "")}`
      + ` · answer ${answerBytes} bytes · usage ${measured.input}/${measured.output}/${measured.cached}`;
    const level = failure ? "warn" : "info";
    this.deps.audit(open.callerId, open.callerServiceId, level, `Brokered request ${call.label} model ${call.model || "-"}: ${detail}.`);
    this.deps.audit(owner.pluginId, owner.serviceId, level, `Brokered request by ${open.callerId} through ${open.accountId} ${call.path} model ${call.model || "-"}: ${detail}.`);
    // The owner settles: its quota and budget learn what was used.
    void this.deps.call(owner.pluginId, owner.serviceId, "canvastty.broker.settle", {
      ref: open.accountId,
      caller: { pluginId: open.callerId },
      model: call.model,
      status: failure ? failure.reason : "ok",
      httpStatus: status,
      ...(failure?.retryAfter !== undefined ? { retryAfter: failure.retryAfter } : {}),
      usage: measured
    }, this.limits.settleMs).catch(() => undefined);
  }
}

class DeliveryError extends Error {}

/**
 * Masks one known key in a text stream cut at arbitrary places: a piece is passed on only up to where the key could
 * still begin, the rest waits for the next piece.
 */
export class KeyMask {
  private held = "";
  private readonly key: string;
  constructor(key: string) {
    this.key = key;
  }

  push(text: string): string {
    const joined = (this.held + text).split(this.key).join(KEY_MASK);
    let keep = Math.min(this.key.length - 1, joined.length);
    while (keep > 0 && !this.key.startsWith(joined.slice(joined.length - keep))) keep -= 1;
    this.held = joined.slice(joined.length - keep);
    return joined.slice(0, joined.length - keep);
  }

  flush(): string {
    const rest = this.held;
    this.held = "";
    return rest;
  }
}

/** Token usage from an OpenAI (Chat Completions or Responses) or Anthropic answer, streamed or not. */
export class UsageMeter {
  private input = 0;
  private output = 0;
  private cached = 0;

  sseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]" || data.length > 1024 * 1024 || !data.includes("tokens")) return;
    this.json(data);
  }

  json(text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(value)) return;
    const usage = [value.usage, isRecord(value.response) ? value.response.usage : undefined, isRecord(value.message) ? value.message.usage : undefined]
      .find(isRecord);
    if (!usage) return;
    const count = (entry: unknown): number => (typeof entry === "number" && Number.isFinite(entry) && entry >= 0 ? Math.floor(entry) : 0);
    const details = (entry: unknown): Record<string, unknown> => (isRecord(entry) ? entry : {});
    this.input = Math.max(this.input, count(usage.prompt_tokens ?? usage.input_tokens));
    this.output = Math.max(this.output, count(usage.completion_tokens ?? usage.output_tokens));
    this.cached = Math.max(this.cached, count(
      details(usage.prompt_tokens_details).cached_tokens ?? details(usage.input_tokens_details).cached_tokens ?? usage.cache_read_input_tokens
    ));
  }

  value(): BrokerUsage {
    return { input: this.input, output: this.output, cached: this.cached };
  }
}

/** The grant's pin: the owner's source and the account's origin, protocol and auth scheme (not its models). */
export function brokerGrantFingerprint(ownerSourceUrl: string, offer: Pick<BrokerOffer, "id" | "origin" | "protocol" | "auth">): string {
  return createHash("sha256").update(JSON.stringify(["broker-grant-v1", ownerSourceUrl, offer.id, offer.origin, offer.protocol, offer.auth])).digest("hex");
}

/** One offered account as the owner's service gave it; null when anything about it is not acceptable. */
export function validateBrokerOffer(value: unknown): BrokerOffer | null {
  if (!isRecord(value)) return null;
  const allowed = ["id", "label", "protocol", "baseUrl", "paths", "models", "secretKey", "auth", "flatRate"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return null;
  if (typeof value.id !== "string" || !ACCOUNT_ID.test(value.id)) return null;
  if (typeof value.label !== "string" || !value.label.trim() || value.label.length > 80 || /[\u0000-\u001f\u007f]/.test(value.label)) return null;
  if (value.protocol !== "openai" && value.protocol !== "anthropic") return null;
  // A keyed account names its secret and auth scheme; a keyless one names neither.
  const keyed = value.secretKey !== undefined || value.auth !== undefined;
  if (keyed && value.auth !== "bearer" && value.auth !== "x-api-key") return null;
  if (keyed && (typeof value.secretKey !== "string" || !SECRET_KEY.test(value.secretKey))) return null;
  if (value.flatRate !== undefined && typeof value.flatRate !== "boolean") return null;
  if (typeof value.baseUrl !== "string" || value.baseUrl.length > 300) return null;
  let url: URL;
  try {
    url = new URL(value.baseUrl);
  } catch {
    return null;
  }
  const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (url.protocol !== "https:" && !loopback) return null;
  // Fail closed: a key never goes to plain http, not even on loopback (another process may hold the port).
  if (keyed && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash || value.baseUrl.includes("?") || value.baseUrl.includes("#")) return null;
  if (!Array.isArray(value.paths) || value.paths.length === 0 || value.paths.length > BROKER_PATHS.length
    || value.paths.some((path) => !BROKER_PATHS.includes(path as BrokerPath))) return null;
  if (!Array.isArray(value.models) || value.models.length === 0 || value.models.length > 64
    || value.models.some((model) => typeof model !== "string" || !model || model.length > 200 || /[\s\u0000-\u001f\u007f]/.test(model))) return null;
  return {
    id: value.id,
    label: value.label.trim(),
    protocol: value.protocol,
    baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
    origin: url.origin,
    paths: BROKER_PATHS.filter((path) => (value.paths as unknown[]).includes(path)),
    models: [...new Set(value.models as string[])],
    secretKey: keyed ? value.secretKey as string : null,
    auth: keyed ? value.auth as "bearer" | "x-api-key" : null,
    flatRate: value.flatRate === true,
    loopback
  };
}

function viewOf(owner: BrokerOwner, offer: BrokerOffer): BrokerAccountView {
  return {
    ref: `${owner.pluginId}:${offer.id}`,
    owner: owner.pluginId,
    ownerName: owner.name,
    id: offer.id,
    label: offer.label,
    protocol: offer.protocol,
    origin: offer.origin,
    paths: [...offer.paths],
    models: [...offer.models],
    flatRate: offer.flatRate
  };
}

function parseRequest(params: unknown): {
  requestId: string; ownerId: string; accountId: string; path: BrokerPath; stream: boolean; body?: unknown;
} | null {
  if (!isRecord(params)) return null;
  if (Object.keys(params).some((key) => !["ref", "path", "body", "stream", "requestId"].includes(key))) return null;
  if (typeof params.requestId !== "string" || !REQUEST_ID.test(params.requestId)) return null;
  if (typeof params.ref !== "string" || params.ref.length > 160) return null;
  const split = params.ref.indexOf(":");
  if (split <= 0) return null;
  const ownerId = params.ref.slice(0, split);
  const accountId = params.ref.slice(split + 1);
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(ownerId) || !ACCOUNT_ID.test(accountId)) return null;
  if (typeof params.path !== "string" || !BROKER_PATHS.includes(params.path as BrokerPath)) {
    // A path outside the host's allowlist (another path, a query, a full URL) is refused as such.
    return typeof params.path === "string" ? { requestId: params.requestId, ownerId, accountId, path: "!" as BrokerPath, stream: false } : null;
  }
  if (params.stream !== undefined && typeof params.stream !== "boolean") return null;
  return {
    requestId: params.requestId, ownerId, accountId, path: params.path as BrokerPath, stream: params.stream === true,
    ...(params.body !== undefined ? { body: params.body } : {})
  };
}

async function drain(body: AsyncIterable<Buffer>, keepBytes: number): Promise<string> {
  const parts: Buffer[] = [];
  let kept = 0;
  for await (const piece of body) {
    if (kept < keepBytes) {
      parts.push(piece.subarray(0, keepBytes - kept));
      kept += Math.min(piece.length, keepBytes - kept);
    } else break;
  }
  return Buffer.concat(parts).toString("utf8");
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Retry-After as seconds (a number of seconds or an HTTP date), at most a day; undefined when absent or invalid. */
function retryAfterSeconds(value: string | string[] | undefined): number | undefined {
  const text = firstHeader(value)?.trim();
  if (!text) return undefined;
  if (/^\d{1,6}$/.test(text)) return Math.min(Number(text), 86_400);
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, Math.min(Math.round((at - Date.now()) / 1000), 86_400));
}

function plainLine(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

function shortHash(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
