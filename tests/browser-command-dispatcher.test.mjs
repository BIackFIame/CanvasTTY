import assert from "node:assert/strict";
import test from "node:test";

import { BrowserCommandDispatcher } from "../src/main/services/browser/BrowserCommandDispatcher.ts";

const human = Object.freeze({ kind: "human", connectionId: "renderer-main" });
const agent = Object.freeze({
  kind: "agent",
  agentId: "agent-a",
  provider: "codex",
  terminalSessionId: "terminal-a",
  connectionId: "connection-a",
  cwd: "/tmp/project-a"
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function audit(overrides = {}) {
  return {
    append: async () => ({}),
    ...overrides
  };
}

function dispatcher(options = {}) {
  return new BrowserCommandDispatcher({
    audit: audit(),
    execute: async (_actor, command) => ({ tabId: command.tabId ?? null }),
    getRevision: (tabId) => tabId ? 1 : null,
    getOrigin: (tabId) => tabId ? `https://${tabId}.example` : null,
    ...options
  });
}

async function until(predicate, message = "condition was not reached") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function navigate(requestId, tabId, expectedRevision = 1) {
  return {
    type: "browser_navigate",
    requestId,
    tabId,
    url: `https://${tabId}.example/next`,
    expectedRevision
  };
}

function elementRef(tabId, ref) {
  return {
    ref,
    tabId,
    frameId: "main",
    documentRevision: 1,
    backendNodeId: 1
  };
}

test("BrowserCommandDispatcher runs mutations FIFO per tab and different tabs in parallel", async () => {
  const gates = new Map();
  const started = [];
  const service = dispatcher({
    execute: async (_actor, command) => {
      started.push(command.requestId);
      const gate = deferred();
      gates.set(command.requestId, gate);
      return gate.promise;
    }
  });

  const firstA = service.execute(agent, navigate("a-1", "tab-a"));
  const secondA = service.execute(agent, navigate("a-2", "tab-a"));
  const firstB = service.execute(agent, navigate("b-1", "tab-b"));
  await until(() => started.length === 2);

  assert.deepEqual(new Set(started), new Set(["a-1", "b-1"]));
  assert.equal(started.includes("a-2"), false);
  gates.get("b-1").resolve({ tabId: "tab-b" });
  assert.equal((await firstB).ok, true);
  assert.equal(started.includes("a-2"), false);

  gates.get("a-1").resolve({ tabId: "tab-a" });
  assert.equal((await firstA).ok, true);
  await until(() => started.includes("a-2"));
  gates.get("a-2").resolve({ tabId: "tab-a" });
  assert.equal((await secondA).ok, true);
});

test("BrowserCommandDispatcher derives FIFO lanes from revision-bound refs", async () => {
  const gates = new Map();
  const started = [];
  const service = dispatcher({
    execute: async (_actor, command) => {
      started.push(command.requestId);
      const gate = deferred();
      gates.set(command.requestId, gate);
      return gate.promise;
    }
  });
  const click = (requestId, tabId) => ({
    type: "browser_click",
    requestId,
    ref: elementRef(tabId, `ref-${requestId}`),
    expectedRevision: 1
  });

  const firstA = service.execute(agent, click("ref-a-1", "tab-a"));
  const secondA = service.execute(agent, click("ref-a-2", "tab-a"));
  const firstB = service.execute(agent, click("ref-b-1", "tab-b"));
  await until(() => started.length === 2);
  assert.deepEqual(new Set(started), new Set(["ref-a-1", "ref-b-1"]));

  gates.get("ref-a-1").resolve({ tabId: "tab-a" });
  gates.get("ref-b-1").resolve({ tabId: "tab-b" });
  await Promise.all([firstA, firstB]);
  await until(() => started.includes("ref-a-2"));
  gates.get("ref-a-2").resolve({ tabId: "tab-a" });
  assert.equal((await secondA).ok, true);
});

test("BrowserCommandDispatcher deduplicates request IDs per connection", async () => {
  const gate = deferred();
  let executions = 0;
  const service = dispatcher({
    execute: async () => {
      executions += 1;
      return gate.promise;
    }
  });
  const command = { type: "browser_list_tabs", requestId: "same-request" };

  const first = service.execute(agent, command);
  const repeated = service.execute(agent, structuredClone(command));
  assert.strictEqual(repeated, first);
  await until(() => executions === 1);
  gate.resolve({ data: { tabs: [] }, tabId: null });
  assert.deepEqual(await repeated, await first);
  assert.equal(executions, 1);

  const otherConnection = { ...agent, connectionId: "connection-b" };
  const other = await service.execute(otherConnection, command);
  assert.equal(other.ok, true);
  assert.equal(executions, 2);
});

test("BrowserCommandDispatcher activity cursors follow completion order without gaps", async () => {
  const gates = new Map();
  const service = dispatcher({
    execute: async (_actor, command) => {
      const gate = deferred();
      gates.set(command.requestId, gate);
      return gate.promise;
    }
  });
  const first = service.execute(human, { type: "browser_list_tabs", requestId: "activity-first" });
  const second = service.execute(human, { type: "browser_list_tabs", requestId: "activity-second" });
  await until(() => gates.size === 2);

  gates.get("activity-second").resolve({ tabId: null });
  const secondResult = await second;
  const firstPage = service.getActivity(0);
  assert.equal(secondResult.commandSequence, 2);
  assert.deepEqual(firstPage.map((event) => [event.sequence, event.requestId]), [[1, "activity-second"]]);

  gates.get("activity-first").resolve({ tabId: null });
  const firstResult = await first;
  const nextPage = service.getActivity(firstPage[0].sequence);
  assert.equal(firstResult.commandSequence, 1);
  assert.deepEqual(nextPage.map((event) => [event.sequence, event.requestId]), [[2, "activity-first"]]);
});

test("BrowserCommandDispatcher releases completed reads but retains completed agent mutations", async () => {
  let executions = 0;
  const service = dispatcher({
    execute: async (_actor, command) => {
      executions += 1;
      return { tabId: command.tabId ?? null, data: { execution: executions } };
    }
  });

  const read = { type: "browser_list_tabs", requestId: "read-retry" };
  assert.equal((await service.execute(agent, read)).data.execution, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await service.execute(agent, read)).data.execution, 2);

  const mutation = navigate("mutation-retry", "tab-a");
  const firstMutation = await service.execute(agent, mutation);
  assert.equal(firstMutation.data.execution, 3);
  await new Promise((resolve) => setImmediate(resolve));
  const repeatedMutation = await service.execute(agent, mutation);
  assert.deepEqual(repeatedMutation, firstMutation);
  assert.equal(executions, 3);
});

test("BrowserCommandDispatcher rejects stale revisions before browser side effects", async () => {
  let executions = 0;
  const auditInputs = [];
  const service = dispatcher({
    audit: audit({ append: async (input) => { auditInputs.push(input); return {}; } }),
    execute: async () => {
      executions += 1;
      return { tabId: "tab-a" };
    },
    getRevision: () => 7
  });

  const result = await service.execute(agent, navigate("stale-request", "tab-a", 6));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "STALE_REF");
  assert.equal(result.error.retryable, true);
  assert.equal(executions, 0);
  assert.deepEqual(auditInputs.map((input) => input.phase), ["result"]);
});

