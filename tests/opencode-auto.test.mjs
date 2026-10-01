import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { openCodeAutoEnvironment, openCodePersonRules } from "../src/main/services/openCodeConfig.ts";
import { resolveTerminalLaunch } from "../src/main/services/terminalLaunch.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

// OpenCode 1.18.33: Permission.evaluate is rules.findLast(permission and pattern match), fromConfig turns
// { tool: "action" } into a "*" rule and { tool: { pattern: action } } into one rule per pattern in order, and an
// agent's permission is appended after the top-level one. This shape is what auto gives OpenCode.
const AUTO_RULES = (bash) => ({
  read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
  glob: "allow",
  grep: "allow",
  list: "allow",
  edit: "allow",
  bash
});

test("OpenCode auto is a per-run agent.build permission block after the person's own rules", () => {
  const person = { mcp: { x: { type: "local" } }, permission: { webfetch: "ask", external_directory: { "*": "ask" } },
    agent: { plan: { model: "m" }, build: { temperature: 0.2, permission: { task: "deny" } } } };
  const guarded = JSON.parse(openCodeAutoEnvironment({ OPENCODE_CONFIG_CONTENT: JSON.stringify(person) }, { shellGuarded: true }).OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(guarded.permission, person.permission, "top-level rules, external_directory included, are untouched");
  assert.deepEqual(guarded.mcp, person.mcp);
  assert.deepEqual(guarded.agent.plan, person.agent.plan);
  assert.equal(guarded.agent.build.temperature, 0.2);
  assert.deepEqual(guarded.agent.build.permission, { task: "deny", ...AUTO_RULES("allow") });
  assert.deepEqual(Object.keys(guarded.agent.build.permission.read), ["*", "*.env", "*.env.*", "*.env.example"], "the last matching rule wins");
  const unguarded = JSON.parse(openCodeAutoEnvironment({}, { shellGuarded: false }).OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(unguarded, { agent: { build: { permission: AUTO_RULES("ask") } } }, "without base protection bash still asks");
  const otherModel = JSON.parse(openCodeAutoEnvironment({}, { shellGuarded: true, thirdPartyModel: true }).OPENCODE_CONFIG_CONTENT);
  assert.equal(otherModel.agent.build.permission.bash, "ask");
  // The launch adds no flag for it; normal adds nothing at all.
  const cli = availableRegistry().get("opencode");
  const auto = resolveTerminalLaunch("opencode", "auto", [], { providerCli: cli, shellGuarded: true, environment: {} });
  assert.deepEqual(auto.args, []);
  assert.equal(JSON.parse(auto.environment.OPENCODE_CONFIG_CONTENT).agent.build.permission.bash, "allow");
  assert.equal(resolveTerminalLaunch("opencode", "normal", [], { providerCli: cli, environment: {} }).environment.OPENCODE_CONFIG_CONTENT, undefined);
});

function runtime(decisions) {
  return {
    prepareLaunch: () => ({ args: [], environment: decisions ? { CANVASTTY_RUNTIME_DECISIONS: "1" } : {}, decisions, cleanup() {} }),
    currentStatus: () => null
  };
}

async function launchOpenCode(t, { decisions, baseProtection, profile = "auto" }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-opencode-auto-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, runtime(decisions), true, fakeSpawner(calls));
  terminals.configureBaseProtection(() => baseProtection);
  t.after(() => terminals.disposeAll());
  const session = terminals.create({ provider: "opencode", cwd: root, profile, position: { x: 0, y: 0 } });
  const inline = calls.at(-1).options.env.OPENCODE_CONFIG_CONTENT;
  return { session, permission: inline === undefined ? undefined : JSON.parse(inline).agent?.build?.permission };
}

test("OpenCode auto lets shell commands run without asking only while base protection guards them", async (t) => {
  const guarded = await launchOpenCode(t, { decisions: true, baseProtection: true });
  assert.equal(guarded.session.profile, "auto", "the card shows auto");
  assert.deepEqual(guarded.permission, AUTO_RULES("allow"));
  assert.equal((await launchOpenCode(t, { decisions: true, baseProtection: false })).permission.bash, "ask", "base protection off: ask");
  assert.equal((await launchOpenCode(t, { decisions: false, baseProtection: true })).permission.bash, "ask", "no guard installed: ask");
  assert.equal((await launchOpenCode(t, { decisions: true, baseProtection: true, profile: "normal" })).permission, undefined, "normal: no auto rules");
});

test("OpenCode auto treats an existing uninspectable FIFO as unknown and grants no Auto permissions", { skip: process.platform === "win32" }, async (t) => {
  const { mkdir } = await import("node:fs/promises");
  const { spawnSync } = await import("node:child_process");
  const home = await mkdtemp(join(tmpdir(), "ctty-opencode-fifo-auto-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configDir = join(home, ".config", "opencode");
  await mkdir(configDir, { recursive: true });
  assert.equal(spawnSync("mkfifo", [join(configDir, "opencode.json")]).status, 0);
  const env = { HOME: home };
  const person = openCodePersonRules(env, home);
  assert.equal(person.unknown, true);
  const result = JSON.parse(openCodeAutoEnvironment(env, { shellGuarded: true, cwd: home }).OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(result.agent.build.permission, {});
});

test("OpenCode Auto keeps ancestor restrictions when the working directory is more than 64 levels deep", () => {
  const root = join(tmpdir(), "ctty-deep-config-project");
  const cwd = join(root, ...Array.from({ length: 70 }, () => "nested"));
  const environment = { HOME: join(tmpdir(), "ctty-deep-config-home") };
  const readFile = (path) => path === join(root, "opencode.json")
    ? '{"permission":{"bash":"deny"}}' : null;
  const person = openCodePersonRules(environment, cwd, readFile);
  assert.equal(person.unknown, false);
  assert.equal(person.top.bash, "deny");
  const config = JSON.parse(openCodeAutoEnvironment(environment, { cwd, readFile, shellGuarded: true }).OPENCODE_CONFIG_CONTENT);
  assert.equal(config.agent.build.permission.bash, "deny");
});
