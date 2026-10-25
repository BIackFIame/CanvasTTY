export {};

declare global {
  interface Window {
    CanvasTTYPlugin: CanvasTTYPluginHost;
  }
}

export interface CanvasTTYPluginHost {
  ready(): void;
  request(method: "host.getContext"): Promise<CanvasTTYPluginContext>;
  request(method: "sessions.list"): Promise<CanvasTTYPluginSession[]>;
  request(method: "limits.get"): Promise<CanvasTTYPluginLimitsResult>;
  request(method: "launcher.open", params: { provider: "terminal" | "codex" | "claude" | "qwen" | "kimi" | "opencode" | "hermes" | "grok" | "omp" | "pi" }): Promise<null>;
  request(method: "canvas.open", params: { contributionId: string }): Promise<null>;
  /** sessions:read; canvas apps and HOME widgets, only while the person is in the frame. */
  request(method: "sessions.focus", params: { sessionId: string }): Promise<null>;
  request(method: "external.open", params: { url: string }): Promise<null>;
  request(method: "browser.open", params: { url: string }): Promise<null>;
  request(method: "window.open", params: { contributionId: string }): Promise<null>;
  request(method: "media.pickLibrary"): Promise<CanvasTTYPluginMediaLibrary | null>;
  request(method: "media.listLibraries"): Promise<CanvasTTYPluginMediaLibrary[]>;
  request(method: "media.scanLibrary", params: { libraryId: string }): Promise<CanvasTTYPluginMediaTrack[]>;
  request(method: "media.revokeLibrary", params: { libraryId: string }): Promise<null>;
  request(method: "playlists.list", params: { libraryId: string }): Promise<CanvasTTYPluginPlaylistFile[]>;
  request(method: "playlists.read", params: { libraryId: string; playlistId: string }): Promise<string>;
  request(method: "playlists.write", params: { libraryId: string; name: string; content: string }): Promise<CanvasTTYPluginPlaylistFile>;
  request(method: "hermesHud.getState"): Promise<CanvasTTYPluginHermesHudSnapshot>;
  request(method: "hermesHud.open"): Promise<CanvasTTYPluginHermesHudSnapshot>;
  request(method: "hermesHud.close"): Promise<CanvasTTYPluginHermesHudSnapshot>;
  request(method: "secrets.get", params: { key: string }): Promise<string | null>;
  request(method: "secrets.set", params: { key: string; value: string }): Promise<null>;
  request(method: "secrets.delete", params: { key: string }): Promise<null>;
  request(method: "service.request", params: { serviceId: string; method: string; params?: unknown }): Promise<unknown>;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  secrets: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  canvas: {
    open(contributionId: string): Promise<void>;
    /** `sessions.focus`: moves the camera to an open card (sessions:read; on the person's action only). */
    focusSession(sessionId: string): Promise<null>;
  };
  media: {
    pickLibrary(): Promise<CanvasTTYPluginMediaLibrary | null>;
    listLibraries(): Promise<CanvasTTYPluginMediaLibrary[]>;
    scanLibrary(libraryId: string): Promise<CanvasTTYPluginMediaTrack[]>;
    revokeLibrary(libraryId: string): Promise<null>;
  };
  playlists: {
    list(libraryId: string): Promise<CanvasTTYPluginPlaylistFile[]>;
    read(libraryId: string, playlistId: string): Promise<string>;
    write(libraryId: string, name: string, content: string): Promise<CanvasTTYPluginPlaylistFile>;
  };
  hermesHud: {
    getState(): Promise<CanvasTTYPluginHermesHudSnapshot>;
    open(): Promise<CanvasTTYPluginHermesHudSnapshot>;
    close(): Promise<CanvasTTYPluginHermesHudSnapshot>;
  };
  /** Talks to this plugin's own services only (apiVersion 2 `services`). */
  service: {
    /** Rejects when the service is not running (native code not trusted, disabled, restarting, failed) or after 15 s. */
    request(serviceId: string, method: string, params?: unknown): Promise<unknown>;
    onEvent(listener: (event: CanvasTTYPluginServiceEvent) => void): () => void;
  };
  onContext(listener: (context: CanvasTTYPluginContext) => void): () => void;
  onStorageChange(listener: (key: string, value: unknown) => void): () => void;
  /** "hidden" while the plugin's card is not drawn (summary zoom, HOME editing, off-screen, minimized window). */
  visibility(): "visible" | "hidden";
  /** Called on every change of `visibility()`; the same moment `document` fires `visibilitychange`. */
  onVisibilityChange(listener: (state: "visible" | "hidden") => void): () => void;
}

export interface CanvasTTYPluginContext {
  apiVersion: 1;
  plugin: {
    id: string;
    name: string;
    version: string;
    permissions: Array<"storage" | "secrets" | "sessions:read" | "limits:read" | "providers:read" | "usage:read" | "launcher:open" | "external:open" | "browser:open" | "media:library" | "playlists:read" | "playlists:write" | "hermes:hud" | "network" | "launch:contribute" | "environment:provide" | "decision:provide" | "tools:agents" | "sessions:events" | "sessions:read-screen" | "sessions:launch" | "sessions:control" | "cards:decorate" | "browser:engine">;
    modules: string[];
  };
  contribution: {
    id: string;
    kind: "home-widget" | "canvas-app" | "window";
    title: string;
  };
  appearance: {
    locale: "ru" | "en";
    palette: "sage" | "lilac" | "night";
    /** The app's UI scale (Settings → Appearance; 1 is 100%, from 0.85 to 1.25), the value CanvasTTY scales its own
     * text and controls by. Sent again whenever the person changes it. */
    uiScale: number;
  };
}

export interface CanvasTTYPluginSession {
  id: string;
  provider: "terminal" | "codex" | "claude" | "qwen" | "kimi" | "opencode" | "hermes" | "grok" | "omp" | "pi";
  title: string;
  status: "idle" | "working" | "needs_approval" | "unavailable" | "done" | "failed";
  startedAt: number;
  exitCode: number | null;
}

