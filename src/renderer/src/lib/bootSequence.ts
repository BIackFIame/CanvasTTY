// The renderer's startup order, kept out of App so it can be tested without a DOM:
//   1. the critical snapshot — what the first frame shows (appearance from settings, HOME launchers from CLI
//      availability, session metadata for card positions and the HOME list, installed plugins for HOME widgets);
//   2. the canvas mounts with it, and nothing heavier: no loader over a half-initialized workspace;
//   3. after that first stable frame was painted, restored surfaces (xterm, plugin iframes, the native browser view)
//      mount and deferred work (browser runtime, HOME media, limits) starts.
import type { AgentCliAvailability, AppSettings, CanvasTTYApi, InstalledPlugin, SessionSnapshot } from "../../../shared/contracts";

export interface CriticalSnapshot {
  settings: AppSettings;
  availability: AgentCliAvailability;
  sessions: SessionSnapshot[];
  plugins: InstalledPlugin[];
}

type CriticalApi = {
  settings: Pick<CanvasTTYApi["settings"], "get">;
  agents: Pick<CanvasTTYApi["agents"], "availability">;
  terminal: Pick<CanvasTTYApi["terminal"], "list">;
  plugins: Pick<CanvasTTYApi["plugins"], "list">;
};

/** The four requests the first frame needs, issued together; nothing optional (browser, media, limits) is in here. */
export async function loadCriticalSnapshot(api: CriticalApi): Promise<CriticalSnapshot> {
  const [settings, availability, sessions, plugins] = await Promise.all([
    api.settings.get(),
    api.agents.availability(),
    api.terminal.list(),
    api.plugins.list()
  ]);
  return { settings, availability, sessions, plugins };
}

type FrameScheduler = (callback: () => void) => number;
type FrameCanceller = (handle: number) => void;

/**
 * Runs `callback` once the frame with the current commit was produced: the second animation-frame callback runs
 * after the first frame was painted. Returns a cancel function for effect cleanup.
 */
export function afterNextPaint(
  callback: () => void,
  schedule: FrameScheduler = (next) => requestAnimationFrame(next),
  cancel: FrameCanceller = (handle) => cancelAnimationFrame(handle)
): () => void {
  let handle = schedule(() => {
    handle = schedule(() => {
      handle = -1;
      callback();
    });
  });
  return () => {
    if (handle !== -1) cancel(handle);
    handle = -1;
  };
}
