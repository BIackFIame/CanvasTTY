import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { BACKGROUND_APPEARANCE_DEFAULTS } from "../src/shared/terminalBackgroundAppearance.ts";

const bundle = await build({
  stdin: {
    contents: 'export { TerminalBackgroundPreview, backgroundPreviewViewport } from "./src/renderer/src/features/settings/TerminalBackgroundPreview.tsx"; export { createElement } from "react"; export { renderToStaticMarkup } from "react-dom/server";',
    resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "tsx",
  },
  bundle: true, write: false, platform: "node", format: "esm", jsx: "automatic",
  loader: { ".css": "empty", ".svg": "text", ".png": "dataurl", ".ico": "dataurl", ".webp": "dataurl" },
  banner: { js: `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(import.meta.url)});` },
  logLevel: "silent",
});
const { TerminalBackgroundPreview, backgroundPreviewViewport, createElement, renderToStaticMarkup } =
  await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const render = (appearance, rest = {}) => renderToStaticMarkup(createElement(TerminalBackgroundPreview, {
  appearance: { ...BACKGROUND_APPEARANCE_DEFAULTS, ...appearance }, locale: "ru", active: true, synchronized: true, ...rest,
}));

test("preview supports real window dimensions and wide, square and tall viewport geometry", () => {
  assert.deepEqual(backgroundPreviewViewport("terminal", { width: 800, height: 500 }), { width: 800, height: 500 });
  assert.deepEqual(backgroundPreviewViewport("wide"), { width: 960, height: 540 });
  assert.deepEqual(backgroundPreviewViewport("square"), { width: 720, height: 720 });
  assert.deepEqual(backgroundPreviewViewport("tall"), { width: 540, height: 900 });
  assert.deepEqual(backgroundPreviewViewport("terminal", { width: 0, height: 0 }), { width: 240, height: 160 });
});

test("preview renders the selected background with current colour controls and text readability", () => {
  const html = render({ terminalBackground: "glock-spin", terminalBackgroundBrightness: 80,
    terminalBackgroundContrast: 150, terminalBackgroundSaturation: 0, terminalBackgroundReadabilityStrength: 35 });
  assert(html.includes("terminal-ascii-background"));
  assert(html.includes("opacity:0.8"));
  assert(html.includes("filter:contrast(150%) saturate(0%)"));
  assert(html.includes("--terminal-text-backdrop-strength:0.35"));
  assert(html.includes("terminal-background-live-preview__surface--readable"));
  assert(html.includes("Пример текста"));
  assert(!render({ terminalBackgroundReadability: false }).includes("terminal-background-live-preview__surface--readable"));
});

test("no-background preview stays usable and pause demonstration is enabled only when applicable", () => {
  const empty = render({});
  assert(!empty.includes('class="terminal-ascii-background"'));
  assert(empty.includes("Выберите фон в каталоге."));
  assert(empty.includes("disabled="));
  const enabled = render({ terminalBackground: "glock-spin", terminalBackgroundPauseOnOutput: true });
  assert(!enabled.includes("disabled="));
  assert(render({ terminalBackground: "glock-spin", terminalBackgroundPauseOnOutput: true, terminalBackgroundPaused: true }).includes("disabled="));
  assert(render({ terminalBackground: "glock-spin", terminalBackgroundPauseOnOutput: true }, { active: false }).includes("disabled="));
});