export interface CanvasTTYPluginMediaLibrary {
  id: string;
  name: string;
}

export interface CanvasTTYPluginMediaTrack {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  mimeType: string;
  streamUrl: string;
}

export interface CanvasTTYPluginPlaylistFile {
  id: string;
  name: string;
  relativePath: string;
  size: number;
}

export type CanvasTTYPluginHermesHudSnapshot =
  | { state: "unavailable"; reason: "cli-not-found"; message: string }
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "stopping" }
  | { state: "running"; hudOpen: boolean }
  | { state: "error"; message: string };

export type CanvasTTYPluginLimitsResult =
  | { state: "loading"; snapshot: null }
  | { state: "ready"; snapshot: unknown };

/** Stdin payload for an explicitly enabled native agent hook entry. */
export interface CanvasTTYAgentHookInput {
  apiVersion: 1;
  pluginId: string;
  hookId: string;
  terminalSessionId: string;
  provider: "codex" | "claude" | "qwen" | "kimi" | "opencode" | "hermes" | "grok";
  event: "session-start" | "prompt-submit" | "permission-request" | "permission-result" | "after-tool" | "stop" | "session-end";
  providerEvent: string;
  payload: unknown;
}

export interface CanvasTTYPluginServiceEvent {
  serviceId: string;
  event: string;
  data: unknown;
}

/**
 * Plugin services (manifest apiVersion 2). A service is a bundled single-file Node.js program that
 * CanvasTTY runs as a separate process after the user trusts the plugin's native code. It speaks
 * newline-delimited JSON-RPC 2.0 over stdin/stdout, at most 1 MB per message.
 */
export interface CanvasTTYPluginServiceManifestEntry {
  id: string;
  title: string;
  description?: string;
  /** `.js`, `.mjs` or `.cjs` inside the plugin; integrity-declared in modular plugins. */
  entry: string;
  module?: string;
  /** Launch contributor; needs `launch:contribute`. At most one service per plugin. */
  launch?: CanvasTTYServiceLaunch;
  /** Session environments; needs `environment:provide`. At most 8 kinds per plugin, unique across its services. */
  environments?: CanvasTTYEnvironmentKind[];
  /** Decision hooks; needs `decision:provide`. At most one service per plugin. */
  decide?: CanvasTTYServiceDecide;
  /** Agent tools in canvastty_agents; needs `tools:agents`. Up to 16; names unique within the plugin. */
  tools?: CanvasTTYAgentTool[];
  /** Card actions; needs `cards:decorate`. Up to 16; ids unique within the plugin. */
  cardActions?: CanvasTTYCardAction[];
  /** A browser engine for agents' background tabs; needs `browser:engine`. Ids unique within the plugin. */
  browserEngine?: CanvasTTYBrowserEngine;
  /** Read-only data other plugins' services may read (`canvastty.shares.read`) once the person allowed the pair. */
  shares?: CanvasTTYShare[];
}

/** One shared read. Methods are unique across the plugin's services; at most 16 per plugin. */
export interface CanvasTTYShare {
  /** `^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){0,3}$`, at most 64 characters, never `canvastty.…`. */
  method: string;
  /** Up to 200 characters; shown to the person when they allow a plugin to read it. */
  description: string;
  dataClass?: CanvasTTYDataClass;
}

/** D0 (public) … D3 (most sensitive): a label the person sees and the reader receives; the host does not interpret it. */
export type CanvasTTYDataClass = "D0" | "D1" | "D2" | "D3";

/** Manifest top-level `uses` (apiVersion 2, with a service): one entry per other plugin's method read. Up to 16. */
export interface CanvasTTYPluginUse {
  plugin: string;
  method: string;
}

/** What `plugins.request` answers. `data` is the provider's answer as it sent it (JSON, at most 256 KB). */
export interface CanvasTTYSharedReadResult {
  plugin: string;
  method: string;
  dataClass?: CanvasTTYDataClass;
  data: unknown;
}

/** `error.data.reason` of a refused `plugins.request`. */
export type CanvasTTYSharedReadRefusal =
  | "invalid_request" | "consumer_unavailable" | "not_declared" | "not_shared" | "not_approved" | "approval_changed"
  | "provider_unavailable" | "rate_limited" | "busy" | "timeout" | "provider_error" | "not_json" | "too_large"
  | "secret_in_response";

/** `canvastty.shares.read` params. Answer with any JSON (at most 256 KB, within 5 s) or an error; never a secret. */
export interface CanvasTTYShareReadRequest {
  /** The reading plugin, from the host's own record. */
  caller: { pluginId: string };
  method: string;
  params: unknown;
}

/** `canvastty.activity` to services of plugins with `limits:read`: a provider's default-login allowance is used up. */
export interface CanvasTTYLimitExhaustedActivity {
  type: "limit.exhausted";
  at: number;
  provider: string;
  accountId: "default";
  window: { id: string; label: string | null; windowMinutes: number | null };
  /** Epoch ms of the announced reset, when the provider gave one. */
  resetAt?: number;
  /** Offers accounts for other plugins' brokered model requests (`canvastty.broker.*`); needs `secrets`; one service per plugin. */
  brokerable?: boolean;
}

/** One account a brokerable service offers (`canvastty.broker.offer` answers up to 32). Only accounts the person marked. */
export interface CanvasTTYBrokerOffer {
  /** `^[a-z0-9][a-z0-9._-]{0,63}$`, stable: grants name it. */
  id: string;
  label: string;
  protocol: "openai" | "anthropic";
  /** https; http only on 127.0.0.1 or [::1] and only for a keyless account. No user, query or fragment. Requests go to `baseUrl + path` only. */
  baseUrl: string;
  paths: Array<"/chat/completions" | "/responses" | "/messages" | "/models">;
  /** 1–64 model names; a request for another model is refused. */
  models: string[];
  /** The owner's own secret holding the key; the host reads it, the caller never sees it or its name. Omitted (with `auth`) for a keyless account. */
  secretKey?: string;
  auth?: "bearer" | "x-api-key";
  flatRate?: boolean;
}

