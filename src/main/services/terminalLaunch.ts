import { existsSync } from "node:fs";
import { win32 } from "node:path";
import type { ProviderId } from "../../shared/contracts.ts";
import { normalizeThreadId } from "../../agent-runtime/runtime-protocol.mjs";
import { openCodeYoloEnvironment } from "./openCodeConfig.ts";
import { autoModeArguments, CLAUDE_SANDBOX_SETTINGS, type LaunchProfile } from "../../shared/autoMode.ts";
import {
  providerTerminalBatchCommandLine,
  type ProviderCliResolution
} from "./providerCliRegistry.ts";

export interface TerminalLaunch {
  command: string;
  args: string[] | string;
  environment?: Record<string, string>;
}

interface LaunchResolutionOptions {
  platform?: NodeJS.Platform;
  environment?: Readonly<NodeJS.ProcessEnv>;
  fileExists?: (path: string) => boolean;
  providerCli?: ProviderCliResolution;
  resumePrevious?: boolean;
  resumeThreadId?: string;
  /** A launch contributor runs the CLI on another model: "auto" becomes accept-edits (autoModeArguments). */
  thirdPartyModel?: boolean;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WINDOWS_NATIVE_EXTENSIONS = [".exe", ".com"];

export function resolveTerminalLaunch(
  provider: ProviderId,
  profile: LaunchProfile,
  agentBrowserArgs: string[] = [],
  options: LaunchResolutionOptions = {}
): TerminalLaunch {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const fileExists = options.fileExists ?? existsSync;

  if (provider === "terminal") {
    return platform === "win32"
      ? resolveWindowsShell(environment, fileExists)
      : { command: environment.SHELL || "/bin/bash", args: ["-l"] };
  }

  const providerCli = options.providerCli;
  if (!providerCli || providerCli.provider !== provider) {
    throw new Error(`${provider} CLI resolution was not provided.`);
  }
  if (providerCli.state === "unavailable") throw new Error(providerCli.diagnostic);

  const launchEnvironment = profile === "yolo" && provider === "opencode"
    ? openCodeYoloEnvironment({ ...environment, ...providerCli.environment })
    : undefined;
  const auto = profile === "auto";
  const providerArgs = [
    ...(profile === "yolo" && provider !== "opencode" ? DANGEROUS_ARGUMENTS[provider] : []),
    ...(auto ? autoModeArguments(provider, options.thirdPartyModel === true) : []),
    // Claude Code keeps only the last inline --settings: a plugin's (after the hooks') would silently drop the hooks.
    // Its sandbox for "auto" joins the same one.
    ...(provider === "claude"
      ? mergeClaudeInlineSettings(auto ? [...agentBrowserArgs, "--settings", JSON.stringify({ sandbox: CLAUDE_SANDBOX_SETTINGS })] : agentBrowserArgs)
      : agentBrowserArgs),
    ...(options.resumePrevious ? resolveResumeArguments(provider, options.resumeThreadId) : [])
  ];
  const combinedEnvironment = {
    ...providerCli.environment,
    ...launchEnvironment
  };
  if (providerCli.launcher === "native") {
    return {
      command: providerCli.executable,
      args: providerArgs,
      environment: combinedEnvironment
    };
  }
  if (!providerCli.commandPrompt) throw new Error("A Windows batch provider requires cmd.exe.");
  return {
    command: providerCli.commandPrompt,
    args: providerTerminalBatchCommandLine(providerCli.executable, providerArgs),
    environment: combinedEnvironment
  };
}

function resolveResumeArguments(
  provider: Exclude<ProviderId, "terminal">,
  resumeThreadId?: string
): string[] {
  if (provider === "codex") {
    if (resumeThreadId) {
      if (!UUID_REGEX.test(resumeThreadId)) {
        throw new Error(`Invalid Codex thread ID format: "${resumeThreadId}". Expected a canonical UUID.`);
      }
      return ["resume", resumeThreadId.toLowerCase()];
    }
    return ["resume"];
  }
  const byId = RESUME_BY_ID_ARGUMENTS[provider];
  if (byId && resumeThreadId) {
    const threadId = normalizeThreadId(provider, resumeThreadId);
    if (!threadId) throw new Error(`Invalid ${provider} session ID format: "${resumeThreadId}".`);
    return byId(threadId);
  }
  return RESUME_ARGUMENTS[provider];
}

// The same exact resume for the other CLIs whose hook reports that CLI's own session
// id, each checked against its --help: `claude -r, --resume [value]`,
// `opencode -s, --session <id>`. Everything else continues with RESUME_ARGUMENTS.
const RESUME_BY_ID_ARGUMENTS: Partial<Record<Exclude<ProviderId, "terminal" | "codex">, (id: string) => string[]>> = {
  claude: (id) => ["--resume", id],
  opencode: (id) => ["--session", id]
};

export function canResumeThreadById(provider: ProviderId): boolean {
  return provider === "codex" || (provider !== "terminal" && RESUME_BY_ID_ARGUMENTS[provider] !== undefined);
}

/** Without an id, Codex opens its own resume picker, so the person chooses; nothing is guessed. */
export function resumeWithoutIdOpensPicker(provider: ProviderId): boolean {
  return provider === "codex";
}

/** The CLI has a "latest conversation in this folder" flag. */
export function canResumeLatestConversation(provider: ProviderId): boolean {
  return provider !== "terminal" && provider !== "codex" && RESUME_ARGUMENTS[provider].length > 0;
}

// Per-provider instead of a fallthrough: the old `return ["--continue"]` default would
// have handed an unverified flag to whatever provider was added next. A missing entry is
// now a compile error.
const RESUME_ARGUMENTS: Record<Exclude<ProviderId, "terminal" | "codex">, string[]> = {
  claude: ["--continue"],
  qwen: ["--continue"],
  kimi: ["--continue"],
  opencode: ["--continue"],
  hermes: ["--continue"],
  grok: ["--continue"],
  omp: ["--continue"],
  pi: ["--continue"],
  cursor: ["--continue"],
  minimax: ["--continue"],
  devin: ["--continue"],
  // Antigravity resumes only via the interactive /resume command or
  // `--conversation <id>`; there is no latest-session launch flag, so
  // restore starts a fresh session.
  antigravity: []
};

const DANGEROUS_ARGUMENTS: Record<Exclude<ProviderId, "terminal" | "opencode">, string[]> = {
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  claude: ["--dangerously-skip-permissions"],
  qwen: ["--yolo"],
  kimi: ["--yolo"],
  hermes: ["--yolo"],
  grok: ["--always-approve"],
  // Measured on omp 18.1.19: `omp --help` documents `--auto-approve` ("Auto-approve all
  // tool calls"); the undocumented `--yolo` also parses but is not relied on here.
  omp: ["--auto-approve"],
  // pi 0.85.1 has no permission system, so it has no auto-approve flag. `-a, --approve`
  // only skips its one prompt (trust project-local settings for this run).
  pi: ["--approve"],
  // The Cursor CLI follows Claude Code conventions; its permission bypass is the
  // same flag Claude Code documents.
  cursor: ["--dangerously-skip-permissions"],
  // Measured on @minimax-ai/code 0.5.1: the CLI has no permission bypass flag.
  // Permission modes (default/auto/bypassPermissions/off) are settings.json and
  // TUI state (/permission, Alt+M) only, so YOLO launches the stock CLI.
  minimax: [],
  // Devin CLI documents --permission-mode; `dangerous` (aliases yolo/bypass)
  // auto-approves every tool call. `smart` (an AI gatekeeper that approves only
  // clearly-safe actions) is a supervised mode, deliberately NOT mapped here.
  devin: ["--permission-mode", "dangerous"],
  // Documented on antigravity.google/docs/cli: --dangerously-skip-permissions
  // and --sandbox exist; no --yolo spelling.
  antigravity: ["--dangerously-skip-permissions"]
};

function resolveWindowsShell(
  environment: Readonly<NodeJS.ProcessEnv>,
  fileExists: (path: string) => boolean
): TerminalLaunch {
  const systemRoot = environment.SystemRoot || environment.WINDIR;
  if (systemRoot) {
    const windowsPowerShell = win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    if (fileExists(windowsPowerShell)) {
      return { command: windowsPowerShell, args: ["-NoLogo", "-NoProfile"] };
    }
  }

  const modernPowerShell = findWindowsNativeCommand("pwsh", environment, fileExists);
  if (modernPowerShell) return { command: modernPowerShell, args: ["-NoLogo", "-NoProfile"] };

  return { command: resolveWindowsCommandPrompt(environment, fileExists), args: ["/d"] };
}

function resolveWindowsCommandPrompt(
  environment: Readonly<NodeJS.ProcessEnv>,
  fileExists: (path: string) => boolean
): string {
  const configured = environment.ComSpec || environment.COMSPEC;
  if (configured && fileExists(configured)) return configured;
  const fromPath = findWindowsNativeCommand("cmd", environment, fileExists);
  if (fromPath) return fromPath;
  const systemRoot = environment.SystemRoot || environment.WINDIR;
  const systemCommandPrompt = systemRoot ? win32.join(systemRoot, "System32", "cmd.exe") : null;
  if (systemCommandPrompt && fileExists(systemCommandPrompt)) return systemCommandPrompt;
  throw new Error("No supported Windows shell was found (PowerShell, pwsh, or cmd.exe).");
}

function findWindowsNativeCommand(
  command: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  fileExists: (path: string) => boolean
): string | null {
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path");
  if (!pathKey) return null;
  const directories = (environment[pathKey] ?? "")
    .split(";")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  for (const directory of directories) {
    for (const extension of WINDOWS_NATIVE_EXTENSIONS) {
      const candidate = win32.join(directory, `${command}${extension}`);
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Claude Code 2.1 applies only the last `--settings` it is given (measured with 2.1.281: a hook in an earlier inline
 * JSON never ran). Every inline JSON value, in either form (`--settings <json>` or `--settings=<json>`), is merged
 * into the first one, in order: hook lists are concatenated per event, objects such as `env` are merged key by key
 * (later wins), other keys are replaced. A settings file path is left alone; plugins cannot pass one (a settings file
 * among their launch files is read and checked by the launch pipeline, then passed inline).
 */
export function mergeClaudeInlineSettings(given: readonly string[]): string[] {
  const args = given.flatMap((argument) => argument.startsWith(SETTINGS_EQUALS) && parseInlineSettings(argument.slice(SETTINGS_EQUALS.length))
    ? ["--settings", argument.slice(SETTINGS_EQUALS.length)]
    : [argument]);
  const positions: number[] = [];
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] === "--settings" && parseInlineSettings(args[index + 1]!)) positions.push(index);
  }
  if (positions.length < 2) return args;
  const merged: Record<string, unknown> = {};
  for (const position of positions) {
    for (const [key, value] of Object.entries(parseInlineSettings(args[position + 1]!)!)) {
      const current = merged[key];
      if (key === "hooks" && plainObject(current) && plainObject(value)) {
        const hooks: Record<string, unknown> = { ...current };
        for (const [event, list] of Object.entries(value)) {
          const earlier = hooks[event];
          hooks[event] = Array.isArray(earlier) && Array.isArray(list) ? [...earlier, ...list] : list;
        }
        merged[key] = hooks;
      } else if (plainObject(current) && plainObject(value)) merged[key] = { ...current, ...value };
      else merged[key] = value;
    }
  }
  const drop = new Set(positions.slice(1).flatMap((position) => [position, position + 1]));
  const next = args.filter((_argument, index) => !drop.has(index));
  next[positions[0]! + 1] = JSON.stringify(merged);
  return next;
}

const SETTINGS_EQUALS = "--settings=";

export function parseInlineSettings(value: string): Record<string, unknown> | null {
  if (!value.trimStart().startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return plainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// What a plugin launch contributor may never append. A trusted plugin already runs as the
// user, so this is not a sandbox: it keeps an ordinary launch from being turned into an
// unattended one behind the profile the person chose, and leaves conversation selection
// to the core's restore rules. Every provider's bypass flag is listed for every provider.
const CORE_OWNED_FLAGS = new Set<string>([
  ...Object.values(DANGEROUS_ARGUMENTS).flat().filter((argument) => argument.startsWith("-")),
  "--full-auto", "--approve-for-me", "--ask-for-approval", "--sandbox", "--permission-mode", "--approval-mode",
  "--continue", "--resume", "--session", "--last", "--conversation", "--fork-session"
]);
const CORE_OWNED_SHORT_FLAGS: Partial<Record<ProviderId, string[]>> = {
  claude: ["-c", "-r"],
  cursor: ["-c", "-r"],
  qwen: ["-c", "-r", "-y"],
  opencode: ["-c", "-s"],
  codex: ["-a", "-s"]
};
// `-c hooks.…` would replace CanvasTTY's own Codex hooks (and their per-run trust); `approvals_reviewer` is auto's.
const CORE_OWNED_WORDS = /dangerously|approval_policy|approvals_reviewer|sandbox_mode|bypass|^hooks[.=]/i;
const CORE_OWNED_SUBCOMMANDS: Partial<Record<ProviderId, string[]>> = {
  codex: ["resume", "fork", "exec"]
};

/** Claude settings keys that decide approvals, the hooks or the sandbox; a plugin's settings may carry e.g. `env` only. */
const CLAUDE_CORE_SETTINGS = ["permissions", "hooks", "disableAllHooks", "sandbox", "defaultMode", "apiKeyHelper"];
// Claude 2.1.281 --help: `--bare` and `--safe-mode` skip hooks; `--allowedTools` approves tools without asking;
// `--permission-prompt-tool` / `--permission-prompts` decide who answers permission prompts.
const CLAUDE_CORE_OWNED_FLAGS = new Set(["--bare", "--safe-mode", "--allowedTools", "--allowed-tools", "--permission-prompt-tool", "--permission-prompts"]);

/** The core-owned key a plugin's Claude settings object sets, or null. */
export function claudeCoreSettingsKey(settings: Record<string, unknown>): string | null {
  return CLAUDE_CORE_SETTINGS.find((key) => key in settings) ?? null;
}

export function coreOwnedLaunchArgument(provider: ProviderId, argument: string): boolean {
  const flag = argument.split("=", 1)[0]!;
  if (provider === "claude") {
    if (CLAUDE_CORE_OWNED_FLAGS.has(flag)) return true;
    // `--settings=<value>` in one argument: inline JSON is checked like a separate value; a file cannot be checked here.
    const equals = argument.startsWith(SETTINGS_EQUALS);
    const inline = parseInlineSettings(equals ? argument.slice(SETTINGS_EQUALS.length) : argument);
    if (equals && !inline) return true;
    if (inline && claudeCoreSettingsKey(inline)) return true;
  }
  return CORE_OWNED_FLAGS.has(flag)
    || Boolean(CORE_OWNED_SHORT_FLAGS[provider]?.includes(flag))
    || Boolean(CORE_OWNED_SUBCOMMANDS[provider]?.includes(argument))
    || CORE_OWNED_WORDS.test(argument);
}
