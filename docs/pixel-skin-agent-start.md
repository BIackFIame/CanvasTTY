# Create a CanvasTTY pixel theme with an agent

This is the starting point for an agent with no prior CanvasTTY context. Give the agent [the design-kit repository](https://github.com/teo-nex/CanvasTTY-design-for-agents) or [its offline ZIP](https://github.com/teo-nex/CanvasTTY-design-for-agents/raw/refs/heads/main/CanvasTTY_Agent_Theme_Kit_v1.zip), plus a visual reference. The deliverable is a separate **install ZIP**, not the source-kit ZIP. Read [the full pack specification](pixel-skin-packs.ru.md) and confirm the current contract in `src/main/services/PixelSkinPackRegistry.ts` before generating art.

## Inputs and output

- Input: a visual reference or a written art direction, plus optional theme name. The reference is not a ready-to-import frame unless it satisfies the requirements below.
- Output: one ZIP containing **exactly ten final PNG files**. The nine frame files are `minimal_idle.png`, `minimal_working.png`, `minimal_completed.png`, `detailed_idle.png`, `detailed_working.png`, `detailed_completed.png`, `master_idle.png`, `master_working.png`, and `master_completed.png`. The tenth is `background.png`.
- A single containing folder is permitted, but there must be exactly one file for each name. Do not include drafts, alternate versions, nested source/output copies, instructions, or `apertures.json` in the install ZIP. A separate source kit is optional.
- Use `completed`, **not** `done`, in filenames. Completed covers a finished agent turn, whether it succeeded or failed.

## Artwork contract

1. Make all nine frames 1536 x 1024 px, PNG RGBA, on the same 3:2 canvas. Keep exterior geometry fixed across levels and states. Do not shift, crop, or rotate the frame between states.
2. The terminal output is live UI underneath the art. Leave a transparent central opening large enough for readable text. Do not bake terminal text, a black terminal panel, the cursor, title, controls, or screenshots into the image. Keep the top-right button plaque clear for native search and close buttons.
3. `minimal` is restrained; `detailed` adds visible decoration; `master` is a distinct, richer F4 view. Every level has three **visually distinguishable** states: calm `idle`, active `working`, and resolved `completed`. Maintain identical geometry within a level. Do not represent state solely with a barely visible dot or a tiny color change.
4. `background.png` is separate wallpaper for the canvas. It is not a replacement for the transparent terminal opening. Do not duplicate it under source and output paths in the install ZIP.
5. For each level report `left`, `right`, `top`, and `bottom` aperture insets as percentages of the full 1536 x 1024 frame. Check that all three states of that level use the same safe opening. The user can enter these values in the import dialog; an agent can pass them in a separate `apertures.json` via `skin-install --apertures`. Do not assume the ZIP auto-configures apertures.

## Build and verify

1. Inspect the reference and decide the level/state differences before rendering. Generate or edit the art, then examine all ten final images at their actual resolution. Inspect a contact sheet too, to catch geometry drift and indistinguishable states.
2. Package only the final ten PNGs. Validate the archive from the repository root:

   ```sh
   node scripts/validate-pixel-skin-zip.mjs /absolute/path/theme-install.zip
   ```

   This invokes the same ZIP importer as CanvasTTY in an isolated temporary profile. It checks the exact file set and new-theme frame dimensions. A successful structural check does **not** prove the art looks good.
3. Compare the nine frames overlaid, check the transparent opening and button plaque, and preview with live terminal text in CanvasTTY when possible. Report any visual check that could not be done.
4. Deliver the install ZIP, a small preview/contact sheet, the three aperture presets, and a concise description of what changes in each state. Say whether the theme was actually installed and tested in the app; do not infer that from ZIP validation.

For agent-driven installation in a running CanvasTTY instance, see [the local Agent Control commands](pixel-skin-packs.ru.md#установка-агентом). Installing or changing a theme affects the current user's app; verify the target instance and preserve other installed themes.
