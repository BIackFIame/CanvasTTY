import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { isPathInside } from "../../../agent-runtime/path-inside.mjs";
import { chmod, mkdir, open, realpath, rm, stat, unlink } from "node:fs/promises";
import { BrowserKernelError } from "./BrowserErrors.ts";

export const DEFAULT_BROWSER_URL = "https://duckduckgo.com/";
export const MAX_BROWSER_TABS = 24;
export const MAX_BROWSER_URL_LENGTH = 2_048;
export const MAX_UPLOAD_FILES = 20;
export const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;

const LOCAL_HTTP_HOSTS = new Set(["localhost", "localhost.", "127.0.0.1", "::1"]);

export interface BrowserPolicyOptions {
  downloadRoot: string;
  uploadRoots?: readonly string[];
  uploadStagingRoot?: string;
}

export interface PopupDecision {
  action: "adopt" | "deny";
  url?: string;
  activate?: boolean;
  reason?: string;
}

export class BrowserPolicyService {
  readonly downloadRoot: string;
  readonly uploadStagingRoot: string;
  private readonly uploadRoots: string[];

  constructor(options: BrowserPolicyOptions) {
    this.downloadRoot = resolve(options.downloadRoot);
    this.uploadStagingRoot = resolve(options.uploadStagingRoot ?? resolve(this.downloadRoot, ".upload-staging"));
    this.uploadRoots = (options.uploadRoots ?? []).filter(isAbsolute).map((path) => resolve(path));
  }

  normalizeHumanInput(value: unknown): string {
    const input = typeof value === "string" ? value.trim() : "";
    if (!input) return DEFAULT_BROWSER_URL;
    const direct = input.includes("://")
      ? input
      : !input.includes(" ") && isLocalHostInput(input)
        ? `http://${input}`
        : !input.includes(" ") && input.includes(".")
          ? `https://${input}`
          : null;
    if (direct && isSafeBrowserUrl(direct)) return new URL(direct).toString();
    return `https://duckduckgo.com/?q=${encodeURIComponent(input)}`;
  }

