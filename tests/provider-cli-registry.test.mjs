import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createProviderCliRegistry,
  providerCliAvailability,
  providerChildProcessLaunch,
  providerTerminalBatchCommandLine
} from "../src/main/services/providerCliRegistry.ts";

function inspection(results) {
  return (path) => results.has(path) ? results.get(path) : "missing";
}

test("Finder-like macOS PATH resolves Codex from the Homebrew platform default", () => {
  const codex = "/opt/homebrew/bin/codex";
  const registry = createProviderCliRegistry({
    platform: "darwin",
    environment: { PATH: "/usr/bin:/bin" },
    homeDirectory: "/test-home",
    inspectCandidate: inspection(new Map([[codex, null]])),
    directoryExists: (path) => ["/usr/bin", "/bin", "/opt/homebrew/bin"].includes(path)
  });

  const resolution = registry.get("codex");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.executable, codex);
  assert.equal(resolution.launcher, "native");
  assert.equal(resolution.environment.PATH, "/usr/bin:/bin:/opt/homebrew/bin");
});

test("Finder-like macOS PATH resolves OpenCode from its official per-user directory", () => {
  const opencode = "/test-home/.opencode/bin/opencode";
  const registry = createProviderCliRegistry({
    platform: "darwin",
    environment: { PATH: "/usr/bin:/bin" },
    homeDirectory: "/test-home",
    inspectCandidate: inspection(new Map([[opencode, null]])),
    directoryExists: (path) => ["/usr/bin", "/bin", "/test-home/.opencode/bin"].includes(path)
  });

  const resolution = registry.get("opencode");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.executable, opencode);
  assert.equal(resolution.environment.PATH, "/usr/bin:/bin:/test-home/.opencode/bin");
});

test("override wins over PATH and fallback candidates", () => {
  const override = "/fixtures/codex";
  const fromPath = "/tools/codex";
  const registry = createProviderCliRegistry({
    platform: "linux",
    environment: { PATH: "/tools" },
    overrides: { codex: override },
    inspectCandidate: inspection(new Map([[override, null], [fromPath, null]])),
    directoryExists: () => true
  });

  const resolution = registry.get("codex");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.executable, override);
  assert.deepEqual(resolution.checked, [{ path: override, result: "selected" }]);
});

test("relative PATH entries are frozen as absolute startup paths", () => {
  const codex = "/workspace/tools/codex";
  const registry = createProviderCliRegistry({
    platform: "linux",
    environment: { PATH: "tools:/usr/bin" },
    startupDirectory: "/workspace",
    inspectCandidate: inspection(new Map([[codex, null]])),
    directoryExists: () => true
  });

  const resolution = registry.get("codex");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.executable, codex);
  assert.match(resolution.environment.PATH, /^\/workspace\/tools:/u);
});

test("unavailable diagnostics preserve missing and rejected candidate evidence", () => {
  const notFile = "/tools/codex";
  const notExecutable = "/opt/homebrew/bin/codex";
  const registry = createProviderCliRegistry({
    platform: "darwin",
    environment: { PATH: "/tools" },
    homeDirectory: "/test-home",
    inspectCandidate: inspection(new Map([
      [notFile, "not-file"],
      [notExecutable, "not-executable"]
    ])),
    directoryExists: () => true
  });

  const resolution = registry.get("codex");
  assert.equal(resolution.state, "unavailable");
  assert.match(resolution.diagnostic, /\/tools\/codex: not-file/u);
  assert.match(resolution.diagnostic, /\/opt\/homebrew\/bin\/codex: not-executable/u);
  assert.match(resolution.diagnostic, /Check again in Agents settings/u);
});

