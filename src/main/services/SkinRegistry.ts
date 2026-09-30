import { createHash } from "node:crypto";
import { watch as watchFileSystem, type Dirent, type FSWatcher } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  CustomTerminalBorderSkinId,
  TerminalBorderSkinListItem,
  TerminalBorderSkinManifest,
  TerminalBorderSkinReadResult
} from "../../shared/contracts";

const MAX_SKINS = 100;
const MAX_MANIFEST_BYTES = 4 * 1024;
const MAX_CSS_BYTES = 64 * 1024;
const MAX_SKIN_NAME_LENGTH = 64;
const MAX_SKIN_SLUG_LENGTH = 48;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CUSTOM_SKIN_ID_PATTERN = /^custom:([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const BORDER_PROPERTIES = /^(?:border(?:-(?:top|right|bottom|left))?(?:-(?:color|style|width))?|border-radius|border-image(?:-(?:source|slice|width|outset|repeat))?|outline(?:-(?:color|style|width|offset))?|box-shadow|background(?:-(?:color|image|position|size|repeat|origin|clip))?|color|opacity)$/;
const DANGEROUS_CSS = /(?:@import|\burl\s*\(|\bexpression\s*\(|\b(?:javascript|vbscript|file|data)\s*:|(?:https?:)?\/\/|-moz-binding|(?:^|[;{\s])behavior\s*:|@namespace|@font-face|@document|@supports|@media|paint\s*\(|element\s*\()/i;

interface LoadedSkin {
  id: CustomTerminalBorderSkinId;
  name: string;
  revision: string;
  css: string;
}

interface SkinState {
  good?: LoadedSkin;
  error?: string;
}

interface WatchedDirectory {
  watcher: FSWatcher;
  dev: number;
  ino: number;
}

interface RootWatcherHandle {
  close(): void;
}

type RootWatcherFactory = (
  path: string,
  onChange: () => void,
  onError: (error?: unknown) => void
) => RootWatcherHandle;

export interface SkinRegistryOptions {
  /** Injectable so watcher install and runtime failures can be tested deterministically. */
  rootWatcherFactory?: RootWatcherFactory;
  /** Retry timing is configurable for focused tests; production values are bounded below. */
  rootRetryBaseMs?: number;
  rootRetryMaxMs?: number;
}

const DEFAULT_ROOT_RETRY_BASE_MS = 250;
const DEFAULT_ROOT_RETRY_MAX_MS = 30_000;
const MAX_ROOT_RETRY_EXPONENT = 16;

const nativeRootWatcherFactory: RootWatcherFactory = (path, onChange, onError) => {
  const watcher = watchFileSystem(path, () => onChange());
  watcher.on("error", onError);
  return watcher;
};

/** The slug remains deliberately narrower than the shared template-string type. */
export function isCustomTerminalBorderSkinId(value: unknown): value is CustomTerminalBorderSkinId {
  if (typeof value !== "string") return false;
  const match = CUSTOM_SKIN_ID_PATTERN.exec(value);
  return Boolean(match && match[1].length <= MAX_SKIN_SLUG_LENGTH);
}

function isSkinSlug(value: string): boolean {
  return value.length <= MAX_SKIN_SLUG_LENGTH && SLUG_PATTERN.test(value);
}

export function isTerminalBorderSkinId(value: unknown): value is import("../../shared/contracts").TerminalBorderSkinId {
  return value === "classic"
    || value === "minimal"
    || value === "glass"
    || value === "cyber"
    || value === "nord"
    || value === "gradient"
    || value === "cybercore"
    || value === "titanium"
    || value === "retro"
    || value === "sakura"
    || value === "matrix"
    || value === "forest-cabin"
    || value === "gold-black"
    || value === "cat"
    || value === "gothic-eclipse"
    || (typeof value === "string" && /^pixel:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))
    || isCustomTerminalBorderSkinId(value);
}

/**
 * Loads user-authored, local-only terminal border skins from userData/skins.
 * CSS is a restricted stylesheet; it is never evaluated as JavaScript.
 */
export class SkinRegistry {
  private readonly requestedRoot: string;
  private root = "";
  private readonly entries = new Map<string, SkinState>();
  private readonly listeners = new Set<() => void>();
  private readonly directoryWatchers = new Map<string, WatchedDirectory>();
  private readonly rootWatcherFactory: RootWatcherFactory;
  private readonly rootRetryBaseMs: number;
  private readonly rootRetryMaxMs: number;
  private rootWatcher?: RootWatcherHandle;
  private rootRetryTimer?: ReturnType<typeof setTimeout>;
  private rootRetryAttempt = 0;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private scanInProgress = false;
  private scanAgain = false;
  private initialized = false;
  private disposed = false;
  private rootError?: string;

  constructor(userDataPath: string, options: SkinRegistryOptions = {}) {
    this.requestedRoot = join(userDataPath, "skins");
    this.rootWatcherFactory = options.rootWatcherFactory ?? nativeRootWatcherFactory;
    this.rootRetryBaseMs = boundedRetryDelay(options.rootRetryBaseMs, DEFAULT_ROOT_RETRY_BASE_MS);
    this.rootRetryMaxMs = Math.max(
      this.rootRetryBaseMs,
      boundedRetryDelay(options.rootRetryMaxMs, DEFAULT_ROOT_RETRY_MAX_MS)
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      await mkdir(this.requestedRoot, { recursive: true });
      const rootStat = await lstat(this.requestedRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error("The terminal skin directory must be a real directory.");
      }
      this.root = await realpath(this.requestedRoot);
    } catch (error) {
      this.rootError = safeErrorMessage(error);
      this.initialized = true;
      return;
    }
    this.installRootWatcher();
    try {
      await this.scan(false);
    } catch (error) {
      this.rootError = safeErrorMessage(error);
      this.entries.clear();
    }
    this.initialized = true;
  }

  list(): TerminalBorderSkinListItem[] {
    if (this.rootError) {
      return [{
        id: "custom:skin-registry",
        status: "error",
        error: this.rootError
      }];
    }
    return [...this.entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([slug, state]) => {
        if (state.error) {
          return {
            id: `custom:${slug}` as CustomTerminalBorderSkinId,
            ...(state.good ? { name: state.good.name, revision: state.good.revision } : {}),
            status: "error" as const,
            error: state.error
          };
        }
        if (!state.good) return undefined;
        return {
          id: state.good.id,
          name: state.good.name,
          revision: state.good.revision,
          status: "ready" as const
        };
      })
      .filter((item): item is TerminalBorderSkinListItem => Boolean(item));
  }

  get(id: CustomTerminalBorderSkinId): TerminalBorderSkinReadResult {
    if (!isCustomTerminalBorderSkinId(id)) {
      throw new Error("Custom terminal skin ID is invalid.");
    }
    if (this.rootError) return { id, status: "error", error: this.rootError };
    const slug = id.slice("custom:".length);
    const state = this.entries.get(slug);
    if (state?.good) {
      // Keep serving the last valid CSS during a malformed edit. list() carries
      // the current error so the renderer can show that a newer edit was rejected.
      return { ...state.good, status: "ready" };
    }
    return {
      id,
      status: "error",
      error: state?.error ?? "Terminal border skin was not found."
    };
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.rootRetryTimer) clearTimeout(this.rootRetryTimer);
    this.rootRetryTimer = undefined;
    this.rootWatcher?.close();
    this.rootWatcher = undefined;
    for (const watched of this.directoryWatchers.values()) watched.watcher.close();
    this.directoryWatchers.clear();
    this.listeners.clear();
  }

  private installRootWatcher(): void {
    if (this.disposed || !this.root || this.rootWatcher) return;
    let watcher: RootWatcherHandle | undefined;
    let failedBeforeAssignment = false;
    try {
      watcher = this.rootWatcherFactory(
        this.root,
        () => {
          if (this.disposed || this.rootWatcher !== watcher) return;
          this.rootRetryAttempt = 0;
          this.scheduleScan();
        },
        () => {
          if (!watcher) {
            failedBeforeAssignment = true;
            return;
          }
          this.handleRootWatcherFailure(watcher);
        }
      );
      if (this.disposed || failedBeforeAssignment) {
        watcher.close();
        if (!this.disposed) this.scheduleRootWatcherRetry();
        return;
      }
      this.rootWatcher = watcher;
    } catch {
      this.rootWatcher = undefined;
      this.scheduleRootWatcherRetry();
    }
  }

  private handleRootWatcherFailure(watcher: RootWatcherHandle): void {
    if (this.disposed || this.rootWatcher !== watcher) return;
    this.rootWatcher = undefined;
    watcher.close();
    this.scheduleScan();
    this.scheduleRootWatcherRetry();
  }

  private scheduleRootWatcherRetry(): void {
    if (this.disposed || !this.root || this.rootRetryTimer) return;
    const exponent = Math.min(this.rootRetryAttempt, MAX_ROOT_RETRY_EXPONENT);
    const delay = Math.min(this.rootRetryBaseMs * (2 ** exponent), this.rootRetryMaxMs);
    this.rootRetryAttempt = Math.min(this.rootRetryAttempt + 1, MAX_ROOT_RETRY_EXPONENT);
    this.rootRetryTimer = setTimeout(() => {
      this.rootRetryTimer = undefined;
      if (this.disposed) return;
      this.installRootWatcher();
      // Even if the watcher cannot be reinstalled, bounded retries continue
      // to discover folder additions and removals without requiring restart.
      void this.scan(true).catch(() => undefined);
    }, delay);
  }

  private scheduleScan(): void {
    if (this.disposed || (!this.initialized && !this.root)) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.scan(true).catch(() => undefined);
    }, 80);
  }

  private async scan(notify: boolean): Promise<void> {
    if (this.scanInProgress) {
      this.scanAgain = true;
      return;
    }
    this.scanInProgress = true;
    try {
      do {
        this.scanAgain = false;
        await this.scanOnce(notify);
      } while (this.scanAgain);
    } finally {
      this.scanInProgress = false;
      if (this.scanAgain) {
        this.scanAgain = false;
        this.scheduleScan();
      }
    }
  }

  private async scanOnce(notify: boolean): Promise<void> {
    const children = await readdir(this.root, { withFileTypes: true });
    this.rootError = undefined;
    const slugs = children
      .map((entry) => entry.name)
      .filter(isSkinSlug)
      .sort();
    await this.refreshDirectoryWatchers(children);

    const previous = new Map(this.entries);
    const next = new Map<string, SkinState>();
    for (const [index, slug] of slugs.entries()) {
      if (index >= MAX_SKINS) {
        next.set(slug, { error: `Only the first ${MAX_SKINS} terminal skins can be loaded.` });
        continue;
      }
      const oldState = this.entries.get(slug);
      try {
        next.set(slug, { good: await this.loadSkin(slug) });
      } catch (error) {
        next.set(slug, {
          ...(oldState?.good ? { good: oldState.good } : {}),
          error: safeErrorMessage(error)
        });
      }
    }
    const changed = !sameEntries(previous, next);
    this.entries.clear();
    for (const [slug, state] of next) this.entries.set(slug, state);

    if (notify && changed && this.listeners.size > 0) {
      for (const listener of this.listeners) listener();
    }
  }

  private async refreshDirectoryWatchers(children: Dirent[]): Promise<void> {
    const available = new Set(children
      .filter((child) => isSkinSlug(child.name) && child.isDirectory())
      .map((child) => child.name)
      .sort()
      .slice(0, MAX_SKINS));
    for (const slug of available) {
      try {
        const directory = resolve(this.root, slug);
        const directoryStat = await lstat(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || await realpath(directory) !== directory) continue;
        const existing = this.directoryWatchers.get(slug);
        if (existing?.dev === directoryStat.dev && existing.ino === directoryStat.ino) continue;
        existing?.watcher.close();
        this.directoryWatchers.delete(slug);
        const watcher = watchFileSystem(directory, () => this.scheduleScan());
        watcher.on("error", () => {
          watcher.close();
          if (this.directoryWatchers.get(slug)?.watcher === watcher) this.directoryWatchers.delete(slug);
          this.scheduleScan();
        });
        this.directoryWatchers.set(slug, { watcher, dev: directoryStat.dev, ino: directoryStat.ino });
      } catch {
        // Invalid or disappearing folders will be surfaced by the scanner.
      }
    }
    for (const [slug, watched] of this.directoryWatchers) {
      if (available.has(slug)) continue;
      watched.watcher.close();
      this.directoryWatchers.delete(slug);
    }
  }

  private async loadSkin(slug: string): Promise<LoadedSkin> {
    if (!isSkinSlug(slug)) throw new Error("Skin folder name is invalid.");
    const directory = resolve(this.root, slug);
    const directoryRelative = relative(this.root, directory);
    if (!directoryRelative || directoryRelative.startsWith(`..${sep}`) || directoryRelative === ".." || isAbsolute(directoryRelative)) {
      throw new Error("Skin path escapes the skin directory.");
    }
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("Skin folder must be a real directory, not a symlink.");
    }
    if (await realpath(directory) !== directory) {
      throw new Error("Skin folder resolves outside the skin directory.");
    }

    const manifestPath = join(directory, "manifest.json");
    const manifestText = await readBoundedUtf8File(manifestPath, MAX_MANIFEST_BYTES, "Skin manifest");
    const manifest = parseManifest(manifestText, slug);
    const cssPath = join(directory, "skin.css");
    const css = await readBoundedUtf8File(cssPath, MAX_CSS_BYTES, "Skin CSS");
    validateSkinCss(css);

    const id = `custom:${slug}` as CustomTerminalBorderSkinId;
    const revision = createHash("sha256").update(manifest.name).update("\0").update(css).digest("hex").slice(0, 16);
    return { id, name: manifest.name, revision, css };
  }
}

function boundedRetryDelay(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(DEFAULT_ROOT_RETRY_MAX_MS, Math.max(10, Math.floor(value)));
}

async function readBoundedUtf8File(path: string, maxBytes: number, label: string): Promise<string> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`${label} must be a regular file, not a symlink.`);
  if (before.size > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte limit.`);

  let flags = fsConstants.O_RDONLY;
  if (typeof fsConstants.O_NOFOLLOW === "number") flags |= fsConstants.O_NOFOLLOW;
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed while it was being opened.`);
    }
    if (opened.size > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte limit.`);

    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, total, Math.min(4096, buffer.length - total), null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte limit.`);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total));
    } catch {
      throw new Error(`${label} must use valid UTF-8.`);
    }
  } finally {
    await handle.close();
  }
}

