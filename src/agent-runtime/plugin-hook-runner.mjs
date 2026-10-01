#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { HOOK_TIMEOUT_MS, MAX_HOOK_INPUT_BYTES, preparePluginHook } from "./plugin-hook-dispatch.mjs";

const [registryPath, key, provider, event, providerEvent] = process.argv.slice(2);

let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk.toString("utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_HOOK_INPUT_BYTES) process.exit(0);
}

try {
  const hook = await preparePluginHook({
    registryPath, key, provider, event, providerEvent,
    terminalSessionId: process.env.CANVASTTY_PLUGIN_HOOK_TERMINAL_SESSION_ID,
    raw,
    environment: process.env
  });
  if (!hook) process.exit(0);
  spawnSync(process.execPath, [hook.entry], {
    cwd: hook.root,
    env: hook.env,
    input: hook.input,
    stdio: ["pipe", "ignore", "ignore"],
    timeout: HOOK_TIMEOUT_MS,
    windowsHide: true
  });
} catch {
  // Provider hooks are best-effort. Revocation, uninstall, malformed state, and
  // hook failures must not interrupt the agent process.
}
