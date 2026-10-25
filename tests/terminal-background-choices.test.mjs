import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { TERMINAL_BACKGROUND_CATALOG } from "../src/shared/terminalBackground.ts";

const bundle = await build({
  stdin: {
    contents: 'export { TerminalBackgroundChoices, BackgroundPreviewFrame } from "./src/renderer/src/features/settings/TerminalBackgroundChoices.tsx"; export { createElement } from "react"; export { renderToStaticMarkup } from "react-dom/server";',
    resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "ts"
  },
  bundle: true, platform: "node", format: "esm", jsx: "automatic",
  loader: { ".css": "empty" },
  plugins: [{ name: "poster-urls", setup(build) {
    build.onLoad({ filter: /TerminalBackgroundChoices\.tsx$/ }, async ({ path }) => {
      const urls = Object.fromEntries(TERMINAL_BACKGROUND_CATALOG.map(({ id }) => [`../../assets/ascii-posters/${id}.webp`, `/posters/${id}.webp`]));
      const animations = Object.fromEntries(TERMINAL_BACKGROUND_CATALOG.map(({ id }) => [`../../assets/ascii-animations/${id}.webp`, `/animations/${id}.webp`]));
      const source = await readFile(path, "utf8");
      return { contents: source.replace(/import\.meta\.glob<string>\([^;]+\)/g, (expression) => JSON.stringify(expression.includes("ascii-animations") ? animations : urls)), loader: "tsx" };
    });
  } }],
  banner: { js: `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(import.meta.url)});` },
  logLevel: "silent", write: false
});
const { TerminalBackgroundChoices, BackgroundPreviewFrame, createElement, renderToStaticMarkup } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);

test("hover replaces the poster with the animation instead of layering them", () => {
  const still = renderToStaticMarkup(createElement(BackgroundPreviewFrame, { scene: "not-found", playing: false }));
  const live = renderToStaticMarkup(createElement(BackgroundPreviewFrame, { scene: "not-found", playing: true }));
  assert.match(still, /<img /);
  assert.doesNotMatch(still, /<canvas/);
  assert.doesNotMatch(live, /<canvas/);
  assert.equal((live.match(/<img /g) ?? []).length, 1);
  assert.match(live, /src="\/animations\/not-found\.webp"/);
  assert.match(still, /src="\/posters\/not-found\.webp"/);
});

test("the gallery renders only the selected category and opens on the current background's category", () => {
  for (const category of new Set(TERMINAL_BACKGROUND_CATALOG.map((piece) => piece.category))) {
    const pieces = TERMINAL_BACKGROUND_CATALOG.filter((piece) => piece.category === category);
    const html = renderToStaticMarkup(createElement(TerminalBackgroundChoices, {
      locale: "en", value: pieces[0].id, paused: false, favorites: [], onFavoritesChange: () => {}, onChange: () => {}
    }));
    assert.equal((html.match(/class="border-skin-choice"/g) ?? []).length, pieces.length, category);
    assert.equal((html.match(/<img /g) ?? []).length, pieces.length, "every idle card has an immediate poster");
    assert.doesNotMatch(html, /<canvas|terminal-ascii-background/, "idle cards do not create animation renderers");
    assert.doesNotMatch(html, /\stitle=|terminal-background-choice__original/, "cards have no tooltips or duplicate English subtitles");
    assert.equal((html.match(/<option /g) ?? []).length, 16, "every category and favorites remain switchable");
    assert(html.includes(`value="${category}" selected=""`), category);
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1, "only the selected background is highlighted");
    assert(html.includes("terminal-background-disable"), "turning the background off stays compact");
  }
});

test("favorite controls are separate from selecting a scene and expose saved state", () => {
  const html = renderToStaticMarkup(createElement(TerminalBackgroundChoices, {
    locale: "en", value: "aurora-fjord", paused: false,
    favorites: ["aurora-fjord", "donut"], onFavoritesChange: () => {}, onChange: () => {},
  }));
  assert.match(html, /<option value="favorites">Favorites · 2<\/option>/);
  assert.match(html, /class="terminal-background-favorite" aria-pressed="true" aria-label="Remove from favorites:/);
  assert.match(html, /class="terminal-background-favorite" aria-pressed="false" aria-label="Add to favorites:/);
  assert.equal((html.match(/<button\b/g) ?? []).length, (html.match(/<\/button>/g) ?? []).length);
  assert.doesNotMatch(html, /<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
  assert.doesNotMatch(html, /\stitle=/);
});

test("all 217 previews ship as valid local WebP posters", async () => {
  for (const { id } of TERMINAL_BACKGROUND_CATALOG) {
    const data = await readFile(new URL(`../src/renderer/src/assets/ascii-posters/${id}.webp`, import.meta.url));
    assert.equal(data.toString("ascii", 0, 4), "RIFF", id);
    assert.equal(data.toString("ascii", 8, 12), "WEBP", id);
    assert(data.length > 100, id);
    const animated = await readFile(new URL(`../src/renderer/src/assets/ascii-animations/${id}.webp`, import.meta.url));
    assert.equal(animated.toString("ascii", 0, 4), "RIFF", id);
    assert.equal(animated.toString("ascii", 8, 12), "WEBP", id);
  }
});
