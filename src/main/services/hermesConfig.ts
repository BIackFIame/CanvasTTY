import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  statSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { lazyRequire } from "../lazyRequire.ts";
import {
  ORCHESTRATION_MCP_SERVER_NAME,
  ORCHESTRATION_TOOL_NAMES
} from "../../agent-browser/orchestration-catalog.mjs";
import {
  APPROVED_BROWSER_TOOL_NAMES,
  MCP_SERVER_NAME,
  canonicalStringify
} from "../../agent-browser/tool-catalog.mjs";
import { AGENT_BROWSER_ENV } from "./agent-browser/protocol.ts";
import {
  acquireConfigurationLock,
  atomicWrite,
  backupFile,
  existingMode,
  hashCanonical,
  hashText,
  readOptional,
  releaseConfigurationLock,
  removeEmptyDirectory,
  restoreFromBackup,
  unlinkIfExists,
  writeExactWithCas
} from "./configOverlay.ts";
import { ORCHESTRATION_ENV } from "./agent-browser/orchestration-protocol.ts";

// YAML is only parsed for Hermes configs; it is loaded then, not with the app.
const yaml = lazyRequire<typeof import("yaml")>("yaml");
const CONFIG_DIRECTORY_MODE = 0o700;
const ALLOWED_HELPER_ENVIRONMENT_KEYS = new Set(["ELECTRON_RUN_AS_NODE"]);
const RESERVED_AGENT_ENVIRONMENT_PATTERN = /^CANVASTTY_AGENT_/i;

export interface HermesStdioHelperLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface HermesTemporaryConfigurationOptions {
  homeDirectory: string;
  helper: HermesStdioHelperLaunch;
  /** Optional second MCP server (canvastty_agents) written next to the browser one. */
  orchestrationHelper?: HermesStdioHelperLaunch;
}

interface HermesRecoveryJournal {
  version: 1;
  ownershipId: string;
  entryHash: string;
  /** Absent in journals written before orchestration support; never undefined when set. */
  orchestrationEntryHash?: string;
  configOriginalHash: string | null;
  configMutatedHash: string;
  mcpServersOriginallyPresent: boolean;
  backupDirectory: string;
}

export class HermesTemporaryConfiguration {
  readonly hasOrchestrationEntry: boolean;
  private readonly paths: ReturnType<typeof hermesPaths>;
  private readonly journal: HermesRecoveryJournal;
  private cleaned = false;

  private constructor(
    paths: ReturnType<typeof hermesPaths>,
    journal: HermesRecoveryJournal
  ) {
    this.paths = paths;
    this.journal = journal;
    this.hasOrchestrationEntry = journal.orchestrationEntryHash !== undefined;
  }

