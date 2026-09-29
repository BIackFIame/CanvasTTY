import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCodeAutoEnvironment, openCodePersonRules } from "../src/main/services/openCodeConfig.ts";
import { permissionConfigProblem } from "../src/main/services/LaunchPipeline.ts";
import { coreOwnedLaunchArgument } from "../src/main/services/terminalLaunch.ts";
import { availableProfiles, BYPASS_CHANGES_NOTHING, profileAvailable } from "../src/shared/autoMode.ts";

const rulesOf = (env) => JSON.parse(env.OPENCODE_CONFIG_CONTENT).agent.build.permission;

test("OpenCode auto keeps the person's own deny and ask rules after its allow rules", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "ctty-opencode-rules-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = join(home, "p");
  await mkdir(join(home, ".config", "opencode"), { recursive: true });
  await mkdir(project);
  // JSONC, as OpenCode allows: comments and a trailing comma.
  await writeFile(join(home, ".config", "opencode", "opencode.jsonc"), `{
    // mine
    "permission": { "read": { "*.pem": "deny", "*.md": "allow" }, "bash": { "git push *": "ask" }, },
  }`);
  await writeFile(join(project, "opencode.json"), JSON.stringify({ agent: { build: { permission: { edit: { "secrets/**": "deny" } } } } }));
  const env = { HOME: home, OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { grep: "ask" } }) };
  assert.deepEqual(openCodePersonRules(env, project), {
    read: { "*.pem": "deny" }, bash: { "git push *": "ask" }, edit: { "secrets/**": "deny" }, grep: "ask"
  });
  const rules = rulesOf(openCodeAutoEnvironment(env, { shellGuarded: true, cwd: project }));
  // Last matching rule wins in OpenCode: the person's come last.
  assert.deepEqual(Object.entries(rules.read).at(-1), ["*.pem", "deny"]);
  assert.equal(rules.read["*"], "allow");
  assert.deepEqual(rules.bash, { "*": "allow", "git push *": "ask" });
  assert.deepEqual(rules.edit, { "*": "allow", "secrets/**": "deny" });
  assert.equal(rules.grep, "ask", "a whole-tool ask replaces auto's allow");
  assert.equal(rules.glob, "allow");
});

test("a plugin cannot hand OpenCode or Kimi a configuration that decides approvals", () => {
  const files = [{ relPath: "opencode.json", content: JSON.stringify({ provider: { x: { options: { baseURL: "http://127.0.0.1:1/v1" } } }, model: "x/m" }) }];
  assert.equal(permissionConfigProblem("opencode", { env: { OPENCODE_CONFIG: "{launchFiles}/opencode.json" }, args: [], files }), null, "a provider file is fine");
  const widening = [{ relPath: "opencode.json", content: JSON.stringify({ permission: "allow" }) }];
  assert.match(permissionConfigProblem("opencode", { env: { OPENCODE_CONFIG: "{launchFiles}/opencode.json" }, args: [], files: widening }),
    /sets permission in its OpenCode configuration/u);
  const agentRule = [{ relPath: "o.json", content: JSON.stringify({ agent: { build: { permission: { bash: "allow" } } } }) }];
  assert.match(permissionConfigProblem("opencode", { env: { OPENCODE_CONFIG: "{launchFiles}/o.json" }, args: [], files: agentRule }), /permission/u);
  assert.match(permissionConfigProblem("opencode", { env: { OPENCODE_CONFIG: "/nonexistent/o.json" }, args: [], files: [] }), /cannot check/u);
  assert.match(permissionConfigProblem("opencode", { env: { OPENCODE_PERMISSION: "{\"*\":\"allow\"}" }, args: [], files: [] }), /OPENCODE_PERMISSION/u);
  assert.equal(permissionConfigProblem("kimi", { env: {}, args: ["--config", JSON.stringify({ models: { m: { provider: "p", max_context_size: 1 } } })], files: [] }), null);
  assert.match(permissionConfigProblem("kimi", { env: {}, args: ["--config", JSON.stringify({ default_yolo: true })], files: [] }), /default_yolo/u);
  assert.match(permissionConfigProblem("kimi", { env: {}, args: ["--config-file", "{launchFiles}/k.json"],
    files: [{ relPath: "k.json", content: JSON.stringify({ approval: { auto: true } }) }] }), /approval/u);
});

test("core-owned flags: cursor's --force/-f/--yolo/--approve-mcps and mode switches are CanvasTTY's alone", () => {
  for (const flag of ["--force", "-f", "--yolo", "--approve-mcps", "--mode", "--plan"]) assert.equal(coreOwnedLaunchArgument("cursor", flag), true, flag);
  for (const flag of ["--auto", "--agent"]) assert.equal(coreOwnedLaunchArgument("opencode", flag), true, flag);
  assert.equal(coreOwnedLaunchArgument("grok", "--always-approve"), true);
  assert.equal(coreOwnedLaunchArgument("cursor", "--model"), false);
});

test("the profiles each CLI offers; YOLO that changes nothing is known", () => {
  assert.deepEqual(availableProfiles("claude", false), ["auto", "normal", "acceptEdits", "plan", "yolo"]);
  assert.deepEqual(availableProfiles("codex", false), ["auto", "normal", "acceptEdits", "plan", "yolo"]);
  assert.deepEqual(availableProfiles("opencode", false), ["auto", "normal", "acceptEdits", "plan", "yolo"]);
  assert.deepEqual(availableProfiles("qwen", false), ["normal", "yolo"], "no auto of its own and no isolation layer");
  assert.deepEqual(availableProfiles("qwen", true), ["auto", "normal", "yolo"], "a contained auto inside the layer");
  assert.deepEqual(availableProfiles("cursor", true), ["auto", "normal", "plan", "yolo"]);
  assert.deepEqual(availableProfiles("terminal", true), ["normal"]);
  assert.equal(profileAvailable("kimi", "acceptEdits", true), false);
  assert.deepEqual([...BYPASS_CHANGES_NOTHING].sort(), ["minimax", "pi"]);
});
