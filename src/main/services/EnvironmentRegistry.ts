import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type {
  PluginEnvironmentKeeps,
  PluginEnvironmentKind,
  PluginLaunchField,
  PluginLaunchValues,
  ProviderId,
  SessionEnvironmentChoice
} from "../../shared/contracts.ts";
import { envKey, errorText, isRecord, MAX_ENV, MAX_ENV_VALUE_BYTES, MAX_SECRET_ENV, stringMap } from "./LaunchPipeline.ts";
import { MAX_PLUGIN_SLOT_BYTES, type PersistedEnvironmentRef } from "./TerminalSessionStore.ts";

/** A trusted plugin service that provides session environments (PluginManager.environmentProviders). */
export interface EnvironmentProvider {
  pluginId: string;
  pluginName: string;
  serviceId: string;
  kinds: PluginEnvironmentKind[];
  /** The plugin holds the `secrets` permission, so `wrap` may name its secrets in `secretEnv`. */
  secrets: boolean;
}

/** One environment kind an orchestrator may choose for subagents, as list_providers shows it: ids and names only. */
export interface DelegatedEnvironmentKind {
  pluginId: string;
  plugin: string;
  kind: string;
  name: string;
  appliesTo?: ProviderId[];
  /** The fields an orchestrator may set (static choices only; the plugin checks the rest when it prepares). */
  options: Array<{ key: string; kind: PluginLaunchField["kind"]; choices?: string[] }>;
  /** Subagents at once: per value of `capBy` (each server) when it is set, else in the whole kind. */
  maxParallel: number;
  /** The settable field whose value names a server; each value has its own cap. */
  capBy?: string;
  /** With capBy: subagents at once in the whole kind, all servers together. */
  maxParallelTotal?: number;
  /**
   * With capBy: the values an orchestrator may pass for it, the person's servers by the labels they gave them (static
   * select values, or what the plugin answered to `canvastty.environment.choices`); null until the plugin answered.
   */
  servers?: string[] | null;
  /** The launch reaches the agent unchanged (CanvasTTY's hooks and every profile work there); otherwise normal only. */
  keepsLaunch: boolean;
}

/** Subagents in one kind at once when the plugin did not say. */
export const DEFAULT_ENVIRONMENT_SUBAGENTS = 1;

export type EnvironmentStep = "prepare" | "wrap" | "resume" | "release" | "describe" | "choices";
export type EnvironmentMethod = `canvastty.environment.${EnvironmentStep}`;

export interface EnvironmentRegistryDependencies {
  providers(): EnvironmentProvider[];
  call(pluginId: string, serviceId: string, method: EnvironmentMethod, params: unknown, timeoutMs: number): Promise<unknown>;
  /** Reads one of the plugin's own secrets in this process; the value never reaches plugin code or UI. */
  secret(pluginId: string, key: string): Promise<string | null>;
  timeouts?: Partial<Record<EnvironmentStep, number>>;
  platform?: NodeJS.Platform;
}

/** The core never waits longer and never falls back to a local launch when a step runs out. */
const ENVIRONMENT_TIMEOUTS: Record<EnvironmentStep, number> = {
  prepare: 15_000,
  wrap: 5_000,
  resume: 10_000,
  release: 10_000,
  describe: 3_000,
  choices: 2_000
};

/** How long the server labels a plugin answered stay valid, and how many it may answer. */
const CHOICES_TTL_MS = 30_000;
const MAX_CHOICES = 64;

/**
 * How long a prepare or resume that ran out of time may still answer: the plugin call itself keeps this budget (the
 * host call maximum), so an environment it creates or starts late is still heard of and released instead of left
 * running.
 */
const LATE_ANSWER_BUDGET_MS = 60_000;

/** What the host would spawn without an environment; `wrap` returns its replacement. */
export interface EnvironmentLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export type PreparedEnvironment =
  | { ok: true; environment: PersistedEnvironmentRef; cwd?: string }
  | { ok: false; reason: string };

export type WrappedLaunch =
  | { ok: true; command: string; args: string[]; env: Record<string, string>; cwd: string; secrets: string[] }
  | { ok: false; reason: string };

