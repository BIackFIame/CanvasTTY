import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { ProviderId, SessionIsolation } from "../../../shared/contracts.ts";
import { autoKind, PROFILE_RANK, type LaunchProfile } from "../../../shared/autoMode.ts";
import { LaunchRefusal } from "../launchRefusal.ts";
import { isolationPaths } from "./isolationPaths.ts";
import { seatbeltProfile } from "./seatbelt.ts";
import { bubblewrapArguments } from "./bubblewrap.ts";
import { LinuxHostPaths } from "./linuxHostPaths.ts";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** The prefix of a launch's own folder (its profile and TMPDIR) in the temporary folder. */
export const ISOLATION_FOLDER_PREFIX = "ctty-iso-";
/** Tells the agent inside the layer what it may do (its value is ISOLATION_NOTE). */
export const ISOLATION_ENV = "CANVASTTY_ISOLATION";
export const ISOLATION_NOTE = "CanvasTTY agent isolation: files can be written only inside the project folder, $TMPDIR and this CLI's own folders; SSH/cloud keys, other agents' credentials and CanvasTTY's tokens cannot be read; other processes, apps and daemons are out of reach. \"Operation not permitted\" outside that is this rule: do the work inside the project, or tell the person what you need.";

export interface AgentIsolationOptions {
  /** CanvasTTY's userData folder (its private data is never readable inside the layer). */
  userDataPath: string;
  /** The person's setting (Settings → Agents → Agent isolation). */
  enabled: () => boolean;
  /** Environment before plugin contributions; copied when the layer is constructed. */
  hostEnvironment?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  /** Where each launch's own folder is made; the system temporary folder by default. */
  tempRoot?: string;
  sandboxExecPath?: string;
  /** bubblewrap's path on Linux; found on PATH when omitted, null when it is not installed. */
  bubblewrapPath?: string | null;
  exists?: (path: string) => boolean;
  /** Linux: the host folders and placeholders bubblewrap needs (shared across launches); tests pass their own. */
  linuxHostPaths?: LinuxHostPaths;
}

export interface IsolationDecisionInput {
  provider: ProviderId;
  profile: LaunchProfile;
  /** Not launched by the person: a subagent, or an agent a plugin started. */
  delegated: boolean;
  /** A plugin environment runs this card; `isolated` when it does not run on this computer's files (container, remote). */
  environment?: { isolated: boolean; label: string } | null;
}

export interface IsolationDecision {
  /** Wrap the launch in the layer. */
  apply: boolean;
  /** What the card shows; absent when the layer does not concern this launch (a plain terminal, a manual agent). */
  isolation?: SessionIsolation;
  /** The profile to launch in: lowered to normal when a subagent's layer is missing. */
  profile: LaunchProfile;
  /** The launch must not start, and why. */
  refuse?: string;
}

export interface IsolationLaunch {
  sessionId: string;
  provider: ProviderId;
  cwd: string;
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  /** Folders under CanvasTTY's private data this launch was handed (its control grant, its account home). */
  grantedPrivate?: readonly string[];
  /** The launch profile: in plan the project is not writable. */
  profile?: LaunchProfile;
}

export interface WrappedLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Removes the launch's own folder (profile and temporary files); call when its process exited or was replaced. */
  cleanup(): void;
}

/**
 * CanvasTTY's operating-system isolation layer around an agent's whole process tree (the CLI, its tools, MCP servers
 * and hooks): macOS seatbelt through sandbox-exec, Linux bubblewrap. It applies to agents the person did not launch
 * directly (subagents, plugin-started agents) and to every launch in a profile other than normal (manual), unless
 * the person turned it off. It fails closed: when it cannot be set up, the launch is refused, never run without it.
 */
export class AgentIsolation {
  private readonly options: AgentIsolationOptions;
  private readonly platform: NodeJS.Platform;
  private readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
  private bubblewrap: string | null | undefined;
  private readonly linuxHostPaths: LinuxHostPaths;

  constructor(options: AgentIsolationOptions) {
    this.options = options;
    this.platform = options.platform ?? process.platform;
    this.hostEnvironment = { ...(options.hostEnvironment ?? process.env) };
    this.bubblewrap = options.bubblewrapPath;
    this.linuxHostPaths = options.linuxHostPaths ?? new LinuxHostPaths();
  }

  /** The layer this computer has, or why it has none. */
  availability(): { layer: "seatbelt" | "bubblewrap" } | { reason: string } {
    const exists = this.options.exists ?? existsSync;
    if (this.platform === "darwin") {
      return exists(this.options.sandboxExecPath ?? SANDBOX_EXEC)
        ? { layer: "seatbelt" }
        : { reason: "macOS sandbox-exec is missing on this computer." };
    }
    if (this.platform === "linux") {
      if (this.bubblewrap === undefined) this.bubblewrap = findOnPath("bwrap", exists);
      return this.bubblewrap ? { layer: "bubblewrap" } : { reason: "bubblewrap (bwrap) is not installed; install it to isolate agents on Linux." };
    }
    if (this.platform === "win32") return { reason: "CanvasTTY has no agent isolation layer on Windows yet." };
    return { reason: `CanvasTTY has no agent isolation layer on ${this.platform}.` };
  }

  /** The layer is on and can contain an agent here. */
  containment(): boolean {
    return this.enabled() && "layer" in this.availability();
  }

