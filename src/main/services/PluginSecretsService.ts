import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PluginPermission } from "../../shared/contracts";

const MAX_SECRET_KEYS = 32;
const MAX_SECRET_KEY_LENGTH = 80;
const MAX_SECRET_VALUE_BYTES = 16 * 1024;
const MAX_SECRET_PAYLOAD_BYTES = 64 * 1024;

export interface SecretEncryption {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

type AssertPermission = (pluginId: string, permission: PluginPermission) => void;

export class PluginSecretsService {
  private readonly root: string;
  private readonly writes = new Map<string, Promise<void>>();
  /** Plugin id -> revocations queued or running. Writes are refused while one is pending. */
  private readonly revoking = new Map<string, number>();
  private readonly assertPermission: AssertPermission;
  private readonly encryption: SecretEncryption;

  constructor(
    userDataPath: string,
    assertPermission: AssertPermission,
    encryption: SecretEncryption
  ) {
    this.root = join(userDataPath, "plugin-secrets");
    this.assertPermission = assertPermission;
    this.encryption = encryption;
  }

  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async get(pluginId: string, key: string): Promise<string | null> {
    this.authorize(pluginId, key);
    const values = await this.read(pluginId);
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
  }

  async set(pluginId: string, key: string, value: string): Promise<void> {
    this.authorize(pluginId, key);
    if (typeof value !== "string" || Buffer.byteLength(value) > MAX_SECRET_VALUE_BYTES) {
      throw new Error("Plugin secret must be a string no larger than 16 KB.");
    }
    await this.mutate(pluginId, (values) => {
      if (!Object.prototype.hasOwnProperty.call(values, key) && Object.keys(values).length >= MAX_SECRET_KEYS) {
        throw new Error("Plugin secret storage supports at most 32 keys.");
      }
      values[key] = value;
    });
  }

  async delete(pluginId: string, key: string): Promise<void> {
    this.authorize(pluginId, key);
    await this.mutate(pluginId, (values) => {
      delete values[key];
    });
  }

  async revokeAll(pluginId: string): Promise<void> {
    assertPluginId(pluginId);
    this.revoking.set(pluginId, (this.revoking.get(pluginId) ?? 0) + 1);
    try {
      await this.queue(pluginId, async () => {
        await rm(this.path(pluginId), { force: true });
        await rm(`${this.path(pluginId)}.tmp`, { force: true });
      });
    } finally {
      const remaining = (this.revoking.get(pluginId) ?? 1) - 1;
      if (remaining > 0) this.revoking.set(pluginId, remaining);
      else this.revoking.delete(pluginId);
    }
  }

  private authorize(pluginId: string, key: string): void {
    assertPluginId(pluginId);
    assertSecretKey(key);
    this.assertPermission(pluginId, "secrets");
    if (!this.encryption.isAvailable()) {
      throw new Error("Secure plugin storage is unavailable on this system.");
    }
  }

  private async mutate(pluginId: string, mutation: (values: Record<string, string>) => void): Promise<void> {
    // A write queued behind a revocation would run after it and recreate the file uninstall removed.
    if (this.revoking.has(pluginId)) throw new Error("Plugin secrets are being removed.");
    await this.queue(pluginId, async () => {
      // Authorization was checked when the write was requested; the plugin may have been
      // uninstalled while earlier writes ran, and then this one must not land.
      this.assertPermission(pluginId, "secrets");
      const values = await this.read(pluginId);
      mutation(values);
      const keys = Object.keys(values);
      if (keys.length === 0) {
        await rm(this.path(pluginId), { force: true });
        return;
      }
      const plaintext = JSON.stringify(values);
      if (Buffer.byteLength(plaintext) > MAX_SECRET_PAYLOAD_BYTES) {
        throw new Error("Plugin secret storage exceeds the 64 KB quota.");
      }
      const encrypted = this.encryption.encrypt(plaintext);
      const path = this.path(pluginId);
      const temporaryPath = `${path}.tmp`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temporaryPath, encrypted, { mode: 0o600 });
      await rename(temporaryPath, path);
    });
  }

  private queue(pluginId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(pluginId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.writes.set(pluginId, next);
    void next.then(() => {
      if (this.writes.get(pluginId) === next) this.writes.delete(pluginId);
    }, () => {
      if (this.writes.get(pluginId) === next) this.writes.delete(pluginId);
    });
    return next;
  }

  private async read(pluginId: string): Promise<Record<string, string>> {
    if (!this.encryption.isAvailable()) {
      throw new Error("Secure plugin storage is unavailable on this system.");
    }
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.path(pluginId));
    } catch (error) {
      if (isMissingFile(error)) return {};
      throw error;
    }
    try {
      const plaintext = this.encryption.decrypt(encrypted);
      if (Buffer.byteLength(plaintext) > MAX_SECRET_PAYLOAD_BYTES) throw new Error("Secret payload is too large.");
      const candidate: unknown = JSON.parse(plaintext);
      if (!isSecretRecord(candidate)) throw new Error("Secret payload is invalid.");
      return { ...candidate };
    } catch {
      throw new Error("Plugin secrets could not be decrypted.");
    }
  }

  private path(pluginId: string): string {
    return join(this.root, `${pluginId}.bin`);
  }
}

function assertPluginId(value: string): void {
  if (!/^(?!.*\.\.)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) || value.length > 80) {
    throw new Error("Plugin identifier is invalid.");
  }
}

function assertSecretKey(value: string): void {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_SECRET_KEY_LENGTH
    || !/^[A-Za-z0-9._-]+$/.test(value)
  ) {
    throw new Error("Plugin secret key is invalid.");
  }
}

function isSecretRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= MAX_SECRET_KEYS && entries.every(([key, item]) => (
    key.length > 0
    && key.length <= MAX_SECRET_KEY_LENGTH
    && /^[A-Za-z0-9._-]+$/.test(key)
    && typeof item === "string"
    && Buffer.byteLength(item) <= MAX_SECRET_VALUE_BYTES
  ));
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
