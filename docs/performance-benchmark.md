# Runtime benchmark

`scripts/bench-runtime.mjs` measures what CanvasTTY costs while it runs: memory and CPU of the built app,
and the main-process hot paths that grow with the number of cards. Use it before and after a change that
touches terminal output, the canvas, orchestration, redaction or the Even G2 companion.

```sh
npx electron-vite build                 # the app scenarios measure out/
node scripts/bench-runtime.mjs          # 3 runs, medians
node scripts/bench-runtime.mjs --runs 1 --micro-only
node scripts/bench-runtime.mjs --runs 1 --pan-only    # cards and the pan only, about 30 s
node scripts/bench-runtime.mjs --terminals 8 --kbps 1024 --flood-seconds 20 --json bench.json
```

Every run gets its own temporary `HOME` (with `GROK_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and the XDG
folders inside it), userData and working folder, removed afterwards. The app runs from `out/` through a
small harness in `scripts/bench-runtime/app/`: its windows are created hidden, off-screen and unfocusable,
native dialogs are answered locally, `safeStorage` is off and `/usr/bin/security` is refused, so a run never
shows a window, takes focus or touches the keychain. Temporary folders go under `/tmp` (or `BENCH_TMPDIR`)
because the app's Unix sockets live in userData and macOS caps a socket path at 104 bytes.

## App scenarios

| Scenario | What happens | Reported |
| --- | --- | --- |
| idle | 8 s after the workspace is ready, 10 s window | RSS per process kind, CPU % per kind |
| terminals | N plain terminal cards (`--terminals`, default 8), 8 s settle, 10 s window | same |
| flood | every card runs `scripts/bench-runtime/flood.mjs` at `--kbps` KB/s (default 1024) | same, peak RSS, MB of `terminal:data` sent to the renderer |
| after | 10 s after the flood ended, 5 s window | same |
| pan | a middle-button drag of 300 moves, 16 ms apart, over the N cards | React commits, components rendered with new props per move, TerminalCard renders per move, renderer main-thread ms per move (script, style, layout, all tasks, from the DevTools Performance domain), the most rendered components, renderer CPU % |

CPU % is per process kind, of one core, from the kernel's per-process CPU time (`ps`) over the window.
"pty" is the shells and whatever runs in them (the flood generators included); "electron" is the app itself.
Component renders are counted by a minimal React DevTools hook the harness installs in the page; it needs no
component names, so a minified build counts the same way.

## Micro-benchmarks

`scripts/bench-runtime/micro.mjs` runs in plain Node against `src/` with fake PTYs:

| Key | Meaning |
| --- | --- |
| `scrollbackRetainedChars` | characters the scrollback chunk array still references after 2 MB of output in 1/4/16 KB chunks (the ring keeps 240 000) |
| `visibleResendBytes8Cards` | bytes sent to the renderer when 8 hidden cards with full scrollback become visible after 1 KB more output each |
| `orchestratorToolCallMs`, `orchestratorToolCallAllocatedBytes` | one `observe_agent` call (ownership check, status, observation) on a canvas of 20 agent cards with full scrollback |
| `observeAgentMs`, `listAgentsMs` | `observe_agent` and `list_agents` alone |
| `evenG2FeedMs`, `evenG2HeadlessTerminals` | Even G2 companion on, 8 cards stream 512 KB each while the glasses show one |
| `kimiFirstLaunchBlockMs` | how long the first Kimi launch blocks the main thread when the CLI takes 1 s to answer `--help` |

The report prints medians; `--json` also keeps every run.
