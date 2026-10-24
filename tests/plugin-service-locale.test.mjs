import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginServiceSupervisor } from "../src/main/services/PluginServiceSupervisor.ts";
import { PluginCards } from "../src/main/services/PluginCards.ts";

const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Condition was not met in time.");
};

/** Records every host notification; `seen` answers them, `crash` exits. */
const PROBE = `
import { createInterface } from "node:readline";
const seen = [];
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined && m.method) seen.push({ method: m.method, locale: m.params?.locale });
  if (m.method === "seen") send({ id: m.id, result: seen });
  if (m.method === "crash") process.exit(3);
});
`;

async function spec(root, pluginId, serviceId = "probe", source = PROBE) {
  const dir = join(root, pluginId);
  await mkdir(dir, { recursive: true });
  const entryPath = join(dir, `${serviceId}.mjs`);
  await writeFile(entryPath, source);
  return { pluginId, serviceId, root: dir, entryPath, sha256: sha256(source), dataDir: join(dir, "data"), permissions: [] };
}

function supervisorWith(locale, restartDelaysMs = [60_000]) {
  return new PluginServiceSupervisor({
    command: process.execPath,
    hostVersion: "9.9.9",
    locale: () => locale.value,
    requestTimeoutMs: 2_000,
    stopGraceMs: 300,
    restartDelaysMs,
    host: { storageGet: async () => null, storageSet: async () => undefined, emit: () => undefined }
  });
}

const seen = (instance, pluginId) => instance.request(pluginId, "probe", "seen", null);
const localeNotes = (list) => list.filter((entry) => entry.method === "canvastty.locale.changed").map((entry) => entry.locale);

test("a language change reaches every running service once, after its initialize", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-locale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const locale = { value: "en" };
  const instance = supervisorWith(locale);
  t.after(() => instance.dispose());
  await instance.sync([await spec(root, "p.one"), await spec(root, "p.two")]);
  await waitFor(() => instance.running("p.one", "probe") && instance.running("p.two", "probe"));
  await waitFor(async () => (await seen(instance, "p.one")).length === 1 && (await seen(instance, "p.two")).length === 1);

  // A settings save that leaves the language alone sends nothing.
  assert.equal(instance.localeChanged(), 0);
  locale.value = "ru";
  assert.equal(instance.localeChanged(), 2);
  // Saving again with the same language does not repeat it.
  assert.equal(instance.localeChanged(), 0);
  for (const pluginId of ["p.one", "p.two"]) {
    const list = await seen(instance, pluginId);
    assert.deepEqual(list.map((entry) => entry.method), ["canvastty.initialize", "canvastty.locale.changed"]);
    assert.equal(list[0].locale, "en");
    assert.deepEqual(localeNotes(list), ["ru"]);
  }
  locale.value = "en";
  assert.equal(instance.localeChanged(), 2);
  assert.deepEqual(localeNotes(await seen(instance, "p.one")), ["ru", "en"]);
});

