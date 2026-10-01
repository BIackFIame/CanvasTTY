/**
 * canvastty-helper embeds the MCP tool catalogs and instructions generated from the .mjs sources
 * (scripts/build-native-helpers.mjs). A catalog change without regenerating would make the native helpers list other
 * tools than the JavaScript ones.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { nativeHelperCatalogText } from "../scripts/build-native-helpers.mjs";

const CATALOG = "native/canvastty-helper/catalog.json";
const root = fileURLToPath(new URL("..", import.meta.url));
const inCheckout = (() => {
  try { execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: "ignore" }); return true; } catch { return false; }
})();

test("the native helper's embedded catalog matches the .mjs catalogs (run npm run build:helpers -- --catalog)", async () => {
  const embedded = await readFile(new URL(`../${CATALOG}`, import.meta.url), "utf8");
  const generated = await nativeHelperCatalogText();
  // The content first (a real difference means the catalog must be regenerated), then the bytes the helper embeds.
  assert.deepEqual(JSON.parse(embedded), JSON.parse(generated), "the catalog differs from the .mjs sources: run npm run build:helpers -- --catalog");
  assert.equal(embedded, generated, "same content, other bytes: the catalog must be checked out with LF (.gitattributes)");
});

test("the embedded catalog is checked out with LF on every platform, so every build embeds the same bytes",
  { skip: inCheckout ? false : "not a git checkout" }, () => {
  const eol = execFileSync("git", ["check-attr", "eol", "--", CATALOG], { cwd: root, encoding: "utf8" });
  assert.equal(eol.trim(), `${CATALOG}: eol: lf`);
});
