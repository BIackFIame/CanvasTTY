import assert from "node:assert/strict";
import test from "node:test";
import { canonicalStringify } from "../src/agent-browser/tool-catalog.mjs";
import { canonicalStringify as orchestrationCanonical } from "../src/agent-browser/orchestration-catalog.mjs";

// The serializer the browser audit chain used before it moved here (and still
// verifies older records with, under localeCompare).
function previousAuditJson(value, order) {
  if (Array.isArray(value)) return `[${value.map((item) => previousAuditJson(item, order)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => order(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${previousAuditJson(entry, order)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function randomJson(random, depth = 0) {
  const pick = Math.floor(random() * (depth > 3 ? 4 : 6));
  if (pick === 0) return null;
  if (pick === 1) return random() < 0.5;
  if (pick === 2) return Math.round((random() - 0.5) * 1e6) / 100;
  if (pick === 3) return ["", "é", "a\"b", " ", "Z", "_"][Math.floor(random() * 6)];
  if (pick === 4) return Array.from({ length: Math.floor(random() * 4) }, () => randomJson(random, depth + 1));
  const keys = ["b", "B", "a", "é", "_", "10", "9", "Zeta", "zeta", "ä"];
  return Object.fromEntries(keys.filter(() => random() < 0.4).map((key) => [key, randomJson(random, depth + 1)]));
}

test("keys are ordered by code unit, never by locale, integer-like keys included", () => {
  assert.equal(canonicalStringify({ b: 1, B: 2, a: 3, "é": 4, _: 5, 10: 6, 9: 7 }), '{"10":6,"9":7,"B":2,"_":5,"a":3,"b":1,"é":4}');
  assert.equal(canonicalStringify({ z: [3, { y: 1, x: undefined }], a: "t" }), '{"a":"t","z":[3,{"y":1}]}');
  assert.equal(canonicalStringify(JSON.parse('{"__proto__":1}')), '{"__proto__":1}');
  assert.equal(orchestrationCanonical, canonicalStringify);
});

test("strict mode refuses what JSON would silently change; lenient answers as JSON does", () => {
  const cycle = {};
  cycle.self = cycle;
  for (const value of [Number.NaN, { n: Infinity }, cycle, [undefined], new Date(0), { f() {} }, undefined, 1n]) {
    assert.throws(() => canonicalStringify(value), TypeError);
  }
  assert.equal(canonicalStringify({ n: Number.NaN, list: [undefined, () => 1], f() {}, d: new Map() }, { lenient: true }), '{"d":{},"list":[null,null],"n":null}');
  assert.throws(() => canonicalStringify(cycle, { lenient: true }), TypeError);
});

test("the audit form matches the previous audit serializer on JSON data, in both key orders", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
  const byCodeUnit = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  const byLocale = (left, right) => left.localeCompare(right);
  for (let index = 0; index < 500; index += 1) {
    const value = randomJson(random);
    assert.equal(canonicalStringify(value, { lenient: true }), previousAuditJson(value, byCodeUnit));
    assert.equal(canonicalStringify(value, { lenient: true, compareKeys: byLocale }), previousAuditJson(value, byLocale));
    assert.deepEqual(JSON.parse(canonicalStringify(value)), value);
  }
});
