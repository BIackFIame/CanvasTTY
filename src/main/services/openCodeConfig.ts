import { ORCHESTRATION_MCP_SERVER_NAME } from "../../agent-browser/orchestration-catalog.mjs";
import { MCP_SERVER_NAME } from "../../agent-browser/tool-catalog.mjs";
import { ORCHESTRATION_ENV } from "./agent-browser/orchestration-protocol.ts";
import { otherSpellings } from "./onDiskPath.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const OPENCODE_CONFIG_CONTENT = "OPENCODE_CONFIG_CONTENT";

interface OpenCodeStdioHelper {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

type OpenCodeConfig = Record<string, unknown>;

export function openCodeBrowserEnvironment(
  helper: OpenCodeStdioHelper,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  orchestrationHelper?: OpenCodeStdioHelper
): Record<string, string> {
  const config = parseInlineConfig(environment[OPENCODE_CONFIG_CONTENT]);
  const mcp = objectField(config.mcp, "mcp");
  return {
    [OPENCODE_CONFIG_CONTENT]: JSON.stringify({
      ...config,
      mcp: {
        ...mcp,
        [MCP_SERVER_NAME]: {
          type: "local",
          command: [helper.command, ...helper.args],
          enabled: true,
          ...(helper.env && Object.keys(helper.env).length > 0
            ? { environment: helper.env }
            : {})
        },
        ...(orchestrationHelper
          ? { [ORCHESTRATION_MCP_SERVER_NAME]: openCodeOrchestrationEntry(orchestrationHelper) }
          : {})
      },
      permission: allowBrowserTools(config.permission)
    })
  };
}

// OpenCode merges the parent environment into local MCP servers, so the
// orchestration variables reach the helper through inheritance exactly like
// the browser variables do. The {env:NAME} references pin them explicitly:
// OpenCode substitutes those tokens from its own environment while loading the
// inline config, which resolves to the inherited value when the variables are
// present and keeps the helper reachable even if a future version stopped
// passing the full parent environment.
function openCodeOrchestrationEntry(helper: OpenCodeStdioHelper): Record<string, unknown> {
  return {
    type: "local",
    command: [helper.command, ...helper.args],
    enabled: true,
    environment: {
      ...helper.env,
      ...Object.fromEntries(Object.values(ORCHESTRATION_ENV).map((key) => [key, `{env:${key}}`]))
    }
  };
}

export function openCodeYoloEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const config = parseInlineConfig(environment[OPENCODE_CONFIG_CONTENT]);
  return {
    [OPENCODE_CONFIG_CONTENT]: JSON.stringify({ ...config, permission: "allow" })
  };
}

/**
 * OpenCode's "auto" profile for this run (OpenCode 1.18 has no auto flag). Its permission rules are a list where the
 * last matching rule wins (Permission.evaluate: findLast), and an agent's own `permission` is appended after the
 * top-level one (agent config: merge(agent, fromConfig(agent.permission))). So the rules go under `agent.build`,
 * OpenCode's default agent: they come after the person's own top-level rules without replacing them, and every tool
 * not named here keeps whatever the person's configuration says.
 *
 * - read, glob, grep, list: allowed, except `.env` files (OpenCode's own default asks for those).
 * - edit (OpenCode's edit, write and apply_patch): allowed.
 * - bash: allowed only when `shellGuarded` (CanvasTTY's base protection is on and its guard runs in this OpenCode:
 *   hard denies still deny before OpenCode's own check); otherwise it asks, as without auto.
 * - external_directory is not touched: a path outside the project still asks (each tool checks it first).
 * `thirdPartyModel` (a launch contributor put OpenCode on another model) keeps bash asking, like accept-edits.
 */
export function openCodeAutoEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  options: { shellGuarded: boolean; thirdPartyModel?: boolean; cwd?: string; readFile?: (path: string) => string | null }
): Record<string, string> {
  const config = parseInlineConfig(environment[OPENCODE_CONFIG_CONTENT]);
  const agents = objectField(config.agent, "agent");
  const build = objectField(agents.build, "agent.build");
  const permission = build.permission === undefined ? {} : objectField(build.permission, "agent.build.permission");
  // The person's own deny and ask rules (their config files and this run's inline config) come after the auto rules,
  // so they still win: auto never allows what the person denied or wanted to be asked about.
  const person = openCodePersonRules(environment, options.cwd, options.readFile);
  return {
    [OPENCODE_CONFIG_CONTENT]: JSON.stringify({
      ...config,
      agent: {
        ...agents,
        build: {
          ...build,
          permission: withPersonRules({
            ...permission,
            ...openCodeAutoPermission(options.shellGuarded && options.thirdPartyModel !== true)
          }, person)
        }
      }
    })
  };
}

type Rule = string | Record<string, string>;

/**
 * The deny and ask rules the person's OpenCode configuration sets for the tools auto allows (read, glob, grep, list,
 * edit, bash): the global and project config files, OPENCODE_CONFIG, and the inline config this run started with,
 * top-level `permission` and `agent.build.permission` alike. Allow rules are left out (auto allows those already).
 */
