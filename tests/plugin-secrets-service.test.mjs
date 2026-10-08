import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginSecretsService } from "../src/main/services/PluginSecretsService.ts";

const pluginId = "com.example.music";

function fakeEncryption(available = true) {
  return {
    isAvailable: () => available,
    encrypt: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`),
    decrypt: (value) => Buffer.from(value.toString().slice("encrypted:".length), "base64").toString()
  };
}

async function fixture(t, { permission = true, available = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-plugin-secrets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new PluginSecretsService(
    root,
    (_pluginId, requested) => {
      assert.equal(requested, "secrets");
      if (!permission) throw new Error("permission denied");
    },
    fakeEncryption(available)
  );
  await service.load();
  return { root, service };
}

test("stores plugin secrets encrypted and restores them", async (t) => {
  const { root, service } = await fixture(t);
  await service.set(pluginId, "oauth-token", "very-secret-value");
  assert.equal(await service.get(pluginId, "oauth-token"), "very-secret-value");
  const bytes = await readFile(join(root, "plugin-secrets", `${pluginId}.bin`));
  assert.equal(bytes.includes(Buffer.from("very-secret-value")), false);
});

test("deletes one secret and revokes all secrets on uninstall", async (t) => {
  const { service } = await fixture(t);
  await service.set(pluginId, "first", "one");
  await service.set(pluginId, "second", "two");
  await service.delete(pluginId, "first");
  assert.equal(await service.get(pluginId, "first"), null);
  assert.equal(await service.get(pluginId, "second"), "two");
  await service.revokeAll(pluginId);
  assert.equal(await service.get(pluginId, "second"), null);
});

test("fails closed without permission or OS-backed encryption", async (t) => {
  const denied = await fixture(t, { permission: false });
  await assert.rejects(() => denied.service.get(pluginId, "token"), /permission denied/);

  const unavailable = await fixture(t, { available: false });
  await assert.rejects(() => unavailable.service.set(pluginId, "token", "secret"), /unavailable/);
});

test("rejects invalid keys and oversized values", async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(() => service.set(pluginId, "not a key", "secret"), /key is invalid/);
  await assert.rejects(() => service.set(pluginId, "token", "x".repeat(16 * 1024 + 1)), /16 KB/);
});

async function uninstallableFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-plugin-secrets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = { installed: true };
  const service = new PluginSecretsService(
    root,
    () => {
      if (!state.installed) throw new Error("Plugin is not installed.");
    },
    fakeEncryption()
  );
  await service.load();
  const secretFile = join(root, "plugin-secrets", `${pluginId}.bin`);
  const secretFileExists = () => access(secretFile).then(() => true, () => false);
  return { service, state, secretFileExists };
}

test("a secret write requested right after revokeAll is refused and leaves no file", async (t) => {
  const { service, secretFileExists } = await uninstallableFixture(t);
  await service.set(pluginId, "token", "before");

  const [revoked, written] = await Promise.allSettled([
    service.revokeAll(pluginId),
    service.set(pluginId, "token", "after")
  ]);

  assert.equal(revoked.status, "fulfilled");
  assert.equal(written.status, "rejected");
  assert.match(written.reason.message, /being removed/);
  assert.equal(await secretFileExists(), false);
  // Once the revocation finished, a reinstalled plugin can store secrets again.
  await service.set(pluginId, "token", "reinstalled");
  assert.equal(await service.get(pluginId, "token"), "reinstalled");
});

test("a queued secret write is refused when the plugin is uninstalled before it runs", async (t) => {
  const { service, state, secretFileExists } = await uninstallableFixture(t);
  const written = service.set(pluginId, "token", "late");
  state.installed = false;
  await assert.rejects(written, /not installed/);
  await service.revokeAll(pluginId);
  assert.equal(await secretFileExists(), false);
});