/** `accounts.list` answers these: granted, currently offered accounts. Never a key or its secret's name. */
export interface CanvasTTYBrokerAccount {
  /** `<owner plugin id>:<account id>`, passed to `accounts.request`. */
  ref: string;
  owner: string;
  ownerName: string;
  id: string;
  label: string;
  protocol: "openai" | "anthropic";
  origin: string;
  paths: string[];
  models: string[];
  flatRate: boolean;
}

/** `accounts.request` params; nothing else is accepted (no headers, query, method or URL). */
export interface CanvasTTYBrokerRequest {
  /** `^[A-Za-z0-9_.:-]{1,64}$`, chosen by the caller; the notifications carry it. */
  requestId: string;
  ref: string;
  path: "/chat/completions" | "/responses" | "/messages" | "/models";
  /** A JSON object with `model` (POST); omitted for `/models` or when sent before with `accounts.body`. */
  body?: Record<string, unknown>;
  stream?: boolean;
}

/** `canvastty.accounts.end`: always the last notification of an accepted request. */
export interface CanvasTTYBrokerEnd {
  requestId: string;
  /** The provider's HTTP status, 0 when none arrived. */
  status: number;
  usage: { input: number; output: number; cached: number };
  error?: { reason: CanvasTTYBrokerRefusal; status?: number; retryAfter?: number; message: string };
}

/** `error.data.reason` of a refused `accounts.*` call, or `end.error.reason`. */
export type CanvasTTYBrokerRefusal =
  | "invalid_request" | "caller_unavailable" | "not_granted" | "grant_changed" | "owner_unavailable" | "account_unknown"
  | "path_refused" | "model_refused" | "too_large" | "rate_limited" | "budget_refused" | "upstream" | "network" | "timeout"
  | "cancelled";

/**
 * The host calls `canvastty.browserEngine.openTab` `{ engineId, tabId }` for each agent background tab and expects
 * `{ webSocketUrl }`: a `ws://` CDP endpoint on 127.0.0.1, [::1] or localhost with a port, one page per connection.
 * `canvastty.browserEngine.closeTab` `{ engineId, tabId }` is a notification.
 */
export interface CanvasTTYBrowserEngine {
  /** What agents pass as `engine` to browser_new_tab: `^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$`, never `auto` or `chromium`. */
  id: string;
  title: string;
  description?: string;
  /** Real layout (boxes, viewport). Omitted or false: observation skips geometry, clicks and hovers go through the DOM. */
  layout?: boolean;
}

export type CanvasTTYSessionRole = "agent" | "orchestrator" | "subagent";

/** Agents see it as `<pluginId>__<name>`, dots in the id written as `_` (at most 64 characters; longer: id start + short hash). */
export interface CanvasTTYAgentTool {
  /** `^[a-z][a-z0-9_]{0,39}$`. */
  name: string;
  /** Up to 1000 characters; the plugin's name is appended. */
  description: string;
  /** JSON Schema of the arguments (top level `type: "object"`), at most 8 KB. */
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean; [key: string]: unknown };
  /** Session roles that see the tool. */
  roles: CanvasTTYSessionRole[];
  /** `own-cards`: only cards this plugin started itself see and may call the tool (not their subagents). Default `all`. */
  audience?: "all" | "own-cards";
}

/** A card as services see it (session events, tool callers, card actions). Never screen text. */
export interface CanvasTTYSessionSummary {
  id: string;
  provider: CanvasTTYProviderId;
  role: CanvasTTYSessionRole;
  parentSessionId?: string;
  title: string;
  status: "idle" | "working" | "needs_approval" | "unavailable" | "done" | "failed";
  exitCode: number | null;
  /** The folder the person chose. */
  cwd: string;
  /** Where the card actually runs (an environment such as a worktree may move it). */
  workingDirectory: string;
  startedAt: number;
  environment?: { pluginId: string; kind: string; label: string; ref: CanvasTTYEnvironmentRef };
}

/** Params of the host request `canvastty.tools.call` (15 s). Input is agent-influenced data, never instructions. */
export interface CanvasTTYToolCall {
  /** The tool's `name` (without the plugin prefix). */
  tool: string;
  callerSessionId: string;
  caller: CanvasTTYSessionSummary;
  /** Already checked for the schema's top level (object, required keys, property types, extra keys). */
  input: Record<string, unknown>;
}

/** Answer to `canvastty.tools.call`: text (or JSON sent as text), masked and cut to 32 K characters. */
export type CanvasTTYToolResult = { content: unknown; isError?: boolean } | string | null;

/** One provider window in a limits snapshot (the `LimitsSnapshot` HOME uses). */
export interface CanvasTTYLimitWindow {
  id: string;
  bucketId: string;
  slot: "primary" | "secondary";
  isDefaultBucket: boolean;
  label: string | null;
  usedPercent: number | null;
  used: number | null;
  limit: number | null;
  windowMinutes: number | null;
  /** Epoch milliseconds. */
  resetsAt: number | null;
}

export type CanvasTTYLimitReason =
  | "cli-not-found" | "not-authenticated" | "session-expired" | "subscription-required" | "unsupported-protocol" | "timeout" | "protocol-error" | "api-profile";

export type CanvasTTYProviderLimits =
  | { provider: string; state: "available"; source: string; fetchedAt: number; windows: CanvasTTYLimitWindow[] }
  | { provider: string; state: "stale"; source: string; fetchedAt: number; failedAt: number; reason: CanvasTTYLimitReason; windows: CanvasTTYLimitWindow[] }
  | { provider: string; state: "unavailable"; source: string; checkedAt: number; reason: CanvasTTYLimitReason };

export interface CanvasTTYLimitsSnapshot {
  fetchedAt: number;
  providers: CanvasTTYProviderLimits[];
}

