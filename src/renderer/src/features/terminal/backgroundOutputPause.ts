export function createBackgroundOutputPause(onChange: () => void): {
  activity(): void;
  setEnabled(value: boolean): void;
  isPaused(): boolean;
  dispose(): void;
} {
  let enabled = false;
  let paused = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => { clearTimeout(timer); timer = undefined; };
  return {
    activity() {
      if (!enabled) return;
      clear();
      if (!paused) { paused = true; onChange(); }
      timer = setTimeout(() => { timer = undefined; paused = false; onChange(); }, 1000);
    },
    setEnabled(value) {
      enabled = value;
      if (!enabled) {
        clear();
        if (paused) { paused = false; onChange(); }
      }
    },
    isPaused: () => paused,
    dispose() { enabled = false; paused = false; clear(); },
  };
}
