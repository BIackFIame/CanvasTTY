import assert from "node:assert/strict";
import test from "node:test";
import { CANVAS_LAUNCHER_ITEMS, PROVIDER_LABELS, isProviderId } from "../src/shared/providerCatalog.ts";
import { AGENT_PROVIDERS, LIMIT_PROVIDERS, RADIAL_LAUNCHER_ITEMS } from "../src/shared/contracts.ts";

test("every provider list is derived from the catalog", () => {
  assert.deepEqual([...CANVAS_LAUNCHER_ITEMS].sort(), Object.keys(PROVIDER_LABELS).sort());
  assert.equal(new Set(CANVAS_LAUNCHER_ITEMS).size, CANVAS_LAUNCHER_ITEMS.length);
  assert.deepEqual(AGENT_PROVIDERS, CANVAS_LAUNCHER_ITEMS.filter((item) => item !== "terminal"));
  assert.deepEqual(RADIAL_LAUNCHER_ITEMS, [...CANVAS_LAUNCHER_ITEMS, "note", "browser", "settings"]);
  assert.ok(LIMIT_PROVIDERS.every((provider) => AGENT_PROVIDERS.includes(provider)));
});

test("isProviderId accepts exactly the catalog's ids", () => {
  for (const id of CANVAS_LAUNCHER_ITEMS) assert.equal(isProviderId(id), true, id);
  for (const value of ["note", "Codex", "toString", "__proto__", "", null, undefined, 1, {}]) assert.equal(isProviderId(value), false, String(value));
});