/**
 * A window whose allowance came back before the reset time the previous snapshot announced: the used share dropped by
 * at least 5 points and at least half (or to 5% or less by more than 2 points) while that time was over 5 minutes away.
 */
export interface CanvasTTYLimitEarlyReset {
  provider: "codex" | "claude" | "qwen" | "kimi" | "opencode" | "grok";
  /** The account home it was read for; absent for the default login. */
  home?: string;
  windowId: string;
  slot: "primary" | "secondary";
  windowLabel: string | null;
  windowMinutes: number | null;
  /** Used share in percent before and after the drop. */
  usedBefore: number;
  usedAfter: number;
  /** Epoch milliseconds: the reset time announced before the drop, and the one reported after it (new, same, or none). */
  announcedResetAt: number;
  reportedResetAtAfter: number | null;
  /** The provider still reports the old reset time; its arrival later is a normal reset. */
  resetTimeKept: boolean;
}

/** Notification `canvastty.limits.changed`, after `limits.subscribe` (needs `limits:read`); at most once per 2 s. */
export interface CanvasTTYLimitsChanged {
  state: "ready";
  snapshot: CanvasTTYLimitsSnapshot;
  earlyReset: boolean;
  earlyResets: CanvasTTYLimitEarlyReset[];
  /** Only for an account home this plugin asked about with `limits.get { provider, home }`. */
  provider?: "codex" | "claude" | "qwen" | "kimi" | "opencode" | "grok";
  home?: string;
}

/** Notification `canvastty.sessions.event`, after `sessions.subscribe` (needs `sessions:events`). */
export interface CanvasTTYSessionEvent {
  type: "created" | "restored" | "status" | "exited" | "closed";
  session: CanvasTTYSessionSummary;
  /** This plugin started the card (`sessions.create`), so it may send to it and stop it. */
  owned: boolean;
  /** Only with `sessions:read-screen`, on status and exited: the last 4000 characters of output, plain and masked. */
  screen?: string;
}

export interface CanvasTTYCardAction {
  id: string;
  /** Up to 40 characters, shown in the card's options menu. */
  title: string;
  /** The title when the app is in Russian / English (up to 40 characters, like `description.ru`); `title` otherwise. */
  "title.ru"?: string;
  "title.en"?: string;
  /** Every listed key must match; a card outside an environment never matches `environmentKinds`. */
  when?: { providers?: CanvasTTYProviderId[]; environmentKinds?: string[]; roles?: CanvasTTYSessionRole[] };
  /** `false`: not listed in the card menu; only a change review calls it, always with `input` (accept/reject). */
  menu?: false;
}

/** Params of the host request `canvastty.cards.invoke` (15 s). */
export interface CanvasTTYCardActionInvocation {
  /**
   * Only while the change review dialog is open (a JSON object, at most 1 MiB, from the app window): `{ offset }` or
   * `{ agentSessionId, file, page }` for the review action, `{ agentSessionId?, files, resolutions? }` for its accept
   * action and `{ agentSessionId? }` for its reject action. Never the session's identity: that is `sessionId`.
   */
  input?: {
    agentSessionId?: string;
    files?: string[];
    resolutions?: Record<string, "current" | "agent">;
    offset?: number;
    file?: string;
    page?: number;
  };
  actionId: string;
  sessionId: string;
  session: CanvasTTYSessionSummary;
  /** The app language when the person chose the action (`"en"`, `"ru"`): write `message` in it. */
  locale: string;
}

/** A page of text in a review (plain text, masked). */
export interface CanvasTTYReviewTextPage {
  label?: string;
  text: string;
  startLine: number;
  totalLines: number;
  hasMore: boolean;
}

/**
 * A change review a card action can answer with (at most 512 KiB, 24 groups, 400 files; text cut at 16 KiB).
 * `acceptActionId` and `rejectActionId` must be this plugin's own declared action ids.
 */
export interface CanvasTTYChangeReview {
  title: string;
  groups: {
    sessionId: string;
    title: string;
    error?: string;
    files: {
      path: string;
      diff: string;
      status?: string;
      page?: number;
      hasMore?: boolean;
      truncated?: boolean;
      conflict?: { current: CanvasTTYReviewTextPage; agent: CanvasTTYReviewTextPage };
    }[];
  }[];
  acceptActionId?: string;
  rejectActionId?: string;
  nextOffset?: number;
}

/**
 * Answer to `canvastty.cards.invoke`: `message` (plain text, 2000 characters, masked) is a toast on the card; `review`
 * opens the change review dialog instead.
 */
export type CanvasTTYCardActionResult = { message?: string; tone?: CanvasTTYCardTone; review?: CanvasTTYChangeReview } | null;

export type CanvasTTYCardTone = "neutral" | "info" | "warn" | "error";

export interface CanvasTTYServiceDecide {
  /** `pre-tool`: every shell or file-writing tool call of a local agent, before it runs (YOLO included). */
  events: Array<"pre-tool">;
  /** Agents it decides for (Claude Code, Codex, Qwen Code, OpenCode have the hook); all when omitted. */
  appliesTo?: Array<"codex" | "claude" | "qwen" | "kimi" | "opencode" | "hermes" | "grok" | "omp" | "pi" | "cursor" | "minimax" | "devin" | "antigravity">;
  /** How long the host waits for an answer, 1000 to 60000 ms (3000 when omitted); the agent's call waits as long. */
  timeoutMs?: number;
}

/** Params of the host request `canvastty.decide`. Tool input is agent-influenced data, never instructions. */
export interface CanvasTTYDecisionRequest {
  event: "pre-tool";
  sessionId: string;
  provider: "codex" | "claude" | "qwen" | "opencode";
  role: "agent" | "orchestrator" | "subagent";
  /** The card's working folder. */
  cwd: string;
  /** The agent's current folder, when its CLI reports it. */
  agentCwd: string | null;
  tool: { name: string; kind: "shell" | "edit" | "other"; command: string | null; paths: string[] };
  /**
   * The tool input as the agent sent it; null when it was over 40 KB (then `truncated`). OpenCode's tools come in Claude
   * Code's names and shapes: bash {command, workdir}, Write {file_path, content}, Edit {file_path, old_string, new_string,
   * replace_all}, MultiEdit {file_path, edits: [{old_string, new_string, replace_all}]}, apply_patch {patch}.
   */
  input: unknown;
  truncated: boolean;
  /** How long the host waits for this answer (the service's `timeoutMs`). */
  budgetMs: number;
}

