import assert from "node:assert/strict";
import test from "node:test";
import { animatedBackgroundAgentPrompt } from "../src/renderer/src/features/settings/animatedBackgroundPrompt.ts";

test("animatedBackgroundAgentPrompt generates complete instructions for all 3 styles in Russian", () => {
  // 1. Fine dots
  const promptFine = animatedBackgroundAgentPrompt({
    style: "fine-dots",
    title: "Неоновый дождь",
    sourceUrl: "https://www.youtube.com/watch?v=sample123",
    locale: "ru",
  });
  assert.match(promptFine, /Название: "Неоновый дождь"/);
  assert.match(promptFine, /ID фона: "neonovyy-dozhd"/);
  assert.match(promptFine, /FINE DOTS/);
  assert.match(promptFine, /256 масок Брайля/);
  assert.match(promptFine, /ПОЛНЫЙ ХРОНОМЕТРАЖ/);
  assert.match(promptFine, /src\/renderer\/src\/vendor\/ascii-rest\/data\/neonovyy-dozhd\.json/);
  assert.match(promptFine, /src\/renderer\/src\/vendor\/ascii-rest\/pieces\/neonovyy-dozhd\.js/);
  assert.match(promptFine, /node \.\.\/prepare-copy\.mjs/);

  // 2. Dot matrix
  const promptDot = animatedBackgroundAgentPrompt({
    style: "dot-matrix",
    title: "Cyber Sunset",
    sourceUrl: "/tmp/test/clip.mp4",
    locale: "ru",
  });
  assert.match(promptDot, /DOT MATRIX/);
  assert.match(promptDot, /200, rows: 100/);
  assert.match(promptDot, /матрицей Байера 4×4/);

  // 3. Classic ASCII
  const promptAscii = animatedBackgroundAgentPrompt({
    style: "classic-ascii",
    title: "Matrix Code",
    locale: "ru",
  });
  assert.match(promptAscii, /CLASSIC ASCII/);
  assert.match(promptAscii, /рампа плотности/);
});

test("animatedBackgroundAgentPrompt generates English instructions", () => {
  const promptEn = animatedBackgroundAgentPrompt({
    style: "fine-dots",
    title: "Cyber City",
    sourceUrl: "https://tenor.com/view/sample",
    locale: "en",
  });
  assert.match(promptEn, /Create a new animated terminal background/);
  assert.match(promptEn, /FINE DOTS/);
  assert.match(promptEn, /FULL TIMELINE/);
  assert.match(promptEn, /prepare-copy\.mjs/);
});
