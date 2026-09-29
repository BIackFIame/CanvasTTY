import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createTerminalBorderSkinPreviewStyleController,
  createTerminalBorderSkinStyleController,
  normalizeTerminalBorderSkinList,
  scopeTerminalBorderSkinCss,
  terminalBorderSkinFallback
} from "../src/renderer/src/lib/skinStyles.ts";

const settingsPanelPath = new URL("../src/renderer/src/features/settings/SettingsPanel.tsx", import.meta.url);
const terminalCardPath = new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url);

function createFakeDocument() {
  const styles = [];
  class FakeStyle {
    attributes = new Map();
    isConnected = false;
    textContent = "";

    setAttribute(name, value) {
      this.attributes.set(name, value);
    }

    replaceWith(next) {
      const index = styles.indexOf(this);
      if (index >= 0) styles[index] = next;
      this.isConnected = false;
      next.isConnected = true;
    }

    remove() {
      const index = styles.indexOf(this);
      if (index >= 0) styles.splice(index, 1);
      this.isConnected = false;
    }
  }

  const documentTarget = {
    createElement: () => new FakeStyle(),
    head: {
      append(style) {
        styles.push(style);
        style.isConnected = true;
      }
    }
  };
  return { documentTarget, styles };
}

const readySkin = (css, revision = "r1") => ({
  id: "custom:aurora",
  name: "Aurora",
  revision,
  status: "ready",
  css
});

test("custom skin settings expose ready and error states and select only ready skins", async () => {
  const skins = normalizeTerminalBorderSkinList([
    { id: "custom:aurora", name: "Aurora", revision: "r1", status: "ready" },
    { id: "custom:broken", name: "Broken", status: "error", error: "Invalid manifest" },
    { id: "custom:bad id", name: "Ignored", revision: "r1", status: "ready" },
    { id: "custom:aurora", name: "Duplicate", revision: "r2", status: "ready" }
  ]);
  assert.deepEqual(skins.map(({ id, status }) => [id, status]), [
    ["custom:aurora", "ready"],
    ["custom:broken", "error"]
  ]);

  const settings = await readFile(settingsPanelPath, "utf8");
  assert.match(settings, /window\.canvasTTY\.skins\.list\(\)/);
  assert.match(settings, /window\.canvasTTY\.skins\.onChanged/);
  assert.match(settings, /aria-pressed=\{value === skin\.id\}/);
  assert.match(settings, /onClick=\{\(\) => skin\.status === "ready" && onChange\(skin\.id\)\}/);
  assert.match(settings, /disabled=\{skin\.status === "error"\}/);
  assert.match(settings, /createTerminalBorderSkinPreviewStyleController/);
  assert.match(settings, /border-skin-preview--custom/);
  assert.match(settings, /data-custom-border-skin=\{skinId\}/);
  assert.match(settings, /CustomTerminalBorderSkinPreview skinId=\{selectedCustomSkinId\} selected/);
  assert.match(settings, /customSkinsLoadState === "loading"/);
  assert.match(settings, /customSkinsLoadState === "error"/);
  assert.match(settings, /borderSkinUnavailable/);
});

