// Main-process boot marks: each named phase is recorded at most once, in milliseconds since the process
// started, and published on `globalThis.__canvasTTYMainBootMarks` for a bench harness running in the same
// process. The renderer keeps its own list (src/renderer/src/lib/bootMarks.ts) with wall-clock stamps, so a
// harness can put both on one time axis. A handful of entries, no timers: safe in every build.
export interface MainBootMark {
  readonly name: string;
  /** Milliseconds since the process started. */
  readonly atMs: number;
}

const processStartEpochMs = Date.now() - process.uptime() * 1000;
let marks: MainBootMark[] = [];
const seen = new Set<string>();

/** Records `name` the first time it is called; later calls for the same name are no-ops. */
export function markMainBoot(name: string): void {
  if (seen.has(name)) return;
  seen.add(name);
  marks = [...marks, { name, atMs: Math.round(Date.now() - processStartEpochMs) }];
  (globalThis as { __canvasTTYMainBootMarks?: readonly MainBootMark[] }).__canvasTTYMainBootMarks = marks;
}

export function mainBootMarks(): readonly MainBootMark[] {
  return marks;
}