export function openCodePersonRules(
  environment: Readonly<Record<string, string | undefined>>,
  cwd?: string,
  readFile: (path: string) => string | null = readTextFile
): Record<string, Rule> {
  const home = environment.HOME ?? "";
  const configHome = environment.XDG_CONFIG_HOME || (home ? join(home, ".config") : "");
  const files = [
    ...(configHome ? ["opencode.json", "opencode.jsonc", "config.json"].map((name) => join(configHome, "opencode", name)) : []),
    ...(environment.OPENCODE_CONFIG ? [environment.OPENCODE_CONFIG] : []),
    ...(cwd ? ["opencode.json", "opencode.jsonc", join(".opencode", "opencode.json"), join(".opencode", "opencode.jsonc")].map((name) => join(cwd, name)) : [])
  ];
  const configs: unknown[] = [];
  for (const file of files) {
    const text = readFile(file);
    if (text !== null) configs.push(parseLoose(text));
  }
  configs.push(parseLoose(environment[OPENCODE_CONFIG_CONTENT] ?? ""));
  const rules: Record<string, Rule> = {};
  for (const config of configs) {
    if (!isObject(config)) continue;
    const agent = isObject(config.agent) && isObject(config.agent.build) ? config.agent.build.permission : undefined;
    for (const permission of [config.permission, agent]) {
      if (permission === "deny" || permission === "ask") {
        for (const tool of AUTO_TOOLS) rules[tool] = permission;
        continue;
      }
      if (!isObject(permission)) continue;
      for (const tool of AUTO_TOOLS) {
        const value = permission[tool];
        if (value === "deny" || value === "ask") { rules[tool] = value; continue; }
        if (!isObject(value)) continue;
        const current = rules[tool];
        if (typeof current === "string") continue;
        const kept: Record<string, string> = { ...(current ?? {}) };
        for (const [pattern, action] of Object.entries(value)) {
          if (action === "deny" || action === "ask") { delete kept[pattern]; kept[pattern] = action; }
        }
        if (Object.keys(kept).length > 0) rules[tool] = kept;
      }
    }
  }
  return rules;
}

const AUTO_TOOLS = ["read", "glob", "grep", "list", "edit", "bash"] as const;

/** Appends the person's rules after the auto rules: a whole-tool deny/ask replaces the tool, patterns go last. */
function withPersonRules(permission: OpenCodeConfig, person: Record<string, Rule>): OpenCodeConfig {
  const result: OpenCodeConfig = { ...permission };
  for (const [tool, rule] of Object.entries(person)) {
    if (typeof rule === "string") { result[tool] = rule; continue; }
    const current = result[tool];
    const merged: Record<string, string> = typeof current === "string" ? { "*": current } : isObject(current) ? { ...(current as Record<string, string>) } : {};
    for (const [pattern, action] of Object.entries(rule)) {
      delete merged[pattern];
      merged[pattern] = action;
    }
    result[tool] = merged;
  }
  return result;
}

function parseLoose(text: string): unknown {
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch { /* JSONC */ }
  try { return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:"\\])\/\/.*$/gmu, "$1").replace(/,\s*([}\]])/gu, "$1")); } catch { return null; }
}

function readTextFile(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/** The auto rules (see openCodeAutoEnvironment); insertion order matters, the last matching rule wins. */
export function openCodeAutoPermission(allowShell: boolean): OpenCodeConfig {
  return {
    read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
    glob: "allow",
    grep: "allow",
    list: "allow",
    edit: "allow",
    bash: allowShell ? "allow" : "ask"
  };
}

/**
 * OpenCode asks before a tool touches a path outside its project folder (external_directory), comparing strings.
 * Its project folder is the one it reads back from the system, spelled as on disk (NFD for Finder-made names on
 * macOS), while the prompt it got usually spells the same folder in NFC. This run allows exactly that folder in its
 * other spellings; nothing else is widened, and a folder whose name has one spelling (ASCII) changes nothing.
 */
export function openCodeProjectFolderEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  folder: string
): Record<string, string> {
  const spellings = otherSpellings(folder);
  if (spellings.length === 0) return {};
  const config = parseInlineConfig(environment[OPENCODE_CONFIG_CONTENT]);
  const permission = config.permission;
  // Everything is allowed already (YOLO), or the person's own inline config decides with a single word.
  if (permission === "allow" || typeof permission === "string") return {};
  const current = objectField(permission, "permission");
  const external = current.external_directory;
  if (external === "allow") return {};
  const patterns = typeof external === "string" ? { "*": external } : objectField(external, "permission.external_directory");
  const allowed = Object.fromEntries(spellings.flatMap((spelling) => [[spelling, "allow"], [`${spelling}/**`, "allow"]]));
  return {
    [OPENCODE_CONFIG_CONTENT]: JSON.stringify({
      ...config,
      permission: { ...current, external_directory: { ...patterns, ...allowed } }
    })
  };
}

function parseInlineConfig(raw: string | undefined): OpenCodeConfig {
  if (!raw || raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OPENCODE_CONFIG_CONTENT must contain valid JSON before CanvasTTY can extend it.");
  }
  if (!isObject(parsed)) {
    throw new Error("OPENCODE_CONFIG_CONTENT must contain a JSON object before CanvasTTY can extend it.");
  }
  return parsed;
}

function objectField(value: unknown, name: string): OpenCodeConfig {
  if (value === undefined) return {};
  if (!isObject(value)) {
    throw new Error(`OpenCode inline config field ${name} must be an object.`);
  }
  return value;
}

function allowBrowserTools(permission: unknown): OpenCodeConfig {
  if (permission === undefined) return { [`${MCP_SERVER_NAME}_*`]: "allow" };
  if (permission === "allow") return { "*": "allow", [`${MCP_SERVER_NAME}_*`]: "allow" };
  if (permission === "ask" || permission === "deny") {
    return { "*": permission, [`${MCP_SERVER_NAME}_*`]: "allow" };
  }
  return {
    ...objectField(permission, "permission"),
    [`${MCP_SERVER_NAME}_*`]: "allow"
  };
}

function isObject(value: unknown): value is OpenCodeConfig {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