test("custom css is card-scoped and malformed styles fail closed", () => {
  const css = scopeTerminalBorderSkinCss(
    ".terminal-card { border-color: teal; } .terminal-card .terminal-card__header, .terminal-card .output { color: white; }",
    "custom:aurora"
  );
  assert.ok(css);
  assert.match(css, /^\.terminal-card\[data-custom-border-skin="custom:aurora"\] \{/);
  assert.match(css, /\.terminal-card\[data-custom-border-skin="custom:aurora"\] \.terminal-card__header/);
  assert.match(css, /\.terminal-card\[data-custom-border-skin="custom:aurora"\] \.output/);
  assert.equal(scopeTerminalBorderSkinCss("@import url(https://example.test/x.css);", "custom:aurora"), null);
  assert.equal(scopeTerminalBorderSkinCss(".terminal-card { background: url(https://example.test/x.png); }", "custom:aurora"), null);
  assert.equal(scopeTerminalBorderSkinCss(".outside { color: red; }", "custom:aurora"), null);
  assert.equal(scopeTerminalBorderSkinCss(".terminal-card { color: red;", "custom:aurora"), null);
  assert.equal(scopeTerminalBorderSkinCss(".terminal-card { color red; }", "custom:aurora"), null);
  assert.equal(scopeTerminalBorderSkinCss(".terminal-card { color: red; }", 'custom:bad"id'), null);
});

test("custom preview css styles its frame, header, and controls only inside its preview scope", async () => {
  const sourceCss = ".terminal-card { border: 3px solid teal; } .terminal-card .terminal-card__header { color: gold; } .terminal-card .terminal-card__actions button { border-color: orange; } .terminal-card .terminal-card__surface { border-top: 1px solid bronze; }";
  const compiled = scopeTerminalBorderSkinCss(sourceCss, "custom:aurora", "preview");
  assert.ok(compiled);
  const previewScope = '.border-skin-preview--custom[data-custom-border-skin="custom:aurora"]';
  assert.ok(compiled.startsWith(`${previewScope} { border: 3px solid teal; }`));
  assert.match(compiled, /\.border-skin-preview--custom\[data-custom-border-skin="custom:aurora"\] \.border-skin-preview__header \{ color: gold; \}/);
  assert.match(compiled, /\.border-skin-preview--custom\[data-custom-border-skin="custom:aurora"\] \.border-skin-preview__actions \.border-skin-preview__action \{ border-color: orange; \}/);
  assert.match(compiled, /\.border-skin-preview--custom\[data-custom-border-skin="custom:aurora"\] \.border-skin-preview__surface \{ border-top: 1px solid bronze; \}/);
  assert.doesNotMatch(compiled, /\.terminal-card(?:\[|\.|:|\s|>|\+|~)/u);
  assert.ok(compiled.split("\n").every((rule) => rule.startsWith(previewScope)));

  const { documentTarget, styles } = createFakeDocument();
  const api = {
    list: async () => [{ id: "custom:aurora", name: "Aurora", revision: "r1", status: "ready" }],
    get: async () => readySkin(sourceCss),
    onChanged: () => () => undefined
  };
  const controller = createTerminalBorderSkinPreviewStyleController(api, documentTarget);
  controller.setActive(["custom:aurora"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(styles.length, 1);
  assert.equal(styles[0].attributes.get("data-terminal-border-skin-preview-style"), "custom:aurora");
  assert.match(styles[0].textContent, /border-skin-preview--custom\[data-custom-border-skin/);
  controller.dispose();
  assert.equal(styles.length, 0);
});

test("the bundled custom skin compiles through the renderer scope", async () => {
  const source = await readFile(new URL("../examples/terminal-skins/foundry-seven/skin.css", import.meta.url), "utf8");
  const compiled = scopeTerminalBorderSkinCss(source, "custom:foundry-seven");
  const previewCompiled = scopeTerminalBorderSkinCss(source, "custom:foundry-seven", "preview");
  assert.ok(compiled);
  assert.ok(previewCompiled);
  assert.match(compiled, /^\.terminal-card\[data-custom-border-skin="custom:foundry-seven"\]/);
  assert.equal((compiled.match(/\.terminal-card\[data-custom-border-skin=/g) ?? []).length, 7);
  assert.match(previewCompiled, /^\.border-skin-preview--custom\[data-custom-border-skin="custom:foundry-seven"\]/);
  assert.match(previewCompiled, /\.border-skin-preview__header/);
  assert.match(previewCompiled, /\.border-skin-preview__actions \.border-skin-preview__action/);
  assert.ok(previewCompiled.split("\n").filter((line) => line.includes("{")).every((rule) => rule.startsWith('.border-skin-preview--custom[data-custom-border-skin="custom:foundry-seven"]')));
});

test("reload atomically replaces good css, preserves it on errors, and cleans up", async () => {
  const { documentTarget, styles } = createFakeDocument();
  const responses = [
    readySkin(".terminal-card { border-color: teal; }", "r1"),
    { id: "custom:aurora", status: "error", error: "Unreadable skin" },
    readySkin(".terminal-card { border-color: plum; }", "r2"),
    { id: "custom:aurora", name: "Aurora", revision: "r3", status: "ready", css: ".terminal-card { color red; }" }
  ];
  let changed;
  let unsubscribed = false;
  const api = {
    list: async () => [{ id: "custom:aurora", name: "Aurora", revision: "r1", status: "ready" }],
    get: async () => responses.shift(),
    onChanged(listener) {
      changed = listener;
      return () => { unsubscribed = true; };
    }
  };
  const controller = createTerminalBorderSkinStyleController(api, documentTarget);
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  controller.setActive("custom:aurora");
  await flush();
  assert.equal(styles.length, 1);
  const lastGood = styles[0];
  assert.match(lastGood.textContent, /border-color: teal/);

  changed();
  await flush();
  assert.equal(styles[0], lastGood);
  assert.match(styles[0].textContent, /border-color: teal/);

  changed();
  await flush();
  assert.equal(styles.length, 1);
  assert.notEqual(styles[0], lastGood);
  assert.match(styles[0].textContent, /border-color: plum/);

  changed();
  await flush();
  assert.match(styles[0].textContent, /border-color: plum/);

  controller.dispose();
  assert.equal(unsubscribed, true);
  assert.equal(styles.length, 0);
});

test("removing an active skin clears its style while invalid edits retain last-good css", async () => {
  const { documentTarget, styles } = createFakeDocument();
  let list = [{ id: "custom:aurora", name: "Aurora", revision: "r1", status: "ready" }];
  let getCalls = 0;
  let changed;
  const api = {
    list: async () => list,
    get: async () => {
      getCalls += 1;
      return readySkin(".terminal-card { border-color: teal; }");
    },
    onChanged(listener) {
      changed = listener;
      return () => undefined;
    }
  };
  const controller = createTerminalBorderSkinStyleController(api, documentTarget);
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  controller.setActive("custom:aurora");
  await flush();
  assert.equal(styles.length, 1);
  assert.match(styles[0].textContent, /border-color: teal/);

  // A present error entry means the directory exists but its latest edit failed.
  // Backend get() continues returning the last-good CSS in this case.
  list = [{
    id: "custom:aurora",
    name: "Aurora",
    revision: "r1",
    status: "error",
    error: "Invalid CSS edit"
  }];
  changed();
  await flush();
  assert.equal(styles.length, 1);
  assert.match(styles[0].textContent, /border-color: teal/);
  assert.equal(getCalls, 2);

  // A registry-level error makes absence ambiguous, so keep the last-good style.
  list = [{ id: "custom:skin-registry", status: "error", error: "Registry unavailable" }];
  changed();
  await flush();
  assert.equal(styles.length, 1);
  assert.equal(getCalls, 2);

  // The backend omits a removed directory from list(), which is positive removal evidence.
  list = [];
  changed();
  await flush();
  assert.equal(styles.length, 0);
  assert.equal(getCalls, 2);
  assert.equal(terminalBorderSkinFallback("custom:aurora"), "classic");

  controller.dispose();
});

test("custom skins fall back to classic while built-in skin ids remain intact", async () => {
  assert.equal(terminalBorderSkinFallback("custom:aurora"), "classic");
  assert.equal(terminalBorderSkinFallback("cyber"), "cyber");
  assert.equal(terminalBorderSkinFallback("classic"), "classic");

  const card = await readFile(terminalCardPath, "utf8");
  assert.match(card, /terminalBorderSkinFallback\(selectedBorderSkin\)/);
  assert.match(card, /data-border-skin=\{borderSkin\}/);
  assert.match(card, /data-custom-border-skin=\{customBorderSkin\}/);
});