const MAX_LABEL = 80;
const MAX_DETAIL = 240;
const MAX_REASON = 240;
const MAX_WRAP_ARGS = 256;
const MAX_WRAP_ARG_BYTES = 8 * 1024;
const BARE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

export class EnvironmentRegistry {
  private readonly dependencies: EnvironmentRegistryDependencies;
  private readonly timeouts: Record<EnvironmentStep, number>;
  /** The latest resume asked per session: a late answer to an earlier one never stops what a newer one started. */
  private readonly resumes = new Map<string, number>();
  private resumeSerial = 0;
  /** Server labels per `<pluginId>\u0000<kind>` (canvastty.environment.choices), with when they were read. */
  private readonly choiceCache = new Map<string, { at: number; values: string[] | null }>();
  private readonly choiceReads = new Map<string, Promise<void>>();

  constructor(dependencies: EnvironmentRegistryDependencies) {
    this.dependencies = dependencies;
    this.timeouts = { ...ENVIRONMENT_TIMEOUTS, ...dependencies.timeouts };
  }

  /** What the plugin declared its environment keeps of CanvasTTY's protection (nothing when it declared nothing). */
  keeps(environment: Pick<PersistedEnvironmentRef, "pluginId" | "kind">): PluginEnvironmentKeeps {
    return { ...(this.lookup(environment.pluginId, environment.kind)?.kind.keeps ?? {}) };
  }

  /** True when the plugin named by a saved ref can serve that kind now. */
  available(environment: Pick<PersistedEnvironmentRef, "pluginId" | "kind">): boolean {
    return Boolean(this.lookup(environment.pluginId, environment.kind));
  }

  unavailableReason(environment: Pick<PersistedEnvironmentRef, "pluginId" | "kind" | "label">): string {
    return `Needs plugin ${environment.pluginId} (${environment.label}); it is disabled, removed, or its native code is not trusted. It was not started locally.`;
  }

  /**
   * Checks a launcher choice against the provider's declared kinds and fields and fills defaults.
   * Throws with a person-readable reason; returns undefined for "this computer".
   */
  normalizeChoice(provider: ProviderId, candidate: unknown): SessionEnvironmentChoice | undefined {
    if (candidate === undefined || candidate === null) return undefined;
    if (!isRecord(candidate) || typeof candidate.pluginId !== "string" || typeof candidate.kind !== "string") {
      throw new Error("Environment choice is invalid.");
    }
    const found = this.lookup(candidate.pluginId, candidate.kind);
    if (!found) throw new Error(`Environment ${candidate.kind.slice(0, 32)} from plugin ${candidate.pluginId.slice(0, 80)} is not available.`);
    const { provider: owner, kind } = found;
    if (kind.appliesTo && !kind.appliesTo.includes(provider)) throw new Error(`${kind.label} does not apply to ${provider}.`);
    const raw = candidate.options ?? {};
    if (!isRecord(raw)) throw new Error(`${kind.label} options are invalid.`);
    const fields = kind.fields ?? [];
    const known = new Set(fields.map((field) => field.key));
    const unknown = Object.keys(raw).find((key) => !known.has(key));
    if (unknown) throw new Error(`${kind.label} has no option ${unknown.slice(0, 40)}.`);
    const options: PluginLaunchValues = {};
    for (const field of fields) {
      const value = raw[field.key] ?? field.default
        ?? (field.kind === "boolean" ? false : field.kind === "select" ? field.options?.[0]?.value ?? "" : "");
      const valid = field.kind === "boolean"
        ? typeof value === "boolean"
        : field.kind === "select"
          ? typeof value === "string" && Boolean(field.options?.some((option) => option.value === value))
          : typeof value === "string" && value.length <= (field.maxLength ?? 200) && !/[\u0000-\u001f\u007f]/.test(value);
      if (!valid) throw new Error(`${kind.label} option ${field.label} is invalid.`);
      options[field.key] = value as boolean | string;
    }
    return { pluginId: owner.pluginId, kind: kind.kind, ...(fields.length ? { options } : {}) };
  }

