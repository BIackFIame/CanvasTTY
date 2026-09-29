# Installing, releases, and local data

[English](installing-and-security.md) · [Русский](installing-and-security.ru.md) · [简体中文](installing-and-security.zh-CN.md) · [Docs home](README.md)

## User-facing packages

Each `v*` tag starts native GitHub-hosted builds for all three operating systems:

| Platform | Artifacts | Notes |
|:--|:--|:--|
| Linux x86_64 | AppImage, deb | AppImage is a single-file package and requires a FUSE 2 compatibility library (`libfuse2t64` on Ubuntu 24.04); deb integrates with Debian-family desktops |
| Windows x64 | NSIS installer, portable executable | The installer allows choosing a directory and creates Start Menu/Desktop shortcuts |
| macOS arm64 (Apple Silicon) | dmg, zip | Both contain the graphical `.app` bundle; Intel/x64 builds are not included |

Download artifacts only from the repository's [GitHub Releases](https://github.com/howdeploy/CanvasTTY/releases) page. Starting with `1.2.4`, macOS bundles are ad-hoc signed and pass strict `codesign` verification before upload. This verifies bundle integrity but does not provide a Developer ID identity or Apple notarization, so Gatekeeper may require Finder → Open or Privacy & Security → Open Anyway. Windows packages remain unsigned and may trigger SmartScreen. macOS artifacts from `1.2.2` and `1.2.3` predate this signature fix; use `1.2.4` or later. Verify the release tag and artifact name before acknowledging any warning.

## What the distributable contains

`electron-builder.yml` uses an explicit allowlist: production bundles under `out/`, `package.json`, the MIT `LICENSE`, and required production dependencies. Source docs, `.env`, local agent/planning folders, logs, settings, credentials, and release workspace files are not copied into the packaged application.

`node-pty` is rebuilt on the matching GitHub runner, so Linux, Windows, and macOS packages receive a native module for their own operating system. A package from one OS is never relabeled as another OS build.

## Local-only user data

| Data | Location and lifetime |
|:--|:--|
| CanvasTTY settings | Electron's per-user `userData` directory (`~/.config/canvastty` on typical Linux desktops, `%APPDATA%\canvastty` on Windows, `~/Library/Application Support/canvastty` on macOS) |
| Provider credentials | The local credential store owned by the installed Codex, Claude, Qwen Code, Kimi, OpenCode, Hermes, or Grok Build CLI; CanvasTTY does not copy it |
| Temporary provider browser bridge | Kimi fallback and Hermes MCP entries are journaled, scoped to owning CanvasTTY sessions, and restored on final PTY exit or recovered after an interrupted launch; capability secrets are never written as literals |
| PTY scrollback | Bounded main-process memory for the live app session; not saved in the repository |
| Home media | The user's original local file; settings retain only its local path |
| Runtime plugins | Static packages and the enabled registry below `userData/plugins`; isolated JSON storage below `userData/plugin-storage` is capped at 64 KB per plugin and removed on uninstall |
| Plugin secrets | Encrypted blobs below `userData/plugin-secrets`; plaintext is available only to the owning enabled plugin through permission-gated calls, storage fails closed without protected OS encryption, and the file is removed on uninstall |
| Plugin media grants | `userData/plugin-media-libraries.json`; stores the absolute paths of folders explicitly selected by the user and removes a plugin's grants on uninstall |
| Plugin playlists | A plugin with confirmed write permission may create bounded files only below the selected library's `Playlists/` directory |
| Built-in browser profile | Cookies, cache, and site storage in the persistent `canvastty-browser` Electron partition; the browser is available from HOME in `1.0.2` |
| Browser restore state | Safe HTTP(S) tab URLs, tab order, and active-tab ID in `userData/browser-state.json`; disabled/cleared when tab restore is turned off |
| Browser audit log | Redacted hash-chain JSONL below `userData/browser/audit`; the active file rotates at 100 MB and rotated files older than 30 days are pruned during store initialization or rotation |
| Other logs | Local stdout/stderr only; CanvasTTY has no remote log collector or project-operated telemetry endpoint |

Exact `userData` paths may vary with OS configuration. CanvasTTY asks Electron for the correct per-user directory and never uses the source checkout as runtime storage.

## Credential boundary

Provider credentials are read only in the trusted main process when a source-backed quota request needs them. They are sent only to that provider's matching endpoint, are not logged, are not persisted by CanvasTTY, and never cross the typed preload bridge. Kimi's loopback usage token remains in process memory and its child stderr is discarded.

