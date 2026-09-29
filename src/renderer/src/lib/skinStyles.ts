import type {
  CustomTerminalBorderSkinId,
  TerminalBorderSkinId,
  TerminalBorderSkinListItem,
  TerminalBorderSkinReadResult
} from "../../../shared/contracts";

export interface TerminalBorderSkinApi {
  list(): Promise<TerminalBorderSkinListItem[]>;
  get(id: CustomTerminalBorderSkinId): Promise<TerminalBorderSkinReadResult>;
  onChanged(listener: () => void): () => void;
}

const MAX_SKIN_ID_LENGTH = 55;
const SKIN_SLUG_PATTERN = /^custom:[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ALLOWED_BORDER_PROPERTIES = /^(?:border(?:-(?:top|right|bottom|left))?(?:-(?:color|style|width))?|border-radius|border-image(?:-(?:source|slice|width|outset|repeat))?|outline(?:-(?:color|style|width|offset))?|box-shadow|background(?:-(?:color|image|position|size|repeat|origin|clip))?|color|opacity)$/u;
const DANGEROUS_CSS = /(?:@import|\burl\s*\(|\bexpression\s*\(|\b(?:javascript|vbscript|file|data)\s*:|(?:https?:)?\/\/|-moz-binding|(?:^|[;{\s])behavior\s*:|@namespace|@font-face|@document|@supports|@media|paint\s*\(|element\s*\()/iu;

export function isCustomTerminalBorderSkinId(value: unknown): value is CustomTerminalBorderSkinId {
  if (typeof value !== "string" || value.length > MAX_SKIN_ID_LENGTH) return false;
  const match = SKIN_SLUG_PATTERN.exec(value);
  return Boolean(match && value.slice("custom:".length).length <= 48);
}

export function terminalBorderSkinFallback(skinId: TerminalBorderSkinId): TerminalBorderSkinId {
  return typeof skinId === "string" && skinId.startsWith("custom:") ? "classic" : skinId;
}

export function normalizeTerminalBorderSkinList(value: unknown): TerminalBorderSkinListItem[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const skins: TerminalBorderSkinListItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    if (!isCustomTerminalBorderSkinId(candidate.id) || seen.has(candidate.id)) continue;
    if (candidate.status === "ready"
      && typeof candidate.name === "string"
      && candidate.name.trim().length > 0
      && typeof candidate.revision === "string"
      && candidate.revision.trim().length > 0) {
      skins.push({
        id: candidate.id,
        name: candidate.name,
        revision: candidate.revision,
        status: "ready"
      });
      seen.add(candidate.id);
    } else if (candidate.status === "error" && typeof candidate.error === "string" && candidate.error.length > 0) {
      skins.push({
        id: candidate.id,
        ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
        ...(typeof candidate.revision === "string" ? { revision: candidate.revision } : {}),
        status: "error",
        error: candidate.error
      });
      seen.add(candidate.id);
    }
  }
  return skins;
}

function isReadySkinResult(value: unknown, expectedId: CustomTerminalBorderSkinId): value is Extract<TerminalBorderSkinReadResult, { status: "ready" }> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.id === expectedId
    && candidate.status === "ready"
    && typeof candidate.name === "string"
    && candidate.name.trim().length > 0
    && typeof candidate.revision === "string"
    && candidate.revision.trim().length > 0
    && typeof candidate.css === "string";
}

function isWellFormedSkinList(value: unknown): value is TerminalBorderSkinListItem[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Record<string, unknown>;
    const isRegistryError = candidate.id === "custom:skin-registry" && candidate.status === "error";
    if ((!isCustomTerminalBorderSkinId(candidate.id) && !isRegistryError)
      || typeof candidate.id !== "string" || ids.has(candidate.id)) return false;
    if (candidate.status === "ready") {
      if (typeof candidate.name !== "string" || !candidate.name.trim()
        || typeof candidate.revision !== "string" || !candidate.revision.trim()) return false;
    } else if (candidate.status === "error") {
      if (typeof candidate.error !== "string" || !candidate.error
        || (candidate.name !== undefined && typeof candidate.name !== "string")
        || (candidate.revision !== undefined && typeof candidate.revision !== "string")) return false;
    } else {
      return false;
    }
    ids.add(candidate.id);
  }
  return true;
}

function stripCssComments(css: string): string | null {
  let result = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index];
    const next = css[index + 1];
    if (quote) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      result += character;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = css.indexOf("*/", index + 2);
      if (end < 0) return null;
      result += " ";
      index = end + 1;
      continue;
    }
    result += character;
  }
  return quote ? null : result;
}