  /**
   * The kinds an orchestrator may choose for its subagents now: offered by an enabled plugin whose native code the
   * person trusted (the launcher's list), and declared safe for subagents by that plugin. No plugin is asked anything.
   */
  delegatedKinds(): DelegatedEnvironmentKind[] {
    const kinds: DelegatedEnvironmentKind[] = [];
    const seen = new Set<string>();
    for (const provider of this.dependencies.providers()) {
      for (const kind of provider.kinds) {
        const key = `${provider.pluginId}\u0000${kind.kind}`;
        if (!kind.subagents || seen.has(key)) continue;
        seen.add(key);
        kinds.push(this.withServers(delegatedKind(provider, kind), kind));
      }
    }
    return kinds;
  }

  /**
   * Checks an orchestrator's environment for a subagent: the kind must be available now and declared safe for
   * subagents, apply to the provider, and set only the fields its plugin let an orchestrator set (the others keep
   * their declared defaults, never the person's last launcher values). Never asks the plugin.
   */
  delegatedChoice(provider: ProviderId, candidate: unknown): { ok: true; choice: SessionEnvironmentChoice; kind: DelegatedEnvironmentKind } | { ok: false; reason: string } {
    if (!isRecord(candidate) || typeof candidate.pluginId !== "string" || typeof candidate.kind !== "string") {
      return { ok: false, reason: "environment must be { pluginId, kind, options? } from list_providers." };
    }
    const found = this.lookup(candidate.pluginId, candidate.kind);
    if (!found) {
      return { ok: false, reason: `Environment ${candidate.kind.slice(0, 32)} from plugin ${candidate.pluginId.slice(0, 80)} is not available: its plugin is disabled, removed or not trusted, or offers no such kind. Call list_providers for the environments subagents may use.` };
    }
    const { provider: owner, kind } = found;
    if (!kind.subagents) {
      return { ok: false, reason: `${owner.pluginName} has not declared ${kind.label} safe for an orchestrator to choose; only the person starts agents there, in the launcher.` };
    }
    if (kind.appliesTo && !kind.appliesTo.includes(provider)) return { ok: false, reason: `${kind.label} does not apply to ${provider}.` };
    const raw = candidate.options ?? {};
    if (!isRecord(raw)) return { ok: false, reason: `${kind.label} options are invalid.` };
    const allowed = new Set(kind.subagents.fields ?? []);
    const refused = Object.keys(raw).find((key) => !allowed.has(key));
    if (refused) {
      return { ok: false, reason: `${kind.label}: an orchestrator may not set ${refused.slice(0, 40)}; only the person sets it, in the launcher. Options it may set: ${[...allowed].join(", ") || "none"}.` };
    }
    try {
      const choice = this.normalizeChoice(provider, { pluginId: owner.pluginId, kind: kind.kind, options: raw });
      if (!choice) return { ok: false, reason: "environment is invalid." };
      const delegated = this.withServers(delegatedKind(owner, kind), kind);
      if (delegated.capBy) {
        const value = choice.options?.[delegated.capBy];
        const field = kind.fields?.find((candidate) => candidate.key === delegated.capBy);
        const name = field?.label ?? delegated.capBy;
        if (typeof value !== "string" || value.length === 0) {
          return { ok: false, reason: `${kind.label}: pass options.${delegated.capBy} (${name}), one of the servers list_providers lists for it.` };
        }
        if (!delegated.servers) {
          return { ok: false, reason: `${owner.pluginName} did not list the servers for ${kind.label}, so none can be chosen now; call list_providers again later.` };
        }
        if (!delegated.servers.includes(value)) {
          return { ok: false, reason: `${kind.label}: ${value.slice(0, 40)} is not one of the servers the person set up for subagents (${delegated.servers.join(", ") || "none"}). Call list_providers for them.` };
        }
      }
      return { ok: true, choice, kind: delegated };
    } catch (error) {
      return { ok: false, reason: errorText(error) };
    }
  }

  /**
   * Asks each plugin whose subagent kind is capped per server for the person's servers (labels only), at most every
   * 30 s per kind and 2 s per call. A failure or invalid answer leaves no servers, so none can be chosen (fail closed).
   */
  async refreshChoices(): Promise<void> {
    const reads: Array<Promise<void>> = [];
    for (const provider of this.dependencies.providers()) {
      for (const kind of provider.kinds) {
        const field = serverField(kind);
        if (!field || field.kind === "select") continue;
        const key = `${provider.pluginId}\u0000${kind.kind}`;
        const cached = this.choiceCache.get(key);
        if (cached && Date.now() - cached.at < CHOICES_TTL_MS) continue;
        let read = this.choiceReads.get(key);
        if (!read) {
          read = this.ask(provider, "choices", { kind: kind.kind, field: field.key }).then((answer) => {
            this.choiceCache.set(key, { at: Date.now(), values: answer.ok ? serverLabels(answer.value, field) : null });
          }).finally(() => this.choiceReads.delete(key));
          this.choiceReads.set(key, read);
        }
        reads.push(read);
      }
    }
    await Promise.all(reads);
  }

