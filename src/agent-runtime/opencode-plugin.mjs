import { reportLifecycle } from "./runtime-client.mjs";
import { createOpenCodeDecisions } from "./opencode-decisions.mjs";
import { spawn } from "node:child_process";

let rootSessionId = null;
let rootWorking = false;
const lifecycleEnabled = process.env.CANVASTTY_LIFECYCLE_HOOKS_ENABLED !== "0";
const pluginHookRegistry = process.env.CANVASTTY_PLUGIN_HOOK_REGISTRY ?? "";
const pluginHookRunnerCommand = process.env.CANVASTTY_PLUGIN_HOOK_RUNNER_COMMAND ?? "";
const pluginHookRunner = process.env.CANVASTTY_PLUGIN_HOOK_RUNNER ?? "";
const pluginHookTerminalSessionId = process.env.CANVASTTY_PLUGIN_HOOK_TERMINAL_SESSION_ID ?? "";
const pluginHooks = parsePluginHooks(process.env.CANVASTTY_PLUGIN_HOOK_SESSION);

export const CanvasTTYLifecycle = async (input) => {
  // Decision hooks: only for a session launched with them; otherwise nothing below changes. A deny throws, which
  // fails the tool call before OpenCode asks anyone.
  const decisions = createOpenCodeDecisions({ client: input && typeof input === "object" ? input.client : undefined });
  return {
    ...(decisions.enabled ? { "tool.execute.before": (hookInput, output) => decisions.guard(hookInput, output) } : {}),
    event: async ({ event }) => lifecycleEvent(event, decisions)
  };
};

async function lifecycleEvent(event, decisions) {
  if (!event || typeof event !== "object") return;
  const properties = event.properties && typeof event.properties === "object"
    ? event.properties
    : {};
  const info = properties.info && typeof properties.info === "object" ? properties.info : null;
  const sessionId = stringField(properties.sessionID, properties.sessionId, properties.id, info?.id);
  // A call a plugin allowed is answered for every session of this OpenCode (subagents included).
  if (event.type === "permission.asked" && await decisions.permissionAsked(properties)) return;

  // A resumed root session emits updates, not a second creation event.
  if (event.type === "session.created" || (!rootSessionId && event.type === "session.updated")) {
    const session = info ?? properties;
    if (session.parentID || session.parentId) return;
    rootSessionId = stringField(session.id, sessionId);
    rootWorking = false;
    if (!rootSessionId) return;
    if (lifecycleEnabled) {
      await reportLifecycle({ state: "idle", event: event.type, turnId: rootSessionId, threadId: rootSessionId });
    }
    runPluginHooks("session-start", event.type, event);
    return;
  }
  if (rootSessionId && sessionId && sessionId !== rootSessionId) return;
  if (!rootSessionId) return;

  if (event.type === "session.status") {
    const statusValue = properties.status;
    const status = typeof statusValue === "string"
      ? statusValue
      : statusValue && typeof statusValue === "object"
        ? statusValue.type
        : null;
    if (status === "busy" || status === "retry") {
      if (lifecycleEnabled) {
        await reportLifecycle({ state: "working", event: `session.status:${status}`, turnId: rootSessionId });
      }
      if (status === "busy" && !rootWorking) {
        runPluginHooks("prompt-submit", `session.status:${status}`, event);
      }
      rootWorking = true;
    } else if (status === "idle") {
      rootWorking = false;
      if (lifecycleEnabled) await reportLifecycle({ state: "idle", event: "session.status:idle", turnId: rootSessionId });
    }
    return;
  }
  if (event.type === "session.idle") {
    rootWorking = false;
    if (lifecycleEnabled) await reportLifecycle({ state: "idle", event: event.type, turnId: rootSessionId });
    runPluginHooks("stop", event.type, event);
  } else if (event.type === "permission.asked") {
    if (lifecycleEnabled) await reportLifecycle({ state: "needs_approval", event: event.type, turnId: rootSessionId });
    runPluginHooks("permission-request", event.type, event);
  } else if (event.type === "permission.replied") {
    if (lifecycleEnabled) await reportLifecycle({ state: "working", event: event.type, turnId: rootSessionId });
    runPluginHooks("permission-result", event.type, event);
  } else if (event.type === "question.asked") {
    if (lifecycleEnabled) await reportLifecycle({ state: "needs_approval", event: event.type, turnId: rootSessionId });
  } else if (event.type === "question.replied" || event.type === "question.rejected") {
    if (lifecycleEnabled) await reportLifecycle({ state: "working", event: event.type, turnId: rootSessionId });
  } else if (event.type === "session.error") {
    rootWorking = false;
    if (lifecycleEnabled) await reportLifecycle({ state: "idle", event: event.type, turnId: rootSessionId });
    runPluginHooks("stop", event.type, event);
  } else if (event.type === "session.deleted") {
    runPluginHooks("session-end", event.type, event);
    rootWorking = false;
    rootSessionId = null;
  } else if (event.type === "tool.execute.after") {
    runPluginHooks("after-tool", event.type, event);
  }
}

function stringField(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}

function parsePluginHooks(raw) {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((hook) => (
      hook
      && typeof hook === "object"
      && typeof hook.key === "string"
      && Array.isArray(hook.events)
      && hook.events.every((event) => typeof event === "string")
    ));
  } catch {
    return [];
  }
}

function runPluginHooks(event, providerEvent, payload) {
  if (!pluginHookRegistry || !pluginHookRunnerCommand || !pluginHookRunner || !pluginHookTerminalSessionId) return;
  let input = "{}";
  try {
    input = JSON.stringify(payload);
  } catch {
    // The runner accepts an empty event when an OpenCode payload is not serializable.
  }
  if (Buffer.byteLength(input, "utf8") > 1024 * 1024) return;
  for (const hook of pluginHooks) {
    if (!hook.events.includes(event)) continue;
    launchPluginHook(hook.key, event, providerEvent, input);
  }
}

function launchPluginHook(key, event, providerEvent, input) {
  try {
    const child = spawn(pluginHookRunnerCommand, [
      pluginHookRunner,
      pluginHookRegistry,
      key,
      "opencode",
      event,
      providerEvent
    ], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true
    });
    const timeout = setTimeout(() => child.kill(), 3_000);
    timeout.unref();
    const clear = () => clearTimeout(timeout);
    child.once("exit", clear);
    child.once("error", clear);
    child.stdin?.once("error", () => undefined);
    child.stdin?.end(input);
  } catch {
    // Optional plugin hooks never interrupt OpenCode's own event handling.
  }
}
