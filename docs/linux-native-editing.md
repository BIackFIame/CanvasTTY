# Local Linux native-editor check

This local branch layers keyboard fixes on CanvasTTY PR #103 head
`c61889b0035a67bdd1eed3f95a3d7455df7d2393`. Its optional frontend integration
accepts Linux as well as macOS. The adapted frontend is in the sibling
`codex-macos-tui` checkout, branch `integration/canvastty-linux-native-editing`.
Standard launches without the QA environment variables or bundled frontend keep
using the official CLI.

## Current preparation

- Official Codex 0.159.2 for x86_64 Linux is downloaded in
  `artifacts/codex-native-backend/`; the `codex` symlink targets the extracted
  official executable. The global Codex installation remains unchanged.
- The release archive SHA-256 matches GitHub's asset digest:
  `26586b0d246d41a799b0ef8ee1add370f0fb0721b3709340f28db612381616ea`.
- The Rust frontend has not been built. It requires Rust 1.95.0, which was not
  installed during this preparation. CanvasTTY dependencies have not been
  installed in this worktree.
- No build, test suite, lint, typecheck or application launch was performed.

## Build and start for manual checking

From the adapted frontend checkout:

```sh
cd /home/kosya/vibecoding/codex-macos-tui/codex-rs
rustup toolchain install 1.95.0 --profile minimal
CARGO_PROFILE_DEV_DEBUG=0 rustup run 1.95.0 cargo build --locked -p codex-tui --bin canvastty-codex-tui
```

Prepare CanvasTTY dependencies in this worktree if needed, then start the dev app
with the optional frontend and a separate CanvasTTY profile:

```sh
cd /home/kosya/vibecoding/canvastty-pr103-keyboard
npm ci
PATH="$PWD/artifacts/codex-native-backend:$PATH" \
CANVASTTY_USER_DATA_DIR="$PWD/artifacts/native-tui-profile" \
CANVASTTY_CODEX_TUI_QA=/home/kosya/vibecoding/codex-macos-tui/codex-rs/target/debug/canvastty-codex-tui \
CANVASTTY_CODEX_TUI_LAUNCHER_QA=/home/kosya/vibecoding/codex-macos-tui/macos/codex-tui-launch.mjs \
npm run dev
```

Open a Codex terminal in the dev app. The prefixed PATH lets the provider registry
resolve the isolated official 0.159.2 executable. The existing launcher checks
that backend version before starting its private app-server and patched frontend.
The separate CanvasTTY profile isolates application settings; Codex retains its
normal authentication/config directory.

## Manual behavior to check

1. With two canvas windows present and Codex input focused, Alt+Up reaches the
   CLI instead of switching canvas focus. Alt+arrow still navigates windows when
   the canvas itself has keyboard focus.
2. Enter and Shift+Enter add newlines. Ctrl+Enter submits or queues; Super+Enter
   is an alias when the window manager delivers it. Tab completes without sending.
3. Startup draft Enter/Shift+Enter remain newlines. Trust, resume and approval
   dialogs retain their ordinary confirmation keys.
4. After initialization, Ctrl+A selects multiline/offscreen draft text. Ctrl+C
   copies it; typing, paste and Backspace replace/delete the selection. Large
   pasted content is copied as actual text rather than its placeholder marker.
5. Ctrl+Shift+V pastes text; Ctrl+V retains CLI image paste. Ctrl+C without a
   selection retains interrupt behavior. Ctrl+Shift+F searches terminal output;
   Ctrl+D restarts an exited terminal.
6. Closing/restarting the card releases the owned backend. Resume selection
   opens the expected session with the selected sandbox/approval launch profile.

Whole-draft selection/copy in the provisional startup composer remains restricted
by its existing input owner; this adaptation adds Ctrl+A to the initialized
composer. This limitation should be assessed before the upstream proposal.

After user validation, prepare an upstream Codex PR for the relevant editor and
keymap behavior. Do not publish this local launcher/backend version restriction
as a required dependency of that proposal.

Backend source: [official 0.159.2 release](https://github.com/openai/codex/releases/tag/rust-v0.159.2).