Sanitized percentages, window metadata, timestamps, and explicit unavailable reasons may cross IPC. Raw provider responses, bearer headers, cookies, and credential files may not. Runtime-plugin secrets are a separate opt-in boundary: they cross only the owning sandbox's request path when its manifest declares `secrets` and are encrypted at rest through Electron `safeStorage`.

## Agent protection layers

Agents work in their own mode; CanvasTTY's layers sit outside it as a quiet safety net that adds no prompts for ordinary work in the project and stops what is dangerous, with a short reason the agent can act on.

**Launch modes.** Auto (the default), Manual, Accept edits, Plan and Bypass, offered only where the CLI supports them. Auto is the CLI's own auto mode where it has one (Claude Code's classifier, Codex's reviewer, Grok's classifier), CanvasTTY's per-run rules for OpenCode (your own deny and ask rules still win), and for a CLI without one its approval bypass, only inside agent isolation. Bypass is the person's choice per CLI, acknowledged once, checked in the main process, never given to a subagent, and still inside the layers below. In Manual the CLI follows its own configuration; when that configuration skips approvals, the card says so.

| Layer | Guarantees | Does not guarantee |
| --- | --- | --- |
| The agent's own permission system | What its CLI promises in the chosen mode (Claude Code, Codex, OpenCode, Grok…). | Anything the CLI's own classifier or reviewer lets through. |
| Base protection (hooks) | Denies elevation, pipes into a shell, disk commands, fork bombs, writes and deletes outside the project and access to CanvasTTY's private data, before the tool call runs, for agents whose CLI has hooks (Claude Code, Codex, Qwen Code, OpenCode). A decision plugin's "ask" is shown by Claude Code; for a CLI that cannot ask it is a deny with the reason. | It reads commands; code that hides what it does, or a CLI without hooks, is not covered. It is a guard, not a sandbox. |
| Delegation rules | A subagent never gets more than its orchestrator (never YOLO), works only in its orchestrator's project folder, within the depth and count limits the person set; orchestrators get a control connection of their own; no agent-facing tool changes settings, protection, profiles, trust or isolation; plugin launch options from an agent only where the plugin declared them delegable. | What a plugin the person trusted does with its own permissions. |
| Agent isolation (OS layer) | On macOS (sandbox-exec) and Linux (bubblewrap), for subagents, plugin-started agents and every agent not in Manual: the whole process tree writes only in the project, its own temporary folder and its CLI's own folders; keys, other CLIs' credentials and CanvasTTY's tokens are unreadable; no other process, app, Apple event, preference write, launchd job or foreign Unix socket (Docker, tmux, SSH agent) is reachable. Fails closed. | Network is not restricted. Linux cannot filter Unix sockets, only hide the user runtime folder. The CLI's own sandbox cannot run inside the layer on macOS, so it is switched off there (approvals unchanged) and commands can use the network. A Claude launch may rewrite the login keychain file to save a refreshed sign-in, so it could also damage that file (other items stay behind their own access lists). Windows has no layer yet: subagents run in Manual there unless the person turns isolation off. |

## Repository guards

```bash
npm run audit:secrets
npm test
```

The audit checks high-confidence provider/cloud token formats, private-key blocks, hard-coded secret assignments, sensitive filenames, and personal absolute home paths. Repository metadata names are excluded before file-type inspection, so both a normal-clone `.git/` directory and a linked-worktree `.git` file are ignored without weakening personal-path detection in publishable files. `.gitignore` excludes local agent context, planning data, env files, credentials, logs, settings, dependencies, and generated packages. CI runs the audit before build and every release job runs it again before packaging.

No scanner is perfect. Never commit a live secret “temporarily.” If one reaches Git history, revoke it first, then purge the history before making the repository public.

## Build packages locally

```bash
npm install
npm run package
```

`npm run package` creates an unpacked app for the current OS. Platform scripts create installers:

```bash
npm run package:linux
npm run package:win
npm run package:mac
```

Run each platform script on its matching operating system. Cross-compilation is not treated as proof of compatibility because `node-pty` is native.

## Release checklist

1. Confirm `package.json` and the tag use the same semantic version.
2. Run secret audit, tests, typecheck, production build, and a current-OS package build.
3. Inspect the real packaged app and verify the package-content allowlist.
4. Push `vX.Y.Z`; wait for all three GitHub Actions package jobs.
5. Treat the automatically created release as a prerelease until real-device checks pass on Linux, Windows, and macOS.

Browser storage, agent access, and audit retention are documented in [Built-in browser and audit log](browser.md). Security reports follow the repository [security policy](../SECURITY.md).
