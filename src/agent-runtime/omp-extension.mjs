import { reportLifecycle } from "./runtime-client.mjs";

export default function CanvasTTYLifecycle(api) {
  async function report(ctx, state, event) {
    // OMP also binds extensions to spawned agents, which share the terminal's capability.
    if (ctx.agent?.kind === "sub") return;
    try {
      const threadId = ctx.sessionManager.getSessionId();
      await reportLifecycle({ state, event, threadId });
    } catch {
      // Optional status reporting must never interrupt OMP.
    }
  }

  for (const event of ["session_start", "session_switch", "session_branch", "session_fork"]) {
    api.on(event, (_event, ctx) => report(ctx, "idle", event));
  }
  api.on("agent_start", (_event, ctx) => report(ctx, "working", "UserPromptSubmit"));
  api.on("agent_end", (_event, ctx) => report(ctx, "idle", "Stop"));
}
