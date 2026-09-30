// What plugin-hook-runner.mjs does for one plugin hook, shared with the OpenCode plugin (which runs inside OpenCode
// and starts each hook's process itself instead of a runner process that starts another).
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { isPathInside } from "./path-inside.mjs";

export const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
const MAX_REGISTRY_BYTES = 1024 * 1024;
export const HOOK_TIMEOUT_MS = 2_500;

/**
 * The hook `key` of the registry at `registryPath` for this provider and event, ready to run: its folder, its entry
 * (inside that folder), the JSON its stdin receives and its environment (host capabilities removed). Null when the
 * arguments are malformed or the hook is not (or no longer) registered for them.
 */
export async function preparePluginHook({ registryPath, key, provider, event, providerEvent, terminalSessionId, raw, environment }) {
  if (
    !isAbsolute(registryPath ?? "")
    || typeof key !== "string"
    || key.length === 0
    || key.length > 160
    || typeof terminalSessionId !== "string"
    || terminalSessionId.length === 0
    || terminalSessionId.length > 160
    || typeof provider !== "string"
    || provider.length > 32
    || typeof event !== "string"
    || event.length > 40
    || typeof providerEvent !== "string"
    || providerEvent.length > 80
    || Buffer.byteLength(raw, "utf8") > MAX_HOOK_INPUT_BYTES
  ) return null;
  const registryRaw = await readFile(registryPath, "utf8");
  if (Buffer.byteLength(registryRaw, "utf8") > MAX_REGISTRY_BYTES) return null;
  const registry = JSON.parse(registryRaw);
  const hook = registry?.version === 1 && registry.hooks && typeof registry.hooks === "object"
    ? registry.hooks[key]
    : null;
  if (!validHook(hook, key, provider, event)) return null;

  const root = await realpath(hook.root);
  const entry = await realpath(resolve(root, hook.entry));
  if (!isPathInside(root, entry)) return null;

  let payload = raw;
  try {
    payload = raw.trim().length > 0 ? JSON.parse(raw) : null;
  } catch {
    // Hooks receive non-JSON provider input as an opaque string.
  }
  const input = JSON.stringify({
    apiVersion: 1,
    pluginId: hook.pluginId,
    hookId: hook.hookId,
    terminalSessionId,
    provider,
    event,
    providerEvent,
    payload
  });
  return {
    root,
    entry,
    input,
    env: childEnvironment(environment, hook.pluginId, hook.hookId, terminalSessionId, provider, event, providerEvent)
  };
}

function validHook(hook, expectedKey, expectedProvider, expectedEvent) {
  return Boolean(
    hook
    && typeof hook === "object"
    && typeof hook.pluginId === "string"
    && typeof hook.hookId === "string"
    && expectedKey === `${hook.pluginId}:${hook.hookId}`
    && typeof hook.root === "string"
    && isAbsolute(hook.root)
    && typeof hook.entry === "string"
    && !isAbsolute(hook.entry)
    && Array.isArray(hook.providers)
    && hook.providers.includes(expectedProvider)
    && Array.isArray(hook.events)
    && hook.events.includes(expectedEvent)
  );
}

function childEnvironment(source, pluginId, hookId, terminalSessionId, hookProvider, hookEvent, hookProviderEvent) {
  const environment = Object.fromEntries(Object.entries(source).filter(([name, value]) => (
    typeof value === "string"
    && !name.startsWith("CANVASTTY_RUNTIME_")
    && !name.startsWith("CANVASTTY_AGENT_")
    && name !== "CANVASTTY_TERMINAL_SESSION_ID"
    && name !== "OPENCODE_CONFIG_CONTENT"
    && name !== "QWEN_CODE_SYSTEM_SETTINGS_PATH"
    && !name.startsWith("CANVASTTY_PLUGIN_HOOK_")
  )));
  return {
    ...environment,
    ELECTRON_RUN_AS_NODE: "1",
    CANVASTTY_PLUGIN_HOOK_PLUGIN_ID: pluginId,
    CANVASTTY_PLUGIN_HOOK_ID: hookId,
    CANVASTTY_PLUGIN_HOOK_TERMINAL_SESSION_ID: terminalSessionId,
    CANVASTTY_PLUGIN_HOOK_PROVIDER: hookProvider,
    CANVASTTY_PLUGIN_HOOK_EVENT: hookEvent,
    CANVASTTY_PLUGIN_HOOK_PROVIDER_EVENT: hookProviderEvent
  };
}
