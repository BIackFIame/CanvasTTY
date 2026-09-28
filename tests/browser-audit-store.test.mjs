import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  BrowserAuditStore,
  redactAuditValue
} from "../src/main/services/browser/BrowserAuditStore.ts";

async function fixture(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function auditInput(requestId, overrides = {}) {
  return {
    timestamp: 1_700_000_000_000,
    requestId,
    actorKind: "agent",
    actorId: "agent-test",
    operation: "browser_click",
    phase: "result",
    tabId: "tab-1",
    ok: true,
    details: { targetHash: `hash-${requestId}` },
    ...overrides
  };
}

async function auditFiles(store) {
  const directory = dirname(store.filePath);
  const names = await readdir(directory);
  return names.filter((name) => /^browser-audit(?:-.+)?\.jsonl$/.test(name)).sort();
}

test("redactAuditValue removes typed values, tokens, credentials, and URL query/fragment", () => {
  const sentinel = ["fixture", "sensitive", "value"].join("-");
  const redacted = redactAuditValue({
    text: sentinel,
    promptText: sentinel,
    value: sentinel,
    values: ["one", "two"],
    accessToken: sentinel,
    nested: {
      password: sentinel,
      authorization: `Basic ${sentinel}`,
      safeLabel: "visible",
      url: `https://user:pass@example.com/private/path?token=${sentinel}#${sentinel}`,
      bearerHeader: `Bearer ${sentinel}`
    }
  });

  assert.deepEqual(redacted, {
    text: "[REDACTED]",
    promptText: "[REDACTED]",
    value: "[REDACTED]",
    values: "[REDACTED]",
    accessToken: "[REDACTED]",
    nested: {
      password: "[REDACTED]",
      authorization: "[REDACTED]",
      safeLabel: "visible",
      url: "https://example.com/private/path",
      bearerHeader: "[REDACTED]"
    }
  });
  assert.equal(redactAuditValue(`https://example.com/path?q=${sentinel}#${sentinel}`), "https://example.com/path");
  assert.equal(redactAuditValue(`Bearer ${sentinel}`), "[REDACTED]");
  assert.equal(redactAuditValue(["password", sentinel].join("=")), "[REDACTED]");
});

test("BrowserAuditStore serializes concurrent appends into a verifiable hash chain", async (t) => {
  const root = await fixture(t, "canvastty-audit-chain-");
  const store = new BrowserAuditStore(root);

  const records = await Promise.all(
    Array.from({ length: 12 }, (_, index) => store.append(auditInput(`request-${index}`)))
  );

  assert.deepEqual(records.map((record) => record.sequence), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(records[0].previousHash, null);
  for (let index = 1; index < records.length; index += 1) {
    assert.equal(records[index].previousHash, records[index - 1].hash);
  }
  assert.deepEqual(await store.verify(), {
    valid: true,
    records: 12,
    lastHash: records.at(-1).hash
  });

  const lines = (await readFile(store.filePath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 12);
  assert.equal(lines[0].details.targetHash, "hash-request-0");
});

test("BrowserAuditStore detects tampering and a reopened store fails closed", async (t) => {
  const root = await fixture(t, "canvastty-audit-tamper-");
  const store = new BrowserAuditStore(root);
  await store.append(auditInput("request-1"));
  await store.append(auditInput("request-2"));

  const records = (await readFile(store.filePath, "utf8")).trim().split("\n").map(JSON.parse);
  records[0].operation = "browser_type";
  await writeFile(store.filePath, `${records.map(JSON.stringify).join("\n")}\n`);
  assert.deepEqual(await store.verify(), { valid: false, records: 0, lastHash: null });

  const reopened = new BrowserAuditStore(root);
  await assert.rejects(reopened.append(auditInput("request-3")), /hash chain is invalid/i);
});

test("BrowserAuditStore rotates without breaking the cross-file hash chain", async (t) => {
  const root = await fixture(t, "canvastty-audit-rotate-");
  let now = 1_700_000_000_000;
  const store = new BrowserAuditStore(root, { maxBytes: 1_024, now: () => now });
  const records = [];
  for (let index = 0; index < 5; index += 1) {
    now += 1_000;
    records.push(await store.append(auditInput(`rotate-${index}`, {
      timestamp: now,
      details: { note: `${index}-${"x".repeat(700)}` }
    })));
  }

  const files = await auditFiles(store);
  assert.equal(files.includes("browser-audit.jsonl"), true);
  assert.equal(files.filter((name) => name.startsWith("browser-audit-")).length >= 1, true);
  assert.deepEqual(await store.verify(), {
    valid: true,
    records: records.length,
    lastHash: records.at(-1).hash
  });
});

test("BrowserAuditStore prunes expired rotations while retaining a verifiable chain anchor", async (t) => {
  const root = await fixture(t, "canvastty-audit-retention-");
  const retentionMs = 5_000;
  let now = 1_700_000_000_000;
  const store = new BrowserAuditStore(root, { maxBytes: 1_024, retentionMs, now: () => now });
  for (let index = 0; index < 3; index += 1) {
    now += 1_000;
    await store.append(auditInput(`retention-${index}`, {
      timestamp: now,
      details: { note: "x".repeat(700) }
    }));
  }

  const directory = dirname(store.filePath);
  const rotatedBefore = (await auditFiles(store)).filter((name) => name.startsWith("browser-audit-"));
  assert.equal(rotatedBefore.length >= 1, true);
  const expiredSeconds = (now - retentionMs - 1_000) / 1_000;
  for (const name of rotatedBefore) await utimes(join(directory, name), expiredSeconds, expiredSeconds);

  now += retentionMs + 2_000;
  const reopened = new BrowserAuditStore(root, { maxBytes: 1_024, retentionMs, now: () => now });
  const verification = await reopened.verify();
  assert.equal(verification.valid, true);
  assert.equal((await auditFiles(reopened)).some((name) => name.startsWith("browser-audit-")), false);

  const firstSurviving = JSON.parse((await readFile(reopened.filePath, "utf8")).trim().split("\n")[0]);
  assert.equal(typeof firstSurviving.previousHash, "string");
  assert.equal(firstSurviving.previousHash.length, 64);
});

test("BrowserAuditStore propagates storage failures instead of pretending to audit", async (t) => {
  const root = await fixture(t, "canvastty-audit-failure-");
  await writeFile(join(root, "browser"), "directory blocker");
  const store = new BrowserAuditStore(root);

  await assert.rejects(store.append(auditInput("blocked")), (error) => {
    assert.equal(["EEXIST", "ENOTDIR"].includes(error?.code), true);
    return true;
  });
  await assert.rejects(store.verify());
});

test("BrowserAuditStore repairs a line torn by a crash instead of refusing every later action", async (t) => {
  const root = await fixture(t, "canvastty-audit-torn-");
  const store = new BrowserAuditStore(root);
  await store.append(auditInput("torn-1"));
  await store.append(auditInput("torn-2"));
  const complete = await readFile(store.filePath, "utf8");
  // A crash or ENOSPC during the append left half a record and no newline.
  const third = JSON.stringify({ ...JSON.parse(complete.trim().split("\n")[1]), sequence: 3 });
  await writeFile(store.filePath, complete + third.slice(0, 40));

  const reopened = new BrowserAuditStore(root);
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const appended = await reopened.append(auditInput("after-crash"));
    assert.equal(appended.sequence, 3);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(await reopened.verify(), { valid: true, records: 3, lastHash: (await reopened.verify()).lastHash });
  assert.equal((await readFile(reopened.filePath, "utf8")).split("\n").filter(Boolean).length, 3);

  // A complete last record that only lost its newline is kept, not dropped.
  const whole = await readFile(reopened.filePath, "utf8");
  await writeFile(reopened.filePath, whole.slice(0, -1));
  const again = new BrowserAuditStore(root);
  assert.equal((await again.append(auditInput("after-newline"))).sequence, 4);
  assert.equal((await again.verify()).valid, true);
});
