import type { ProviderId } from "../../shared/contracts.ts";

/** Providers whose final answer can be captured: Codex through its Stop hook, OpenCode through CanvasTTY's plugin. */
export const RESULT_CAPTURE_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(["codex", "opencode"]);
