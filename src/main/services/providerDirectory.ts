import type { AgentProviderId, LimitsSnapshot, PluginLaunchField, ProviderLimitsSnapshot } from "../../shared/contracts.ts";
import { AGENT_PROVIDERS, PROVIDER_CAPABILITIES } from "../../shared/contracts.ts";
import { PROVIDER_LABELS } from "../../shared/providerCatalog.ts";

/**
 * What an orchestrator can launch as a subagent, from what CanvasTTY already knows: the provider CLI registry
 * (resolved at startup and on a recheck), the last usage-limits read (never started from here), and the launch
 * options trusted plugins declared. Nothing here starts a process, reads a credential or calls a network API.
 */

/** Sign-in as the last usage-limits read left it; "unknown" when it was never read for that provider. */
export type ProviderSignIn = "ok" | "signed_out" | "expired" | "unknown";

export interface ProviderDirectoryEntry {
  /** The exact value spawn_agent.provider takes. */
  id: AgentProviderId;
  name: string;
  /** The provider's CLI was found on this computer; null when CanvasTTY cannot tell. */
  installed: boolean | null;
  /** spawn_agent can start it now (its CLI is installed and it accepts prompts). */
  available: boolean;
  signIn: ProviderSignIn;
  /** When the sign-in state was read (ms since the epoch); absent with signIn "unknown". */
  signInCheckedAt?: number;
  /** It can run as a subagent: it takes prompts and its output can be read back. */
  subagent: boolean;
  /** Started with the Orchestrator role, it gets the canvastty_agents tools itself. */
  orchestrator: boolean;
  /** Plugin launch options it accepts (spawn_agent.launchOptions), by plugin. */
  launchOptions?: Array<{ pluginId: string; plugin: string; fields: Array<{ key: string; kind: PluginLaunchField["kind"]; choices?: string[] }> }>;
}

export interface ProviderDirectory {
  providers: ProviderDirectoryEntry[];
  /** Plugin tools that pick launch options (such as an account route) for spawn_agent.launchOptions. */
  launchOptionTools?: string[];
  note: string;
}

export interface ProviderDirectorySources {
  /** "available" / "unavailable" from the provider CLI registry; null when there is none. */
  cli(provider: AgentProviderId): "available" | "unavailable" | null;
  /** The cached usage-limits snapshot, or null; must not start a read. */
  limits(): LimitsSnapshot | null;
  /** Launch options trusted plugins declared (PluginManager.launchContributors). */
  launchContributors?(): Array<{ pluginId: string; pluginName: string; launch: { appliesTo?: AgentProviderId[]; fields: PluginLaunchField[] } }>;
}

const NOTE = "Pass one of these ids as spawn_agent.provider. Prefer available providers whose signIn is \"ok\"; "
  + "\"unknown\" only means CanvasTTY has not read it yet. Do not search the filesystem for agent CLIs or their configuration.";

/** A plugin tool whose name says it picks routes or accounts for a launch. */
const LAUNCH_OPTION_TOOL = /__(?:list_routes|pick_route|list_accounts|pick_account)$/;

export function listProviderDirectory(sources: ProviderDirectorySources, pluginTools: readonly string[] = []): ProviderDirectory {
  let limits: LimitsSnapshot | null = null;
  try { limits = sources.limits(); } catch { limits = null; }
  const byProvider = new Map<string, ProviderLimitsSnapshot>((limits?.providers ?? []).map((entry) => [entry.provider, entry]));
  let contributors: ReturnType<NonNullable<ProviderDirectorySources["launchContributors"]>> = [];
  try { contributors = sources.launchContributors?.() ?? []; } catch { contributors = []; }
  const providers = AGENT_PROVIDERS.map((id): ProviderDirectoryEntry => {
    const capabilities = PROVIDER_CAPABILITIES[id];
    let cli: "available" | "unavailable" | null;
    try { cli = sources.cli(id); } catch { cli = null; }
    const installed = cli === null ? null : cli === "available";
    const subagent = capabilities.send && capabilities.observe;
    const signIn = signInState(byProvider.get(id));
    const options = contributors
      .filter((contributor) => !contributor.launch.appliesTo || contributor.launch.appliesTo.includes(id))
      .map((contributor) => ({
        pluginId: contributor.pluginId,
        plugin: contributor.pluginName,
        fields: contributor.launch.fields.map((field) => ({
          key: field.key,
          kind: field.kind,
          ...(field.kind === "select" && field.options?.length && field.optionsFrom !== "service"
            ? { choices: field.options.map((option) => option.value) }
            : {})
        }))
      }))
      .filter((contributor) => contributor.fields.length > 0);
    return {
      id,
      name: PROVIDER_LABELS[id],
      installed,
      available: installed !== false && subagent,
      signIn: signIn.state,
      ...(signIn.checkedAt !== undefined ? { signInCheckedAt: signIn.checkedAt } : {}),
      subagent,
      orchestrator: capabilities.browser === "mcp",
      ...(options.length > 0 ? { launchOptions: options } : {})
    };
  });
  const launchOptionTools = pluginTools.filter((name) => LAUNCH_OPTION_TOOL.test(name));
  return {
    providers,
    ...(launchOptionTools.length > 0 ? { launchOptionTools } : {}),
    note: launchOptionTools.length > 0
      ? `${NOTE} To launch through a specific plugin account or route, call ${launchOptionTools.join(" or ")} and pass what it returns as spawn_agent.launchOptions.`
      : NOTE
  };
}

function signInState(entry: ProviderLimitsSnapshot | undefined): { state: ProviderSignIn; checkedAt?: number } {
  if (!entry) return { state: "unknown" };
  if (entry.state === "available") return { state: "ok", checkedAt: entry.fetchedAt };
  const checkedAt = entry.state === "stale" ? entry.failedAt : entry.checkedAt;
  if (entry.reason === "not-authenticated") return { state: "signed_out", checkedAt };
  if (entry.reason === "session-expired") return { state: "expired", checkedAt };
  // A stale entry was read successfully before a later read failed for another reason (a timeout, the network).
  if (entry.state === "stale") return { state: "ok", checkedAt: entry.fetchedAt };
  return { state: "unknown" };
}
