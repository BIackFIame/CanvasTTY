/**
 * canvastty-helper embeds the MCP tool catalogs and instructions generated from the .mjs sources
 * (scripts/build-native-helpers.mjs). A catalog change without regenerating would make the native helpers list other
 * tools than the JavaScript ones.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { nativeHelperCatalogText } from "../scripts/build-native-helpers.mjs";

test("the native helper's embedded catalog matches the .mjs catalogs (run npm run build:helpers -- --catalog)", async () => {
  const embedded = await readFile(new URL("../native/canvastty-helper/catalog.json", import.meta.url), "utf8");
  assert.equal(embedded, await nativeHelperCatalogText());
});
