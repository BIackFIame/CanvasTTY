/**
 * The "auto" launch profile, next to "normal" and "yolo". It exists only where the CLI has a native auto mode (its own
 * reviewer or classifier approves safe actions), and runs inside the CLI's own sandbox where one is verified (Codex,
 * Claude Code). "normal" stays the default.
 *
 * Every entry is a per-run flag or inline setting; no CLI configuration file is written. Verified against the installed
 * CLIs' `--help` under a fake HOME (Claude Code 2.1.281, codex-cli 0.156.1, grok 1.0.41). Any other agent has no auto
 * profile until its flags are checked the same way.
 */
import type { ProviderId } from "./providerCatalog.ts";

export type LaunchProfile = "normal" | "yolo" | "auto";
export const isLaunchProfile = (value: unknown): value is LaunchProfile => value === "normal" || value === "yolo" || value === "auto";

export interface AutoModeFlags {
  /** Native full auto, inside the CLI's own sandbox. */
  readonly auto: readonly string[];
  /** Accept-edits inside the same sandbox: edits in the project run, anything else asks or stays in the sandbox. */
  readonly acceptEdits: readonly string[];
}

/** The native flag table. Claude's sandbox is not a flag but an inline settings block (CLAUDE_SANDBOX_SETTINGS). */
export const AUTO_MODE: Readonly<Partial<Record<ProviderId, AutoModeFlags>>> = Object.freeze({
  // claude --help: `--permission-mode <mode>` (choices: "acceptEdits", "auto", "bypassPermissions", "manual",
  // "dontAsk", "plan").
  claude: { auto: ["--permission-mode", "auto"], acceptEdits: ["--permission-mode", "acceptEdits"] },
  // codex --help (and `codex resume --help`): `--approve-for-me  Route approval requests through automatic review using
  // the workspace-write sandbox`; `-s, --sandbox <read-only|workspace-write|danger-full-access>`;
  // `-a, --ask-for-approval <on-request|never>`. Accept-edits: workspace-write, the model asks for anything beyond it.
  codex: { auto: ["--approve-for-me"], acceptEdits: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"] },
  // grok --help: `--permission-mode <MODE>` [default, acceptEdits, auto, dontAsk, bypassPermissions, plan]. Its
  // `--sandbox <PROFILE>` does not list its profiles, so no Grok sandbox is relied on.
  grok: { auto: ["--permission-mode", "auto"], acceptEdits: ["--permission-mode", "acceptEdits"] }
});

/**
 * Claude Code's sandbox, merged into the one inline `--settings` CanvasTTY passes. `autoAllowBashIfSandboxed` defaults
 * to true, which would run every sandboxed command without its classifier or a prompt, so it is off.
 */
export const CLAUDE_SANDBOX_SETTINGS = Object.freeze({ enabled: true, autoAllowBashIfSandboxed: false });

/**
 * Agents whose "auto" is a per-run permission configuration instead of a flag: OpenCode (1.18) has no auto flag, so its
 * auto profile is an inline OPENCODE_CONFIG_CONTENT (openCodeAutoEnvironment in openCodeConfig.ts).
 */
export const CONFIG_AUTO_MODE: ReadonlySet<ProviderId> = new Set<ProviderId>(["opencode"]);

export function hasAutoMode(provider: ProviderId): boolean {
  return AUTO_MODE[provider] !== undefined || CONFIG_AUTO_MODE.has(provider);
}

/**
 * The flags "auto" adds. `thirdPartyModel` (a launch contributor ran the CLI on another model, e.g. an API or Ollama
 * account) turns it into accept-edits: the native auto reviewer would then be that same model, and a weak model's own
 * classifier is not a safety boundary. Accept-edits keeps the sandbox.
 */
export function autoModeArguments(provider: ProviderId, thirdPartyModel: boolean): string[] {
  if (CONFIG_AUTO_MODE.has(provider)) return [];
  const flags = AUTO_MODE[provider];
  if (!flags) throw new Error(`${provider} has no auto mode; use the normal profile.`);
  return [...(thirdPartyModel ? flags.acceptEdits : flags.auto)];
}