function parseManifest(text: string, slug: string): TerminalBorderSkinManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Skin manifest is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Skin manifest must be a JSON object.");
  }
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 4
    || keys.join(",") !== "id,kind,name,schemaVersion"
    || value.schemaVersion !== 1
    || value.kind !== "terminal-border"
    || value.id !== slug
    || typeof value.name !== "string"
    || value.name.trim().length === 0
    || value.name.trim().length > MAX_SKIN_NAME_LENGTH
    || /[\u0000-\u001f\u007f]/.test(value.name)
  ) {
    throw new Error("Skin manifest fields are invalid or do not match the folder name.");
  }
  return {
    schemaVersion: 1,
    id: slug,
    name: value.name.trim(),
    kind: "terminal-border"
  };
}

function validateSkinCss(css: string): void {
  if (Buffer.byteLength(css, "utf8") === 0) throw new Error("Skin CSS is empty.");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(css)) {
    throw new Error("Skin CSS contains unsupported control characters.");
  }
  if (css.includes("<")) throw new Error("Skin CSS cannot contain HTML markup.");
  if (css.includes("\\")) throw new Error("Skin CSS escapes are not supported.");

  const normalized = stripCssComments(css);
  if (DANGEROUS_CSS.test(normalized)) throw new Error("Skin CSS contains a forbidden import, URL, or executable CSS feature.");
  if (normalized.trim().length === 0) throw new Error("Skin CSS is empty.");

  let cursor = 0;
  let ruleCount = 0;
  while (cursor < normalized.length) {
    while (/\s/.test(normalized[cursor] ?? "")) cursor += 1;
    if (cursor >= normalized.length) break;

    const openBrace = findCssDelimiter(normalized, cursor, "{");
    if (openBrace < 0) throw new Error("Skin CSS contains an incomplete rule.");
    const selectorText = normalized.slice(cursor, openBrace).trim();
    if (!selectorText || selectorText.startsWith("@") || selectorText.includes("@") || selectorText.includes(";")) {
      throw new Error("Skin CSS at-rules and malformed selectors are not supported.");
    }
    for (const selector of splitTopLevel(selectorText, ",")) {
      validateScopedSelector(selector);
    }

    const closeBrace = findCssBlockEnd(normalized, openBrace + 1);
    const body = normalized.slice(openBrace + 1, closeBrace);
    validateDeclarations(body);
    ruleCount += 1;
    if (ruleCount > 256) throw new Error("Skin CSS contains too many rules.");
    cursor = closeBrace + 1;
  }
  if (ruleCount === 0) throw new Error("Skin CSS does not contain any rules.");
}

