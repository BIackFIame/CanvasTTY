# Security policy

[English](SECURITY.md) · [Русский](SECURITY.ru.md) · [简体中文](SECURITY.zh-CN.md)

## Supported version

CanvasTTY `1.0.2` is the current release and the only line receiving fixes. Its unsigned cross-platform packages require additional platform warnings to be acknowledged.

## Reporting a vulnerability

Do not publish credentials, terminal history, private paths, or exploit details in a public issue.

Use the repository's **Security → Report a vulnerability** flow when private vulnerability reporting is available. If it is not available, open a public issue containing only a short non-sensitive request for a private contact channel.

Include the CanvasTTY version, operating system, affected flow, impact, and minimal reproduction steps. Replace real tokens, usernames, home directories, project names, prompts, and terminal output with synthetic values.

## Data boundary

- Provider credentials remain in each provider CLI's local credential store. CanvasTTY reads them only inside the trusted Electron main process and does not copy them into project files or settings.
- CanvasTTY settings are stored below Electron's per-user `userData` directory.
- PTY scrollback is held in bounded process memory and is not committed to the repository.
- CanvasTTY has no project-operated telemetry endpoint and does not upload application logs.
- Provider usage requests go only to the matching provider adapter; sanitized limit snapshots cross IPC, never raw responses or credentials.
- Runtime plugins are static GitHub packages stored below `userData/plugins`. CanvasTTY does not execute their repository scripts or expose Node.js. Plugin UI runs in sandboxed frames/windows and receives only the permissions confirmed during install. A plugin is still third-party code: inspect its source and requested `network`/`external:open`/`browser:open` capabilities before installing it.
- Plugin storage is isolated by plugin ID below `userData/plugin-storage`, capped at 64 KB, and is removed on uninstall. Session access excludes PTY buffers and working directories.
- Plugin media grants are stored in `userData/plugin-media-libraries.json`. They contain selected absolute folder paths and are removed when the owning plugin is uninstalled. A plugin with playlist write permission may create bounded files inside the selected library's `Playlists/` directory.
- The built-in browser is available from HOME in `1.0.2` and uses the persistent `canvastty-browser` Electron partition for cookies, cache, and site storage. Remote pages are sandboxed without Node.js or CanvasTTY preload; navigation is limited to HTTP(S), and cookies, passwords, authorization headers, local storage, arbitrary JavaScript, and raw CDP are not exposed to agents. Browser data remains local below Electron `userData` unless a visited website transmits it.
- Browser commands are recorded in a redacted local hash-chain audit below `userData/browser/audit`. The active file rotates at 100 MB; rotated files older than 30 days are pruned during initialization or rotation. Typed/page text, screenshots, credentials, URL queries/fragments, headers, cookies, and tokens are not stored. The browser-data clearing control deliberately leaves this audit evidence intact.
- The opt-in [Web companion](docs/mobile-companion.md) binds the companion HTTP listener to `127.0.0.1:3481` when configured with an exact Tailscale `https://<device>.<tailnet>.ts.net` origin. Use Tailscale Serve (tailnet access), never Funnel (public access). Desktop-approved SRP pairing and per-session grants still apply; browser clients have no filesystem or desktop-browser API. Terminal input can execute commands as the host user. Browser pairing credentials in localStorage are sensitive to scripts at that origin and anyone with access to an unlocked device/profile: use trusted devices and revoke compromised pairings. Tailscale Serve configuration and tailnet membership are managed outside CanvasTTY; turning off the listener does not remove the Serve mapping.

The repository runs `npm run audit:secrets` in CI and before packaging. This is a guardrail, not a reason to commit a secret temporarily: if a real secret ever reaches Git history, revoke it immediately and rewrite/purge the affected history before publishing.