test("BrowserCommandDispatcher limits each agent to eight commands in flight", async () => {
  const gates = [];
  let executions = 0;
  const service = dispatcher({
    execute: async () => {
      executions += 1;
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    }
  });

  const promises = Array.from({ length: 9 }, (_, index) => service.execute(agent, {
    type: "browser_list_tabs",
    requestId: `inflight-${index}`
  }));
  await until(() => executions === 8);
  const ninth = await promises[8];
  assert.equal(ninth.ok, false);
  assert.equal(ninth.error.code, "RATE_LIMITED");
  assert.equal(ninth.error.retryable, true);

  for (const gate of gates) gate.resolve({ tabId: null, data: { tabs: [] } });
  const firstEight = await Promise.all(promises.slice(0, 8));
  assert.equal(firstEight.every((result) => result.ok), true);
});

test("BrowserCommandDispatcher enforces a 100-command agent window without affecting humans", async () => {
  let now = 50_000;
  let executions = 0;
  const service = dispatcher({
    now: () => now,
    execute: async () => {
      executions += 1;
      return { tabId: null, data: { tabs: [] } };
    }
  });

  for (let index = 0; index < 100; index += 1) {
    const result = await service.execute(agent, { type: "browser_list_tabs", requestId: `window-${index}` });
    assert.equal(result.ok, true);
  }
  const limited = await service.execute(agent, { type: "browser_list_tabs", requestId: "window-100" });
  assert.equal(limited.ok, false);
  assert.equal(limited.error.code, "RATE_LIMITED");

  const humanResult = await service.execute(human, { type: "browser_list_tabs", requestId: "human-after-100" });
  assert.equal(humanResult.ok, true);
  now += 10_001;
  const afterWindow = await service.execute(agent, { type: "browser_list_tabs", requestId: "window-reset" });
  assert.equal(afterWindow.ok, true);
  assert.equal(executions, 102);
});

