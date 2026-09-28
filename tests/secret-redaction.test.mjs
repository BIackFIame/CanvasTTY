/**
 * The secret redaction registry (EP-8), ported from the local chain's credential and child-text redaction tests.
 * Every key-shaped fixture is assembled at run time, so the repository secret audit has nothing to find here.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SecretRedactionRegistry, redactCredentials } from "../src/main/services/safety/SecretRedaction.ts";
import { ProviderSecretsService } from "../src/main/services/ProviderSecretsService.ts";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { SECRET_PATTERNS } from "../scripts/audit-secrets.mjs";

const run = (character, length) => character.repeat(length);
const sk = (...parts) => ["sk", ...parts].join("-");
const mixed = ["Q7vX2mK9", "pL4sT8wZ", "1nB6cR3y", "H5jD0fGa"].join(""); // 32 characters, high entropy
const secrets = {
  "private-key": `-----${"BEGIN"} RSA ${"PRIVATE"} KEY-----\n${run("M", 40)}\n-----${"END"} RSA ${"PRIVATE"} KEY-----`,
  anthropic: ["sk", "ant", run("a", 24)].join("-"),
  openai: sk(run("b", 30)),
  github: `${"ghp"}_${run("c", 30)}`,
  "github-pat": `${"github"}_pat_${run("D", 30)}`,
  slack: `${"xoxb"}-${run("1", 20)}`,
  aws: `${"AKIA"}${"ABCDEFGHIJKLMNOP"}`,
  jwt: [`${"eyJ"}${run("a", 12)}`, run("b", 12), run("c", 12)].join("."),
  xai: `${"xai"}-${run("Z", 30)}`,
  google: `${"AIza"}${run("Q", 35)}`
};

test("every credential shape is masked, including the ones the repository secret audit checks", () => {
  for (const [kind, secret] of Object.entries(secrets)) {
    const text = redactCredentials(`before ${secret} after`);
    assert.equal(text.includes(secret), false, kind);
    assert.match(text, /^before <redacted:[a-z-]+> after$/u, kind);
  }
  assert.equal(redactCredentials(`Authorization: Bearer ${run("t", 24)}`), "Authorization: <redacted:authorization>");
  assert.equal(redactCredentials(`curl -H "Bearer ${run("u", 24)}"`), `curl -H "Bearer <redacted:bearer>"`);
  assert.equal(redactCredentials(`https://deploy:${run("p", 12)}@example.test/repo`), "https://<redacted:url-credentials>@example.test/repo");
  assert.equal(redactCredentials("https://git@example.test/repo"), "https://git@example.test/repo", "a plain user name is not a credential");
  assert.equal(redactCredentials(`https://example.test/cb?code=7&access_token=${run("z", 16)}&sig=abc123`), "https://example.test/cb?code=7&access_token=<redacted:url-secret>&sig=<redacted:url-secret>");
  const clientSecret = ["client", "secret"].join("_");
  assert.equal(
    redactCredentials(`OPENAI_API_KEY=plainvalue123\n${clientSecret}: "two words here"\nPASSWD=hunter22 apiToken=abcd1234`),
    `OPENAI_API_KEY=<redacted:assignment>\n${clientSecret}: <redacted:assignment>\nPASSWD=<redacted:assignment> apiToken=<redacted:assignment>`
  );
  assert.equal(redactCredentials(`random ${mixed} end`), "random <redacted:high-entropy> end");
  assert.equal(redactCredentials(`ANTHROPIC_API_KEY=${secrets.anthropic}`), "ANTHROPIC_API_KEY=<redacted:anthropic>");
});

test("every positive fixture of the audit's credential patterns is masked", () => {
  const fixtures = {
    "private key": secrets["private-key"], "Anthropic token": secrets.anthropic, "OpenAI-style token": secrets.openai,
    "GitHub token": secrets.github, "Slack token": secrets.slack, "AWS access key": secrets.aws, JWT: secrets.jwt,
    "hard-coded secret assignment": `${["api", "key"].join("_")} = "${run("k", 16)}"`
  };
  for (const [rule, pattern] of SECRET_PATTERNS) {
    if (rule === "personal home path") continue;
    const fixture = fixtures[rule];
    assert.ok(fixture, `a fixture exists for ${rule}`);
    pattern.lastIndex = 0;
    assert.ok(pattern.test(fixture), `the fixture is positive for ${rule}`);
    pattern.lastIndex = 0;
    assert.equal(pattern.test(redactCredentials(fixture)), false, rule);
  }
});

test("ordinary text, paths and commit SHAs are unchanged; masking is idempotent", () => {
  for (const text of [
    "Fix the settings panel so that Save works; run npm test afterwards.",
    "src/renderer/src/features/settings/ProviderAccountsSettings2.tsx and /work/project/src/main/index.ts",
    `commit ${"3f2a9c1d4e5b6a7f8c9d0e1f2a3b4c5d6e7f8a9b"} fixed it`,
    "max_tokens: 4096, monkey = banana, keyboard=qwerty, the key point is clarity",
    "uuid 123e4567-e89b-12d3-a456-426614174000 and handleProviderAccountLaunchServiceFixture",
    "Hello world 1234\nline two 5678", "tokens: 4096", "secretary: Jane Doe", "TOKEN_COUNT=4096"
  ]) assert.equal(redactCredentials(text), text, text);
  const once = redactCredentials(`${secrets.openai} ${secrets.github} Authorization: Bearer ${run("t", 20)}`);
  assert.equal(redactCredentials(once), once);
});

test("masking stays linear on long runs of name-like text", () => {
  for (const unit of ["a-", "ab.", "Token-", "key_", "x.", "Ab1\n"]) {
    const started = performance.now();
    redactCredentials(unit.repeat(Math.floor(60000 / unit.length)));
    assert.ok(performance.now() - started < 1000, `${JSON.stringify(unit)} took ${Math.round(performance.now() - started)} ms`);
  }
});

/** What OpenCode printed in a live run: the config with its key, wrapped by the terminal inside a box. */
function boxedDump(key) {
  const config = `{"provider":{"x":{"options":{"baseURL":"https://api.example.test/v1","apiKey":"${key}"}}}}`;
  const lines = [];
  for (let at = 0; at < config.length; at += 40) lines.push(`│   ${config.slice(at, at + 40)}`);
  return `Error: Config file is not valid JSON(C):\n${lines.join("\r\n")}\n└─ fix the config and try again\n`;
}

