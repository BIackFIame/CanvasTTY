import assert from "node:assert/strict";
import test from "node:test";
import { importWithFakeReact, findAll, tick } from "./helpers/fake-react.mjs";
import { CANVASLINK_ANDROID_RELEASE, canvasLinkInstallPrompt } from "../src/shared/canvasLinkInstall.ts";

const ui = await importWithFakeReact("src/renderer/src/features/settings/CanvasLinkSettings.tsx", "CanvasLinkSettings");
const content = (tree) => findAll(tree, (node) => typeof node.props?.children === "string")
  .map((node) => node.props.children).join("\n");
const button = (tree, label) => findAll(tree, (node) => node.type === "button" && node.props.children === label)[0];

for (const locale of ["ru", "en"]) test(`Android onboarding copies a pinned prompt without session data or host changes (${locale})`, async () => {
  const previousWindow = globalThis.window;
  const copied = [], opened = [], commands = [];
  const pairingCode = "987654";
  globalThis.window = { canvasTTY: {
    canvasLink: {
      state: async () => ({ enabled: true, phase: "streaming", pin: pairingCode,
        expires: Date.now() + 120000, devices: [{ name: "Private test tablet" }] }),
      command: async (action) => { commands.push(action); throw Error("unexpected host mutation"); },
    },
    clipboard: { writeText: (value) => copied.push(value) },
    external: { openUrl: async (value) => { opened.push(value); } },
  } };
  ui.__reset();
  const render = () => ui.__render(ui.CanvasLinkSettings, { locale, open: true });
  try {
    render(); await tick(); ui.__flush();
    let tree = render();
    button(tree, locale === "ru" ? "Скопировать промпт агенту" : "Copy prompt for agent").props.onClick();
    ui.__flush(); tree = render();
    assert.deepEqual(copied, [canvasLinkInstallPrompt(locale)]);
    assert.match(content(tree), locale === "ru" ? /Промпт скопирован/ : /Prompt copied/);
    assert.ok(copied[0].includes(CANVASLINK_ANDROID_RELEASE.url));
    assert.ok(copied[0].includes(CANVASLINK_ANDROID_RELEASE.sha256));
    assert.ok(!copied[0].includes(pairingCode));
    assert.ok(!copied[0].includes("Private test tablet"));
    assert.match(copied[0], /adb -s SERIAL install -r PATH_TO_APK/);
    assert.match(copied[0], /unauthorized/);
    button(tree, locale === "ru" ? "Инструкция и APK" : "Guide and APK").props.onClick();
    assert.deepEqual(opened, [locale === "ru" ? CANVASLINK_ANDROID_RELEASE.guideRuUrl : CANVASLINK_ANDROID_RELEASE.guideUrl]);
    assert.deepEqual(commands, []);
  } finally { ui.__unmount(); globalThis.window = previousWindow; }
});

test("clipboard failure offers the guide without changing Android access", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { canvasTTY: { clipboard: { writeText() { throw Error("clipboard unavailable"); } } } };
  ui.__reset();
  try {
    const props = { locale: "en", open: false };
    const tree = ui.__render(ui.CanvasLinkSettings, props);
    button(tree, "Copy prompt for agent").props.onClick();
    ui.__flush();
    const next = ui.__render(ui.CanvasLinkSettings, props);
    assert.match(content(next), /Could not copy the prompt. Open the installation guide/);
    assert.doesNotMatch(content(next), /Prompt copied/);
  } finally { ui.__unmount(); globalThis.window = previousWindow; }
});