  static begin(options: HermesTemporaryConfigurationOptions): HermesTemporaryConfiguration {
    validateHelper(options.helper);
    if (options.orchestrationHelper) validateHelper(options.orchestrationHelper);
    mkdirSync(options.homeDirectory, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
    const paths = hermesPaths(options.homeDirectory);
    const lock = acquireConfigurationLock(paths.lock, "Hermes");
    try {
      this.recoverLocked(paths);
      const ownershipId = randomUUID();
      const entry = hermesMcpEntry(options.helper);
      const orchestrationEntry = options.orchestrationHelper
        ? hermesOrchestrationEntry(options.orchestrationHelper)
        : null;
      const configOriginal = readOptional(paths.config);
      const { document, value } = parseHermesDocument(configOriginal ?? "", paths.config);
      const mcpServersOriginallyPresent = Object.hasOwn(value, "mcp_servers");
      const servers = mcpServers(value, paths.config);
      if (MCP_SERVER_NAME in servers) {
        throw new Error(`Hermes MCP server name ${MCP_SERVER_NAME} is already configured.`);
      }
      if (orchestrationEntry && ORCHESTRATION_MCP_SERVER_NAME in servers) {
        throw new Error(`Hermes MCP server name ${ORCHESTRATION_MCP_SERVER_NAME} is already configured.`);
      }
      document.setIn(["mcp_servers", MCP_SERVER_NAME], entry);
      if (orchestrationEntry) {
        document.setIn(["mcp_servers", ORCHESTRATION_MCP_SERVER_NAME], orchestrationEntry);
      }
      const configMutated = document.toString({ lineWidth: 0 });
      const backupDirectory = join(paths.backupRoot, ownershipId);
      mkdirSync(backupDirectory, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
      chmodSync(backupDirectory, CONFIG_DIRECTORY_MODE);
      if (configOriginal !== null) backupFile(paths.config, join(backupDirectory, "config.yaml"));

      const journal: HermesRecoveryJournal = {
        version: 1,
        ownershipId,
        entryHash: hashCanonical(entry),
        ...(orchestrationEntry ? { orchestrationEntryHash: hashCanonical(orchestrationEntry) } : {}),
        configOriginalHash: configOriginal === null ? null : hashText(configOriginal),
        configMutatedHash: hashText(configMutated),
        mcpServersOriginallyPresent,
        backupDirectory
      };
      atomicWrite(paths.journal, `${canonicalStringify(journal)}\n`);
      writeExactWithCas(paths.config, configOriginal, configMutated, "Hermes");
      return new HermesTemporaryConfiguration(paths, journal);
    } catch (error) {
      try {
        this.recoverLocked(paths);
      } catch {
        // Keep the journal and backup for the next safe startup recovery.
      }
      throw error;
    } finally {
      releaseConfigurationLock(paths.lock, lock, "Hermes");
    }
  }

  static recover(homeDirectory: string): void {
    if (!existsSync(homeDirectory)) return;
    const paths = hermesPaths(homeDirectory);
    const lock = acquireConfigurationLock(paths.lock, "Hermes");
    try {
      this.recoverLocked(paths);
    } finally {
      releaseConfigurationLock(paths.lock, lock, "Hermes");
    }
  }

  cleanup(): void {
    if (this.cleaned) return;
    const lock = acquireConfigurationLock(this.paths.lock, "Hermes");
    try {
      cleanupOwnedConfiguration(this.paths, this.journal);
      removeRecoveryArtifacts(this.paths, this.journal);
      this.cleaned = true;
    } finally {
      releaseConfigurationLock(this.paths.lock, lock, "Hermes");
    }
  }

  private static recoverLocked(paths: ReturnType<typeof hermesPaths>): void {
    const raw = readOptional(paths.journal);
    if (raw === null) return;
    const journal = parseJournal(raw, paths);
    cleanupOwnedConfiguration(paths, journal);
    removeRecoveryArtifacts(paths, journal);
  }
}

export function recoverHermesConfigurationOnStartup(
  hermesHomeDirectory = resolveHermesHomeDirectory()
): void {
  HermesTemporaryConfiguration.recover(hermesHomeDirectory);
}

export function resolveHermesHomeDirectory(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  userHome = homedir()
): string {
  const configured = environment.HERMES_HOME?.trim();
  const localAppData = environment.LOCALAPPDATA?.trim();
  const directory = configured
    || (platform === "win32"
      ? win32.join(localAppData || win32.join(userHome, "AppData", "Local"), "hermes")
      : join(userHome, ".hermes"));
  if (!isAbsolute(directory)) throw new Error("HERMES_HOME must be an absolute path.");

  let existingPath = directory;
  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) throw new Error("HERMES_HOME has no accessible parent directory.");
    existingPath = parent;
  }
  if (!statSync(existingPath).isDirectory()) {
    throw new Error("HERMES_HOME must resolve beneath a directory.");
  }
  accessSync(existingPath, constants.W_OK);
  return directory;
}

export function hermesMcpEntry(helper: HermesStdioHelperLaunch): Record<string, unknown> {
  validateHelper(helper);
  const capabilityEnvironment = Object.fromEntries(
    Object.values(AGENT_BROWSER_ENV).map((key) => [key, `\${${key}}`])
  );
  return {
    command: helper.command,
    args: [...helper.args],
    env: { ...helper.env, ...capabilityEnvironment },
    enabled: true,
    trust: "full",
    tools: {
      include: [...APPROVED_BROWSER_TOOL_NAMES],
      resources: false,
      prompts: false
    }
  };
}

// Same placeholder contract as the browser entry: Hermes resolves ${VAR} from
// its own environment when launching the server, so the per-session
// orchestration capability injected into the PTY environment reaches the
// helper without baking launch-specific values into the shared config.yaml.
export function hermesOrchestrationEntry(helper: HermesStdioHelperLaunch): Record<string, unknown> {
  validateHelper(helper);
  const orchestrationEnvironment = Object.fromEntries(
    Object.values(ORCHESTRATION_ENV).map((key) => [key, `\${${key}}`])
  );
  return {
    command: helper.command,
    args: [...helper.args],
    env: { ...helper.env, ...orchestrationEnvironment },
    enabled: true,
    trust: "full",
    tools: {
      include: [...ORCHESTRATION_TOOL_NAMES],
      resources: false,
      prompts: false
    }
  };
}