function readRuleOpen(css: string, start: number): number {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let parentheses = 0;
  let brackets = 0;
  for (let index = start; index < css.length; index += 1) {
    const character = css[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "(") parentheses += 1;
    else if (character === ")") {
      if (parentheses === 0) return -1;
      parentheses -= 1;
    } else if (character === "[") brackets += 1;
    else if (character === "]") {
      if (brackets === 0) return -1;
      brackets -= 1;
    } else if (character === "{" && parentheses === 0 && brackets === 0) return index;
    else if (character === "}" && parentheses === 0 && brackets === 0) return -1;
  }
  return -1;
}

function readRuleClose(css: string, start: number): number {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let parentheses = 0;
  let brackets = 0;
  for (let index = start; index < css.length; index += 1) {
    const character = css[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "(") parentheses += 1;
    else if (character === ")") {
      if (parentheses === 0) return -1;
      parentheses -= 1;
    } else if (character === "[") brackets += 1;
    else if (character === "]") {
      if (brackets === 0) return -1;
      brackets -= 1;
    } else if (character === "{" && parentheses === 0 && brackets === 0) return -1;
    else if (character === "}" && parentheses === 0 && brackets === 0) return index;
  }
  return -1;
}

function splitTopLevel(value: string, delimiter: "," | ";"): string[] | null {
  const parts: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let parentheses = 0;
  let brackets = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "(") parentheses += 1;
    else if (character === ")") {
      if (parentheses === 0) return null;
      parentheses -= 1;
    } else if (character === "[") brackets += 1;
    else if (character === "]") {
      if (brackets === 0) return null;
      brackets -= 1;
    } else if (character === delimiter && parentheses === 0 && brackets === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quote || parentheses !== 0 || brackets !== 0) return null;
  parts.push(value.slice(start));
  return parts;
}

function hasValidDeclarations(body: string): boolean {
  const declarations = splitTopLevel(body, ";");
  if (!declarations) return false;
  for (const declaration of declarations) {
    const trimmed = declaration.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(":");
    if (separator < 1) return false;
    const property = trimmed.slice(0, separator).trim().toLowerCase();
    const value = trimmed.slice(separator + 1).trim();
    if (!/^(?:--[a-z0-9_-]+|[a-z][a-z0-9-]*)$/u.test(property) || !value) return false;
    if (!property.startsWith("--") && !ALLOWED_BORDER_PROPERTIES.test(property)) return false;
    if (/!\s*important/iu.test(value)) return false;
  }
  return declarations.some((declaration) => declaration.trim().length > 0);
}

function selectorEscapesCard(selector: string): boolean {
  let quote: "'" | '"' | null = null;
  let parentheses = 0;
  let brackets = 0;
  for (const character of selector) {
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (parentheses === 0 && brackets === 0 && (character === "+" || character === "~")) return true;
  }
  return false;
}

