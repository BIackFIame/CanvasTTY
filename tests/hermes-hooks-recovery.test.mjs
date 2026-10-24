import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HermesRuntimeHooks } from "../src/main/services/agent-runtime/ProviderRuntimeLaunch.ts";

test("HermesRuntimeHooks.recover does not throw when config.yaml has no hooks map", async t => {
  const dir = await mkdtemp(join(tmpdir(), "hermes-hooks-recover-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const configPath = join(dir, "config.yaml");
  const initialYaml = "database:\n  journal_mode: wal\nmodel:\n  default: antigravity/gemini\n";
  await writeFile(configPath, initialYaml, "utf8");

  // Create a journal that records an aborted hook registration
  const journalPath = join(dir, ".canvastty-runtime-hermes.json");
  const journal = {
    version: 1,
    provider: "hermes",
    originalHash: "dummy-hash",
    mutatedHash: "unmatched-hash",
    backupPath: join(dir, "backup.bak"),
    extra: {
      commands: {
        on_session_start: ["set ELECTRON_RUN_AS_NODE=1 && CanvasTTY.exe hook-helper.mjs"],
        pre_llm_call: ["set ELECTRON_RUN_AS_NODE=1 && CanvasTTY.exe hook-helper.mjs"],
      },
    },
  };
  await writeFile(journalPath, JSON.stringify(journal), "utf8");

  // Must not throw "Expected YAML collection at hooks. Remaining path: on_session_start"
  assert.doesNotThrow(() => {
    HermesRuntimeHooks.recover(dir);
  });

  // Verify journal was cleaned up and config remains valid
  const updatedYaml = await readFile(configPath, "utf8");
  assert.match(updatedYaml, /database:\s*journal_mode: wal/);
});
