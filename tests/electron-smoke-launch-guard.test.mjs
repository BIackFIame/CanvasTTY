import assert from "node:assert/strict";
import test from "node:test";
import { electronSmokeLaunchBlockReason } from "../scripts/lib/electron-smoke-launch-guard.mjs";

test("blocks only the known macOS seatbelt Electron smoke launch context", () => {
  const environment = { CODEX_SANDBOX: "seatbelt" };
  const before = { ...environment };

  assert.match(electronSmokeLaunchBlockReason("darwin", environment), /CODEX_SANDBOX=seatbelt/u);
  assert.deepEqual(environment, before);
});

test("allows a normal macOS launch", () => {
  assert.equal(electronSmokeLaunchBlockReason("darwin", {}), undefined);
  assert.equal(electronSmokeLaunchBlockReason("darwin", { CODEX_SANDBOX: "other" }), undefined);
});

test("leaves Linux CI launch behavior unchanged", () => {
  assert.equal(electronSmokeLaunchBlockReason("linux", { CI: "true", CODEX_SANDBOX: "seatbelt" }), undefined);
});
