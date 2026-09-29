type Draw = (now: number) => void;

interface Entry {
  draw: Draw;
  visible: boolean;
  fps: number;
  nextAt: number;
}

/** One clock for every decorated terminal in the renderer window. */
export class SkinScheduler {
  private readonly entries = new Set<Entry>();
  private readonly documentTarget: Document;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private frame: number | undefined;

  constructor(documentTarget: Document) {
    this.documentTarget = documentTarget;
    documentTarget.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  register(draw: Draw): { update(visible: boolean, fps: number): void; invalidate(): void; dispose(): void } {
    const entry: Entry = { draw, visible: false, fps: 0, nextAt: 0 };
    this.entries.add(entry);
    return {
      update: (visible, fps) => {
        const becameVisible = visible && !entry.visible;
        entry.visible = visible;
        entry.fps = Math.max(0, Math.min(24, fps));
        entry.nextAt = 0;
        if (becameVisible) this.drawEntry(entry, performance.now());
        this.schedule();
      },
      invalidate: () => {
        entry.nextAt = 0;
        if (entry.visible) this.drawEntry(entry, performance.now());
        this.schedule();
      },
      dispose: () => {
        this.entries.delete(entry);
        this.schedule();
      }
    };
  }

  get size(): number { return this.entries.size; }

  dispose(): void {
    this.documentTarget.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.entries.clear();
    this.cancelScheduled();
  }

  private onVisibilityChange = (): void => {
    if (this.documentTarget.hidden) {
      this.cancelScheduled();
      return;
    }
    const now = performance.now();
    for (const entry of this.entries) if (entry.visible) this.drawEntry(entry, now);
    this.schedule();
  };

  private drawEntry(entry: Entry, now: number): void {
    if (this.documentTarget.hidden || !entry.visible) return;
    try {
      entry.draw(now);
    } catch {
      // A decorative renderer must not break terminal input or the shared clock.
      entry.fps = 0;
    }
    entry.nextAt = entry.fps > 0 ? now + 1000 / entry.fps : Infinity;
  }

  private cancelScheduled(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.timer = undefined;
    this.frame = undefined;
  }

  private schedule(): void {
    this.cancelScheduled();
    if (this.documentTarget.hidden) return;
    let nextAt = Infinity;
    for (const entry of this.entries) {
      if (entry.visible && entry.fps > 0) nextAt = Math.min(nextAt, entry.nextAt);
    }
    if (!Number.isFinite(nextAt)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.frame = requestAnimationFrame((now) => {
        this.frame = undefined;
        for (const entry of this.entries) {
          if (entry.visible && entry.fps > 0 && now >= entry.nextAt - 1) this.drawEntry(entry, now);
        }
        this.schedule();
      });
    }, Math.max(0, nextAt - performance.now() - 8));
  }
}

let sharedScheduler: SkinScheduler | undefined;
export function getSkinScheduler(): SkinScheduler {
  sharedScheduler ??= new SkinScheduler(document);
  return sharedScheduler;
}
