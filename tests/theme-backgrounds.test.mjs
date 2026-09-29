import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const BUNDLED_THEMES = ["sakura", "matrix", "forest-cabin", "gold-black", "cat", "gothic-eclipse"];

test("verify bundled theme background PNGs exist and have correct signature and dimensions", () => {
  const backgroundsDir = path.resolve("src/renderer/src/assets/theme-backgrounds");

  for (const theme of BUNDLED_THEMES) {
    const filePath = path.join(backgroundsDir, `${theme}.png`);
    assert.ok(fs.existsSync(filePath), `${theme}.png should exist in repo`);

    const buf = fs.readFileSync(filePath);
    assert.ok(buf.length > 24, `${theme}.png should have valid size`);

    // Verify 8-byte PNG signature: 89 50 4E 47 0D 0A 1A 0A
    const expectedSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < expectedSignature.length; i++) {
      assert.equal(buf[i], expectedSignature[i], `Byte ${i} of ${theme}.png should match PNG signature`);
    }

    // Verify IHDR chunk header (bytes 12-15: "IHDR")
    assert.equal(buf.toString("ascii", 12, 16), "IHDR", `${theme}.png must contain IHDR chunk`);

    // Verify dimensions 1536x1024 from IHDR chunk (width at offset 16, height at offset 20, 32-bit big-endian)
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    assert.equal(width, 1536, `${theme}.png width should be 1536 (got ${width})`);
    assert.equal(height, 1024, `${theme}.png height should be 1024 (got ${height})`);
  }
});

test("verify appSkins.css defines rules for all bundled themes", () => {
  const cssPath = path.resolve("src/renderer/src/styles/appSkins.css");
  const css = fs.readFileSync(cssPath, "utf8");

  for (const theme of BUNDLED_THEMES) {
    assert.match(
      css,
      new RegExp(`\\[data-theme-background="${theme}"\\]`),
      `appSkins.css should have rule for [data-theme-background="${theme}"]`
    );
    assert.match(
      css,
      new RegExp(`url\\(["']?\\.\\./assets/theme-backgrounds/${theme}\\.png["']?\\)`),
      `appSkins.css should reference ../assets/theme-backgrounds/${theme}.png`
    );
  }

  // Check background attributes: cover, center, no-repeat, fixed viewport
  assert.match(css, /\.workspace\[data-theme-background\]/);
  assert.match(css, /background-size:\s*cover/);
  assert.match(css, /background-position:\s*center/);
  assert.match(css, /background-repeat:\s*no-repeat/);

  // Pattern suppression
  assert.match(css, /\.workspace\[data-theme-background\]::before\s*\{[^}]*display:\s*none\s*!important/);
});

test("verify WorkspaceCanvas.tsx source-level wiring and background theme scoping", () => {
  const tsxPath = path.resolve("src/renderer/src/features/workspace/WorkspaceCanvas.tsx");
  const tsx = fs.readFileSync(tsxPath, "utf8");

  // Verify CANVAS_OVERLAY_PLACEMENTS is defined with CanvasOverlayPlacement type
  assert.match(
    tsx,
    /const\s+CANVAS_OVERLAY_PLACEMENTS:\s*readonly\s+CanvasOverlayPlacement\[\]\s*=/,
    "WorkspaceCanvas.tsx should declare CANVAS_OVERLAY_PLACEMENTS with CanvasOverlayPlacement[]"
  );

  // Check data-theme-background attribute is attached to workspace element
  assert.match(
    tsx,
    /data-theme-background=\{themeBackground \?\? \(packBackground \? "custom" : undefined\)\}/,
    "WorkspaceCanvas.tsx should attach bundled or imported theme background"
  );

  // Check themeBackground wiring to settings.terminalBorderSkin
  assert.match(
    tsx,
    /const\s+themeBackground\s*=\s*themeBackgroundForBorderSkin\(settings\.terminalBorderSkin\);/,
    "WorkspaceCanvas.tsx should resolve themeBackground from settings.terminalBorderSkin"
  );

  // Verify themeBackgroundForBorderSkin restricts strictly to bundled themes
  const functionMatch = tsx.match(/function\s+themeBackgroundForBorderSkin[\s\S]*?\n\}/);
  assert.ok(functionMatch, "themeBackgroundForBorderSkin function definition should exist");
  const functionBody = functionMatch[0];

  assert.ok(
    !functionBody.includes("isPixelSkinThemeId"),
    "themeBackgroundForBorderSkin should not accept arbitrary isPixelSkinThemeId"
  );

  const bundledThemesSetMatch = tsx.match(
    /const\s+PIXEL_THEME_BACKGROUND_IDS\s*=\s*new\s+Set<string>\(\[\s*([\s\S]*?)\]\);/
  );
  assert.ok(bundledThemesSetMatch, "PIXEL_THEME_BACKGROUND_IDS should be defined as a Set");
  const extractedThemes = [...bundledThemesSetMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    extractedThemes.sort(),
    BUNDLED_THEMES.slice().sort(),
    "PIXEL_THEME_BACKGROUND_IDS must contain exactly the bundled themes"
  );
});