  assertNavigationUrl(value: unknown): string {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_BROWSER_URL_LENGTH) {
      throw new BrowserKernelError("INVALID_URL", "Browser URL is missing or too long.");
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BrowserKernelError("INVALID_URL", "Browser URL is invalid.");
    }
    if (!isSafeBrowserUrl(url)) {
      throw new BrowserKernelError("NAVIGATION_BLOCKED", "Only HTTP(S) browser URLs are allowed.");
    }
    return url.toString();
  }

  popup(url: string, disposition: string, tabCount: number): PopupDecision {
    if (tabCount >= MAX_BROWSER_TABS) {
      return { action: "deny", reason: "tab-limit" };
    }
    if (!isSafeBrowserUrl(url)) {
      return { action: "deny", reason: "url-policy" };
    }
    return {
      action: "adopt",
      url: new URL(url).toString(),
      activate: disposition !== "background-tab"
    };
  }

  permission(_permission: string, requestingUrl?: string): boolean {
    return Boolean(requestingUrl && isSafeBrowserUrl(requestingUrl)) && false;
  }

  resolveDownloadPath(downloadId: string, suggestedFilename: string): string {
    const safeId = downloadId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "download";
    const fileName = sanitizeFilename(suggestedFilename);
    const target = resolve(this.downloadRoot, `${safeId}-${fileName}`);
    if (!isPathInside(this.downloadRoot, target)) {
      throw new BrowserKernelError("PATH_DENIED", "Download path escaped the managed directory.");
    }
    return target;
  }

  async validateUploadPaths(
    values: unknown,
    additionalRoots: readonly string[] = []
  ): Promise<string[]> {
    if (!Array.isArray(values) || values.length === 0 || values.length > MAX_UPLOAD_FILES) {
      throw new BrowserKernelError("PATH_DENIED", `Upload requires 1-${MAX_UPLOAD_FILES} files.`);
    }
    const requestedRoots = [...this.uploadRoots, ...additionalRoots.filter(isAbsolute).map((path) => resolve(path))];
    const roots = await Promise.all(requestedRoots.map(async (path) => {
      try {
        return await realpath(path);
      } catch {
        return null;
      }
    }));
    const allowedRoots = roots.filter((path): path is string => Boolean(path));
    if (allowedRoots.length === 0) {
      throw new BrowserKernelError("PATH_DENIED", "No upload directory is authorized for this browser actor.");
    }

    await mkdir(this.uploadStagingRoot, { recursive: true, mode: 0o700 });
    await chmod(this.uploadStagingRoot, 0o700);
    const paths: string[] = [];
    for (const candidate of values) {
      if (typeof candidate !== "string" || !isAbsolute(candidate) || candidate.length > 4_096) {
        throw new BrowserKernelError("PATH_DENIED", "Upload path is invalid.");
      }
      let canonical: string;
      try {
        canonical = await realpath(candidate);
      } catch {
        throw new BrowserKernelError("PATH_DENIED", "Upload file does not exist.");
      }
      if (!allowedRoots.some((root) => isPathInside(root, canonical))) {
        throw new BrowserKernelError("PATH_DENIED", "Upload file is outside authorized directories.");
      }
      const metadata = await stat(canonical);
      if (!metadata.isFile() || metadata.size > MAX_UPLOAD_FILE_BYTES) {
        throw new BrowserKernelError("PAYLOAD_TOO_LARGE", "Upload file is invalid or exceeds 100 MB.");
      }
      paths.push(await this.stageUploadFile(canonical));
    }
    return paths;
  }

  async clearStagedUploads(): Promise<void> {
    await rm(this.uploadStagingRoot, { recursive: true, force: true });
  }

  private async stageUploadFile(canonical: string): Promise<string> {
    const targetDirectory = resolve(this.uploadStagingRoot, randomUUID());
    const target = resolve(targetDirectory, sanitizeFilename(basename(canonical)));
    if (!isPathInside(this.uploadStagingRoot, target)) {
      throw new BrowserKernelError("PATH_DENIED", "Upload staging path escaped its managed directory.");
    }

    let source;
    let destination;
    try {
      await mkdir(targetDirectory, { recursive: false, mode: 0o700 });
      source = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await source.stat();
      if (!before.isFile() || before.size > MAX_UPLOAD_FILE_BYTES) {
        throw new BrowserKernelError("PAYLOAD_TOO_LARGE", "Upload file is invalid or exceeds 100 MB.");
      }
      destination = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600
      );
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let offset = 0;
      while (offset < before.size) {
        const requested = Math.min(buffer.byteLength, before.size - offset);
        const { bytesRead } = await source.read(buffer, 0, requested, offset);
        if (bytesRead <= 0) throw new BrowserKernelError("PATH_DENIED", "Upload file changed while it was staged.");
        let written = 0;
        while (written < bytesRead) {
          const result = await destination.write(buffer, written, bytesRead - written, offset + written);
          if (result.bytesWritten <= 0) throw new BrowserKernelError("BRIDGE_UNAVAILABLE", "Upload staging write failed.");
          written += result.bytesWritten;
        }
        offset += bytesRead;
      }
      const after = await source.stat();
      if (
        after.dev !== before.dev
        || after.ino !== before.ino
        || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs
      ) {
        throw new BrowserKernelError("PATH_DENIED", "Upload file changed while it was staged.");
      }
      await destination.sync();
      return target;
    } catch (error) {
      await unlink(target).catch(() => undefined);
      await rm(targetDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      await destination?.close().catch(() => undefined);
      await source?.close().catch(() => undefined);
    }
  }
}

export function isSafeBrowserUrl(value: string | URL): boolean {
  try {
    const url = value instanceof URL ? value : new URL(value);
    if (url.toString().length > MAX_BROWSER_URL_LENGTH || !url.hostname) return false;
    if (url.username || url.password) return false;
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function sanitizeFilename(value: string): string {
  const raw = basename(value || "download").replace(/[\u0000-\u001f\u007f]/g, "");
  const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "").trim().slice(0, 180);
  return safe || "download";
}

function isLocalHostInput(value: string): boolean {
  const authority = value.split(/[/?#]/, 1)[0] ?? "";
  const host = authority.startsWith("[")
    ? authority.slice(1, authority.indexOf("]") > 0 ? authority.indexOf("]") : undefined).toLowerCase()
    : authority.split(":", 1)[0]?.toLowerCase();
  return Boolean(host && LOCAL_HTTP_HOSTS.has(host));
}