test("registry: a held value is removed also when wrapping split it across box lines, and in its JSON-escaped form", () => {
  const registry = new SecretRedactionRegistry();
  const key = `${sk("cp", "Qx7vN2mK9pL4")}\\${"rT8wY1zB5cD3fG6hJ0aE"}`; // a key holding a backslash
  registry.add("vault", [key, "cat"]);
  const screen = boxedDump(JSON.stringify(key).slice(1, -1));
  const redacted = registry.redact(screen);
  for (const part of [key.slice(0, 12), key.slice(12, 24), key.slice(24)]) assert.equal(redacted.replace(/\s|│/gu, "").includes(part), false, part);
  assert.match(redacted, /not valid JSON\(C\)/u, "the rest of the screen stays readable");
  const escaped = JSON.stringify(key).slice(1, -1);
  assert.equal(registry.redact(`key: ${escaped.slice(0, 15)}\n      ${escaped.slice(15)} done`), "key: <redacted:secret> done");
  assert.equal(registry.redact(redacted), redacted, "idempotent");
  assert.equal(registry.redact("the cat sat"), "the cat sat", "values too short to be keys are ignored");
  // Owners are forgotten on their own: a closed card's launch secret stops being searched for.
  const launch = ["launch", "secret", "4d9e1b77"].join("-");
  registry.add("session:a", [launch]);
  assert.equal(registry.redact(`x ${launch}`), "x <redacted:secret>");
  registry.clear("session:a");
  assert.equal(registry.redact(`x ${launch}`), `x ${launch}`);
});