function stripCssComments(value: string): string {
  let result = "";
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      result += character;
      if (character === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      result += character;
      continue;
    }
    if (character === "/" && value[index + 1] === "*") {
      const end = value.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Skin CSS contains an unclosed comment.");
      index = end + 1;
      continue;
    }
    result += character;
  }
  if (quote) throw new Error("Skin CSS contains an unclosed string.");
  return result;
}

function findCssDelimiter(value: string, start: number, delimiter: string): number {
  let quote = "";
  let parentheses = 0;
  let brackets = 0;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === delimiter && parentheses === 0 && brackets === 0) return index;
    else if (character === "}" && parentheses === 0 && brackets === 0) {
      throw new Error("Skin CSS contains an unexpected closing brace.");
    }
    if (parentheses < 0 || brackets < 0) throw new Error("Skin CSS contains unbalanced delimiters.");
  }
  if (quote || parentheses !== 0 || brackets !== 0) throw new Error("Skin CSS contains unbalanced delimiters.");
  return -1;
}

function findCssBlockEnd(value: string, start: number): number {
  let quote = "";
  let parentheses = 0;
  let brackets = 0;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "{") throw new Error("Nested CSS rules are not supported.");
    else if (character === "}" && parentheses === 0 && brackets === 0) return index;
    if (parentheses < 0 || brackets < 0) throw new Error("Skin CSS contains unbalanced delimiters.");
  }
  throw new Error("Skin CSS contains an unclosed rule.");
}

