# Terminal renderer transition check

For Windows hotfix verification, also check a new terminal and Codex's hook-review menu before any conversation starts. Resize the card repeatedly, switch its DOM/WebGL renderer by zooming across 1x, then restart and restore the card. Old menu rows must not remain over the current menu. Repeat with a plain PowerShell terminal and a non-pixel theme. `scripts/smoke-windows-terminal.mjs` checks the packaged ConPTY runtime and three resize/redraw cycles without opening a window or launching a real agent; it does not verify GPU pixels.

The terminal card keeps a short DOM snapshot while xterm switches between its DOM and WebGL renderers. Use this manual check when changing renderer lifecycle code.

1. Start CanvasTTY with a clean or disposable profile and open a terminal card.
2. Produce continuous output in the card, for example `yes renderer-check` followed by `Ctrl-C`.
3. Zoom or resize the canvas across the WebGL eligibility boundary several times. The transition should reveal the new renderer with a short fade and should not leave a stale frame over the live terminal.
4. Start another burst of output, hide the CanvasTTY window or switch applications before the fade completes, then restore the window. The snapshot must be gone and the newest terminal output must be visible immediately; no old frame may cover it.
5. Repeat the hide/restore step while the card is switching renderer and while several terminal cards are visible. Check that other cards keep rendering and that selection and pinned input still work.

The automated coverage is in `tests/terminal-renderer-transition.test.mjs`. It exercises the normal render-to-paint path, the cleanup deadline when rendering or animation frames stop, document visibility cleanup, teardown in each transition phase, and reduced-motion behavior. The manual steps above remain necessary for the compositor-visible hide/restore result.