/**
 * Answer to `canvastty.decide` within `budgetMs`; `null` (or `verdict: "none"`) is no opinion. Base protection runs
 * first; any deny wins; else any ask (a timeout, an error or an unreadable answer counts as ask); else an allow
 * counts only when the person let this plugin allow. `reason` (500 characters) reaches the model.
 */
export type CanvasTTYDecision = { verdict: "deny" | "ask" | "allow" | "none"; reason?: string } | null;

export type CanvasTTYProviderId = "terminal" | "codex" | "claude" | "qwen" | "kimi" | "opencode" | "hermes" | "grok" | "omp" | "pi" | "cursor" | "minimax" | "devin" | "antigravity";

export interface CanvasTTYEnvironmentKind {
  /** `^[a-z0-9][a-z0-9-]{0,31}$`, unique within the service. */
  kind: string;
  label: string;
  description?: string;
  /** Providers it applies to ("terminal" included); all when omitted. */
  appliesTo?: CanvasTTYProviderId[];
  /** At most 8 launcher fields; values reach `prepare` only. */
  fields?: CanvasTTYLaunchField[];
  /** What of CanvasTTY's protection reaches the agent there; undeclared means no (see docs/plugins.md). */
  keeps?: { launch?: boolean; isolated?: boolean; confines?: boolean };
  /**
   * An orchestrator may choose this kind for its subagents (spawn_agent `environment`); without it only the person
   * chooses it. `maxParallel` (1 to 16, 1 when omitted): subagents in this kind at once, all orchestrations together.
   * `fields`: keys of `fields` an orchestrator may set; every other field keeps its declared default.
   * `capBy`: one of those keys whose value names a server; `maxParallel` then counts per server and `maxParallelTotal`
   * (1 to 64) over all of them. A text field's servers come from `canvastty.environment.choices`.
   */
  subagents?: { maxParallel?: number; fields?: string[]; capBy?: string; maxParallelTotal?: number };
}

/** Opaque to CanvasTTY: saved with the card (at most 4 KB of JSON) and handed back unchanged. */
export type CanvasTTYEnvironmentRef = unknown;

/** `canvastty.environment.prepare` (15 s): create the place once, when the card first starts. */
export interface CanvasTTYEnvironmentPrepareParams {
  sessionId: string;
  kind: string;
  provider: CanvasTTYProviderId;
  cwd: string;
  /** The folder of the agent the person started (the task's project), for a worktree of that repository. */
  projectRoot?: string;
  options: Record<string, boolean | string>;
}
export type CanvasTTYEnvironmentPrepareResult =
  /** `label` is the card badge (80 characters); `cwd` (an existing absolute folder) becomes the card's folder. */
  | { ref: CanvasTTYEnvironmentRef; label: string; cwd?: string }
  | { refuse: { reason: string } };

/** `canvastty.environment.wrap` (5 s): before every start; the host still spawns the PTY. */
export interface CanvasTTYEnvironmentWrapParams {
  sessionId: string;
  kind: string;
  ref: CanvasTTYEnvironmentRef;
  provider: CanvasTTYProviderId;
  command: string;
  args: string[];
  /** The launch's own variables, without reserved `CANVASTTY_*` names and without secret values. */
  env: Record<string, string>;
  /** Names whose values the spawned process gets from the host (forward them by name). */
  secretEnvNames: string[];
  cwd: string;
}
export type CanvasTTYEnvironmentWrapResult =
  | {
    /** An absolute path to an executable, or a bare program name resolved on PATH. Never a shell string. */
    command: string;
    /** At most 256, 8 KB each, no NUL. */
    args: string[];
    /** Launch-contributor rules: no reserved names, no names this launch already sets. */
    env?: Record<string, string>;
    /** Env name -> the plugin's own secret key (needs `secrets`); set and masked by the host. */
    secretEnv?: Record<string, string>;
    /** An existing absolute folder; the launch's folder when omitted. */
    cwd?: string;
  }
  | { refuse: { reason: string } };

/** `canvastty.environment.resume` (10 s): on restore, and before restarting a card from an earlier run. */
export type CanvasTTYEnvironmentResumeResult = { ok: true } | { stopped: { reason: string } };

/** `canvastty.environment.release` (10 s): the card was closed, the app quit with saving off, or a `prepare` answer came after its launch was gone. */
export interface CanvasTTYEnvironmentReleaseParams {
  sessionId: string;
  kind: string;
  ref: CanvasTTYEnvironmentRef;
  /** The person's answer to "Keep environment data?"; always true when quitting. */
  keepData: boolean;
  reason: "closed" | "quit";
}

/** `canvastty.environment.describe` (3 s): the card badge and its tooltip. */
export interface CanvasTTYEnvironmentDescribeResult {
  label: string;
  detail?: string;
}

/**
 * `canvastty.environment.choices` (2 s, cached 30 s): for a kind with `subagents.capBy` on a text field, the person's
 * servers by the labels they gave them (at most 64). Never an address, user or key.
 */
export interface CanvasTTYEnvironmentChoicesResult {
  choices: string[];
}

