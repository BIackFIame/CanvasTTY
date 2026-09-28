import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LimitsService } from "../src/main/services/LimitsService.ts";

test("disposing limits while the Kimi usage server is starting leaves no `kimi web` process", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-kimi-dispose-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "kimi-web-started");
  const kimi = join(root, "kimi");
  // Records that it ran and exits at once, so a leaked start leaves only the marker behind.
  await writeFile(kimi, `#!/bin/sh\necho "$@" > ${JSON.stringify(marker)}\n`, { mode: 0o700 });
  const service = new LimitsService({
    get(provider) {
      if (provider === "kimi") {
        return { state: "available", provider, executable: kimi, launcher: "native", environment: {}, checked: [] };
      }
      return { state: "unavailable", provider, reason: "cli-not-found", checked: [], diagnostic: "" };
    }
  }, "test");
  const reading = service.get();
  // The Kimi client is waiting for a free loopback port: nothing is spawned yet.
  service.dispose();
  const snapshot = await reading;
  assert.equal(snapshot.providers.find((provider) => provider.provider === "kimi").state, "unavailable");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await assert.rejects(stat(marker), { code: "ENOENT" }, "kimi web must not start after dispose");
});
