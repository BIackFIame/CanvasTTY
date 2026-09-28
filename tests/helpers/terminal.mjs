// Shared stand-ins for TerminalManager tests: a provider CLI registry where every
// CLI resolves, and a PTY spawner that records its calls instead of starting a process.

/** Every provider resolves to `/resolved/<provider>`, frozen like the real registry's answers. */
export function availableRegistry() {
  return {
    get(provider) {
      return Object.freeze({
        state: "available",
        provider,
        executable: `/resolved/${provider}`,
        launcher: "native",
        environment: Object.freeze({ PATH: "/resolved:/usr/bin" }),
        checked: Object.freeze([{ path: `/resolved/${provider}`, result: "selected" }])
      });
    },
    snapshot() {
      return {};
    }
  };
}

/**
 * A PTY spawner that pushes `{ command, args, options, process }` to `calls` and
 * returns a fake PTY: `emitData`/`emitExit` drive its listeners, `lastResize`
 * holds the last size, and `onWrite(data, options)` sees what was written.
 */
export function fakeSpawner(calls, { pidBase = 20_000, onWrite } = {}) {
  return (command, args, options) => {
    let dataListener = () => undefined;
    let exitListener = () => undefined;
    const process = {
      pid: pidBase + calls.length,
      process: command,
      lastResize: null,
      write(data) { onWrite?.(data, options); },
      resize(cols, rows) { process.lastResize = { cols, rows }; },
      kill() {},
      pause() {},
      resume() {},
      onData(listener) {
        dataListener = listener;
        return { dispose() {} };
      },
      onExit(listener) {
        exitListener = listener;
        return { dispose() {} };
      },
      emitData(data) { dataListener(data); },
      emitExit(exitCode) { exitListener({ exitCode, signal: 0 }); }
    };
    calls.push({ command, args, options, process });
    return process;
  };
}
