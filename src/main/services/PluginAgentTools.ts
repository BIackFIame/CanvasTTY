import { createHash } from "node:crypto";
import type { AgentProviderId, PluginAgentTool, ProviderId, SessionRole } from "../../shared/contracts.ts";
import { MAX_PLUGIN_TOOL_NAME_LENGTH, isPluginOrchestrationTool } from "../../agent-browser/orchestration-catalog.mjs";
import type { PluginSessionSummary } from "./PluginSessions.ts";

/** A trusted plugin service that declared `tools` (PluginManager.agentToolProviders). */
export interface AgentToolProvider {
  pluginId: string;
  pluginName: string;
  serviceId: string;
  tools: PluginAgentTool[];
}

/** How an agent sees one plugin tool in the canvastty_agents MCP list. */
export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface PluginAgentToolsDependencies {
  providers(): AgentToolProvider[];
  call(pluginId: string, serviceId: string, method: "canvastty.tools.call", params: unknown, timeoutMs: number): Promise<unknown>;
  /** The calling session as plugins see it (EP-4 summary); null when it is gone. */
  caller(sessionId: string): PluginSessionSummary | null;
  /** EP-8: every text an agent reads back passes through it. */
  redact(text: string): string;
  timeoutMs?: number;
}

/** What a tool service receives (`canvastty.tools.call`). */
export interface AgentToolCall {
  tool: string;
  callerSessionId: string;
  caller: PluginSessionSummary;
  input: Record<string, unknown>;
}

export const AGENT_TOOL_TIMEOUT_MS = 15_000;
/** The answer an agent gets back, after redaction; the bridge caps a whole response at 128 KB. */
export const MAX_AGENT_TOOL_RESULT_CHARS = 32 * 1024;
const MAX_AGENT_TOOL_RESULT_JSON_BYTES = 96 * 1024;
/**
 * Agents whose launch lists canvastty_agents tools per session. Kimi and Hermes share one configuration file
 * between cards, so they keep the core tools only.
 */
export const PLUGIN_TOOL_PROVIDERS: ReadonlySet<ProviderId> = new Set<AgentProviderId>(["claude", "codex", "qwen", "opencode"]);

/** `<pluginId>__<name>` with the id's dots as `_`: the shape Anthropic and OpenAI accept for tool names. */
export const isPluginToolName = isPluginOrchestrationTool;

/**
 * The name agents see for a plugin tool: `<pluginId>__<name>`, dots in the id written as `_` (ids never contain
 * `_`, so the name reads back unambiguously). A name over 64 characters keeps the start of the id plus a short
 * hash of the whole id, so two long ids stay apart.
 */
export function pluginToolName(pluginId: string, tool: string): string {
  const prefix = pluginId.replaceAll(".", "_");
  const full = `${prefix}__${tool}`;
  if (full.length <= MAX_PLUGIN_TOOL_NAME_LENGTH) return full;
  const hash = createHash("sha256").update(pluginId).digest("hex").slice(0, 8);
  const room = MAX_PLUGIN_TOOL_NAME_LENGTH - tool.length - hash.length - 3;
  return `${prefix.slice(0, room).replace(/[_-]+$/u, "")}-${hash}__${tool}`;
}

/**
 * Plugin tools in `canvastty_agents` (EP-6). A session sees a tool only while its service is trusted and
 * running and only when the tool lists the session's role. Calls go to the plugin's service with the caller's
 * session id; the answer is redacted, cut to a fixed size and bounded in time. A timeout or error is an error
 * result for the agent, never anything more.
 */
export class PluginAgentTools {
  private readonly deps: PluginAgentToolsDependencies;

  constructor(deps: PluginAgentToolsDependencies) {
    this.deps = deps;
  }

  /** The tools a session of this role (and agent) sees, in plugin-id order. */
  list(role: SessionRole, provider?: ProviderId): AgentToolDefinition[] {
    if (provider !== undefined && !PLUGIN_TOOL_PROVIDERS.has(provider)) return [];
    return this.entries(role).map(({ name, provider, tool }) => ({
      name,
      description: `${tool.description} (CanvasTTY plugin "${provider.pluginName}")`,
      inputSchema: structuredClone(tool.inputSchema)
    }));
  }

  names(role: SessionRole, provider?: ProviderId): string[] {
    return this.list(role, provider).map((tool) => tool.name);
  }

