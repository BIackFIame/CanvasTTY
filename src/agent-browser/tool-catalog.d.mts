export const MAX_BRIDGE_PAYLOAD_BYTES: number;
export const MCP_SERVER_NAME: string;

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_DEFINITIONS: readonly McpToolDefinition[];
export const APPROVED_BROWSER_TOOL_NAMES: readonly string[];
export function isApprovedBrowserTool(value: unknown): value is string;
export function validateToolArguments(toolName: unknown, value: unknown):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };
export function canonicalStringify(
  value: unknown,
  options?: { lenient?: boolean; compareKeys?: (left: string, right: string) => number }
): string;