test("Windows native launch preserves the resolved executable and child PATH", () => {
  const codex = "D:\\Tools\\codex.exe";
  const registry = createProviderCliRegistry({
    platform: "win32",
    environment: { Path: "D:\\Tools;C:\\Windows\\System32" },
    homeDirectory: "C:\\Users\\Kisa",
    inspectCandidate: inspection(new Map([[codex, null]])),
    directoryExists: () => true
  });

  const resolution = registry.get("codex");
  assert.equal(resolution.state, "available");
  const launch = providerChildProcessLaunch(resolution, ["app-server"]);
  assert.deepEqual(launch, {
    command: codex,
    args: ["app-server"],
    environment: { Path: resolution.environment.Path }
  });
});

test("Windows batch launch uses the startup-resolved command prompt", () => {
  const claude = "C:\\Users\\Kisa\\AppData\\Roaming\\npm\\claude.cmd";
  const commandPrompt = "C:\\Windows\\System32\\cmd.exe";
  const registry = createProviderCliRegistry({
    platform: "win32",
    environment: { APPDATA: "C:\\Users\\Kisa\\AppData\\Roaming", ComSpec: commandPrompt },
    homeDirectory: "C:\\Users\\Kisa",
    inspectCandidate: inspection(new Map([[claude, null], [commandPrompt, null]])),
    directoryExists: () => true
  });

  const resolution = registry.get("claude");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.launcher, "batch");
  const launch = providerChildProcessLaunch(resolution, ["--bridge"]);
  assert.equal(launch.command, commandPrompt);
  assert.deepEqual(launch.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(launch.args[3], /claude\.cmd/u);
  assert.equal(launch.windowsVerbatimArguments, true);
});

test("Cursor permits an explicitly configured generic agent executable", () => {
  const agent = "/test-home/.local/bin/agent";
  const registry = createProviderCliRegistry({
    platform: "darwin",
    overrides: { cursor: agent },
    environment: { PATH: "/usr/bin:/bin" },
    homeDirectory: "/test-home",
    inspectCandidate: inspection(new Map([
      [agent, null],
      ["/usr/bin/cursor", null]
    ])),
    directoryExists: (path) => ["/usr/bin", "/bin", "/test-home/.local/bin"].includes(path)
  });

  const resolution = registry.get("cursor");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.provider, "cursor");
  assert.equal(resolution.executable, agent);
  assert.equal(resolution.environment.PATH, "/usr/bin:/bin:/test-home/.local/bin");
  // A literal `cursor` executable must never be selected for the cursor provider.
  assert.equal(resolution.checked.some((candidate) => candidate.path.endsWith("/cursor")), false);
});

test("Cursor falls back to the cursor-agent spelling when agent is absent", () => {
  const legacy = "/usr/local/bin/cursor-agent";
  const registry = createProviderCliRegistry({
    platform: "linux",
    environment: { PATH: "/usr/bin:/usr/local/bin" },
    inspectCandidate: inspection(new Map([[legacy, null]])),
    directoryExists: () => true
  });

  const resolution = registry.get("cursor");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.executable, legacy);
});

test("MiniMax Code resolves through its mcode command instead of the provider id", () => {
  const mcode = "/test-home/.npm-global/bin/mcode";
  const registry = createProviderCliRegistry({
    platform: "linux",
    environment: { PATH: "/usr/bin" },
    homeDirectory: "/test-home",
    inspectCandidate: inspection(new Map([
      [mcode, null],
      ["/usr/bin/minimax", null]
    ])),
    directoryExists: (path) => ["/usr/bin", "/test-home/.npm-global/bin"].includes(path)
  });

  const resolution = registry.get("minimax");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.executable, mcode);
  assert.equal(resolution.checked.some((candidate) => candidate.path.endsWith("/minimax")), false);
});

test("Devin resolves through its devin command", () => {
  const devin = "/opt/homebrew/bin/devin";
  const registry = createProviderCliRegistry({
    platform: "darwin",
    environment: { PATH: "/usr/bin:/bin" },
    inspectCandidate: inspection(new Map([[devin, null]])),
    directoryExists: (path) => ["/usr/bin", "/bin", "/opt/homebrew/bin"].includes(path)
  });

  const resolution = registry.get("devin");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.executable, devin);
});