  async call(callerSessionId: string, role: SessionRole, name: string, input: unknown): Promise<{ content: string; isError: boolean }> {
    const entry = this.entries(role).find((candidate) => candidate.name === name);
    if (!entry) throw new Error("That plugin tool is not available to this session.");
    const caller = this.deps.caller(callerSessionId);
    if (!caller) throw new Error("The calling session no longer exists.");
    const problem = checkArguments(entry.tool.inputSchema, input);
    if (problem) throw new Error(problem);
    const timeoutMs = this.deps.timeoutMs ?? AGENT_TOOL_TIMEOUT_MS;
    const params: AgentToolCall = { tool: entry.tool.name, callerSessionId, caller, input: input as Record<string, unknown> };
    let timer: NodeJS.Timeout | undefined;
    let answer: unknown;
    try {
      answer = await Promise.race([
        this.deps.call(entry.provider.pluginId, entry.provider.serviceId, "canvastty.tools.call", params, timeoutMs),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("The plugin tool did not answer in time.")), timeoutMs);
        })
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The plugin tool failed.";
      return { content: this.bound(`Plugin "${entry.provider.pluginName}": ${message}`), isError: true };
    } finally {
      clearTimeout(timer);
    }
    return this.result(answer);
  }

  private result(answer: unknown): { content: string; isError: boolean } {
    const record = answer && typeof answer === "object" && !Array.isArray(answer) ? answer as Record<string, unknown> : null;
    const isError = record?.isError === true;
    const value = record && "content" in record ? record.content : answer;
    let text: string;
    if (typeof value === "string") text = value;
    else {
      try {
        text = JSON.stringify(value ?? null);
      } catch {
        text = "null";
      }
    }
    return { content: this.bound(text), isError };
  }

  /** Redaction first (it may change lengths), then the size cap, measured as the JSON the bridge sends. */
  private bound(text: string): string {
    let result = this.deps.redact(text);
    let cut = false;
    if (result.length > MAX_AGENT_TOOL_RESULT_CHARS) {
      result = result.slice(0, MAX_AGENT_TOOL_RESULT_CHARS);
      cut = true;
    }
    while (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_AGENT_TOOL_RESULT_JSON_BYTES) {
      result = result.slice(0, Math.floor(result.length / 2));
      cut = true;
    }
    return cut ? `${result}\n[cut: the plugin answer was too long]` : result;
  }

  /** In plugin-id order; a name two tools would share is listed for neither (never a guess which one runs). */
  private entries(role: SessionRole): Array<{ name: string; provider: AgentToolProvider; tool: PluginAgentTool }> {
    let providers: AgentToolProvider[];
    try {
      providers = this.deps.providers();
    } catch {
      return [];
    }
    const entries = [...providers]
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId))
      .flatMap((provider) => provider.tools
        .filter((tool) => tool.roles.includes(role))
        .map((tool) => ({ name: pluginToolName(provider.pluginId, tool.name), provider, tool })));
    const counts = new Map<string, number>();
    for (const { name } of entries) counts.set(name, (counts.get(name) ?? 0) + 1);
    return entries.filter(({ name }) => counts.get(name) === 1 && isPluginToolName(name));
  }
}

/**
 * The host checks the shape agents most often get wrong (an object, required keys, top-level types, no extra
 * keys when the schema says so); everything deeper is the plugin's to validate.
 */
export function checkArguments(schema: Record<string, unknown>, input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "Tool arguments must be an object.";
  const values = input as Record<string, unknown>;
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, unknown> : {};
  const required = Array.isArray(schema.required) ? schema.required as string[] : [];
  const errors: string[] = [];
  for (const key of required) if (!Object.hasOwn(values, key)) errors.push(`Missing required argument: ${key}.`);
  for (const [key, value] of Object.entries(values)) {
    const property = properties[key];
    if (property === undefined) {
      if (schema.additionalProperties === false) errors.push(`Unexpected argument: ${key}.`);
      continue;
    }
    const type = property && typeof property === "object" ? (property as Record<string, unknown>).type : undefined;
    if (typeof type === "string" && !matchesType(type, value)) errors.push(`${key} must be ${type === "integer" ? "an" : "a"} ${type}.`);
  }
  return errors.length ? errors.join(" ") : null;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    case "null": return value === null;
    default: return true;
  }
}