test("BrowserCommandDispatcher caps one tab mutation lane at 100 queued commands", async () => {
  const firstGate = deferred();
  let executions = 0;
  const service = dispatcher({
    execute: async (_actor, command) => {
      executions += 1;
      if (executions === 1) await firstGate.promise;
      return { tabId: command.tabId ?? null };
    }
  });

  const accepted = Array.from({ length: 100 }, (_, index) => service.execute(agent, navigate(
    `queue-${index}`,
    "tab-a"
  )));
  await until(() => executions === 1);
  const overflow = await service.execute(agent, navigate("queue-overflow", "tab-a"));
  assert.equal(overflow.ok, false);
  assert.equal(overflow.error.code, "RATE_LIMITED");
  assert.equal(overflow.error.retryable, true);
  assert.equal(executions, 1);

  firstGate.resolve();
  const results = await Promise.all(accepted);
  assert.equal(results.every((result) => result.ok), true);
  assert.equal(executions, 100);
});

test("BrowserCommandDispatcher fails closed only for unaudited agent mutations", async () => {
  let executions = 0;
  const service = dispatcher({
    audit: audit({ append: async () => { throw new Error("disk unavailable"); } }),
    execute: async (_actor, command) => {
      executions += 1;
      return { tabId: command.tabId ?? null };
    }
  });
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    const blocked = await service.execute(agent, navigate("agent-mutation", "tab-a"));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, "AUDIT_UNAVAILABLE");
    assert.equal(executions, 0);

    const humanMutation = await service.execute(human, navigate("human-mutation", "tab-a"));
    assert.equal(humanMutation.ok, true);
    const agentRead = await service.execute(agent, {
      type: "browser_read_page",
      requestId: "agent-read",
      tabId: "tab-a"
    });
    assert.equal(agentRead.ok, true);
    assert.equal(executions, 2);
  } finally {
    console.warn = originalWarn;
  }
});

test("BrowserCommandDispatcher times out even when protected execution never settles", async () => {
  const service = dispatcher({
    execute: async () => new Promise(() => {})
  });
  const startedAt = Date.now();
  const result = await service.execute(human, {
    type: "browser_list_tabs",
    requestId: "stalled-timeout",
    timeoutMs: 50
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TIMEOUT");
  assert.equal(Date.now() - startedAt < 1_000, true);
});

test("BrowserCommandDispatcher aborts stalled execution and drains on shutdown", async () => {
  let executionSignal;
  const service = dispatcher({
    execute: async (_actor, _command, signal) => {
      executionSignal = signal;
      return new Promise(() => {});
    }
  });
  const pending = service.execute(human, {
    type: "browser_list_tabs",
    requestId: "stalled-shutdown"
  });
  await until(() => Boolean(executionSignal));

  await Promise.race([
    service.closeAndDrain(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown did not drain")), 1_000))
  ]);
  assert.equal(executionSignal.aborted, true);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CANCELED");

  const rejected = await service.execute(human, {
    type: "browser_list_tabs",
    requestId: "after-shutdown"
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "BRIDGE_UNAVAILABLE");
});

test("BrowserCommandDispatcher bounds a stalled result audit during shutdown", async () => {
  const resultAuditStarted = deferred();
  const service = dispatcher({
    audit: audit({
      append: async (input) => {
        if (input.phase === "result") {
          resultAuditStarted.resolve();
          return new Promise(() => {});
        }
        return {};
      }
    })
  });
  const pending = service.execute(human, {
    type: "browser_list_tabs",
    requestId: "stalled-result-audit"
  });
  await resultAuditStarted.promise;

  await Promise.race([
    service.closeAndDrain(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown did not bound result audit")), 1_000))
  ]);
  assert.equal((await pending).ok, true);
});

test("BrowserCommandDispatcher answers a mutation resent after a dropped connection from its record instead of running it again", async () => {
  let executions = 0;
  const service = dispatcher({
    execute: async (_actor, command) => {
      executions += 1;
      return { tabId: command.tabId ?? null, data: { execution: executions } };
    }
  });
  const click = navigate("click-1", "tab-a");
  const first = await service.execute(agent, click);
  // The socket dropped before the answer arrived; the helper reconnects with the same connection and resends.
  service.clearActor(agent, { reconnecting: true });
  assert.deepEqual(await service.execute(agent, click), first);
  assert.equal(executions, 1, "not clicked twice");
  // A revoked or expired connection keeps nothing.
  service.clearActor(agent);
  await service.execute(agent, click);
  assert.equal(executions, 2);
});

test("BrowserCommandDispatcher forgets completed agent mutations after ten minutes", async () => {
  let now = 1_000;
  let executions = 0;
  const service = dispatcher({
    now: () => now,
    execute: async (_actor, command) => {
      executions += 1;
      return { tabId: command.tabId ?? null, data: { execution: executions } };
    }
  });
  await service.execute(agent, navigate("old", "tab-a"));
  now += 9 * 60_000;
  await service.execute(agent, navigate("old", "tab-a"));
  assert.equal(executions, 1, "still remembered");
  now += 2 * 60_000;
  await service.execute(agent, navigate("new", "tab-a"));
  await service.execute(agent, navigate("old", "tab-a"));
  assert.equal(executions, 3, "the old record was released");
});