test("Antigravity resolves through its agy command instead of the provider id", () => {
  const agy = "/test-home/.local/bin/agy";
  const registry = createProviderCliRegistry({
    platform: "linux",
    environment: { PATH: "/usr/bin" },
    homeDirectory: "/test-home",
    inspectCandidate: inspection(new Map([
      [agy, null],
      ["/usr/bin/antigravity", null]
    ])),
    directoryExists: (path) => ["/usr/bin", "/test-home/.local/bin"].includes(path)
  });

  const resolution = registry.get("antigravity");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.executable, agy);
  assert.equal(resolution.checked.some((candidate) => candidate.path.endsWith("/antigravity")), false);
});

test("registry snapshot and provider resolutions are immutable", () => {
  const registry = createProviderCliRegistry({
    platform: "linux",
    environment: {},
    inspectCandidate: () => "missing",
    directoryExists: () => false
  });

  assert.equal(Object.isFrozen(registry.snapshot()), true);
  assert.equal(Object.isFrozen(registry.get("codex")), true);
});

test("custom definitions resolve executables that do not match the provider id", () => {
  const registry = createProviderCliRegistry({
    platform: "linux",
    environment: { PATH: "/usr/bin" },
    definitions: [{ id: "example", commands: ["exa"] }],
    inspectCandidate: inspection(new Map([["/usr/bin/exa", null]])),
    directoryExists: () => true
  });

  const resolution = registry.get("example");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.provider, "example");
  assert.equal(resolution.executable, "/usr/bin/exa");
  assert.deepEqual(Object.keys(registry.snapshot()), ["example"]);
});

test("definitions fall back to later commands when the primary command is missing", () => {
  const registry = createProviderCliRegistry({
    platform: "linux",
    environment: { PATH: "/usr/bin" },
    definitions: [{ id: "example", commands: ["exa", "example-agent"] }],
    inspectCandidate: inspection(new Map([["/usr/bin/example-agent", null]])),
    directoryExists: () => true
  });

  const resolution = registry.get("example");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.executable, "/usr/bin/example-agent");
  assert.deepEqual(
    resolution.checked.map((candidate) => candidate.path),
    ["/usr/bin/exa", "/usr/bin/example-agent"]
  );
});

test("definition known directories participate in resolution and child PATH", () => {
  const registry = createProviderCliRegistry({
    platform: "darwin",
    environment: { PATH: "/usr/bin:/bin" },
    homeDirectory: "/test-home",
    definitions: [{
      id: "example",
      commands: ["exa"],
      knownDirectories: [{ root: "home", segments: [".example", "bin"] }]
    }],
    inspectCandidate: inspection(new Map([["/test-home/.example/bin/exa", null]])),
    directoryExists: (path) => ["/usr/bin", "/bin", "/test-home/.example/bin"].includes(path)
  });

  const resolution = registry.get("example");
  assert.equal(resolution.state, "available");
  assert.equal(resolution.executable, "/test-home/.example/bin/exa");
  assert.equal(resolution.environment.PATH, "/usr/bin:/bin:/test-home/.example/bin");
});

test("windows-local-appdata known directories are ignored outside Windows", () => {
  const registry = createProviderCliRegistry({
    platform: "darwin",
    environment: { PATH: "/usr/bin" },
    homeDirectory: "/test-home",
    definitions: [{
      id: "example",
      commands: ["exa"],
      knownDirectories: [{ root: "windows-local-appdata", segments: ["Programs", "Example", "bin"] }]
    }],
    inspectCandidate: () => "missing",
    directoryExists: () => true
  });

  const resolution = registry.get("example");
  assert.equal(resolution.state, "unavailable");
  assert.equal(
    resolution.checked.some((candidate) => candidate.path.includes("AppData")),
    false
  );
});