test("registry: generic shapes without a held value, including keys the terminal wrapped over lines", () => {
  const registry = new SecretRedactionRegistry();
  const unknown = ["Zp8Rk2Wq", "5Tn9Xm3V", "b7Lc4Hd1", "Gs6Jf0Ay"].join("");
  const json = registry.redact(`{"apiKey":"${unknown.slice(0, 10)}\n    ${unknown.slice(10)}","baseURL":"https://x.example"}`);
  assert.equal(json.includes(unknown.slice(0, 10)) || json.includes(unknown.slice(10)), false);
  assert.match(json, /"baseURL":"https:\/\/x\.example"/u);
  const key = sk("A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6");
  const wrapped = registry.redact(`${key.slice(0, 25)}\n${key.slice(25)} ok\nnext line`);
  assert.equal(wrapped, "<redacted:openai> ok\nnext line");
  const random = registry.redact(`token ${unknown.slice(0, 16)}\n  ${unknown.slice(16)}\nplain words`);
  assert.equal(random.includes(unknown.slice(16)), false);
  assert.match(random, /plain words/u);
});

test("the vault hands every value it reads or writes to the registry; agent-readable text is masked", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-redaction-vault-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new SecretRedactionRegistry();
  const encryption = { isAvailable: () => true, encrypt: (value) => Buffer.from(value, "utf8"), decrypt: (value) => value.toString("utf8") };
  const value = ["vault", "value", "9c1e7a55"].join("-");
  await new ProviderSecretsService(directory, encryption, (values) => registry.add("vault", values)).set("OPENAI_API_KEY", value);
  const reread = new SecretRedactionRegistry();
  await new ProviderSecretsService(directory, encryption, (values) => reread.add("vault", values)).status();
  assert.equal(reread.redact(`key ${value}`), "key <redacted:secret>", "read back in a later run too");

  const manager = new TerminalManager(() => undefined, { get: () => ({ state: "unavailable" }), snapshot: () => ({}) });
  manager.configureRedaction(registry);
  const control = new AgentControlService({
    getMetadata: (id) => (id === "s1" ? { id: "s1", provider: "claude", status: "working", exitCode: null } : null),
    readBuffer: () => ({ buffer: `env OPENAI=${value}\n${secrets.github}\n` }),
    redactSecrets: (text) => manager.redactSecrets(text)
  });
  const observed = control.observe("s1").output;
  assert.equal(observed.includes(value) || observed.includes(secrets.github), false);
  assert.match(observed, /env OPENAI=<redacted:secret>/u);
});

// A custom secret with no generic token shape: once its head is cut away, nothing but the full value identifies it.
const PLAIN_SECRET = "purple-otter-marmalade-sings-loudly";
const fragments = (text) => {
  const found = [];
  for (let size = 6; size < PLAIN_SECRET.length; size++) {
    for (let start = 0; start + size <= PLAIN_SECRET.length; start++) {
      const piece = PLAIN_SECRET.slice(start, start + size);
      if (/[a-z]-[a-z]/u.test(piece) && text.includes(piece)) found.push(piece);
    }
  }
  return found;
};

function cutFixture(t) {
  const registry = new SecretRedactionRegistry();
  registry.add("plugin:p.custom", [PLAIN_SECRET]);
  const prints = [];
  const exits = [];
  let sessions;
  const terminals = new TerminalManager((channel, payload) => sessions?.observe(channel, payload),
    { get: (provider) => ({ state: "available", provider, executable: `/resolved/${provider}`, launcher: "native", environment: {}, checked: [] }), snapshot: () => ({}) },
    undefined, undefined, true, () => ({ pid: 1, write() {}, resize() {}, kill() {},
      onData(listener) { prints.push(listener); return { dispose() {} }; },
      onExit(listener) { exits.push(listener); return { dispose() {} }; } }));
  t.after(() => terminals.shutdown());
  terminals.configureRedaction(registry);
  const card = terminals.create({ provider: "claude", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 } });
  return { terminals, card, print: (text) => prints.forEach((listener) => listener(text)), exit: (code) => exits.forEach((listener) => listener({ exitCode: code })),
    attach: (value) => { sessions = value; } };
}

