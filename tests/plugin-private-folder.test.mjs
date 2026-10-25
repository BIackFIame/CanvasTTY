import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginSessions } from "../src/main/services/PluginSessions.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";

const PLUGIN = "com.example.conductor";

function clis() {
  return {
    get(name) {
      return { state: "available", provider: name, executable: `/resolved/${name}`, launcher: "native", environment: { PATH: "/usr/bin" }, checked: [] };
    },
    snapshot() { return {}; }
  };
}

const spawner = () => () => ({
  pid: 62_000, process: "x", write() {}, resize() {}, kill() {}, pause() {}, resume() {},
  onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }
});

test("C6: a plugin never starts a card inside CanvasTTY's data folder, however the path is spelled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-private-folder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userData = join(root, "userData");
  const project = join(root, "projects", "shop-api");
  const accounts = join(userData, "plugin-data", "com.example.accounts", "account-homes", "a1");
  const accented = join(userData, "café");
  await mkdir(accounts, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(accented, { recursive: true });
  await symlink(accounts, join(root, "projects", "looks-harmless"));

  let sessions = null;
  const terminals = new TerminalManager((channel, payload) => sessions?.observe(channel, payload), clis(), undefined, undefined, true, spawner());
  sessions = new PluginSessions({ terminals, notify: () => true, mayStartOrchestrators: () => true, privateDataFolder: userData });
  const create = (cwd, role = "agent") => sessions.handle(PLUGIN, "main", "sessions.create", { provider: "claude", cwd, role }, ["sessions:launch"]);
  const refused = /CanvasTTY's own data folder/u;

  for (const cwd of [userData, accounts, join(userData, "plugin-data"), join(root, "projects", "looks-harmless"),
    `${userData}/plugin-data/../plugin-data/com.example.accounts`, accented.normalize("NFD")]) {
    assert.throws(() => create(cwd), refused, cwd);
    assert.throws(() => create(cwd, "orchestrator"), refused, cwd);
  }
  assert.equal(terminals.listMetadata().length, 0, "nothing was started");
  // Outside the data folder, and a folder that contains it (the home folder, say), are fine.
  const own = create(project, "orchestrator");
  const above = create(root);
  assert.equal(terminals.listMetadata().length, 2);
  // Fail closed: a relative folder or one that does not resolve is refused before anything starts.
  for (const cwd of ["projects/shop-api", ".", join(root, "missing"), ""]) {
    assert.throws(() => create(cwd), /absolute path to an existing folder/u, cwd);
  }
  assert.equal(terminals.listMetadata().length, 2);
  terminals.dispose(own.sessionId);
  terminals.dispose(above.sessionId);
});

test("C6: the card is created with the folder the host checked, so changing a link afterwards cannot move it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-private-swap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userData = join(root, "userData");
  const project = join(root, "project");
  const secrets = join(userData, "plugin-secrets");
  await mkdir(project, { recursive: true });
  await mkdir(secrets, { recursive: true });
  const link = join(root, "work");
  await symlink(project, link);

  let sessions = null;
  const terminals = new TerminalManager((channel, payload) => sessions?.observe(channel, payload), clis(), undefined, undefined, true, spawner());
  sessions = new PluginSessions({ terminals, notify: () => true, privateDataFolder: userData });
  const { sessionId } = sessions.handle(PLUGIN, "main", "sessions.create", { provider: "claude", cwd: link }, ["sessions:launch"]);
  const expected = await realpath(project);
  assert.equal(terminals.listMetadata().find((metadata) => metadata.id === sessionId).cwd, expected, "the canonical folder, not the link");
  // The link now points into the data folder: the card (and any restart of it) still runs in the checked folder.
  await rm(link);
  await symlink(secrets, link);
  assert.equal(terminals.listMetadata().find((metadata) => metadata.id === sessionId).cwd, expected);
  assert.throws(() => sessions.handle(PLUGIN, "main", "sessions.create", { provider: "claude", cwd: link }, ["sessions:launch"]), /own data folder/u);
  terminals.dispose(sessionId);
});
