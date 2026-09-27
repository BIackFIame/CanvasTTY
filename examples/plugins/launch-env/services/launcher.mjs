// A CanvasTTY launch contributor: newline-delimited JSON-RPC 2.0 over stdin/stdout.
// CanvasTTY calls canvastty.launch.prepare only for launches where the person chose this
// plugin in the launcher's Advanced section, and waits at most 5 s for the answer. The launcher
// asks canvastty.launch.options for the choices of "optionsFrom": "service" selects (3 s).
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

// Choices a real plugin would read from its own storage (its accounts, say).
// "local" stands for an account that runs the agent on another model (an API or a local one).
const PROFILES = [{ value: "work", label: "Work" }, { value: "home", label: "Home" }, { value: "local", label: "Local model" }];

function prepare({ provider, restoring, options }) {
  if (!options.enabled) return {};
  // A service-provided value may be stale by the time the card starts or is restored: check it here.
  const profile = options.profile ?? "none";
  if (profile !== "none" && !PROFILES.some((entry) => entry.value === profile)) {
    return { refuse: { reason: `Profile ${profile} no longer exists; choose another one.` } };
  }
  const value = options.mode === "loud" ? options.greeting.toUpperCase() : options.greeting;
  if (!value) return { refuse: { reason: "Value is empty; type one in the launcher or turn the option off." } };
  return {
    env: {
      CTTY_LAUNCH_EXAMPLE: value,
      ...(profile !== "none" ? { CTTY_LAUNCH_PROFILE: profile } : {}),
      // {launchFiles} becomes this plugin's folder of files for this run.
      CTTY_LAUNCH_EXAMPLE_FILE: "{launchFiles}/note.txt"
    },
    files: [{ relPath: "note.txt", content: `${provider} ${restoring ? "restored" : "started"}\n` }],
    args: ["--verbose"],
    // Another model than the agent's vendor's: its own auto reviewer is that model, so CanvasTTY runs "auto" as
    // accept-edits for this launch. The mark can only make a launch stricter.
    ...(profile === "local" ? { thirdPartyModel: true } : {})
  };
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "canvastty.shutdown") process.exit(0);
  if (message.method === "canvastty.launch.options" && message.id !== undefined) {
    send({ id: message.id, result: { profile: PROFILES } });
  } else if (message.method === "canvastty.launch.prepare" && message.id !== undefined) {
    try {
      send({ id: message.id, result: prepare(message.params) });
    } catch (error) {
      send({ id: message.id, error: { code: -32000, message: error.message } });
    }
  } else if (typeof message.method === "string" && message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: `Unknown method: ${message.method}` } });
  }
}).on("close", () => process.exit(0));
