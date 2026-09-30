import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCodeAutoEnvironment, openCodePersonRules } from "../src/main/services/openCodeConfig.ts";
import { permissionConfigProblem } from "../src/main/services/LaunchPipeline.ts";
import { coreOwnedLaunchArgument } from "../src/main/services/terminalLaunch.ts";
import { availableProfiles, BYPASS_CHANGES_NOTHING, profileAvailable } from "../src/shared/autoMode.ts";


// OpenCode 1.18.33's decision for the build agent (agent.ts, permission/index.ts, core/util/wildcard.ts): its
// defaults, the merged top-level permission, then the merged agent.build.permission; the last rule whose key and
// pattern both match wins. Config objects merge with remeda's mergeDeep (a key keeps its first place).
const OPENCODE_DEFAULTS = { "*": "allow", doom_loop: "ask", external_directory: { "*": "ask" }, question: "deny",
  read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" } };
const match = (input, pattern) => {
  let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, "s").test(input);
};
const fromConfig = (block = {}) => Object.entries(typeof block === "string" ? { "*": block } : block).flatMap(([permission, rule]) =>
  typeof rule === "string" ? [{ permission, pattern: "*", action: rule }] : Object.entries(rule).map(([pattern, action]) => ({ permission, pattern, action })));
const mergeDeep = (target, source) => {
  const result = { ...target };
  for (const [key, value] of Object.entries(source ?? {})) {
    const current = result[key];
    const plain = (item) => item && typeof item === "object" && !Array.isArray(item);
    result[key] = plain(current) && plain(value) ? mergeDeep(current, value) : value;
  }
  return result;
};
/** What OpenCode decides for `tool` on `input`, given the config files it reads (in its order) and the inline config. */
function decide(files, inlineConfig, tool, input = "*") {
  const config = [...files, inlineConfig].reduce((merged, next) => mergeDeep(merged, next), {});
  const rules = [...fromConfig(OPENCODE_DEFAULTS), ...fromConfig(config.permission), ...fromConfig(config.agent?.build?.permission)];
  return rules.findLast((rule) => match(tool, rule.permission) && match(input, rule.pattern))?.action ?? "ask";
}
const inlineOf = (env) => JSON.parse(env.OPENCODE_CONFIG_CONTENT);
const auto = (env, options = {}) => inlineOf(openCodeAutoEnvironment(env, { shellGuarded: true, readFile: () => null, ...options }));

test("OpenCode auto never overrides the person's wildcard deny or ask (the reviewer's case)", () => {
  for (const action of ["deny", "ask"]) {
    const person = { permission: { "*": action } };
    const result = auto({ OPENCODE_CONFIG_CONTENT: JSON.stringify(person) });
    for (const tool of ["read", "glob", "grep", "list", "edit", "bash"]) {
      assert.equal(decide([], result, tool, "src/a.ts"), action, `${tool} stays ${action}`);
      assert.equal(result.agent?.build?.permission?.[tool], undefined, `auto adds nothing for ${tool}`);
    }
  }
  // A single word for the whole permission means every tool, like "*".
  assert.equal(decide([], auto({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: "deny" }) }), "edit"), "deny");
  // A wildcard key reaches the tools it matches only.
  const partial = auto({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { "ed*": "deny", "b?sh": "ask" } }) });
  assert.equal(decide([], partial, "edit"), "deny");
  assert.equal(decide([], partial, "bash", "ls"), "ask");
  assert.equal(decide([], partial, "grep"), "allow", "the tools the person did not restrict still get auto");
  // The person's own later allow keeps working, and auto does not turn their catch-all ask into an allow elsewhere.
  const mixed = auto({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { "*": "ask", read: "allow" } }) });
  assert.equal(decide([], mixed, "read", "a.ts"), "allow");
  assert.equal(decide([], mixed, "edit", "a.ts"), "ask");
  // An agent-level wildcard in the inline config counts the same.
  const agentLevel = auto({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { build: { permission: { "*": "deny" } } } }) });
  assert.equal(decide([], agentLevel, "bash", "ls"), "deny");
  assert.equal(decide([], agentLevel, "edit"), "deny");
});

