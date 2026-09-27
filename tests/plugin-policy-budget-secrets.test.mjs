/**
 * Small extension points a model-backed plugin needs (the CanvasTTY Assistant): `secrets.get` for a service's own
 * secrets. HOME is whatever the test runner's fake HOME is.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validatePluginManifest } from "../src/main/services/PluginManager.ts";
import { PluginServiceSupervisor } from "../src/main/services/PluginServiceSupervisor.ts";

const echoExample = new URL("../examples/plugins/service-echo/", import.meta.url);
const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));
const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-points-")));
process.on("exit", () => { void rm(root, { recursive: true, force: true }); });

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Condition was not met in time.");
};

test("manifests: the examples validate", async () => {
  assert.deepEqual(validatePluginManifest(await readJson(new URL("canvastty.plugin.json", echoExample))).permissions, ["storage", "secrets"]);
});

test("secrets.get: a service reads its own plugin's secret only with the permission", async (t) => {
  const source = await readFile(new URL("services/echo.mjs", echoExample), "utf8");
  const dir = join(root, "echo");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "echo.mjs"), source);
  const asked = [];
  const secrets = new Map([["com.example.service-echo/token", "echo-token-value-9d2f41"]]);
  const supervisor = new PluginServiceSupervisor({
    command: process.execPath, hostVersion: "9.9.9", locale: () => "en", stopGraceMs: 300,
    host: {
      storageGet: async () => null, storageSet: async () => undefined, emit: () => undefined,
      secretGet: async (pluginId, key) => { asked.push(`${pluginId}/${key}`); return secrets.get(`${pluginId}/${key}`) ?? null; }
    }
  });
  t.after(() => supervisor.dispose());
  const spec = (permissions) => ({ pluginId: "com.example.service-echo", serviceId: "echo", root: dir, entryPath: join(dir, "echo.mjs"), sha256: sha256(source), dataDir: join(dir, "data"), permissions });
  await supervisor.sync([spec(["storage"])]);
  await assert.rejects(supervisor.request("com.example.service-echo", "echo", "token", null), /secrets permission/u);
  assert.deepEqual(asked, [], "nothing is read without the permission");
  await supervisor.sync([spec(["storage", "secrets"])]);
  await waitFor(() => supervisor.report("com.example.service-echo").services[0]?.state === "running");
  assert.deepEqual(await supervisor.request("com.example.service-echo", "echo", "token", null), { set: true });
  assert.deepEqual(asked, ["com.example.service-echo/token"], "bound to the service's own plugin");
  secrets.delete("com.example.service-echo/token");
  assert.deepEqual(await supervisor.request("com.example.service-echo", "echo", "token", null), { set: false });
});
