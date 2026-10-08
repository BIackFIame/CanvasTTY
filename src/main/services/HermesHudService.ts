import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { HermesHudSnapshot } from "../../shared/contracts.ts";
import {
  providerChildProcessLaunch,
  type ProviderCliRegistry
} from "./providerCliRegistry.ts";

const HERMES_DESKTOP_RUNTIME_FILENAME = "desktop-runtime.json";

interface HermesDesktopRuntimeState {
  version: 1;
  pid: number;
  hudOpen: boolean;
  startedAt: number;
  updatedAt: number;
}

interface HermesHudServiceOptions {
  runtimeStatePath?: string;
  readText?: (path: string) => Promise<string>;
  processAlive?: (pid: number) => boolean;
  spawnProcess?: typeof spawn;
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  openTimeoutMs?: number;
  closeTimeoutMs?: number;
}

type Transition = "starting" | "stopping";

export class HermesHudService {
  private readonly providerClis: ProviderCliRegistry;
  private readonly runtimeStatePath: string;
  private readonly readText: (path: string) => Promise<string>;
  private readonly processAlive: (pid: number) => boolean;
  private readonly spawnProcess: typeof spawn;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly openTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private lane: Promise<void> = Promise.resolve();
  private transition: Transition | null = null;

  constructor(
    providerClis: ProviderCliRegistry,
    hermesHomeDirectory: string,
    options: HermesHudServiceOptions = {}
  ) {
    this.providerClis = providerClis;
    this.runtimeStatePath = options.runtimeStatePath
      ?? join(hermesHomeDirectory, HERMES_DESKTOP_RUNTIME_FILENAME);
    this.readText = options.readText ?? ((path) => readFile(path, "utf8"));
    this.processAlive = options.processAlive ?? isProcessAlive;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.openTimeoutMs = options.openTimeoutMs ?? 45_000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 15_000;
  }

  async status(): Promise<HermesHudSnapshot> {
    const actual = await this.actualState();
    if (!this.transition) return actual;
    if (this.transition === "starting" && actual.state === "running" && actual.hudOpen) return actual;
    if (this.transition === "stopping" && actual.state === "stopped") return actual;
    return { state: this.transition };
  }

  open(): Promise<HermesHudSnapshot> {
    return this.enqueue(async () => {
      const current = await this.actualState();
      if (current.state === "running" && current.hudOpen) return current;
      this.transition = "starting";
      try {
        await this.sendControl("--hud");
        return await this.waitFor(
          (state) => state.state === "running" && state.hudOpen,
          this.openTimeoutMs,
          "Hermes Desktop did not enter HUD mode in time. Rebuild Hermes Desktop with external HUD control support."
        );
      } finally {
        this.transition = null;
      }
    });
  }

  close(): Promise<HermesHudSnapshot> {
    return this.enqueue(async () => {
      const current = await this.actualState();
      if (current.state === "stopped") return current;
      this.transition = "stopping";
      try {
        await this.sendControl("--quit");
        return await this.waitFor(
          (state) => state.state === "stopped",
          this.closeTimeoutMs,
          "Hermes Desktop did not close in time. It may be waiting for confirmation before quitting an active turn."
        );
      } finally {
        this.transition = null;
      }
    });
  }

  private enqueue(action: () => Promise<HermesHudSnapshot>): Promise<HermesHudSnapshot> {
    const result = this.lane.then(action, action);
    this.lane = result.then(() => undefined, () => undefined);
    return result;
  }

  private async actualState(): Promise<HermesHudSnapshot> {
    const resolution = this.providerClis.get("hermes");
    if (resolution.state === "unavailable") {
      return { state: "unavailable", reason: "cli-not-found", message: resolution.diagnostic };
    }

    let raw: string;
    try {
      raw = await this.readText(this.runtimeStatePath);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return { state: "stopped" };
      return { state: "error", message: "Hermes Desktop runtime state could not be read." };
    }

    let runtime: HermesDesktopRuntimeState;
    try {
      runtime = parseHermesDesktopRuntimeState(raw);
    } catch {
      return { state: "error", message: "Hermes Desktop runtime state is invalid." };
    }

    return this.processAlive(runtime.pid)
      ? { state: "running", hudOpen: runtime.hudOpen }
      : { state: "stopped" };
  }

  private async sendControl(flag: "--hud" | "--quit"): Promise<void> {
    const resolution = this.providerClis.get("hermes");
    if (resolution.state === "unavailable") throw new Error(resolution.diagnostic);
    const launch = providerChildProcessLaunch(resolution, ["desktop", "--skip-build", flag]);
    const child = this.spawnProcess(launch.command, launch.args, {
      detached: true,
      env: { ...process.env, ...launch.environment },
      stdio: "ignore",
      windowsHide: true,
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
    });
    await spawned(child);
    child.unref();
  }

  private async waitFor(
    accept: (state: HermesHudSnapshot) => boolean,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<HermesHudSnapshot> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const state = await this.actualState();
      if (accept(state)) return state;
      if (state.state === "unavailable" || state.state === "error") {
        throw new Error(state.message);
      }
      if (Date.now() >= deadline) throw new Error(timeoutMessage);
      await this.sleep(this.pollIntervalMs);
    }
  }
}

export function parseHermesDesktopRuntimeState(raw: string): HermesDesktopRuntimeState {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)
    || Reflect.ownKeys(value).length !== 5
    || value.version !== 1
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) <= 0
    || typeof value.hudOpen !== "boolean"
    || typeof value.startedAt !== "number"
    || !Number.isFinite(value.startedAt)
    || typeof value.updatedAt !== "number"
    || !Number.isFinite(value.updatedAt)
  ) throw new Error("Invalid Hermes Desktop runtime state.");
  return value as unknown as HermesDesktopRuntimeState;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "EPERM")) return true;
    if (hasErrorCode(error, "ESRCH")) return false;
    return false;
  }
}

function spawned(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
