/**
 * Base protection of CanvasTTY's own private data: its control token and descriptor, the gateways' connection
 * records and sockets, the secret stores and account homes. Everything lives in temporary folders: HOME and the
 * userData folder are fakes, nothing real is read, and no socket is opened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeAction } from "../src/main/services/safety/commandFacts.ts";
import { canvasTtyPrivateData, checkBaseProtection, denyRule } from "../src/main/services/safety/baseProtection.ts";
import { DecisionHooks } from "../src/main/services/DecisionHooks.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "canvastty-app-private-")));
const home = join(base, "home");
const project = join(base, "project");
const userData = join(home, "Library", "Application Support", "canvastty");
const control = join(userData, "agent-control");
for (const dir of [project, join(project, "src"), join(project, "agent-control"), control, join(userData, "plugin-secrets"), join(userData, "account-homes", "acct-1", ".claude"), join(userData, "lifecycle", "runtime")]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(control, "token-0123abcd"), "fake-token\n", { mode: 0o600 });
writeFileSync(join(control, "connection.json"), "{}\n", { mode: 0o600 });
writeFileSync(join(userData, "settings.json"), "{}\n");
writeFileSync(join(project, "agent-control", "token-1"), "fixture\n");
process.on("exit", () => rmSync(base, { recursive: true, force: true }));

const privateData = canvasTtyPrivateData(userData);
const token = join(control, "token-0123abcd");
const shell = (command) => ({ kind: "shell", command, commandCwd: null, paths: [] });
const rule = (command, extra = {}) => denyRule(analyzeAction(shell(command), project, { home, privateData, ...extra }));
const q = (path) => `'${path}'`;
const sock = "$TMPDIR/ctty-control-Ab12Cd/c.sock";

const DENY = [
  // Reading the token and the descriptor, whatever the program.
  `cat ${q(token)}`,
  `cat "$HOME/Library/Application Support/canvastty/agent-control/token-0123abcd"`,
  "cat ~/Library/Application\\ Support/canvastty/agent-control/token-*",
  `head -c 64 ${q(join(control, "connection.json"))}`,
  `grep -a . ${q(token)}`,
  `cp ${q(token)} ./copy.txt`,
  `base64 < ${q(token)}`,
  `xxd ${q(join(userData, "provider-secrets.bin"))}`,
  `strings ${q(join(userData, "provider-secrets.bin"))}`,
  `sqlite3 ${q(join(userData, "account-homes", "acct-1", "state.db"))} .dump`,
  `cat ${q(join(userData, "github-oauth.json"))}`,
  `cat ${q(join(userData, "lifecycle", "runtime", "connection.json"))}`,
  `ls ${q(control)}`,
  `cd ${q(control)} && cat token-0123abcd`,
  `cd ${q(userData)} && cat agent-control/token-0123abcd`,
  `echo "$(cat ${q(token)})"`,
  `bash -c "cat ${q(token)}"`,
  `find ${q(userData)} -name 'token-*'`,
  `grep -r token ${q(userData)}`,
  `rg secret ${q(userData)}`,
  `tar -czf out.tgz ${q(userData)}`,
  `cat ${q(userData)}/*/token-*`,
  "cat \"$CANVASTTY_CONTROL_CONNECTION\"",
  "echo $CANVASTTY_RUNTIME_CAPABILITY",
  // Interpreter one-liners and heredocs.
  `python3 -c "print(open('${token}').read())"`,
  "python3 -c \"import os;p=os.path.join(os.path.expanduser('~'),'Library','Application Support','canvastty','agent-control');print(os.listdir(p))\"",
  "node -e \"console.log(require('fs').readFileSync(process.env.HOME + '/Library/Application Support/canvastty/plugin-secrets/x', 'utf8'))\"",
  `python3 - <<'EOF'\nprint(open("${token}").read())\nEOF`,
  // The control and runtime sockets.
  `curl --unix-socket ${sock} http://localhost/`,
  `curl -s --unix-socket=${sock} http://x/`,
  `nc -U ${sock}`,
  "echo '{\"v\":1}' | nc -U $TMPDIR/ctty-orch-501-abcd1234/o.sock",
  `socat - UNIX-CONNECT:${sock}`,
  "ls $TMPDIR/ctty-control-*",
  "cat $TMPDIR/ctty-*/c.sock",
  "python3 -c \"import socket,os;s=socket.socket(socket.AF_UNIX);s.connect(os.environ['TMPDIR']+'/ctty-control-x/c.sock')\"",
  `nc -U ${q(join(userData, "lifecycle", "runtime", "r-ab12.sock"))}`,
  // A controlled-looking word that is not the CLI does not excuse the rest.
  `cat ${q(token)} canvastty-control.mjs`
];

