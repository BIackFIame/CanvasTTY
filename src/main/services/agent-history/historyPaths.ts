import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

interface HistoryPathOptions {
  environment?: Readonly<NodeJS.ProcessEnv>;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  startupDirectory?: string;
  pathExists?: (path: string) => boolean;
}

/** Match CLI storage rules rather than the desktop platform's application-data convention. */
export function resolveAgentHistoryPaths(options: HistoryPathOptions = {}) {
  const platform = options.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  const home = options.homeDirectory ?? homedir();
  const cwd = options.startupDirectory ?? process.cwd();
  const environment = options.environment ?? process.env;
  const exists = options.pathExists ?? existsSync;
  const env = (name: string): string | undefined => platform === "win32"
    ? environment[Object.keys(environment).find(key => key.toUpperCase() === name) ?? name]
    : environment[name];
  const expand = (value: string): string => path.resolve(cwd,
    value === "~" ? home : /^~[/\\]/.test(value) ? path.join(home, value.slice(2)) : value);

  // OMP named profiles override the shared Pi agent-dir variable. XDG is adopted
  // only when that app/profile directory exists, as in OMP's DirResolver.
  const normalizeProfile = (value: string | undefined): string | undefined => {
    const name = value?.trim();
    return name && name !== "default" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) && !name.endsWith(".")
      && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(name) ? name : undefined;
  };
  const profile = normalizeProfile(env("OMP_PROFILE") ?? env("PI_PROFILE"));
  const config = path.join(home, env("PI_CONFIG_DIR") || ".omp");
  const profileRoot = profile ? path.join(config, "profiles", profile) : config;
  const defaultAgent = path.join(profileRoot, "agent");
  const inheritedProfile = profile ?? normalizeProfile(env("PI_PROFILE"));
  const agentOverride = env("PI_CODING_AGENT_DIR");
  const inheritedAgent = inheritedProfile && agentOverride === path.join(config, "profiles", inheritedProfile, "agent");
  const ompAgent = !profile && agentOverride && !inheritedAgent ? path.resolve(cwd, agentOverride) : defaultAgent;
  let ompData = ompAgent;
  if ((platform === "linux" || platform === "darwin") && ompAgent === defaultAgent && env("XDG_DATA_HOME")) {
    const appRoot = path.join(env("XDG_DATA_HOME")!, "omp");
    const candidate = profile ? path.join(appRoot, "profiles", profile) : appRoot;
    if (exists(candidate)) ompData = candidate;
  }
  const qwen = expand(env("QWEN_RUNTIME_DIR") || env("QWEN_HOME") || path.join(home, ".qwen"));
  return {
    codex: env("CODEX_HOME") || path.join(home, ".codex"),
    grok: env("GROK_HOME") || path.join(home, ".grok"),
    // OpenCode uses xdg-basedir on all platforms, including Windows; OPENCODE_HOME is not its data override.
    opencode: path.join(env("XDG_DATA_HOME") || path.join(home, ".local", "share"), "opencode"),
    claude: path.join(env("CLAUDE_CONFIG_DIR") || path.join(home, ".claude"), "projects"),
    qwen: [path.join(qwen, "projects"), path.join(qwen, "tmp")],
    kimi: env("KIMI_SHARE_DIR") || path.join(home, ".kimi"),
    kimiCode: env("KIMI_CODE_HOME") || path.join(home, ".kimi-code"),
    omp: env("PI_CODING_AGENT_SESSION_DIR") || path.join(ompData, "sessions"),
    pi: env("PI_CODING_AGENT_SESSION_DIR") ? expand(env("PI_CODING_AGENT_SESSION_DIR")!)
      : path.join(expand(env("PI_CODING_AGENT_DIR") || path.join(home, ".pi", "agent")), "sessions"),
    cursor: env("CURSOR_CONFIG_DIR") || (env("XDG_CONFIG_HOME")
      ? path.join(env("XDG_CONFIG_HOME")!, "cursor") : path.join(home, ".cursor")),
    minimax: env("MINIMAX_DATA_DIR")?.trim() || env("MAVIS_DATA_DIR")?.trim() || path.join(home, ".minimax")
  };
}
