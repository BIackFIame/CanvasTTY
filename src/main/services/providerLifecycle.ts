import type { ProviderId, SessionStatus } from "../../shared/contracts.ts";
import { basename } from "node:path";

const OSC_PREFIX = "\u001b]";
const OSC_BEL = "\u0007";
const OSC_ST = "\u001b\\";
const MAX_PENDING_CHARS = 4_096;
const WORKING_PREFIXES = ["◐\uFE0E ", "◐ "] as const;
const STAR_PREFIXES = ["✳\uFE0E ", "✳ "] as const;

/**
 * What a title prefix means differs by CLI. Qwen Code: «◐» working, «✳» waiting for an approval, the bare title idle.
 * Claude Code animates «◐»/«◑» while a turn runs and shows «✳» whenever none runs: at startup, after the turn ended, and
 * while its own permission prompt waits (measured in a PTY with 2.1.x), so its «✳» says idle; the prompt itself is told
 * by the PermissionRequest hook, never by the title.
 */
interface TitleGrammar {
  working: readonly string[];
  star: "idle" | "needs_approval";
}
const QWEN_TITLES: TitleGrammar = { working: WORKING_PREFIXES, star: "needs_approval" };
const CLAUDE_TITLES: TitleGrammar = { working: [...WORKING_PREFIXES, "◑\uFE0E ", "◑ "], star: "idle" };

export interface ProviderLifecycleParser {
  push(data: string): Extract<SessionStatus, "idle" | "working" | "needs_approval"> | null;
}

export function initialSessionStatus(provider: ProviderId): SessionStatus {
  return provider === "terminal" ? "idle" : "unavailable";
}

export function createProviderLifecycleParser(provider: ProviderId, cwd = ""): ProviderLifecycleParser | null {
  if (provider !== "claude" && provider !== "qwen") return null;
  const project = basename(cwd);
  return new OscTitleLifecycleParser(provider === "qwen" && project ? `Qwen - ${project}` : null, provider === "claude" ? CLAUDE_TITLES : QWEN_TITLES);
}

class OscTitleLifecycleParser implements ProviderLifecycleParser {
  private pending = "";
  private activeBaseTitle: string | null;
  private readonly grammar: TitleGrammar;

  constructor(initialBaseTitle: string | null, grammar: TitleGrammar) {
    this.activeBaseTitle = initialBaseTitle;
    this.grammar = grammar;
  }

  push(data: string): Extract<SessionStatus, "idle" | "working" | "needs_approval"> | null {
    if (!data) return null;
    this.pending += data;
    let latest: Extract<SessionStatus, "idle" | "working" | "needs_approval"> | null = null;

    while (this.pending.length > 0) {
      const start = this.pending.indexOf(OSC_PREFIX);
      if (start < 0) {
        this.pending = this.pending.endsWith("\u001b") ? "\u001b" : "";
        break;
      }
      if (start > 0) this.pending = this.pending.slice(start);

      const bel = this.pending.indexOf(OSC_BEL, OSC_PREFIX.length);
      const st = this.pending.indexOf(OSC_ST, OSC_PREFIX.length);
      const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
      if (end < 0) {
        if (this.pending.length > MAX_PENDING_CHARS) this.pending = "";
        break;
      }

      const payload = this.pending.slice(OSC_PREFIX.length, end);
      const terminatorLength = end === st ? OSC_ST.length : OSC_BEL.length;
      this.pending = this.pending.slice(end + terminatorLength);
      const separator = payload.indexOf(";");
      if (separator < 0) continue;
      const command = payload.slice(0, separator);
      if (command !== "0" && command !== "2") continue;
      const state = this.readTitle(payload.slice(separator + 1).trimEnd());
      if (state) latest = state;
    }

    return latest;
  }

  private readTitle(title: string): Extract<SessionStatus, "idle" | "working" | "needs_approval"> | null {
    const workingPrefix = this.grammar.working.find((prefix) => title.startsWith(prefix));
    if (workingPrefix) {
      this.activeBaseTitle = title.slice(workingPrefix.length);
      return "working";
    }
    const starPrefix = STAR_PREFIXES.find((prefix) => title.startsWith(prefix));
    if (starPrefix) {
      this.activeBaseTitle = title.slice(starPrefix.length);
      return this.grammar.star;
    }
    if (this.activeBaseTitle !== null && title === this.activeBaseTitle) return "idle";
    return null;
  }
}
