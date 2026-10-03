import assert from "node:assert/strict";
import test from "node:test";

import { CdpTabDriver } from "../src/main/services/browser/CdpTabDriver.ts";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("a socket acquired after the open timeout is closed without creating a target", async () => {
  const connection = deferred();
  const sent = [];
  let closes = 0;
  const keepAlive = setInterval(() => {}, 1_000);
  const opening = CdpTabDriver.open({
    url: "ws://127.0.0.1:9222/devtools/browser/test",
    engine: "test",
    layout: false,
    openTimeoutMs: 5,
    connect: () => connection.promise
  });

  try {
    await assert.rejects(opening, /did not open a page in time/u);
  } finally {
    clearInterval(keepAlive);
  }
  connection.resolve({ send: (text) => sent.push(text), close: () => { closes += 1; } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(closes, 1);
  assert.deepEqual(sent, []);
});
