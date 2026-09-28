#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { isPathInside } from "./path-inside.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const HOOK_TIMEOUT_MS = 2_500;
const [registryPath, key, provider, event, providerEvent] = process.argv.slice(2);
const terminalSessionId = process.env.CANVASTTY_PLUGIN_HOOK_TERMINAL_SESSION_ID;

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
) process.exit(0);

let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk.toString("utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) process.exit(0);
}

try {
  const registryRaw = await readFile(registryPath, "utf8");
  if (Buffer.byteLength(registryRaw, "utf8") > MAX_REGISTRY_BYTES) process.exit(0);
  const registry = JSON.parse(registryRaw);
  const hook = registry?.version === 1 && registry.hooks && typeof registry.hooks === "object"
    ? registry.hooks[key]
    : null;
  if (!validHook(hook, key, provider, event)) process.exit(0);

  const root = await realpath(hook.root);
  const entry = await realpath(resolve(root, hook.entry));
  if (!isPathInside(root, entry)) process.exit(0);

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
  spawnSync(process.execPath, [entry], {
    cwd: root,
    env: childEnvironment(hook.pluginId, hook.hookId, terminalSessionId, provider, event, providerEvent),
    input,
    stdio: ["pipe", "ignore", "ignore"],
    timeout: HOOK_TIMEOUT_MS,
    windowsHide: true
  });
} catch {
  // Provider hooks are best-effort. Revocation, uninstall, malformed state, and
  // hook failures must not interrupt the agent process.
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

function childEnvironment(pluginId, hookId, terminalSessionId, hookProvider, hookEvent, hookProviderEvent) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => (
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