export interface CanvasTTYServiceLaunch {
  /** Agent providers the options apply to; every agent when omitted. */
  appliesTo?: Array<"codex" | "claude" | "qwen" | "kimi" | "opencode" | "hermes" | "grok" | "omp" | "pi" | "cursor" | "minimax" | "devin" | "antigravity">;
  /** At most 8, shown in the agent launcher under Advanced (a policy with none is not shown). */
  fields: CanvasTTYLaunchField[];
  /** Also asked before every launch of these agents where the person did not choose the plugin (`chosen: false`);
   * such an answer may only refuse, and no answer refuses too. `{ scope: "own-trees" }`: only subagents whose
   * ancestors include a card this plugin was chosen for or started; other launches never wait for it. */
  policy?: boolean | { scope: "own-trees" };
  /** An orchestrator may choose these options for its subagents (spawn_agent launchOptions); otherwise only the person. */
  delegable?: boolean;
}

export type CanvasTTYLaunchField = {
  /** The label when the app is in Russian / English (up to 80 characters, like `description.ru`); `label` otherwise. */
  "label.ru"?: string;
  "label.en"?: string;
} & (
  | {
    key: string; label: string; kind: "boolean"; default?: boolean;
    /** Plugin ids (1 to 8) whose launch services see this value in `peerOptions` when this plugin is selected. */
    visibleTo?: string[];
  }
  | {
    key: string; label: string; kind: "select"; options: Array<{ value: string; label: string }>; default?: string;
    /** The launcher also asks `canvastty.launch.options` (3 s) for up to 64 more choices; the saved value is then any
     * text up to 200 characters, which `canvastty.launch.prepare` must check. */
    optionsFrom?: "service";
    /** Plugin ids (1 to 8) whose launch services see this value in `peerOptions` when this plugin is selected.
     * Launch options only; text fields cannot declare it. */
    visibleTo?: string[];
  }
  | { key: string; label: string; kind: "text"; maxLength?: number; default?: string }
);

/** Params of the host request `canvastty.launch.prepare`: launches that chose this plugin, and with `policy` every agent launch. */
export interface CanvasTTYLaunchContext {
  sessionId: string;
  provider: "terminal" | "codex" | "claude" | "qwen" | "kimi" | "opencode" | "hermes" | "grok" | "omp" | "pi" | "cursor" | "minimax" | "devin" | "antigravity";
  /** "auto" only for agents with a native auto mode (Codex, Claude Code, Grok). */
  profile: "normal" | "yolo" | "auto";
  role: "agent" | "orchestrator" | "subagent";
  cwd: string;
  parentSessionId?: string;
  /** The app is bringing back a saved card. */
  restoring: boolean;
  /** The agent continues an earlier conversation. */
  resume: boolean;
  /** This plugin's values for this card, checked against its fields; empty when `chosen` is false. */
  options: Record<string, boolean | string>;
  /** The person chose this plugin for the launch; false for a policy check, whose answer may only refuse. */
  chosen: boolean;
  /** Where the card runs: the chosen or saved environment, or null on this computer. */
  environment: { pluginId: string; kind: string } | null;
  /** A subagent on this computer in (or below) the folder the person chose for its top-level agent: that real path. */
  trustedFolder?: string;
  /** The same for every plugin asked: the model and effort the CLI is started with (absent = the CLI's default),
   * and the ids of the plugins selected for this launch, sorted. */
  requested: { model?: string; effort?: string; plugins: string[] };
  /** Other selected plugins' values, by plugin id: only fields whose owner lists this plugin in `visibleTo`. */
  peerOptions: Record<string, Record<string, boolean | string>>;
}

/**
 * Answer to `canvastty.launch.prepare` (or `null`). Answer within 5 s: a timeout, error or invalid
 * answer refuses the launch. Conflicting names between plugins, reserved names and approval or
 * conversation arguments refuse it as well.
 */
export interface CanvasTTYLaunchContribution {
  /** At most 32; values up to 8 KB. `{launchFiles}` becomes this run's folder of `files`. */
  env?: Record<string, string>;
  /** Env name -> the plugin's own secret key (needs `secrets`); the host sets the value and masks it. */
  secretEnv?: Record<string, string>;
  /** At most 32, appended after CanvasTTY's own arguments. */
  args?: string[];
  /** At most 16 files, 256 KB, removed when the process exits. */
  files?: Array<{ relPath: string; content: string }>;
  /** The agent runs on another model than its vendor's: profile "auto" runs as accept-edits. Allowed in a policy. */
  thirdPartyModel?: boolean;
  refuse?: { reason: string };
}

/** One launchable provider in `providers.list` (the `list_providers` entry). No tokens, e-mails, account ids or paths. */
export interface CanvasTTYProviderDirectoryEntry {
  id: CanvasTTYProviderId;
  name: string;
  /** Its CLI was found on this computer; null when CanvasTTY cannot tell. */
  installed: boolean | null;
  available: boolean;
  /** As the last usage-limits read left it; "unknown" when it was never read. */
  signIn: "ok" | "signed_out" | "expired" | "unknown";
  signInCheckedAt?: number;
  subagent: boolean;
  orchestrator: boolean;
  model: { supported: boolean; format: string; known?: string[]; knownAt?: number };
  efforts?: string[];
  profiles?: Array<"normal" | "auto" | "acceptEdits" | "plan">;
  /** Launch options of plugins whose `launch` block is `delegable`. */
  launchOptions?: Array<{ pluginId: string; plugin: string; fields: Array<{ key: string; kind: string; choices?: string[] }> }>;
}

export interface CanvasTTYProviderDirectory {
  providers: CanvasTTYProviderDirectoryEntry[];
  launchOptionTools?: string[];
  note: string;
}

/** Params of the first host notification, `canvastty.initialize`. */
export interface CanvasTTYServiceContext {
  apiVersion: 2;
  pluginId: string;
  serviceId: string;
  /** `<userData>/plugin-data/<pluginId>`: created before start, removed on uninstall. */
  dataDir: string;
  locale: string;
  hostVersion: string;
}