test("definitions without commands or with duplicate ids are rejected", () => {
  const base = {
    platform: "linux",
    environment: {},
    inspectCandidate: () => "missing",
    directoryExists: () => false
  };
  assert.throws(
    () => createProviderCliRegistry({ ...base, definitions: [{ id: "example", commands: [] }] }),
    /at least one CLI command/u
  );
  assert.throws(
    () => createProviderCliRegistry({
      ...base,
      definitions: [
        { id: "example", commands: ["exa"] },
        { id: "example", commands: ["exa2"] }
      ]
    }),
    /declared more than once/u
  );
});

test("refresh detects installed and removed CLIs without changing an earlier snapshot", () => {
  const executable = "/tools/codex";
  const present = new Set();
  const registry = createProviderCliRegistry({
    platform: "linux",
    environment: { PATH: "/tools" },
    homeDirectory: "/test-home",
    inspectCandidate: (path) => present.has(path) ? null : "missing",
    directoryExists: () => true
  });
  const first = registry.snapshot();
  assert.equal(providerCliAvailability(registry).codex, false);

  present.add(executable);
  registry.refresh();
  assert.equal(registry.get("codex").state, "available");
  assert.equal(providerCliAvailability(registry).codex, true);
  assert.equal(first.codex.state, "unavailable");

  present.delete(executable);
  registry.refresh();
  assert.equal(registry.get("codex").state, "unavailable");
});

test("on the real file system, candidates in missing directories are missing and a directory created later is found on refresh", { skip: process.platform === "win32" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "canvastty-cli-dirs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = join(root, "tools");
  const later = join(root, "later");
  const gone = join(root, "gone");
  mkdirSync(tools);
  writeFileSync(join(tools, "claude"), "");
  chmodSync(join(tools, "claude"), 0o644);
  writeFileSync(join(tools, "codex"), "#!/bin/sh\n");
  chmodSync(join(tools, "codex"), 0o755);
  const registry = createProviderCliRegistry({
    platform: process.platform,
    environment: { PATH: [tools, gone, later].join(":") },
    homeDirectory: join(root, "home"),
    platformRoot: join(root, "platform")
  });
  assert.equal(registry.get("codex").executable, join(tools, "codex"));
  const claude = registry.get("claude");
  assert.equal(claude.state, "unavailable");
  const result = (path) => claude.checked.find((check) => check.path === path)?.result;
  assert.equal(result(join(tools, "claude")), "not-executable");
  assert.equal(result(join(gone, "claude")), "missing");
  assert.equal(result(join(later, "claude")), "missing");
  assert.equal(registry.get("codex").environment.PATH.split(":").includes(gone), false);

  mkdirSync(later);
  writeFileSync(join(later, "claude"), "#!/bin/sh\n");
  chmodSync(join(later, "claude"), 0o755);
  registry.refresh();
  assert.equal(registry.get("claude").executable, join(later, "claude"));
});

// A model of how cmd.exe reads `cmd /d /s /c "<line>"` that starts an npm-style
// .cmd shim (`"node.exe" "cli.js" %*`), and how the program then splits its
// command line. It covers what matters here: %VAR% expansion on the command
// line, caret escapes and quote toggling (phase 2), operators outside quotes,
// the second phase-2 pass over the text %* expands to, and MSVC argv rules.
// This is a model, not cmd.exe; real-Windows verification is still pending.
const CMD_ENV = new Map([["PATH", "C:\\Windows"], ["APPDATA", "C:\\Users\\Kisa\\AppData\\Roaming"]]);

function cmdExpandPercent(line) {
  let out = "";
  for (let index = 0; index < line.length;) {
    if (line[index] === "%") {
      const end = line.indexOf("%", index + 1);
      const name = end > index ? line.slice(index + 1, end) : "";
      if (end > index && CMD_ENV.has(name.toUpperCase())) {
        out += CMD_ENV.get(name.toUpperCase());
        index = end + 1;
        continue;
      }
    }
    out += line[index];
    index += 1;
  }
  return out;
}

