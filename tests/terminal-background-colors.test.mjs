import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({
  stdin: {
    contents: 'export { AsciiTerminalBackground } from "./src/renderer/src/features/terminal/AsciiTerminalBackground.tsx"; export { createElement } from "react"; export { renderToStaticMarkup } from "react-dom/server";',
    resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "tsx",
  },
  bundle: true, write: false, platform: "node", format: "esm", jsx: "automatic", loader: { ".css": "empty" },
  banner: { js: `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(import.meta.url)});` },
  logLevel: "silent",
});
const { AsciiTerminalBackground, createElement, renderToStaticMarkup } =
  await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const props = {
  scene: "basketball-neon", brightness: 75, contrast: 100, saturation: 100,
  paused: true, speed: 1, scale: 100, offsetX: 0, offsetY: 0, live: true,
  pauseOnOutput: false, synchronized: true, outputActivity: { current: null },
};
const render = overrides => renderToStaticMarkup(createElement(AsciiTerminalBackground, { ...props, ...overrides }));

test("default background colours do not enable an extra compositor filter", () => {
  const html = render({});
  assert(!html.includes("filter:"));
  assert(html.includes("opacity:0.75"));
});

test("contrast and saturation affect only the background layer, including paused frames", () => {
  const paused = render({ contrast: 150, saturation: 0 });
  assert(paused.includes('class="terminal-ascii-background"'));
  assert(paused.includes("filter:contrast(150%) saturate(0%)"));
  assert(paused.includes('aria-hidden="true"'));
  assert.equal(render({ contrast: 150, saturation: 0, paused: false }), paused);
  assert(render({ contrast: 0, saturation: 200 }).includes("filter:contrast(0%) saturate(200%)"));
});