/** Notifications the host sends to a service. */
export type CanvasTTYServiceHostNotification =
  | { jsonrpc: "2.0"; method: "canvastty.initialize"; params: CanvasTTYServiceContext }
  | { jsonrpc: "2.0"; method: "canvastty.shutdown"; params: Record<string, never> }
  /** The person switched the app language; sent once to running services, no permission. */
  | { jsonrpc: "2.0"; method: "canvastty.locale.changed"; params: { locale: string } }
  | { jsonrpc: "2.0"; method: "canvastty.sessions.event"; params: CanvasTTYSessionEvent }
  | { jsonrpc: "2.0"; method: "canvastty.activity"; params: CanvasTTYLimitExhaustedActivity }
  /** Brokered requests (`accounts:broker`): the provider's status and content type, then chunks, then the end. */
  | { jsonrpc: "2.0"; method: "canvastty.accounts.head"; params: { requestId: string; status: number; contentType: string; retryAfter?: number } }
  | { jsonrpc: "2.0"; method: "canvastty.accounts.chunk"; params: { requestId: string; data: string } }
  | { jsonrpc: "2.0"; method: "canvastty.accounts.end"; params: CanvasTTYBrokerEnd };

/** Requests the host sends to a service, which plugin surfaces cannot send. */
export type CanvasTTYServiceHostRequest =
  | { jsonrpc: "2.0"; id: number; method: "canvastty.launch.prepare"; params: CanvasTTYLaunchContext }
  /** Answer `{ "<field key>": [{ value, label }] }` (at most 64 per field) within 3 s. */
  | { jsonrpc: "2.0"; id: number; method: "canvastty.launch.options"; params: { provider: CanvasTTYLaunchContext["provider"]; fields: string[] } }
  | { jsonrpc: "2.0"; id: number; method: "canvastty.environment.prepare"; params: CanvasTTYEnvironmentPrepareParams }
  | { jsonrpc: "2.0"; id: number; method: "canvastty.environment.wrap"; params: CanvasTTYEnvironmentWrapParams }
  | { jsonrpc: "2.0"; id: number; method: "canvastty.environment.resume"; params: { sessionId: string; kind: string; ref: CanvasTTYEnvironmentRef } }
  | { jsonrpc: "2.0"; id: number; method: "canvastty.environment.release"; params: CanvasTTYEnvironmentReleaseParams }
  | { jsonrpc: "2.0"; id: number; method: "canvastty.environment.describe"; params: { sessionId: string; kind: string; ref: CanvasTTYEnvironmentRef } }
  | { jsonrpc: "2.0"; id: number; method: "canvastty.environment.choices"; params: { kind: string; field: string } }
  | { jsonrpc: "2.0"; id: number; method: "canvastty.decide"; params: CanvasTTYDecisionRequest }
  | { jsonrpc: "2.0"; id: number; method: "canvastty.tools.call"; params: CanvasTTYToolCall }
  | { jsonrpc: "2.0"; id: number; method: "canvastty.cards.invoke"; params: CanvasTTYCardActionInvocation }
  | { jsonrpc: "2.0"; id: number; method: "canvastty.shares.read"; params: CanvasTTYShareReadRequest }
  /** Brokerable services: answer `CanvasTTYBrokerOffer[]` within 3 s. */
  | { jsonrpc: "2.0"; id: number; method: "canvastty.broker.offer"; params: Record<string, never> }
  /** Answer `{ ok: true }` within 1 s to let the request go; anything else (or no answer) refuses it as budget_refused. */
  | { jsonrpc: "2.0"; id: number; method: "canvastty.broker.admit"; params: { ref: string; caller: { pluginId: string }; model: string; estimate: { bodyBytes: number } } }
  /** After the request: what it used. */
  | { jsonrpc: "2.0"; id: number; method: "canvastty.broker.settle"; params: { ref: string; caller: { pluginId: string }; model: string; status: string; httpStatus: number; retryAfter?: number; usage: { input: number; output: number; cached: number } } };