  decide(input: IsolationDecisionInput): IsolationDecision {
    const { provider, delegated } = input;
    let profile = input.profile;
    if (provider === "terminal") return { apply: false, profile };
    const wanted = delegated || profile !== "normal";
    if (!wanted) return { apply: false, profile };
    const containedAuto = profile === "auto" && autoKind(provider) === "contained";
    if (input.environment?.isolated) {
      return { apply: false, profile, isolation: { state: "environment", reason: `Runs in ${input.environment.label}; the isolation layer of this computer does not apply there.` } };
    }
    const lower = (state: SessionIsolation["state"], why: string): IsolationDecision => {
      if (containedAuto && !delegated) {
        return { apply: false, profile, refuse: `${provider} has no auto mode of its own; its auto runs only inside CanvasTTY's agent isolation, and ${why}` };
      }
      // Without a layer the person did not turn off, a subagent or plugin-started agent never runs more freely than
      // normal (asking). The person turning it off is their opt-in (on Windows the only way to auto subagents), except
      // for a contained auto, which is a bypass and exists only inside the layer.
      if (delegated && (containedAuto || (state === "unavailable" && PROFILE_RANK[profile] > PROFILE_RANK.normal))) {
        const from = profile;
        profile = "normal";
        return { apply: false, profile, isolation: { state, reason: `${why} It runs in normal (it asks) instead of ${from}.` } };
      }
      return { apply: false, profile, isolation: { state, reason: why } };
    };
    if (!this.enabled()) return lower("off", "agent isolation is off in Settings → Agents.");
    const available = this.availability();
    if ("reason" in available) return lower("unavailable", available.reason);
    return { apply: true, profile, isolation: { state: "on", layer: available.layer } };
  }

  /** Wraps one launch; throws a LaunchRefusal (fail closed) when the layer cannot be set up. */
  wrap(launch: IsolationLaunch): WrappedLaunch {
    const available = this.availability();
    if ("reason" in available) throw new LaunchRefusal(`agent isolation is not available: ${available.reason} The agent was not started without it.`);
    let folder: string | null = null;
    let releaseHostPaths: (() => void) | null = null;
    const cleanup = (): void => {
      releaseHostPaths?.();
      releaseHostPaths = null;
      if (folder) rmSync(folder, { recursive: true, force: true });
      folder = null;
    };
    try {
      const root = realpathSync(this.options.tempRoot ?? tmpdir());
      folder = mkdtempSync(join(root, ISOLATION_FOLDER_PREFIX));
      chmodSync(folder, 0o700);
      const temp = join(folder, "tmp");
      mkdirSync(temp, { mode: 0o700 });
      const cwd = realpathSync(launch.cwd);
      const paths = isolationPaths({
        provider: launch.provider,
        cwd,
        sessionTemp: temp,
        env: launch.env,
        hostEnvironment: this.hostEnvironment,
        userDataPath: this.options.userDataPath,
        sessionId: launch.sessionId,
        ...(launch.grantedPrivate ? { grantedPrivate: launch.grantedPrivate } : {}),
        ...(launch.profile === "plan" ? { readOnlyProject: true } : {})
      });
      // An agent that meets "Operation not permitted" can read why here, instead of trying other ways around it.
      const env = { ...launch.env, TMPDIR: `${temp}/`, TMP: temp, TEMP: temp, [ISOLATION_ENV]: ISOLATION_NOTE };
      if (available.layer === "seatbelt") {
        const profilePath = join(folder, "profile.sb");
        writeFileSync(profilePath, seatbeltProfile(paths), { mode: 0o600, flag: "wx" });
        return { command: this.options.sandboxExecPath ?? SANDBOX_EXEC, args: ["-f", profilePath, launch.command, ...launch.args], env, cleanup };
      }
      // bubblewrap mounts only what exists: the CLI's own missing folders are created and a missing protected file
      // gets a placeholder first (LinuxHostPaths), both undone by cleanup().
      releaseHostPaths = this.linuxHostPaths.prepare(paths);
      const kind = (path: string): "file" | "directory" | null => {
        try { const stat = statSync(path); return stat.isDirectory() ? "directory" : stat.isFile() ? "file" : null; } catch { return null; }
      };
      return {
        command: this.bubblewrap!,
        args: bubblewrapArguments(paths, { command: launch.command, args: launch.args, cwd, ...(launch.env.XDG_RUNTIME_DIR ? { runtimeDir: launch.env.XDG_RUNTIME_DIR } : {}) }, kind),
        env,
        cleanup
      };
    } catch (error) {
      cleanup();
      if (error instanceof LaunchRefusal) throw error;
      throw new LaunchRefusal(`agent isolation could not be set up: ${error instanceof Error ? error.message : String(error)} The agent was not started without it.`);
    }
  }

  private enabled(): boolean {
    try { return this.options.enabled() !== false; } catch { return true; }
  }
}

function findOnPath(name: string, exists: (path: string) => boolean): string | null {
  for (const folder of (process.env.PATH ?? "").split(delimiter)) {
    if (!folder) continue;
    const candidate = join(folder, name);
    if (exists(candidate)) return candidate;
  }
  for (const folder of ["/usr/bin", "/usr/local/bin", "/bin"]) {
    const candidate = join(folder, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** The folder of a session's control grant, from the launch environment (it is readable inside the layer). */
export function controlGrantFolder(env: Readonly<Record<string, string | undefined>>): string | null {
  const connection = env.CANVASTTY_CONTROL_CONNECTION;
  return connection ? dirname(connection) : null;
}
