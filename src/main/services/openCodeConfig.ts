import { ORCHESTRATION_MCP_SERVER_NAME } from "../../agent-browser/orchestration-catalog.mjs";
import { MCP_SERVER_NAME } from "../../agent-browser/tool-catalog.mjs";
import { ORCHESTRATION_ENV } from "./agent-browser/orchestration-protocol.ts";
import { otherSpellings } from "./onDiskPath.ts";

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
