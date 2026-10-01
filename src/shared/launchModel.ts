import type { ProviderId } from "./providerCatalog.ts";

/**
 * A launch's model and reasoning effort, passed to the agent's own CLI flag for that run only (nothing is written
 * to the CLI's configuration). Kept free of other imports so the catalog test and the renderer can use it.
 */

/** How hard a reasoning model thinks; each CLI accepts only some of these (PROVIDER_REASONING_EFFORTS). */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

/** Levels each CLI documents: the Codex `model_reasoning_effort` config, `claude --effort`, `grok --reasoning-effort`. */
export const PROVIDER_REASONING_EFFORTS: Readonly<Partial<Record<ProviderId, readonly ReasoningEffort[]>>> = Object.freeze({
  codex: Object.freeze(["minimal", "low", "medium", "high", "xhigh"] as const),
  claude: Object.freeze(["low", "medium", "high", "xhigh", "max"] as const),
  grok: Object.freeze(["low", "medium", "high", "xhigh"] as const)
});

export function reasoningEffortsFor(provider: ProviderId): readonly ReasoningEffort[] {
  return PROVIDER_REASONING_EFFORTS[provider] ?? [];
}

/** The CLIs whose interactive launch takes `--model <id>`; others choose their model elsewhere. */
const MODEL_FLAG_PROVIDERS: ReadonlySet<ProviderId> = new Set(["codex", "claude", "qwen", "kimi", "opencode", "grok", "omp", "pi", "cursor"]);

export function supportsLaunchModel(provider: ProviderId): boolean {
  return MODEL_FLAG_PROVIDERS.has(provider);
}

/** What a model id looks like for this CLI, for list_providers and refusals. */
export function launchModelHint(provider: ProviderId): string {
  if (!supportsLaunchModel(provider)) return `${provider} has no per-launch model option; start it without model.`;
  if (provider === "opencode") return "provider/model as `opencode models` prints it, for example zai-coding-plan/glm-4.6.";
  if (provider === "kimi") return "a model alias configured in Kimi.";
  return "the model id its CLI's --model accepts.";
}

export const MAX_LAUNCH_MODEL_LENGTH = 200;

/** Why this model cannot be passed to this provider's CLI, or null when it can. */
export function launchModelProblem(provider: ProviderId, model: unknown): string | null {
  if (typeof model !== "string" || model.trim() !== model || model.length === 0 || model.length > MAX_LAUNCH_MODEL_LENGTH
    || model.startsWith("-") || /[\s\u0000-\u001f\u007f]/u.test(model)) {
    return `model must be a model id of at most ${MAX_LAUNCH_MODEL_LENGTH} characters without spaces.`;
  }
  if (!supportsLaunchModel(provider)) return launchModelHint(provider);
  if (provider === "opencode" && !/^[^/]+\/.+$/u.test(model)) return `OpenCode takes ${launchModelHint("opencode")}`;
  if (provider === "kimi" && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(model)) return `Kimi takes ${launchModelHint("kimi")}`;
  return null;
}

export function launchEffortProblem(provider: ProviderId, effort: unknown): string | null {
  const allowed = reasoningEffortsFor(provider);
  if (allowed.length === 0) return `${provider} has no per-launch reasoning effort; start it without effort.`;
  return typeof effort === "string" && (allowed as readonly string[]).includes(effort)
    ? null
    : `${provider} takes effort ${allowed.join(", ")}.`;
}

export function providerModelArguments(provider: ProviderId, model?: string): string[] {
  if (model === undefined) return [];
  const problem = launchModelProblem(provider, model);
  if (problem) throw new Error(problem);
  return ["--model", model];
}

export function providerEffortArguments(provider: ProviderId, effort?: ReasoningEffort): string[] {
  if (effort === undefined) return [];
  const problem = launchEffortProblem(provider, effort);
  if (problem) throw new Error(problem);
  if (provider === "codex") return ["-c", `model_reasoning_effort="${effort}"`];
  if (provider === "claude") return ["--effort", effort];
  return ["--reasoning-effort", effort];
}
