import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { exactOrigin } from "../integrations/mobile/src/client.ts";
import { readLocalConnection } from "../integrations/even-g2/src/local-fetch.mjs";

const origin = "http://127.0.0.1:3481";
const key = "a".repeat(64);
const token = "b".repeat(64);
const connection = { version: 1, computer: "c".repeat(64), key, deviceId: "d".repeat(32), origins: [origin] };

function browser(pageOrigin = origin, secure = true) {
  Object.defineProperties(globalThis, {
    location: { configurable: true, value: { origin: pageOrigin } },
    isSecureContext: { configurable: true, value: secure },
    crypto: { configurable: true, value: webcrypto },
  });
}

test("USB pairing accepts only this secure exact loopback origin", () => {
  browser();
  assert.equal(exactOrigin(origin), origin);
  assert.throws(() => readLocalConnection(JSON.stringify({ token, connection })));
  assert.deepEqual(readLocalConnection(JSON.stringify({ token, connection }), true).connection.origins, [origin]);
  for (const invalid of ["http://localhost:3481", "http://192.168.1.2:3481", "http://127.0.0.1:3482", "http://127.0.0.1:3481/mobile/", "http://127.0.0.1:3481?x=1", "http://127.0.0.1:3481/"])
    assert.throws(() => exactOrigin(invalid), `reject ${invalid}`);
  browser("http://localhost:3481");
  assert.throws(() => exactOrigin(origin));
  browser(origin, false);
  assert.throws(() => exactOrigin(origin));
  browser("https://computer.tailnet.ts.net");
  assert.equal(exactOrigin("https://computer.tailnet.ts.net"), "https://computer.tailnet.ts.net");
});