/** Methods a service may call on the host. Every other method is answered with error -32601. */
export interface CanvasTTYServiceHostApi {
  /** Request or notification. */
  log(params: { level?: "info" | "warn" | "error"; message: string }): null;
  /** Needs the `storage` permission. */
  "storage.get"(params: { key: string }): unknown;
  /** Needs the `storage` permission. */
  "storage.set"(params: { key: string; value: unknown }): null;
  /** Notification only: delivered to this plugin's surfaces through `host.service.onEvent`. */
  event(params: { event: string; data?: unknown }): void;
  /** Up to 32 values (8 to 4096 characters) masked in every text one agent reads from another; memory only. */
  "redaction.register"(params: { values: string[] }): null;
  /** Needs the `secrets` permission: the plugin's own secret, or null; the value is masked for agents from then on. */
  "secrets.get"(params: { key: string }): string | null;
  /** Needs `sessions:events`. Events follow as `canvastty.sessions.event`; call again after every start. */
  "sessions.subscribe"(params: { ownedOnly?: boolean }): { sessions: Array<CanvasTTYSessionSummary & { owned: boolean }> };
  "sessions.unsubscribe"(params: Record<string, never>): null;
  /** Needs `sessions:events`. */
  "sessions.list"(params: { ownedOnly?: boolean }): { sessions: Array<CanvasTTYSessionSummary & { owned: boolean }> };
  /** Needs `sessions:launch`. An `agent` card through the normal launch pipeline; at most 16 per plugin. `role:
   * "orchestrator"` also needs the person's "May start orchestrators" for this plugin and never takes `yolo`. */
  "sessions.create"(params: {
    provider: CanvasTTYProviderId; cwd: string; profile?: "normal" | "yolo" | "auto"; title?: string;
    role?: "agent" | "orchestrator";
    launchOptions?: Record<string, Record<string, boolean | string>>;
    environment?: { pluginId: string; kind: string; options?: Record<string, boolean | string> };
  }): { sessionId: string };
  /** Needs `sessions:control`; only cards this plugin created. Enter is added unless `submit: false`. */
  /** Waits until a launch its plugins prepare has started; `sent` is false (and the text dropped) when it did not start. */
  "sessions.send"(params: { sessionId: string; text: string; submit?: boolean }): { sessionId: string; sent: boolean };
  /** Needs `sessions:control`; only cards this plugin created. Closes the card, keeps its environment data. */
  "sessions.stop"(params: { sessionId: string }): { sessionId: string; stopped: true };
  /**
   * Needs `limits:read`: the answer plugin surfaces get. Without params the default login (served from the host's
   * cache; refreshed at most once per 5 minutes for all services when older than 60 s). With `{ provider, home }`
   * (also needs `launch:contribute`): an existing folder strictly inside this plugin's data folder, no symbolic link;
   * at most 32 homes per plugin, each read at most once per 3 minutes. Qwen homes are read passively and always
   * answer `unavailable` (Qwen Code exposes no quota).
   */
  "limits.get"(params: Record<string, never> | { provider: "codex" | "claude" | "qwen" | "kimi" | "opencode" | "grok"; home: string }): { state: "ready"; snapshot: CanvasTTYLimitsSnapshot };
  /** Needs `limits:read`. Starts no read. Changes follow as `canvastty.limits.changed`; call again after every start. */
  "limits.subscribe"(params: Record<string, never>): { state: "ready"; snapshot: CanvasTTYLimitsSnapshot } | { state: "loading"; snapshot: null };
  "limits.unsubscribe"(params: Record<string, never>): null;
  /** Needs `providers:read`. What `list_providers` gives an orchestrator, from cached reads only. */
  "providers.list"(params: Record<string, never>): CanvasTTYProviderDirectory;
  /** Needs `cards:decorate`. `null` removes this plugin's badge from the card. */
  /** Needs `accounts:broker`. The granted, currently offered accounts of other plugins. */
  "accounts.list"(params: Record<string, never>): { accounts: CanvasTTYBrokerAccount[] };
  /**
   * Needs `accounts:broker` and the person's grant for the pair. Answers `{ requestId, accepted: true }` once the
   * owner admitted it; the answer follows as `canvastty.accounts.head|chunk|end`. Refusals carry `error.data.reason`.
   */
  "accounts.request"(params: CanvasTTYBrokerRequest): { requestId: string; accepted: true };
  /** A body part (at most 768 K characters) for a request over the message limit; up to 8 MB in all, held 60 s. */
  "accounts.body"(params: { requestId: string; data: string }): { received: number };
  /** Aborts the request; `end` follows with `cancelled`. */
  "accounts.cancel"(params: { requestId: string }): { cancelled: boolean };
  "cards.setBadge"(params: { sessionId: string; badge: { text: string; tone?: CanvasTTYCardTone; tooltip?: string } | null }): null;
  /**
   * Reads another plugin's share. Needs the pair in the manifest's `uses` and the person's approval; both plugins
   * enabled with native code trusted. 5 s, 16 KB params, 60 per minute and 4 at once per pair. Refusals carry
   * `error.data.reason` (CanvasTTYSharedReadRefusal).
   */
  "plugins.request"(params: { plugin: string; method: string; params?: unknown }): CanvasTTYSharedReadResult;
  /**
   * Needs `usage:read` (`homes` also `launch:contribute`). Measured usage of a card this plugin started or whose
   * launch options include this plugin's; an unknown or foreign id is refused. 30 calls a minute per plugin.
   */
  "usage.session"(params: { cardId: string; homes?: CanvasTTYUsageHome[] }): CanvasTTYUsageSession;
  /** Needs `usage:read` (`homes` also `launch:contribute`). The same cards (and homes) over `[since, until)`, at most 30 days. */
  "usage.summary"(params: {
    since?: number; until?: number;
    groupBy?: CanvasTTYUsageGroup | CanvasTTYUsageGroup[];
    homes?: CanvasTTYUsageHome[];
  }): CanvasTTYUsageSummary;
}

/**
 * An account home in the plugin's own data folder (exact absolute path, no symbolic links, at most 32 per plugin and
 * 8 per call): a `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, OpenCode data folder (or the `XDG_DATA_HOME` holding it),
 * `QWEN_HOME`, or `KIMI_CODE_HOME` / `KIMI_SHARE_DIR` the plugin hands to launches.
 */
export interface CanvasTTYUsageHome {
  provider: "claude" | "codex" | "opencode" | "qwen" | "kimi";
  home: string;
}

export type CanvasTTYUsageGroup = "provider" | "model" | "home";

export interface CanvasTTYUsageCounts {
  /** Prompt tokens, cached ones included. */
  input: number;
  /** Output tokens, reasoning included. */
  output: number;
  /** The cache-read part of `input`. */
  cached: number;
  /** Usage records. */
  events: number;
  /** Sum of the agent's own price estimates in USD (OpenCode's `cost`) over records that carry one; absent if none. Not a bill. */
  providerCostEstimate?: number;
}

export interface CanvasTTYUsageCoverage {
  /** When CanvasTTY's usage history last collected (every 60 s); 0 before the first collection. */
  collectedAt: number;
  /** False when a collection over the period could not read every source: the numbers may be low. */
  complete: boolean;
}

export type CanvasTTYUsageSession =
  | {
    cardId: string;
    provider: CanvasTTYProviderId;
    measured: true;
    totals: CanvasTTYUsageCounts;
    /** At most 256, largest first; `model` is null where the log named none. */
    models: Array<CanvasTTYUsageCounts & { model: string | null }>;
    firstAt: number | null;
    lastAt: number | null;
    coverage: CanvasTTYUsageCoverage;
  }
  | { cardId: string; provider: CanvasTTYProviderId; measured: false; reason: "conversation-unknown" | "provider-not-recorded" };

export interface CanvasTTYUsageSummary {
  since: number;
  until: number;
  groupBy: CanvasTTYUsageGroup[];
  totals: CanvasTTYUsageCounts & { sessions: number };
  /** At most 256, largest first; each row has the grouped keys. `home` is an index into `homes`, null for CanvasTTY's own history. */
  rows: Array<CanvasTTYUsageCounts & { provider?: string; model?: string | null; home?: number | null; sessions: number }>;
  truncated: boolean;
  coverage: CanvasTTYUsageCoverage;
}