test("observe_agent and get_agent_result mask the whole buffer before cutting the tail: no fragment of a custom secret survives", async (t) => {
  const f = cutFixture(t);
  const control = new AgentControlService(f.terminals);
  // The 300-character observation starts 12 characters before the secret ends.
  f.print(`${"a".repeat(1_000)}${PLAIN_SECRET}${"b".repeat(288)}`);
  const observed = control.observe(f.card.id, 300).output;
  assert.ok(observed.length <= 300, "the bound is kept");
  assert.deepEqual(fragments(observed), []);
  // get_agent_result's 8 192-character tail, cut inside the secret the same way.
  f.print(`${PLAIN_SECRET}${"c".repeat(8_192 - 10)}`);
  const result = control.result(f.card.id).output;
  assert.ok(result.length <= 8_192);
  assert.deepEqual(fragments(result), []);
  // Wrapped secrets are still masked whole.
  f.print(`\r\n${PLAIN_SECRET.slice(0, 15)}\r\n${PLAIN_SECRET.slice(15)}\r\n`);
  assert.deepEqual(fragments(control.observe(f.card.id, 8_192).output), []);
});

test("plugin screen text and failure details mask the whole buffer before cutting", async (t) => {
  const { PluginSessions } = await import("../src/main/services/PluginSessions.ts");
  const f = cutFixture(t);
  const screens = [];
  const sessions = new PluginSessions({ terminals: f.terminals, notify: (_p, _s, _m, event) => { if (event.screen !== undefined) screens.push(event.screen); return true; } });
  f.attach(sessions);
  sessions.handle("p.reader", "svc", "sessions.subscribe", {}, ["sessions:events", "sessions:read-screen"]);
  // The 4 000-character screen starts 12 characters before the secret ends.
  f.print(`${PLAIN_SECRET}${"d".repeat(4_000 - 12)}`);
  f.terminals.applyProviderSignal(f.card.id, { kind: "lifecycle", state: "working" });
  f.terminals.applyProviderSignal(f.card.id, { kind: "lifecycle", state: "idle" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(screens.length > 0 && screens.every((screen) => screen.length <= 4_000));
  assert.deepEqual(fragments(screens.join("\n")), []);
  // Failure details keep the last 8 000 characters of the output: cut inside the secret too.
  f.print(`\r\n${"e".repeat(50)}${PLAIN_SECRET}${"f".repeat(8_000 - 1 - 12)}`);
  f.exit(3);
  const failed = f.terminals.list().find((session) => session.id === f.card.id);
  assert.equal(failed.status, "failed");
  assert.ok(failed.failureDetails.length <= 8_000);
  assert.deepEqual(fragments(failed.failureDetails), []);
});

// Ordinary agent output around the secrets below: colour, paths, numbers, box sides.
function scrollback(chars) {
  let text = "";
  for (let i = 0; text.length < chars; i++) {
    text += `\x1b[32m✓\x1b[0m step ${i} src/main/Example.ts:${i} took ${i % 97} ms\r\n`;
    if (i % 9 === 0) text += `│ ${"─".repeat(40)} │\r\n`;
  }
  return text.slice(0, chars);
}

test("redactTail returns exactly what masking the whole text and cutting it returns, wherever the secrets fall", () => {
  const registry = new SecretRedactionRegistry();
  registry.add("plugin:p.custom", [PLAIN_SECRET]);
  const wrapped = `${PLAIN_SECRET.slice(0, 15)}\r\n${PLAIN_SECRET.slice(15)}`;
  const pem = (body) => `-----${"BEGIN"} RSA ${"PRIVATE"} KEY-----\n${body}\n-----${"END"} RSA ${"PRIVATE"} KEY-----`;
  const samples = [
    PLAIN_SECRET, wrapped, secrets.openai, secrets.github, secrets.jwt, secrets.google, mixed,
    `\r\n${sk(run("q", 18))}\r\n${run("7", 12)}x${run("R", 8)}\r\n`, `"apiKey": "${run("k", 30)}"`,
    `export OPENAI_API_KEY=${run("v", 24)}`, `Authorization: Bearer ${run("t", 24)}`,
    `https://deploy:${run("p", 12)}@example.test/repo`, pem(run("M", 64)), pem(`${run("N", 64)}\n`.repeat(400))
  ];
  const base = scrollback(240_000);
  let compared = 0;
  for (const tail of [300, 4_000, 8_192]) {
    const tailCut = base.length - tail;
    const windowCut = base.length - tail - 16_384;
    for (const cut of [tailCut, windowCut]) {
      for (const offset of [-3_000, -400, -20, -5, 0, 3, 17, 300]) {
        for (const sample of samples) {
          const at = cut + offset - Math.floor(sample.length / 2);
          const text = `${base.slice(0, at)}${sample}${base.slice(at)}`;
          assert.equal(registry.redactTail(text, tail), registry.redact(text).slice(-tail), `${tail} ${cut === tailCut ? "tail" : "window"} ${offset} ${sample.slice(0, 12)}`);
          compared++;
        }
      }
    }
  }
  // A private key opened long before the window and never closed masks everything after it, as before.
  const open = `${base.slice(0, 1_000)}-----${"BEGIN"} ${"PRIVATE"} KEY-----\n${base.slice(1_000)}`;
  assert.equal(registry.redactTail(open, 4_000), registry.redact(open).slice(-4_000));
  assert.ok(compared > 600);
  assert.equal(registry.redactTail("", 10), "");
  assert.equal(registry.redactTail(`x ${PLAIN_SECRET}`, 0), "");
});

test("redactTail masks a window around the tail, not the whole scrollback", () => {
  class Measured extends SecretRedactionRegistry {
    lengths = [];
    redact(text) { this.lengths.push(text.length); return super.redact(text); }
  }
  const registry = new Measured();
  registry.add("plugin:p.custom", [PLAIN_SECRET]);
  const text = `${scrollback(240_000)}${PLAIN_SECRET}${"z".repeat(100)}`;
  const masked = registry.redactTail(text, 8_192);
  assert.deepEqual(fragments(masked), []);
  assert.ok(Math.max(...registry.lengths) <= 8_192 + 16_384 + 4_096, `masked ${registry.lengths} characters`);
  // A held value that could wrap over the margin widens the window with it (each gap may hold 64 characters);
  // one that could span the whole scrollback means masking the whole text.
  registry.lengths.length = 0;
  registry.add("plugin:p.long", [run("L", 400)]);
  assert.deepEqual(fragments(registry.redactTail(text, 8_192)), []);
  const widened = Math.max(...registry.lengths);
  assert.ok(widened > 8_192 + 2 * 400 * 65 && widened < text.length, `masked ${widened} characters`);
  registry.lengths.length = 0;
  registry.add("plugin:p.longer", [run("K", 2_000)]);
  registry.redactTail(text, 8_192);
  assert.equal(Math.max(...registry.lengths), text.length);
});

test("observe_agent, get_agent_result and the plugin screen mask a bounded window of a full scrollback", async (t) => {
  const f = cutFixture(t);
  const masked = [];
  const registry = f.terminals.redaction;
  const redact = registry.redact.bind(registry);
  registry.redact = (text) => { masked.push(text.length); return redact(text); };
  f.print(scrollback(250_000));
  f.print(`${PLAIN_SECRET}${"g".repeat(200)}`);
  const control = new AgentControlService(f.terminals);
  assert.deepEqual(fragments(control.observe(f.card.id).output), []);
  assert.deepEqual(fragments(control.result(f.card.id).output), []);
  const { PluginSessions } = await import("../src/main/services/PluginSessions.ts");
  const screens = [];
  const sessions = new PluginSessions({ terminals: f.terminals, notify: (_p, _s, _m, event) => { if (event.screen !== undefined) screens.push(event.screen); return true; } });
  f.attach(sessions);
  sessions.handle("p.reader", "svc", "sessions.subscribe", {}, ["sessions:events", "sessions:read-screen"]);
  f.terminals.applyProviderSignal(f.card.id, { kind: "lifecycle", state: "working" });
  f.terminals.applyProviderSignal(f.card.id, { kind: "lifecycle", state: "idle" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(screens.length > 0);
  assert.deepEqual(fragments(screens.join("\n")), []);
  assert.ok(masked.length >= 3 && Math.max(...masked) < 40_000, `masked ${masked} characters per call`);
});