  private withServers(delegated: DelegatedEnvironmentKind, kind: PluginEnvironmentKind): DelegatedEnvironmentKind {
    const field = serverField(kind);
    if (!field) return delegated;
    const servers = field.kind === "select"
      ? (field.options ?? []).map((option) => option.value)
      : this.choiceCache.get(`${delegated.pluginId}\u0000${kind.kind}`)?.values ?? null;
    return { ...delegated, servers: servers ? [...servers] : null };
  }

  /** `canvastty.environment.prepare`: creates the place (a worktree, a container) and returns its ref. */
  async prepare(request: {
    sessionId: string;
    provider: ProviderId;
    cwd: string;
    choice: SessionEnvironmentChoice;
    /** The task's original project (the folder of the agent the person started), for a worktree of that repository. */
    projectRoot?: string;
  }): Promise<PreparedEnvironment> {
    const found = this.lookup(request.choice.pluginId, request.choice.kind);
    if (!found) return { ok: false, reason: `Environment ${request.choice.kind} from plugin ${request.choice.pluginId} is not available.` };
    const answer = await this.ask(found.provider, "prepare", {
      sessionId: request.sessionId,
      kind: request.choice.kind,
      provider: request.provider,
      cwd: request.cwd,
      ...(request.projectRoot ? { projectRoot: request.projectRoot } : {}),
      options: request.choice.options ?? {}
    }, undefined, {
      budgetMs: LATE_ANSWER_BUDGET_MS,
      // The launch already failed as timed out and nothing holds this ref: release it, data included.
      late: (value) => {
        if (!isRecord(value) || value.refuse !== undefined || value.ref === undefined || !fitsSlot(value.ref)) return;
        const environment = { pluginId: found.provider.pluginId, kind: request.choice.kind, ref: structuredClone(value.ref), label: plainText(value.label, MAX_LABEL) || request.choice.kind };
        void this.release(environment, request.sessionId, { keepData: false, reason: "closed" });
      }
    });
    if (!answer.ok) return answer;
    const value = answer.value;
    const name = found.provider.pluginName;
    if (isRecord(value) && value.refuse !== undefined) return { ok: false, reason: `${name}: ${refusal(value.refuse)}` };
    if (!isRecord(value)) return { ok: false, reason: `${name} answered with an invalid environment: not an object` };
    const unknown = Object.keys(value).find((key) => !["ref", "label", "cwd"].includes(key));
    if (unknown) return { ok: false, reason: `${name} answered with an invalid environment: unknown key ${unknown.slice(0, 40)}` };
    if (value.ref === undefined || !fitsSlot(value.ref)) {
      return { ok: false, reason: `${name} answered with an invalid environment: ref must be JSON of at most 4 KB` };
    }
    const label = plainText(value.label, MAX_LABEL);
    if (!label) return { ok: false, reason: `${name} answered with an invalid environment: label is required` };
    if (value.cwd !== undefined && !isDirectory(value.cwd)) {
      return { ok: false, reason: `${name} answered with an invalid environment: cwd must be an existing absolute folder` };
    }
    return {
      ok: true,
      environment: { pluginId: found.provider.pluginId, kind: request.choice.kind, ref: structuredClone(value.ref), label },
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {})
    };
  }

  /** `canvastty.environment.resume`: on restore and before relaunching a card from an earlier run. */
  async resume(environment: PersistedEnvironmentRef, sessionId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const found = this.lookup(environment.pluginId, environment.kind);
    if (!found) return { ok: false, reason: this.unavailableReason(environment) };
    const serial = ++this.resumeSerial;
    this.resumes.set(sessionId, serial);
    const answer = await this.ask(found.provider, "resume", refParams(environment, sessionId), undefined, {
      budgetMs: LATE_ANSWER_BUDGET_MS,
      // The launch already failed as timed out, yet the plugin started the environment: stop it again. The card still
      // holds the ref (a restart resumes it), so its data is kept.
      late: (value) => {
        if (this.resumes.get(sessionId) !== serial) return;
        this.resumes.delete(sessionId);
        if (isRecord(value) && value.ok === true) void this.release(environment, sessionId, { keepData: true, reason: "closed" });
      }
    });
    if (answer.ok && this.resumes.get(sessionId) === serial) this.resumes.delete(sessionId);
    if (!answer.ok) return answer;
    const value = answer.value;
    const name = found.provider.pluginName;
    if (isRecord(value) && value.ok === true && Object.keys(value).length === 1) return { ok: true };
    if (isRecord(value) && value.stopped !== undefined) return { ok: false, reason: `${name}: ${refusal(value.stopped)}` };
    return { ok: false, reason: `${name} answered resume with neither ok nor stopped.` };
  }

  /**
   * `canvastty.environment.wrap`: turns the host's launch into the one that runs inside the environment.
   * The host still spawns the PTY; the answer is validated and merged under the launch-contributor rules.
   */
  async wrap(environment: PersistedEnvironmentRef, request: {
    sessionId: string;
    provider: ProviderId;
    launch: EnvironmentLaunch;
    /** Names the host sets for this launch whose values the environment never sees (secrets). */
    secretEnvNames: string[];
    /** Names CanvasTTY or a launch contributor sets for this launch; the environment may not set them. */
    takenEnv: ReadonlySet<string>;
    /** PATH used to resolve a bare command name. */
    path: string | undefined;
  }): Promise<WrappedLaunch> {
    const found = this.lookup(environment.pluginId, environment.kind);
    if (!found) return { ok: false, reason: this.unavailableReason(environment) };
    const { provider } = found;
    const name = provider.pluginName;
    const answer = await this.ask(provider, "wrap", {
      ...refParams(environment, request.sessionId),
      provider: request.provider,
      command: request.launch.command,
      args: request.launch.args,
      env: request.launch.env,
      secretEnvNames: request.secretEnvNames,
      cwd: request.launch.cwd
    });
    if (!answer.ok) return answer;
    const invalid = (problem: string): WrappedLaunch => ({ ok: false, reason: `${name} answered with an invalid launch: ${problem}` });
    const value = answer.value;
    if (isRecord(value) && value.refuse !== undefined) return { ok: false, reason: `${name}: ${refusal(value.refuse)}` };
    if (!isRecord(value)) return invalid("not an object");
    const unknown = Object.keys(value).find((key) => !["command", "args", "env", "secretEnv", "cwd"].includes(key));
    if (unknown) return invalid(`unknown key ${unknown.slice(0, 40)}`);
    if (typeof value.command !== "string" || value.command.length === 0 || value.command.length > 1_024) return invalid("command is required");
    const command = resolveCommand(value.command, request.path, this.dependencies.platform ?? process.platform);
    if (!command) {
      return invalid(`command ${value.command.slice(0, 80)} must be an absolute path to a program or a bare program name on PATH; CanvasTTY runs no shell string`);
    }
    const args = value.args ?? [];
    if (!Array.isArray(args) || args.length > MAX_WRAP_ARGS) return invalid(`args must be an array of at most ${MAX_WRAP_ARGS}`);
    for (const argument of args) {
      if (typeof argument !== "string" || argument.includes("\u0000") || Buffer.byteLength(argument, "utf8") > MAX_WRAP_ARG_BYTES) {
        return invalid("every arg must be text without NUL, at most 8 KB");
      }
    }
    if (value.cwd !== undefined && !isDirectory(value.cwd)) return invalid("cwd must be an existing absolute folder");
    const env = stringMap(value.env, MAX_ENV, "env");
    if (typeof env === "string") return invalid(env);
    for (const [key, entry] of Object.entries(env)) {
      if (entry.includes("\u0000") || Buffer.byteLength(entry, "utf8") > MAX_ENV_VALUE_BYTES) return invalid(`env ${key} value is invalid or larger than 8 KB`);
    }
    const secretEnv = stringMap(value.secretEnv, MAX_SECRET_ENV, "secretEnv");
    if (typeof secretEnv === "string") return invalid(secretEnv);
    const merged: Record<string, string> = {};
    const secrets: string[] = [];
    const platform = this.dependencies.platform ?? process.platform;
    const taken = new Set([...request.takenEnv].map((key) => envKey(key, platform)));
    const seen = new Set<string>();
    for (const key of [...Object.keys(env), ...Object.keys(secretEnv)]) {
      if (taken.has(envKey(key, platform))) return { ok: false, reason: `${name} sets ${key}, which CanvasTTY or a launch option already sets for this launch.` };
      if (seen.has(envKey(key, platform))) return { ok: false, reason: `${name} sets ${key} twice.` };
      seen.add(envKey(key, platform));
      merged[key] = env[key] ?? "";
    }
    for (const [key, secretKey] of Object.entries(secretEnv)) {
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(secretKey)) return invalid(`secretEnv ${key} must name a plugin secret key`);
      if (!provider.secrets) return { ok: false, reason: `${name} asked for a secret without the secrets permission.` };
      const secret = await this.dependencies.secret(provider.pluginId, secretKey).catch(() => null);
      if (typeof secret !== "string" || secret.length === 0) return { ok: false, reason: `${name}: its secret ${secretKey} is not set.` };
      if (secret.includes("\u0000")) return { ok: false, reason: `${name}: its secret ${secretKey} cannot be passed in the environment.` };
      merged[key] = secret;
      secrets.push(secret);
    }
    return {
      ok: true,
      command,
      args: args as string[],
      env: merged,
      cwd: typeof value.cwd === "string" ? value.cwd : request.launch.cwd,
      secrets
    };
  }

  /** `canvastty.environment.release`: the card was closed (or the app quit with saving off). Never throws. */
  async release(environment: PersistedEnvironmentRef, sessionId: string, options: { keepData: boolean; reason: "closed" | "quit"; timeoutMs?: number }): Promise<void> {
    const found = this.lookup(environment.pluginId, environment.kind);
    if (!found) return;
    const answer = await this.ask(found.provider, "release", {
      ...refParams(environment, sessionId),
      keepData: options.keepData,
      reason: options.reason
    }, options.timeoutMs);
    if (!answer.ok) console.warn(`CanvasTTY environment ${environment.label} could not be released: ${answer.reason}`);
  }

  /** `canvastty.environment.describe`: the card badge text; null when the plugin gave none. */
  async describe(environment: PersistedEnvironmentRef, sessionId: string): Promise<{ label: string; detail?: string } | null> {
    const found = this.lookup(environment.pluginId, environment.kind);
    if (!found) return null;
    const answer = await this.ask(found.provider, "describe", refParams(environment, sessionId));
    if (!answer.ok || !isRecord(answer.value)) return null;
    const label = plainText(answer.value.label, MAX_LABEL);
    if (!label) return null;
    const detail = plainText(answer.value.detail, MAX_DETAIL);
    return { label, ...(detail ? { detail } : {}) };
  }

  private lookup(pluginId: string, kindId: string): { provider: EnvironmentProvider; kind: PluginEnvironmentKind } | null {
    // Kinds are unique within a plugin, whichever of its services lists them.
    const provider = this.dependencies.providers()
      .find((candidate) => candidate.pluginId === pluginId && candidate.kinds.some((kind) => kind.kind === kindId));
    const kind = provider?.kinds.find((candidate) => candidate.kind === kindId);
    return provider && kind ? { provider, kind } : null;
  }

  /**
   * One plugin call within `timeoutMs`. With `lateAnswer`, the call itself may run for `budgetMs` and an answer that
   * comes after the timeout goes to `late` (the caller has already been told it timed out).
   */
  private async ask(
    provider: EnvironmentProvider,
    step: EnvironmentStep,
    params: unknown,
    timeoutMs = this.timeouts[step],
    lateAnswer?: { budgetMs: number; late(value: unknown): void }
  ): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const call = this.dependencies.call(provider.pluginId, provider.serviceId, `canvastty.environment.${step}`, params,
      lateAnswer ? Math.max(timeoutMs, lateAnswer.budgetMs) : timeoutMs);
    if (lateAnswer) call.then((value) => { if (timedOut) lateAnswer.late(value); }, () => undefined);
    try {
      const value = await Promise.race([
        call,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { timedOut = true; reject(new Error("timed out")); }, timeoutMs);
        })
      ]);
      return { ok: true, value };
    } catch (error) {
      const text = errorText(error);
      if (/timed out/i.test(text)) {
        return { ok: false, reason: `${provider.pluginName} did not answer ${step} within ${Number((timeoutMs / 1000).toFixed(1))} s; nothing was started locally.` };
      }
      return { ok: false, reason: `${provider.pluginName} could not ${step} the environment: ${text}` };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function delegatedKind(provider: EnvironmentProvider, kind: PluginEnvironmentKind): DelegatedEnvironmentKind {
  const allowed = new Set(kind.subagents?.fields ?? []);
  return {
    pluginId: provider.pluginId,
    plugin: provider.pluginName,
    kind: kind.kind,
    name: kind.label,
    ...(kind.appliesTo ? { appliesTo: [...kind.appliesTo] } : {}),
    options: (kind.fields ?? []).filter((field) => allowed.has(field.key)).map((field) => ({
      key: field.key,
      kind: field.kind,
      ...(field.kind === "select" && field.options?.length && field.optionsFrom !== "service"
        ? { choices: field.options.map((option) => option.value) }
        : {})
    })),
    maxParallel: kind.subagents?.maxParallel ?? DEFAULT_ENVIRONMENT_SUBAGENTS,
    ...(kind.subagents?.capBy ? { capBy: kind.subagents.capBy } : {}),
    ...(kind.subagents?.maxParallelTotal !== undefined ? { maxParallelTotal: kind.subagents.maxParallelTotal } : {}),
    keepsLaunch: kind.keeps?.launch === true
  };
}

/** The field that names a server in a kind capped per server (subagents.capBy). */
function serverField(kind: PluginEnvironmentKind): PluginLaunchField | null {
  const key = kind.subagents?.capBy;
  return key ? kind.fields?.find((field) => field.key === key) ?? null : null;
}

/**
 * A plugin's `{ choices: string[] }` as server labels: plain text that fits the field, each once, at most 64. Anything
 * else is no answer. The labels are the person's names for servers; the plugin answers no address, user or key.
 */
function serverLabels(value: unknown, field: PluginLaunchField): string[] | null {
  if (!isRecord(value) || !Array.isArray(value.choices) || Object.keys(value).some((key) => key !== "choices")) return null;
  const limit = field.maxLength ?? 200;
  const labels: string[] = [];
  for (const entry of value.choices.slice(0, MAX_CHOICES)) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > limit || /[\u0000-\u001f\u007f]/.test(entry)) continue;
    if (entry.trim() !== entry || labels.includes(entry)) continue;
    labels.push(entry);
  }
  return labels;
}