const ALLOW = [
  "cat src/agent-control.ts",
  "cat agent-control/token-1",
  "grep -rn \"plugin-secrets\" src",
  "git commit -m \"fix agent-control token file mode\"",
  `cat ${q(join(userData, "settings.json"))}`,
  `ls ${q(userData)}`,
  "node \"$CANVASTTY_CONTROL_CLI\" list",
  `node /Applications/CanvasTTY.app/Contents/Resources/agent-control/canvastty-control.mjs --connection ${q(join(control, "connection.json"))} list`,
  "curl --unix-socket /var/run/docker.sock http://localhost/version",
  "nc -U /tmp/other.sock",
  "ls $TMPDIR",
  "ls /tmp/ctty-notes",
  "python3 -c \"print('canvastty')\"",
  "cat ~/.config/other/token",
  "node -e \"console.log(1)\"",
  "curl https://example.com/agent-control/token-1",
  "echo hi > out.txt"
];

test("CanvasTTY's own tokens, secret stores and sockets are refused for every reader and client", () => {
  for (const command of DENY) assert.equal(rule(command), "app-private", command);
});

test("look-alikes in the project, the app's other files and other sockets stay allowed", () => {
  for (const command of ALLOW) assert.equal(rule(command), null, command);
});

test("file tools that name private data are refused; the agent's own account home is its own", () => {
  const check = (toolName, toolInput, extra = {}) => checkBaseProtection({ toolName, toolInput, root: project, home, privateData, ...extra });
  assert.equal(check("Write", { file_path: join(control, "token-x"), content: "x" })?.rule, "app-private");
  assert.equal(check("edit", { file_path: "~/Library/Application Support/canvastty/plugin-secrets/p.json" })?.rule, "app-private");
  const accountHome = join(userData, "account-homes", "acct-1", ".claude");
  assert.equal(check("Write", { file_path: join(accountHome, "plans", "p.md") }, { agentRoots: [accountHome] }), null);
  assert.equal(check("Bash", { command: `cat ${q(join(accountHome, "projects", "p", "memory", "MEMORY.md"))}` }, { agentRoots: [accountHome] }), null);
  assert.equal(check("Bash", { command: `cat ${q(token)}` }, { agentRoots: [accountHome] })?.rule, "app-private");
});

test("without the app's folder the socket folders are still known; the userData paths are not guessed", () => {
  assert.equal(denyRule(analyzeAction(shell(`nc -U ${sock}`), project, { home })), "app-private");
  assert.equal(denyRule(analyzeAction(shell(`cat ${q(token)}`), project, { home })), null);
});

test("the message tells the model calmly why and what to do instead, without paths or protocol details", () => {
  const verdict = checkBaseProtection({ toolName: "Bash", toolInput: { command: `cat ${q(token)}` }, root: project, home, privateData });
  assert.equal(verdict.rule, "app-private");
  assert.match(verdict.message, /^CanvasTTY blocked this: it reads CanvasTTY's own access tokens/u);
  assert.match(verdict.message, /Orchestrator role/u);
  assert.match(verdict.message, /canvastty_agents tools \(spawn_agent, list_routes, wait_for_agent/u);
  assert.doesNotMatch(verdict.message, /token-|\.sock|agent-control|Application Support|ctty-/u);
});

test("decision hooks pass the app's private data to base protection", async () => {
  const hooks = new DecisionHooks({
    baseProtection: () => true, services: () => [], call: async () => null, home, privateData,
    session: () => ({ provider: "opencode", role: "agent", cwd: project, configDirs: [] })
  });
  const decision = await hooks.decide("s1", { toolName: "bash", toolInput: { command: `cat ${q(token)}` }, toolInputPreview: null, cwd: null, truncated: false }, new AbortController().signal);
  assert.equal(decision.behavior, "deny");
  assert.match(decision.message, /Orchestrator role/u);
  const ordinary = await hooks.decide("s1", { toolName: "bash", toolInput: { command: "cat src/a.ts" }, toolInputPreview: null, cwd: null, truncated: false }, new AbortController().signal);
  assert.equal(ordinary.behavior, "none");
});
