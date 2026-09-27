export const RUNTIME_PROTOCOL_VERSION = 1;
export const MAX_RUNTIME_MESSAGE_BYTES = 64 * 1024;
export const CAPTURE_RESULT_ENV = "CANVASTTY_RUNTIME_CAPTURE_RESULT";
export const MAX_RESULT_CHARS = 4096;
// Final-answer capture requires an explicit, expiring grant for one Codex session.
export const CAPTURE_ANSWER_ENV = "CANVASTTY_RUNTIME_CAPTURE_ANSWER";
export const CAPTURE_ANSWER_EXPIRES_AT_ENV = "CANVASTTY_RUNTIME_CAPTURE_ANSWER_EXPIRES_AT";
export const MAX_ANSWER_CHARS = 4000;
// Hook stdin is read whole before the message is built, so its cap is independent
// of the wire cap: a large Stop payload must still yield its turn id and the
// truncated answer instead of being dropped.
export const MAX_HOOK_INPUT_BYTES = 512 * 1024;

export const AGENT_RUNTIME_ENV = Object.freeze({
  address: "CANVASTTY_RUNTIME_ADDRESS",
  terminalSessionId: "CANVASTTY_RUNTIME_TERMINAL_SESSION_ID",
  provider: "CANVASTTY_RUNTIME_PROVIDER",
  capabilityToken: "CANVASTTY_RUNTIME_CAPABILITY"
});

export const RUNTIME_STATES = Object.freeze(["idle", "working", "needs_approval"]);

// A provider's own conversation id, as its lifecycle hook reports it, lets a restored
// card resume exactly that conversation. It ends up in the provider's argv, so only
// the shapes those CLIs issue are accepted: canonical UUIDs for Codex threads and
// Claude sessions (lower-cased), `ses_` tokens for OpenCode sessions.
const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPENCODE_SESSION_RE = /^ses_[A-Za-z0-9]{1,120}$/;

export function normalizeThreadId(provider, value) {
  if (typeof value !== "string") return undefined;
  if (provider === "codex" || provider === "claude") {
    return CANONICAL_UUID_RE.test(value) ? value.toLowerCase() : undefined;
  }
  if (provider === "opencode") return OPENCODE_SESSION_RE.test(value) ? value : undefined;
  return undefined;
}
