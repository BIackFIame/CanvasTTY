import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// HOME editing hides the whole terminal window layer with CSS
// (`workspace__windows workspace__windows--hidden`, aria-hidden) but the cards stayed mounted
// live: the main process kept delivering terminalData to them and each one kept parsing it
// through xterm even though nothing was drawn. summaryMode already gated the same IPC stream
// (setVisible) for the cheaper reason of being a thumbnail; HOME editing must gate it too.

const terminalCardPath = new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url);
const workspacePath = new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url);

test("the terminalData gate also considers the card's hidden prop, not summary mode alone", async () => {
  const source = await readFile(terminalCardPath, "utf8");
  const setVisibleCall = source.match(/window\.canvasTTY\.terminal\.setVisible\(session\.id,\s*([^)]*)\);/u);
  assert.ok(setVisibleCall, "setVisible call not found");
  assert.match(setVisibleCall[1], /hidden/u, "the visibility gate must factor in the hidden prop");
  assert.match(setVisibleCall[1], /summaryMode/u, "the visibility gate must still factor in summary mode");
});

test("TerminalCard declares a hidden prop and defaults it to visible", async () => {
  const source = await readFile(terminalCardPath, "utf8");
  assert.match(source, /hidden\?:\s*boolean/u, "TerminalCardProps must declare an optional hidden flag");
  assert.match(source, /hidden\s*=\s*false/u, "hidden must default to false so unrelated callers are unaffected");
});

test("WorkspaceCanvas passes homeEditing through to every terminal card as `hidden`", async () => {
  const source = await readFile(workspacePath, "utf8");
  const windowsBlockStart = source.indexOf("workspace__windows--hidden");
  assert.notEqual(windowsBlockStart, -1, "the hidden window layer class was not found");
  const cardStart = source.indexOf("<TerminalCard", windowsBlockStart);
  const cardEnd = source.indexOf("/>", cardStart);
  const cardProps = source.slice(cardStart, cardEnd);
  assert.match(cardProps, /hidden=\{homeEditing\}/u,
    "the terminal card inside the CSS-hidden window layer must receive hidden={homeEditing}");
});