function cleanupOwnedConfiguration(
  paths: ReturnType<typeof hermesPaths>,
  journal: HermesRecoveryJournal
): void {
  const current = readOptional(paths.config);
  if (current === null) return;
  if (hashText(current) === journal.configMutatedHash) {
    restoreFromBackup(
      paths.config,
      journal.configOriginalHash,
      join(journal.backupDirectory, "config.yaml"),
      "CanvasTTY Hermes configuration backup is unavailable or invalid."
    );
    return;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = readOptional(paths.config);
    if (before === null) return;
    const { document, value } = parseHermesDocument(before, paths.config);
    const servers = mcpServers(value, paths.config);
    const ownedEntries: Array<[string, string]> = [[MCP_SERVER_NAME, journal.entryHash]];
    if (journal.orchestrationEntryHash) {
      ownedEntries.push([ORCHESTRATION_MCP_SERVER_NAME, journal.orchestrationEntryHash]);
    }
    let ownedCount = 0;
    for (const [name, expectedHash] of ownedEntries) {
      const owned = servers[name];
      if (owned === undefined) continue;
      if (hashCanonical(owned) !== expectedHash) {
        throw new Error("CanvasTTY Hermes MCP configuration ownership changed before cleanup.");
      }
      ownedCount += 1;
    }
    if (ownedCount === 0) return;
    for (const [name] of ownedEntries) {
      document.deleteIn(["mcp_servers", name]);
    }
    if (!journal.mcpServersOriginallyPresent && Object.keys(servers).length === ownedCount) {
      document.delete("mcp_servers");
    }
    const next = document.toString({ lineWidth: 0 });
    if (readOptional(paths.config) !== before) continue;
    atomicWrite(paths.config, next, existingMode(paths.config));
    return;
  }
  throw new Error(`Hermes configuration changed concurrently: ${paths.config}`);
}

function parseHermesDocument(raw: string, path: string) {
  const { parseDocument } = yaml();
  let document = parseDocument(raw, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`Hermes YAML configuration is invalid: ${path}`);
  }
  let value = document.toJS({ maxAliasCount: 100 }) as unknown;
  if (value === null || value === undefined) {
    value = {};
    document = parseDocument("{}\n", { strict: true, uniqueKeys: true });
  }
  if (!isRecord(value)) throw new Error(`Hermes YAML configuration must be an object: ${path}`);
  return { document, value };
}

function mcpServers(value: Record<string, unknown>, path: string): Record<string, unknown> {
  if (!("mcp_servers" in value)) return {};
  const servers = value.mcp_servers;
  if (!isRecord(servers)) {
    throw new Error(`Hermes YAML configuration has an invalid mcp_servers object: ${path}`);
  }
  return servers;
}

function parseJournal(
  raw: string,
  paths: ReturnType<typeof hermesPaths>
): HermesRecoveryJournal {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("CanvasTTY Hermes recovery journal is invalid.");
  }
  if (
    !isRecord(value)
    || value.version !== 1
    || typeof value.ownershipId !== "string"
    || typeof value.entryHash !== "string"
    || (value.orchestrationEntryHash !== undefined && typeof value.orchestrationEntryHash !== "string")
    || (value.configOriginalHash !== null && typeof value.configOriginalHash !== "string")
    || typeof value.configMutatedHash !== "string"
    || typeof value.mcpServersOriginallyPresent !== "boolean"
    || typeof value.backupDirectory !== "string"
  ) throw new Error("CanvasTTY Hermes recovery journal is invalid.");
  if (!/^[0-9a-f-]{36}$/i.test(value.ownershipId)) {
    throw new Error("CanvasTTY Hermes recovery journal ownership is invalid.");
  }
  if (value.backupDirectory !== join(paths.backupRoot, value.ownershipId)) {
    throw new Error("CanvasTTY Hermes recovery journal backup path is invalid.");
  }
  return value as unknown as HermesRecoveryJournal;
}

function removeRecoveryArtifacts(
  paths: ReturnType<typeof hermesPaths>,
  journal: HermesRecoveryJournal
): void {
  unlinkIfExists(paths.journal);
  unlinkIfExists(join(journal.backupDirectory, "config.yaml"));
  removeEmptyDirectory(journal.backupDirectory);
  removeEmptyDirectory(paths.backupRoot);
}

function hermesPaths(homeDirectory: string) {
  return {
    config: join(homeDirectory, "config.yaml"),
    lock: join(homeDirectory, ".canvastty-hermes-browser.lock"),
    journal: join(homeDirectory, ".canvastty-hermes-browser-recovery.json"),
    backupRoot: join(homeDirectory, ".canvastty-hermes-browser-backups")
  };
}

function validateHelper(helper: HermesStdioHelperLaunch): void {
  if (!helper || typeof helper !== "object" || !helper.command || !Array.isArray(helper.args)) {
    throw new Error("CanvasTTY browser helper configuration is invalid.");
  }
  if (!helper.args.every((argument) => typeof argument === "string")) {
    throw new Error("CanvasTTY browser helper arguments are invalid.");
  }
  if (helper.env === undefined) return;
  if (!isRecord(helper.env)) throw new Error("CanvasTTY browser helper environment is invalid.");
  for (const [key, value] of Object.entries(helper.env)) {
    if (RESERVED_AGENT_ENVIRONMENT_PATTERN.test(key)) {
      throw new Error(`CanvasTTY browser helper environment cannot set reserved key: ${key}`);
    }
    if (!ALLOWED_HELPER_ENVIRONMENT_KEYS.has(key)) {
      throw new Error(`CanvasTTY browser helper environment key is not allowed: ${key}`);
    }
    if (typeof value !== "string") {
      throw new Error(`CanvasTTY browser helper environment value is invalid: ${key}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