function refParams(environment: PersistedEnvironmentRef, sessionId: string): Record<string, unknown> {
  return { sessionId, kind: environment.kind, ref: structuredClone(environment.ref) };
}

function refusal(value: unknown): string {
  const reason = isRecord(value) ? value.reason : value;
  return plainText(reason, MAX_REASON) || "no reason given";
}

function plainText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit) : "";
}

function fitsSlot(value: unknown): boolean {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" && Buffer.byteLength(json, "utf8") <= MAX_PLUGIN_SLOT_BYTES;
  } catch {
    return false;
  }
}

function isDirectory(value: unknown): value is string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\u0000")) return false;
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

/**
 * An absolute path to an executable file, or a bare program name found on PATH. Anything else
 * (a relative path, a command line with spaces or shell syntax) is refused: the host spawns the
 * program directly with an argv and never through a shell.
 */
export function resolveCommand(command: string, path: string | undefined, platform: NodeJS.Platform = process.platform): string | null {
  if (command.includes("\u0000")) return null;
  if (isAbsolute(command)) return isExecutable(command, platform) ? command : null;
  if (!BARE_COMMAND.test(command)) return null;
  const extensions = platform === "win32" && !/\.(?:exe|com)$/iu.test(command) ? [".exe", ".com"] : [""];
  for (const directory of (path ?? "").split(platform === "win32" ? ";" : delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (isExecutable(candidate, platform)) return candidate;
    }
  }
  return null;
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