function cmdPhase2(line) {
  let out = "";
  let quoted = false;
  const operators = [];
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      quoted = !quoted;
      out += char;
    } else if (!quoted && char === "^") {
      index += 1;
      out += line[index] ?? "";
    } else {
      if (!quoted && "&|<>".includes(char)) operators.push(`${char}@${index}`);
      out += char;
    }
  }
  return { out, operators };
}

function msvcArgv(line) {
  const args = [];
  let index = 0;
  while (index < line.length) {
    while (line[index] === " " || line[index] === "\t") index += 1;
    if (index >= line.length) break;
    let current = "";
    let quoted = false;
    while (index < line.length) {
      const char = line[index];
      if ((char === " " || char === "\t") && !quoted) break;
      if (char === "\\") {
        let count = 0;
        while (line[index + count] === "\\") count += 1;
        if (line[index + count] === "\"") {
          current += "\\".repeat(Math.floor(count / 2));
          if (count % 2 === 1) {
            current += "\"";
            index += count + 1;
          } else {
            index += count;
          }
        } else {
          current += "\\".repeat(count);
          index += count;
        }
        continue;
      }
      if (char === "\"") {
        if (quoted && line[index + 1] === "\"") {
          current += "\"";
          index += 2;
          continue;
        }
        quoted = !quoted;
        index += 1;
        continue;
      }
      current += char;
      index += 1;
    }
    args.push(current);
  }
  return args;
}

function runBatchShimModel(commandLine, batchPath) {
  assert.match(commandLine, /^\/d \/s \/c "/u);
  // /s: drop the first and the last quote of the /c text.
  const inner = commandLine.slice("/d /s /c \"".length, -1);
  const first = cmdPhase2(cmdExpandPercent(inner));
  assert.ok(first.out.startsWith(`${batchPath} `), "cmd.exe starts the batch file");
  const percentStar = first.out.slice(batchPath.length + 1);
  const shimLine = `"C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\cli.js" ${percentStar}`;
  const second = cmdPhase2(shimLine);
  return {
    operators: [...first.operators, ...second.operators],
    argv: msvcArgv(second.out).slice(2)
  };
}

test("Windows batch arguments survive cmd.exe and the shim's %* re-parse unchanged (cmd.exe model)", () => {
  const claude = "C:\\Users\\Kisa\\AppData\\Roaming\\npm\\claude.cmd";
  const hook = "set \"ELECTRON_RUN_AS_NODE=1\" && \"C:\\Program Files\\CanvasTTY\\CanvasTTY.exe\" \"C:\\hooks\\hook.cjs\" pretool";
  const settings = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hook }] }] } });
  const args = [
    "--settings", settings,
    "a b", "", "x&y", "p|q", "<in>", "(group)", "100%", "%PATH%", "%%", "^caret", "!bang!",
    "quote\"inside", "trailing\\", "C:\\dir with space\\", "back\\\\\"slash", "semi;comma,", "star*?"
  ];
  const commandLine = providerTerminalBatchCommandLine(claude, args);
  const result = runBatchShimModel(commandLine, claude);
  assert.deepEqual(result.operators, [], "no operator reaches cmd.exe outside quotes");
  assert.deepEqual(result.argv, args);

  const registry = createProviderCliRegistry({
    platform: "win32",
    environment: { APPDATA: "C:\\Users\\Kisa\\AppData\\Roaming", ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    homeDirectory: "C:\\Users\\Kisa",
    inspectCandidate: inspection(new Map([[claude, null], ["C:\\Windows\\System32\\cmd.exe", null]])),
    directoryExists: () => true
  });
  const launch = providerChildProcessLaunch(registry.get("claude"), args);
  assert.equal(`/d /s /c ${launch.args[3]}`, commandLine);
});