test("stopped, restarting and failed services are not notified; a restart starts in the current language", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-locale-stop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const locale = { value: "en" };
  const instance = supervisorWith(locale, [1_500]);
  t.after(() => instance.dispose());
  const kept = await spec(root, "p.kept");
  const removed = await spec(root, "p.removed");
  const crashing = await spec(root, "p.crash");
  const tampered = { ...(await spec(root, "p.tampered")), sha256: "0".repeat(64) };
  await instance.sync([kept, removed, crashing, tampered]);
  await waitFor(() => ["p.kept", "p.removed", "p.crash"].every((id) => instance.running(id, "probe")));
  await waitFor(() => instance.report("p.tampered").services[0]?.state === "failed");
  await assert.rejects(instance.request("p.crash", "probe", "crash", null), /stopped/u);
  assert.equal(instance.report("p.crash").services[0].state, "backoff");
  // Disabling a plugin removes its service.
  await instance.sync([kept, crashing, tampered]);
  assert.equal(instance.running("p.removed", "probe"), false);

  locale.value = "ru";
  assert.equal(instance.localeChanged(), 1, "only the running service is told");
  assert.deepEqual(localeNotes(await seen(instance, "p.kept")), ["ru"]);
  assert.equal(instance.report("p.tampered").services[0].state, "failed");

  assert.equal(instance.report("p.crash").services[0].state, "backoff");
  // The crashed service restarts later and reads the current language in its initialize, with no extra notice.
  await waitFor(() => instance.running("p.crash", "probe"));
  // "starting" counts as running before the process is spawned; a request then is refused, so poll until it answers.
  await waitFor(async () => (await seen(instance, "p.crash").catch(() => [])).length === 1);
  assert.deepEqual(await seen(instance, "p.crash"), [{ method: "canvastty.initialize", locale: "ru" }]);
  assert.equal(instance.localeChanged(), 0);
});

test("a service being started when the language changes gets initialize, then the change, in order", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-locale-start-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const locale = { value: "en" };
  const instance = supervisorWith(locale);
  t.after(() => instance.dispose());
  const syncing = instance.sync([await spec(root, "p.early")]);
  await waitFor(() => instance.report("p.early").services[0]?.state === "starting" || instance.running("p.early", "probe"));
  await syncing;
  locale.value = "ru";
  instance.localeChanged();
  await waitFor(async () => (await seen(instance, "p.early")).length === 2);
  assert.deepEqual(await seen(instance, "p.early"), [
    { method: "canvastty.initialize", locale: "en" },
    { method: "canvastty.locale.changed", locale: "ru" }
  ]);
});

test("canvastty.cards.invoke carries the app language at the moment of the action", async () => {
  const locale = { value: "en" };
  const calls = [];
  const summary = { id: "card-1", provider: "codex", role: "agent", status: "running" };
  const cards = new PluginCards({
    providers: () => [{ pluginId: "p.cards", pluginName: "Cards", serviceId: "svc", actions: [{ id: "report", title: "Report" }] }],
    trustedPlugins: () => new Set(["p.cards"]),
    call: async (pluginId, serviceId, method, params) => {
      calls.push({ method, params });
      return { message: params.locale === "ru" ? "Отчёт готов" : "Report ready", tone: "info" };
    },
    session: (id) => (id === "card-1" ? summary : null),
    redact: (text) => text,
    locale: () => locale.value,
    changed: () => undefined
  });
  assert.deepEqual(await cards.invoke("p.cards", "report", "card-1"), { tone: "info", message: "Report ready" });
  locale.value = "ru";
  assert.deepEqual(await cards.invoke("p.cards", "report", "card-1"), { tone: "info", message: "Отчёт готов" });
  assert.deepEqual(calls.map((call) => call.method), ["canvastty.cards.invoke", "canvastty.cards.invoke"]);
  assert.deepEqual(calls[0].params, { actionId: "report", sessionId: "card-1", session: summary, locale: "en" });
  assert.equal(calls[1].params.locale, "ru");
});

test("the main process wires the settings language into services and card actions", async () => {
  const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
  // Every settings save from the window goes through applyBrowserSettings; it tells services about a new language.
  const apply = source.slice(source.indexOf("applyBrowserSettings: async (next) => {"));
  assert.match(apply.slice(0, 800), /pluginServices\?\.localeChanged\(\);/u);
  const cards = source.slice(source.indexOf("pluginCards = new PluginCards({"));
  assert.match(cards.slice(0, 800), /locale: \(\) => settings\.get\(\)\.locale,/u);
  const ipc = await readFile(new URL("../src/main/ipc/registerIpc.ts", import.meta.url), "utf8");
  assert.match(ipc, /const next = await settings\.update\(patch\);[\s\S]{0,400}await applyBrowserSettings\(next\);/u);
});
