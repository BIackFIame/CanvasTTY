import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import test from "node:test";

// A 1024 px mark drawn at icon size costs a 574 KB download and decode for nothing.

test("raster provider marks ship sized for where they are drawn, with a 2x variant", async () => {
  const directory = new URL("../src/renderer/src/assets/providers/", import.meta.url);
  const pngs = (await readdir(directory)).filter((name) => name.endsWith(".png"));
  for (const name of pngs) {
    const bytes = await readFile(new URL(name, directory));
    const width = bytes.readUInt32BE(16);
    assert.ok(width <= 600, `${name} is ${width} px wide`);
    assert.ok((await stat(new URL(name, directory))).size <= 64 * 1024, `${name} stays small`);
  }
  const icon = await readFile(new URL("../src/renderer/src/components/ProviderIcon.tsx", import.meta.url), "utf8");
  for (const provider of ["hermes", "codex"]) {
    assert.match(icon, new RegExp(`import ${provider}Icon from "../assets/providers/${provider}-128.png"`, "u"));
    assert.match(icon, new RegExp(`import ${provider}Icon2x from "../assets/providers/${provider}-256.png"`, "u"));
  }
  assert.match(icon, /srcSet=/u);
});
