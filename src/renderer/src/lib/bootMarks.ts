// A cheap, always-on boot-phase mark list: each named phase is recorded at most once, with a
// millisecond timestamp relative to this module's own load (module load happens at the very start
// of the renderer bundle, before React mounts, so it is a stable zero point across runs). No timers,
// no polling, no growth beyond the fixed set of phases callers mark — this is safe to leave compiled
// into every build. `window.__canvasTTYBootMarks` is a read-only snapshot array a bench harness can
// poll via executeJavaScript; production code never reads it back.
export interface BootMark {
  readonly name: string;
  readonly atMs: number;
}

const origin = typeof performance !== "undefined" ? performance.now() : Date.now();
let marks: BootMark[] = [];
const seen = new Set<string>();

function publish(): void {
  try {
    (window as unknown as { __canvasTTYBootMarks?: readonly BootMark[] }).__canvasTTYBootMarks = marks;
  } catch {
    // No `window` (a unit test's module scope) or a locked-down global: the in-memory list below
    // still works for callers that read it directly.
  }
}

/** Records `name` the first time it is called; later calls for the same name are no-ops. */
export function markBootOnce(name: string): void {
  if (seen.has(name)) return;
  seen.add(name);
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  marks = [...marks, { name, atMs: Math.round(now - origin) }];
  publish();
}

/** The marks recorded so far, in the order they were first reached. */
export function bootMarks(): readonly BootMark[] {
  return marks;
}

/** Test-only: clears recorded marks so each test starts from a clean slate. */
export function resetBootMarksForTest(): void {
  marks = [];
  seen.clear();
  publish();
}
