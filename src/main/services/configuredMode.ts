import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ProviderId } from "../../shared/contracts.ts";

/**
 * In the normal (manual) profile CanvasTTY passes no permission flag, so the CLI follows its own configuration. When
 * that configuration skips approvals, the card says so: "manual" would otherwise hide a bypass the person set up in
 * the CLI itself. Reads the CLI's own settings files only (never credentials); anything unreadable says nothing.
 */
export function configuredMode(
  provider: ProviderId,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  read: (path: string) => string | null = readText
): { mode: string; source: string } | null {
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : null;
  if (provider === "claude") {
    const config = env.CLAUDE_CONFIG_DIR && isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : home ? join(home, ".claude") : null;
    // Later files win, as in Claude Code: user, then project, then local project settings.
    const files = [...(config ? [join(config, "settings.json")] : []), join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")];
    let found: { mode: string; source: string } | null = null;
    for (const file of files) {
      const text = read(file);
      if (text === null) continue;
      try {
        const mode = (JSON.parse(text) as { permissions?: { defaultMode?: unknown } }).permissions?.defaultMode;
        if (typeof mode === "string") found = ["bypassPermissions", "dontAsk", "acceptEdits", "auto"].includes(mode) ? { mode, source: file } : null;
      } catch { /* not JSON: Claude ignores it too */ }
    }
    return found;
  }
  if (provider === "codex") {
    const codexHome = env.CODEX_HOME && isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : home ? join(home, ".codex") : null;
    if (!codexHome) return null;
    const file = join(codexHome, "config.toml");
    const text = read(file);
    if (text === null) return null;
    // Top-level keys only: everything before the first [table].
    const top = text.split(/^\s*\[/mu)[0] ?? "";
    if (/^\s*approval_policy\s*=\s*["']never["']/mu.test(top)) return { mode: "approval_policy=never", source: file };
    if (/^\s*sandbox_mode\s*=\s*["']danger-full-access["']/mu.test(top)) return { mode: "sandbox_mode=danger-full-access", source: file };
    return null;
  }
  if (provider === "opencode") {
    const configHome = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : home ? join(home, ".config") : null;
    const files = [...(configHome ? [join(configHome, "opencode", "opencode.json"), join(configHome, "opencode", "opencode.jsonc")] : []),
      join(cwd, "opencode.json"), join(cwd, "opencode.jsonc")];
    for (const file of files) {
      const text = read(file);
      if (text !== null && /"permission"\s*:\s*"allow"/u.test(text)) return { mode: "permission=allow", source: file };
    }
  }
  return null;
}

function readText(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}
