#!/usr/bin/env node
// Builds canvastty-helper, the native form of the agent helpers (native/canvastty-helper), with the Go toolchain:
// static, no cgo, standard library only, so nothing is downloaded beyond the toolchain itself.
//
//   node scripts/build-native-helpers.mjs            all release targets
//   node scripts/build-native-helpers.mjs --host     only this computer's platform and architecture
//   node scripts/build-native-helpers.mjs --catalog  only regenerate the embedded tool catalog
//
// Output: build/native-helpers/<os>-<arch>/canvastty-helper[.exe], <os> as electron-builder names it (mac, linux,
// win), packaged by electron-builder.yml as resources/helpers. Without Go the build is skipped with a warning and the
// app keeps its JavaScript helpers; CANVASTTY_REQUIRE_NATIVE_HELPERS=1 makes a missing toolchain an error (release).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "native", "canvastty-helper");
const output = join(root, "build", "native-helpers");
export const NATIVE_HELPER_TARGETS = Object.freeze([
  { os: "mac", goos: "darwin", arch: "arm64", goarch: "arm64" },
  { os: "mac", goos: "darwin", arch: "x64", goarch: "amd64" },
  { os: "linux", goos: "linux", arch: "x64", goarch: "amd64" },
  { os: "linux", goos: "linux", arch: "arm64", goarch: "arm64" },
  { os: "win", goos: "windows", arch: "x64", goarch: "amd64" }
]);

/** The catalog the Go helper embeds: the same tool definitions and instructions the .mjs helpers serve. */
export async function nativeHelperCatalog() {
  const importSource = (path) => import(pathToFileURL(join(root, path)).href);
  const browserCatalog = await importSource("src/agent-browser/tool-catalog.mjs");
  const orchestrationCatalog = await importSource("src/agent-browser/orchestration-catalog.mjs");
  const browserHelper = await importSource("src/agent-browser/mcp-helper.mjs");
  const orchestrationHelper = await importSource("src/agent-browser/orchestration-helper.mjs");
  return {
    browser: {
      serverName: browserCatalog.MCP_SERVER_NAME,
      instructions: browserHelper.BROWSER_AGENT_INSTRUCTIONS,
      tools: browserCatalog.TOOL_DEFINITIONS
    },
    orchestration: {
      serverName: orchestrationCatalog.ORCHESTRATION_MCP_SERVER_NAME,
      instructions: orchestrationHelper.ORCHESTRATION_AGENT_INSTRUCTIONS,
      tools: orchestrationCatalog.ORCHESTRATION_TOOL_DEFINITIONS,
      providerIds: orchestrationCatalog.AGENT_PROVIDER_IDS,
      maxPluginToolNameLength: orchestrationCatalog.MAX_PLUGIN_TOOL_NAME_LENGTH,
      maxLaunchOptionsBytes: 16 * 1024,
      defaultAgentWaitSeconds: orchestrationCatalog.DEFAULT_AGENT_WAIT_SECONDS
    }
  };
}

export async function nativeHelperCatalogText() {
  return `${JSON.stringify(await nativeHelperCatalog(), null, 2)}\n`;
}

function findGo() {
  const candidates = [process.env.GO, "go", "/usr/local/go/bin/go", "/opt/homebrew/bin/go"].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["version"], { encoding: "utf8", windowsHide: true });
    if (probe.status === 0) return { command: candidate, version: probe.stdout.trim() };
  }
  return null;
}

function hostTarget() {
  const os = { darwin: "mac", linux: "linux", win32: "win" }[process.platform];
  return NATIVE_HELPER_TARGETS.find((target) => target.os === os && target.arch === process.arch) ?? null;
}

async function main() {
  const argv = process.argv.slice(2);
  const catalogPath = join(source, "catalog.json");
  const catalog = await nativeHelperCatalogText();
  const current = existsSync(catalogPath) ? readFileSync(catalogPath, "utf8") : null;
  if (current !== catalog) writeFileSync(catalogPath, catalog);
  if (argv.includes("--catalog")) return;

  const required = process.env.CANVASTTY_REQUIRE_NATIVE_HELPERS === "1";
  const go = findGo();
  if (!go) {
    const message = "Go was not found: canvastty-helper is not built and the app keeps its JavaScript helpers.";
    if (required) throw new Error(message);
    process.stderr.write(`warning: ${message}\n`);
    return;
  }
  const targets = argv.includes("--host") ? [hostTarget()].filter(Boolean) : NATIVE_HELPER_TARGETS;
  for (const target of targets) {
    const folder = join(output, `${target.os}-${target.arch}`);
    const binary = join(folder, target.goos === "windows" ? "canvastty-helper.exe" : "canvastty-helper");
    mkdirSync(folder, { recursive: true });
    rmSync(binary, { force: true });
    const build = spawnSync(go.command, ["build", "-trimpath", "-buildvcs=false", "-ldflags", "-s -w", "-o", binary, "."], {
      cwd: source,
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: target.goos,
        GOARCH: target.goarch,
        // Standard library only: never reach for a module proxy or another toolchain.
        GOPROXY: "off",
        GOTOOLCHAIN: "local",
        GOFLAGS: "-mod=mod"
      }
    });
    if (build.status !== 0) throw new Error(`canvastty-helper did not build for ${target.goos}/${target.goarch}.`);
    const size = statSync(binary).size;
    process.stdout.write(`${binary} (${(size / 1048576).toFixed(1)} MB, ${go.version})\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
