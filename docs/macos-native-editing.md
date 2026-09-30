# macOS native editing proposal

This proposal lets macOS users edit a Codex draft with the usual Command keys
without assigning unrelated terminal keys to canvas actions.

## Keyboard and clipboard behavior

When a terminal or editable field has focus, its native keyboard handler receives
keys such as F2 and Home. F2 can therefore open the CLI's error report without
also renaming the canvas window. Existing canvas shortcuts still work when the
canvas has focus. This focus rule applies on macOS only.

- Command+C copies an xterm output selection. With no output selection in a
  Codex terminal, it sends Super+C to the draft editor.
- Command+V pastes text through xterm's bracketed-paste support. An image in the
  native clipboard instead sends Control+V so a CLI supporting image paste can
  read it. An asynchronous clipboard read is discarded if its terminal was
  closed, exited or restarted before the read completed.
- Command+A sends Super+A to the Codex draft editor. It selects the whole draft
  with the optional frontend below, including lines outside the viewport; it
  does not select terminal scrollback.
- Command+A in ordinary application inputs, textareas and contenteditable fields
  keeps native field selection. Physical key codes also support non-Latin
  keyboard layouts. Additional modifier combinations keep their existing path.

## Optional Codex frontend

**Stock Codex 0.159.2 does not implement whole-draft selection.** The renderer
bridge alone cannot provide it. The demonstrated implementation is a separate
[Codex TUI frontend](https://github.com/mrcertis/codex-macos-tui/tree/d8f7729bb529a88f611239c4e85807db80d0bc34/macos)
based on official Codex `rust-v0.159.2`. Its launcher requires official
`codex-cli 0.159.2` as the backend and refuses other backend versions.

CanvasTTY continues resolving the official CLI from its existing provider
registry. An optional macOS bundle can include these resources:

```text
Contents/Resources/codex-native-tui/
  canvastty-codex-tui
  codex-tui-launch.mjs
  LICENSE
```

Both frontend and launcher must be present; a partial bundle gives an explicit
launch error. With neither resource present, the usual CLI launch is used. The
standard build does not download or include the external frontend automatically.
The [build and packaging recipe](https://github.com/mrcertis/codex-macos-tui/blob/d8f7729bb529a88f611239c4e85807db80d0bc34/macos/README.md#canvastty-170-integration)
uses adjacent CanvasTTY and Codex checkouts. On this branch, skip its `git apply`
steps because the integration is already applied. The recipe has been exercised
on Apple Silicon; Intel packaging remains unverified.

For local development, `CANVASTTY_CODEX_TUI_QA` and
`CANVASTTY_CODEX_TUI_LAUNCHER_QA` accept absolute frontend and launcher paths on
macOS. The launcher owns a private local app-server process and cleans up that
process on exit. It preserves interactive approval, sandbox, config and resume
flags. It rejects positional initial prompts and CLI image arguments; image
paste remains interactive. It does not replace the installed official CLI or
change global Codex configuration. Porting to another backend version requires
updating and testing the frontend and launcher together.

The optional frontend's selection and launcher tests live in its linked
repository. A maintainer decision on distribution and ongoing version support
is needed before including that frontend in official CanvasTTY releases.

## Launch-scoped browser configuration

Codex launches carrying inline config use `--no-daemon` so each launch receives
its own browser capability rather than reusing a daemon's earlier configuration.
A successfully spawned PTY retains its unused browser capability while the user
is in a trust dialog or resume picker. Exit, close and failed-spawn cleanup still
revoke the capability; standalone unused capabilities keep their existing TTL.
Identity, one-time token use and reconnection checks remain in place.

## Regression checks

```sh
node --test tests/terminal-shortcuts.test.mjs tests/app-shortcuts.test.mjs \
  tests/canvas-navigation-override.test.mjs tests/terminal-lifecycle.test.mjs \
  tests/terminal-launch.test.mjs tests/orchestration-launch-role.test.mjs \
  tests/agent-browser-protocol-gateway.test.mjs
npm test
npm run test:even
npm run typecheck
npm run build
npm run audit:secrets
```

The checks cover modifier/layout routing, clipboard reads across session
changes, bundle resolution and delayed browser handshakes. Complete draft
selection also needs verification in the separately built frontend. GUI checks
should type and edit drafts without submitting them.
