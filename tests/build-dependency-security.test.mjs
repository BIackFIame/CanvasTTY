import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import uri from "fast-uri";
import plist from "plist";

test("XML parsing preserves plist data and reports malformed end tags", () => {
  const metadata = { CFBundleName: "CanvasTTY", CFBundleVersion: "1.5.1" };
  assert.deepEqual(plist.parse(plist.build(metadata)), metadata);
  const errors = [];
  new DOMParser({ errorHandler: (message) => errors.push(message) })
    .parseFromString("<root></root\nunexpected>", "application/xml");
  assert.ok(errors.length > 0, "malformed end-tag content must be reported");
});

test("URI parsing rejects malformed IPv6 hosts", () => {
  assert.equal(uri.parse("https://example.com/path").host, "example.com");
  assert.ok(uri.parse("http://[::not-valid]/private").error);
});

test("custom ID generators return an empty string for a zero size", () => {
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { customAlphabet, customRandom } from "nanoid";
    assert.equal(customAlphabet("abc", 0)(), "");
    assert.equal(customRandom("abc", 0, () => new Uint8Array())(), "");
  `], { cwd: new URL("..", import.meta.url), timeout: 5_000, stdio: "pipe" });
});