function isCardScopedSelector(selector: string): boolean {
  const normalized = selector.trim();
  if (!normalized.startsWith(".terminal-card")) return false;
  const next = normalized[".terminal-card".length];
  if (next && !/[.#:[\s>+~]/u.test(next)) return false;
  return !(/:global\b|:host\b|::slotted\b/iu.test(normalized) || selectorEscapesCard(normalized));
}

function scopeSelector(selector: string, scope: string, target: "card" | "preview"): string {
  const trimmed = selector.trim();
  if (target === "card") return trimmed.replace(/^\.terminal-card/u, scope);
  const previewSelector = trimmed
    .replace(/\.terminal-card(__[a-z0-9_-]+|--[a-z0-9_-]+)?/gu, (className) =>
      className.replace(".terminal-card", ".border-skin-preview"))
    .replace(/(\.border-skin-preview__actions\s+)button\b/gu, "$1.border-skin-preview__action");
  return previewSelector.replace(/^\.border-skin-preview/u, scope);
}

/** Parse ordinary style rules only and scope every selector to one card or settings preview. */
export function scopeTerminalBorderSkinCss(css: unknown, skinId: unknown, target: "card" | "preview" = "card"): string | null {
  if (typeof css !== "string" || css.trim().length === 0 || new TextEncoder().encode(css).byteLength > 64 * 1024) return null;
  if (!isCustomTerminalBorderSkinId(skinId)) return null;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(css) || css.includes("<") || css.includes("\\")) return null;
  const source = stripCssComments(css);
  if (!source || DANGEROUS_CSS.test(source)) return null;
  const scope = target === "preview"
    ? `.border-skin-preview--custom[data-custom-border-skin="${skinId}"]`
    : `.terminal-card[data-custom-border-skin="${skinId}"]`;
  const output: string[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (cursor >= source.length) break;
    const open = readRuleOpen(source, cursor);
    if (open < 0) return null;
    const selectorText = source.slice(cursor, open).trim();
    if (!selectorText || selectorText.startsWith("@") || selectorText.includes("@") || selectorText.includes(";")) return null;
    const selectors = splitTopLevel(selectorText, ",");
    if (!selectors || selectors.some((selector) => !isCardScopedSelector(selector))) return null;
    const close = readRuleClose(source, open + 1);
    if (close < 0) return null;
    const body = source.slice(open + 1, close);
    if (!hasValidDeclarations(body)) return null;
    output.push(`${selectors.map((selector) => scopeSelector(selector, scope, target)).join(", ")} { ${body.trim()} }`);
    cursor = close + 1;
  }

  return output.length > 0 ? output.join("\n") : null;
}

export interface TerminalBorderSkinStyleController {
  setActive(skinId: TerminalBorderSkinId): void;
  dispose(): void;
}

export function createTerminalBorderSkinStyleController(
  api: TerminalBorderSkinApi,
  documentTarget: Document
): TerminalBorderSkinStyleController {
  return createSingleTerminalBorderSkinStyleController(api, documentTarget);
}

function createSingleTerminalBorderSkinStyleController(
  api: TerminalBorderSkinApi,
  documentTarget: Document
): TerminalBorderSkinStyleController {
  const styleElements = new Map<CustomTerminalBorderSkinId, HTMLStyleElement>();
  const generations = new Map<CustomTerminalBorderSkinId, number>();
  let activeSkinId: CustomTerminalBorderSkinId | null = null;
  let disposed = false;

  const loadActiveSkin = async (skinId: CustomTerminalBorderSkinId): Promise<void> => {
    const generation = (generations.get(skinId) ?? 0) + 1;
    generations.set(skinId, generation);
    try {
      const list: unknown = await api.list();
      if (disposed || generations.get(skinId) !== generation || !isWellFormedSkinList(list)) return;
      // The backend uses this error entry when the registry root itself is unavailable.
      // In that case absence is unknown, so retain any last-good styles.
      if (list.some((item) => item.id === "custom:skin-registry" && item.status === "error")) return;
      if (!list.some((item) => item.id === skinId)) {
        const previousStyle = styleElements.get(skinId);
        previousStyle?.remove();
        styleElements.delete(skinId);
        return;
      }

      const result = await api.get(skinId);
      if (disposed || generations.get(skinId) !== generation || !isReadySkinResult(result, skinId)) return;
      const scopedCss = scopeTerminalBorderSkinCss(result.css, skinId);
      if (!scopedCss) return;

      const nextStyle = documentTarget.createElement("style");
      nextStyle.setAttribute("data-terminal-border-skin-style", skinId);
      nextStyle.textContent = scopedCss;
      const previousStyle = styleElements.get(skinId);
      if (previousStyle?.isConnected) previousStyle.replaceWith(nextStyle);
      else documentTarget.head.append(nextStyle);
      styleElements.set(skinId, nextStyle);
    } catch {
      // Keep the last-good style installed; cards use the built-in classic fallback otherwise.
    }
  };

  let unsubscribe = (): void => undefined;
  try {
    unsubscribe = api.onChanged(() => {
      if (activeSkinId) void loadActiveSkin(activeSkinId);
    });
  } catch {
    // Skin loading still works on selection; live reload is simply unavailable.
  }

  return {
    setActive(skinId) {
      const nextSkinId = isCustomTerminalBorderSkinId(skinId) ? skinId : null;
      if (nextSkinId === activeSkinId) return;
      activeSkinId = nextSkinId;
      if (activeSkinId) void loadActiveSkin(activeSkinId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const style of styleElements.values()) style.remove();
      styleElements.clear();
      generations.clear();
      activeSkinId = null;
    }
  };
}

export interface TerminalBorderSkinPreviewStyleController {
  setActive(skinIds: readonly CustomTerminalBorderSkinId[]): void;
  dispose(): void;
}

/** Loads preview-only styles for each visible custom-skin choice in one list request. */
export function createTerminalBorderSkinPreviewStyleController(
  api: TerminalBorderSkinApi,
  documentTarget: Document
): TerminalBorderSkinPreviewStyleController {
  const styleElements = new Map<CustomTerminalBorderSkinId, HTMLStyleElement>();
  const generations = new Map<CustomTerminalBorderSkinId, number>();
  let activeSkinIds = new Set<CustomTerminalBorderSkinId>();
  let disposed = false;

  const removeStyle = (skinId: CustomTerminalBorderSkinId): void => {
    styleElements.get(skinId)?.remove();
    styleElements.delete(skinId);
  };

  const refresh = async (): Promise<void> => {
    const requested = [...activeSkinIds].map((id) => {
      const generation = (generations.get(id) ?? 0) + 1;
      generations.set(id, generation);
      return { id, generation };
    });
    if (requested.length === 0) return;

    try {
      const list: unknown = await api.list();
      if (disposed || !isWellFormedSkinList(list)) return;
      // A registry-level error makes every missing skin ambiguous, so keep last-good previews.
      if (list.some((item) => item.id === "custom:skin-registry" && item.status === "error")) return;

      const listedIds = new Set(list.map((item) => item.id));
      const present = requested.filter(({ id, generation }) => {
        if (generations.get(id) !== generation || !activeSkinIds.has(id)) return false;
        if (listedIds.has(id)) return true;
        removeStyle(id);
        return false;
      });
      const results = await Promise.all(present.map(async ({ id, generation }) => {
        try {
          return { id, generation, result: await api.get(id) };
        } catch {
          return { id, generation, result: null };
        }
      }));

      for (const { id, generation, result } of results) {
        if (disposed || generations.get(id) !== generation || !activeSkinIds.has(id)
          || !isReadySkinResult(result, id)) continue;
        const scopedCss = scopeTerminalBorderSkinCss(result.css, id, "preview");
        if (!scopedCss) continue;

        const nextStyle = documentTarget.createElement("style");
        nextStyle.setAttribute("data-terminal-border-skin-preview-style", id);
        nextStyle.textContent = scopedCss;
        const previousStyle = styleElements.get(id);
        if (previousStyle?.isConnected) previousStyle.replaceWith(nextStyle);
        else documentTarget.head.append(nextStyle);
        styleElements.set(id, nextStyle);
      }
    } catch {
      // Keep last-good previews on registry or IPC errors.
    }
  };

  let unsubscribe = (): void => undefined;
  try {
    unsubscribe = api.onChanged(() => void refresh());
  } catch {
    // Preview styling still loads on selection; live reload is simply unavailable.
  }

  return {
    setActive(skinIds) {
      const nextSkinIds = new Set(skinIds.filter(isCustomTerminalBorderSkinId));
      const changed = nextSkinIds.size !== activeSkinIds.size
        || [...nextSkinIds].some((skinId) => !activeSkinIds.has(skinId));
      if (!changed) return;
      for (const previousId of activeSkinIds) {
        if (nextSkinIds.has(previousId)) continue;
        generations.set(previousId, (generations.get(previousId) ?? 0) + 1);
        removeStyle(previousId);
      }
      activeSkinIds = nextSkinIds;
      void refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const style of styleElements.values()) style.remove();
      styleElements.clear();
      generations.clear();
      activeSkinIds.clear();
    }
  };
}