test("OpenCode auto keeps the person's specific rules for a tool after its own, from files and the inline config", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "ctty-opencode-rules-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = join(home, "work", "p");
  await mkdir(join(home, ".config", "opencode"), { recursive: true });
  await mkdir(project, { recursive: true });
  // JSONC, as OpenCode allows: comments and a trailing comma.
  const globalText = `{
    // mine
    "permission": { "read": { "*.pem": "deny", "*.md": "allow" }, "bash": { "git push *": "ask" }, },
  }`;
  await writeFile(join(home, ".config", "opencode", "opencode.jsonc"), globalText);
  // A project config one folder up from where the agent starts.
  const parentConfig = { permission: { edit: { "secrets/**": "deny" } } };
  await writeFile(join(home, "work", "opencode.json"), JSON.stringify(parentConfig));
  const inline = { permission: { grep: "ask" } };
  const env = { HOME: home, OPENCODE_CONFIG_CONTENT: JSON.stringify(inline) };
  const person = openCodePersonRules(env, project);
  assert.equal(person.unknown, false);
  assert.deepEqual(person.top, { read: { "*.pem": "deny", "*.md": "allow" }, bash: { "git push *": "ask" }, edit: { "secrets/**": "deny" }, grep: "ask" });
  const result = inlineOf(openCodeAutoEnvironment(env, { shellGuarded: true, cwd: project }));
  const files = [{ permission: { read: { "*.pem": "deny", "*.md": "allow" }, bash: { "git push *": "ask" } } }, parentConfig];
  assert.equal(decide(files, result, "bash", "ls -la"), "allow", "auto opens the shell (guarded)");
  assert.equal(decide(files, result, "bash", "git push origin main"), "ask", "the person's ask still wins");
  assert.equal(decide(files, result, "edit", "secrets/key.txt"), "deny");
  assert.equal(decide(files, result, "edit", "src/a.ts"), "allow");
  assert.equal(decide(files, result, "read", "id.pem"), "deny");
  assert.equal(decide(files, result, "read", ".env"), "ask");
  assert.equal(decide(files, result, "grep"), "ask", "a whole-tool ask replaces auto's allow");
  assert.equal(result.agent.build.permission.grep, "ask");
  assert.equal(decide(files, result, "glob"), "allow");
});

test("OpenCode auto leaves a tool alone when the person's files name it for the build agent, or cannot be read", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "ctty-opencode-agent-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = join(home, "p");
  await mkdir(join(project, ".opencode", "agent"), { recursive: true });
  await mkdir(join(home, ".config", "opencode"), { recursive: true });
  // A file-level agent.build rule would keep its place when OpenCode merges the inline config in: auto stays out.
  const fileAgent = { agent: { build: { permission: { bash: { "rm *": "deny" } } } } };
  await writeFile(join(project, "opencode.json"), JSON.stringify(fileAgent));
  // An agent file's front matter counts as the build agent's permission too.
  await writeFile(join(project, ".opencode", "agent", "build.md"), "---\npermission:\n  edit: ask\n---\nBuild things.\n");
  const env = { HOME: home };
  const result = inlineOf(openCodeAutoEnvironment(env, { shellGuarded: true, cwd: project }));
  assert.equal(result.agent.build.permission.bash, undefined);
  assert.equal(result.agent.build.permission.edit, undefined);
  assert.equal(result.agent.build.permission.grep, "allow");
  const files = [fileAgent, { agent: { build: { permission: { edit: "ask" } } } }];
  assert.equal(decide(files, result, "bash", "rm -rf x"), "deny");
  assert.equal(decide(files, result, "edit"), "ask");

  // A configuration that exists but cannot be parsed: auto assumes nothing and opens nothing.
  await writeFile(join(home, ".config", "opencode", "opencode.json"), "{ \"permission\": { \"*\": \"deny\" ");
  const broken = inlineOf(openCodeAutoEnvironment(env, { shellGuarded: true, cwd: project }));
  assert.equal(openCodePersonRules(env, project).unknown, true);
  assert.deepEqual(broken.agent.build.permission, {});
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

test("a contributor's configuration path that is a FIFO or oversized is refused at once, never read blocking the app", { skip: process.platform === "win32" }, async (t) => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { spawnSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const folder = await mkdtemp(join(tmpdir(), "canvastty-config-fifo-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const fifo = join(folder, "opencode.json");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  const huge = join(folder, "huge.json");
  await writeFile(huge, `{"x":"${"a".repeat(2 * 1024 * 1024)}"}`);
  // In a child: the old synchronous read of a FIFO with no writer never returns.
  const script = `
    const { permissionConfigProblem } = await import(${JSON.stringify(new URL("../src/main/services/LaunchPipeline.ts", import.meta.url).href)});
    for (const path of process.argv.slice(1)) console.log(JSON.stringify(permissionConfigProblem("opencode", { env: { OPENCODE_CONFIG: path }, args: [], files: [] })));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, fifo, huge], { encoding: "utf8", timeout: 20_000 });
  assert.equal(child.signal, null, "it did not hang");
  const answers = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(answers.length, 2);
  for (const answer of answers) assert.match(answer, /cannot check/u);
});