function splitTopLevel(value: string, delimiter: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quote = "";
  let parentheses = 0;
  let brackets = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === delimiter && parentheses === 0 && brackets === 0) {
      result.push(value.slice(start, index));
      start = index + 1;
    }
  }
  result.push(value.slice(start));
  return result;
}

function validateScopedSelector(selector: string): void {
  const normalized = selector.trim();
  if (!normalized.startsWith(".terminal-card")) {
    throw new Error("Every skin selector must start inside .terminal-card.");
  }
  const next = normalized[".terminal-card".length];
  if (next && !/[.#:[\s>+~]/.test(next)) {
    throw new Error("Skin selector does not target the .terminal-card scope.");
  }
  if (/:global\b|:host\b|::slotted\b|::part\b|::backdrop\b|::view-transition\b/i.test(normalized)) {
    throw new Error("Skin selector cannot escape the .terminal-card scope.");
  }
  if (hasTopLevelColumnCombinator(normalized)) {
    throw new Error("Skin selector cannot use a column combinator outside the .terminal-card scope.");
  }
  if (hasTopLevelSiblingCombinator(normalized)) {
    throw new Error("Skin selector cannot use sibling combinators outside the .terminal-card scope.");
  }
}

function hasTopLevelColumnCombinator(selector: string): boolean {
  let parentheses = 0;
  let brackets = 0;
  let quote = "";
  for (let index = 0; index < selector.length - 1; index += 1) {
    const character = selector[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "|" && selector[index + 1] === "|" && parentheses === 0 && brackets === 0) return true;
  }
  return false;
}

function hasTopLevelSiblingCombinator(selector: string): boolean {
  let parentheses = 0;
  let brackets = 0;
  let quote = "";
  for (const character of selector) {
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (parentheses === 0 && brackets === 0) {
      if (character === "+" || character === "~") return true;
    }
  }
  return false;
}

function validateDeclarations(body: string): void {
  const declarations = splitTopLevel(body, ";");
  let count = 0;
  for (const declaration of declarations) {
    const trimmed = declaration.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) throw new Error("Skin CSS contains an invalid declaration.");
    const property = trimmed.slice(0, colon).trim().toLowerCase();
    const value = trimmed.slice(colon + 1).trim();
    if (!/^(?:--[a-z0-9_-]+|[a-z][a-z0-9-]*)$/.test(property) || !value) {
      throw new Error("Skin CSS contains an invalid declaration.");
    }
    if (!property.startsWith("--") && !BORDER_PROPERTIES.test(property)) {
      throw new Error(`Skin CSS property '${property}' is not allowed for terminal border skins.`);
    }
    if (/!\s*important/i.test(value)) throw new Error("Skin CSS cannot use !important.");
    count += 1;
  }
  if (count === 0) throw new Error("Skin CSS rules must contain at least one declaration.");
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && !("code" in error) && error.message.length <= 240) return error.message;
  return "Skin files could not be read or validated.";
}

function sameEntries(left: Map<string, SkinState>, right: Map<string, SkinState>): boolean {
  if (left.size !== right.size) return false;
  for (const [slug, state] of left) {
    const other = right.get(slug);
    if (!other || state.error !== other.error || state.good?.revision !== other.good?.revision) return false;
  }
  return true;
}
