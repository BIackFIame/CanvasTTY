/**
 * The secret redaction registry (EP-8): every text the core hands to another agent (canvastty_agents
 * observe/result, the control CLI's screen, result and failure details) passes through `redact` first.
 * Always on; nothing switches it off. It never touches what a person or an agent writes *to* an agent.
 *
 * 1. Known values: keys from the provider secret vault as this process reads them, plugin `secretEnv` values
 *    of open cards, and values a trusted plugin service registers. Each is removed where it stands, also when
 *    the terminal's wrapping put a line break, indentation or a box side between its characters, and in its
 *    JSON-escaped form. They are found by a linear search over the text with those gaps taken out, never by a
 *    pattern built from the value: a pattern for a key of a few thousand characters exceeds what the regular
 *    expression engine accepts, and the error broke every masking call. A value that holds wrap characters of
 *    its own is also searched exactly as written, so it is masked even when too few characters remain without
 *    them for the wrap-tolerant search, or when its own gaps are wider than a wrap gap.
 * 2. JSON string values under key-like names (`"apiKey"`, `"token"`, `"authorization"`, …), across lines too.
 * 3. Generic shapes: PEM private keys, `sk-…`, GitHub, Slack, AWS, Google, xAI tokens, JWTs, `Bearer …`,
 *    `Authorization:` values, URL credentials, secret-looking query values and assignments, and long
 *    high-entropy runs.
 *
 * Each match becomes `<redacted:…>`. Idempotent: a marker is never masked again. Values live in memory only
 * and are never logged, sent or shown.
 */

const SECRET_MARKER = '<redacted:secret>';
/** Shorter values are not keys, and removing them would only garble ordinary text. */
const MIN_SECRET_CHARS = 8;
/** Long enough for a PEM key or a service-account JSON; the search costs the same for any length. */
const MAX_SECRET_CHARS = 65_536;
const MAX_VALUES_PER_OWNER = 64;
const MAX_OWNERS = 512;
/** What wrapping may put between two characters of a key: whitespace and line breaks, box-drawing sides. */
const MAX_WRAP_GAP = 64;
/**
 * redactTail masks a window that starts this far (at least) before the tail it returns. Every rule except the
 * PEM block (handled apart) and runs of one character class matches at most a few thousand characters, so a
 * match the window's start cuts short ends long before the tail begins; the tail comes out as masking the whole
 * text would leave it.
 */
const TAIL_MARGIN_CHARS = 16_384;
const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/gu;
const PRIVATE_KEY_FOOTER = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/gu;
const JSON_SECRET_VALUE = /("(?:[A-Za-z0-9_.-]{0,40}(?:api[_-]?key|token|secret|password|authorization))"\s*:\s*")(?!<redacted:)[^"]{1,2048}("?)/giu;

/** The search forms of the held values. */
type KnownForms = {
  /** Each value and its JSON-escaped form without wrap characters, when at least MIN_SECRET_CHARS remain. */
  bare: readonly string[];
  /** Each value and JSON-escaped form that holds wrap characters, exactly as written. */
  exact: readonly string[];
};
const NO_FORMS: KnownForms = { bare: [], exact: [] };

export class SecretRedactionRegistry {
  private readonly owners = new Map<string, Set<string>>();
  private forms: KnownForms = NO_FORMS;
  /** The longest text one held value can match: its characters plus a full wrap gap between each two. */
  private knownSpan = 0;
  private dirty = false;

  /** Adds values under an owner (`vault`, `session:<id>`, `plugin:<id>`); short or oversized values are ignored. */
  add(owner: string, values: Iterable<string>): void {
    let set = this.owners.get(owner);
    for (const value of values) {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (trimmed.length < MIN_SECRET_CHARS || trimmed.length > MAX_SECRET_CHARS) continue;
      if (!set) {
        if (this.owners.size >= MAX_OWNERS) return;
        set = new Set();
        this.owners.set(owner, set);
      }
      if (set.has(trimmed)) continue;
      if (set.size >= MAX_VALUES_PER_OWNER) set.delete(set.values().next().value!);
      set.add(trimmed);
      this.dirty = true;
    }
  }

  /** Forgets an owner's values (a card closed, a plugin stopped). */
  clear(owner: string): void {
    if (this.owners.delete(owner)) this.dirty = true;
  }

  redact(text: string): string {
    if (typeof text !== 'string' || text.length === 0) return typeof text === 'string' ? text : '';
    let result = maskKnownValues(text, this.knownForms());
    result = result.replace(JSON_SECRET_VALUE, (_match, prefix: string, closing: string) => `${prefix}${SECRET_MARKER}${closing}`);
    return redactCredentials(result);
  }

  /**
   * The same text as `redact(text)` cut to its last `maxChars` characters, without masking the whole text: a
   * card's 240 000-character scrollback costs as much as its last `maxChars` plus a margin wider than any match
   * (the margin grows with the longest held value and its wrap gaps). A secret the tail's cut splits lies inside
   * the window and is masked whole, exactly as before; an open PEM block starts the window at its header.
   */
  redactTail(text: string, maxChars: number): string {
    if (typeof text !== 'string' || text.length === 0 || maxChars <= 0) return '';
    this.knownForms();
    const margin = Math.max(TAIL_MARGIN_CHARS, 2 * this.knownSpan + 4_096);
    if (text.length <= maxChars + margin) return lastChars(this.redact(text), maxChars);
    let start = text.length - maxChars - margin;
    start = openPrivateKeyStart(text, start) ?? start;
    // Begin on a line: the cut then falls where most rules cannot continue anyway.
    const lineStart = text.lastIndexOf('\n', start);
    if (lineStart >= 0 && start - lineStart <= 4_096) start = lineStart + 1;
    const masked = this.redact(text.slice(start));
    // Masking shortened the window so much that the tail would reach back into its first half: mask everything.
    if (masked.length - maxChars < margin / 2) return lastChars(this.redact(text), maxChars);
    return lastChars(masked, maxChars);
  }

  /** The search forms of every held value; rebuilt only after a change. */
  private knownForms(): KnownForms {
    if (!this.dirty) return this.forms;
    const bare = new Set<string>();
    const exact = new Set<string>();
    let longest = 0;
    for (const values of this.owners.values()) {
      for (const value of values) {
        for (const form of [value, JSON.stringify(value).slice(1, -1)]) {
          longest = Math.max(longest, form.length);
          const stripped = withoutWrapCharacters(form);
          // Without its wrap characters, a value that is mostly spaces would leave a fragment that garbles
          // ordinary text; such a value is found as written (below).
          if (stripped.length >= MIN_SECRET_CHARS) bare.add(stripped);
          // Every held form is at least MIN_SECRET_CHARS long as written: the value was trimmed and checked in
          // add(), and escaping only lengthens it.
          if (stripped !== form) exact.add(form);
        }
      }
    }
    const longestFirst = (a: string, b: string): number => b.length - a.length;
    this.forms = { bare: [...bare].sort(longestFirst), exact: [...exact].sort(longestFirst) };
    // A form of n characters matches at most n characters plus a full wrap gap between each two.
    this.knownSpan = longest * (MAX_WRAP_GAP + 1);
    this.dirty = false;
    return this.forms;
  }
}

/** Whitespace (as `\s` has it) and the box-drawing block: what terminal wrapping may put inside a key. */
function isWrapCharacter(code: number): boolean {
  if (code <= 0x20) return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  if (code < 0xa0) return false;
  return code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029
    || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff || (code >= 0x2500 && code <= 0x257f);
}

function withoutWrapCharacters(text: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (!isWrapCharacter(text.charCodeAt(i))) continue;
    result += text.slice(from, i);
    from = i + 1;
  }
  return from === 0 ? text : result + text.slice(from);
}

/**
 * Replaces every held value in `text`: the wrap-free forms also where wrapping put up to MAX_WRAP_GAP wrap
 * characters between two of their characters, the exact forms as written. Matches are taken leftmost first, the
 * longest at a position, and never overlap.
 */
function maskKnownValues(text: string, forms: KnownForms): string {
  const endAt = knownMatchEnds(text, forms);
  if (!endAt) return text;
  let result = "";
  let kept = 0;
  for (let at = 0; at < text.length;) {
    const end = endAt[at];
    if (end === 0) { at++; continue; }
    result += text.slice(kept, at) + SECRET_MARKER;
    kept = end;
    at = end;
  }
  return kept === 0 ? text : result + text.slice(kept);
}

/**
 * For each position of `text`, the end of the longest held-value match that starts there (0: none), or null when
 * nothing matches. The wrap-free forms are searched in the text with its wrap characters taken out (a map leads
 * back to the original positions), the exact forms in the text itself; each with Knuth-Morris-Pratt, linear in
 * the text plus the form, whatever either holds.
 */
function knownMatchEnds(text: string, forms: KnownForms): Int32Array | null {
  if (forms.bare.length === 0 && forms.exact.length === 0) return null;
  const exact = forms.exact.filter(form => text.includes(form));
  const bare = forms.bare.length ? withoutWrapCharacters(text) : '';
  const present = forms.bare.filter(form => bare.includes(form));
  if (present.length === 0 && exact.length === 0) return null;
  const endAt = new Int32Array(text.length);
  for (const form of exact) {
    for (const start of occurrences(text, form)) endAt[start] = Math.max(endAt[start], start + form.length);
  }
  if (present.length === 0) return endAt;
  // Where each character of `bare` stands in `text`, and how many oversized gaps lie before it (a match may
  // not cross one).
  const positions = new Int32Array(bare.length);
  const oversized = new Int32Array(bare.length + 1);
  for (let i = 0, count = 0, previous = -1; i < text.length; i++) {
    if (isWrapCharacter(text.charCodeAt(i))) continue;
    oversized[count + 1] = oversized[count] + (previous >= 0 && i - previous - 1 > MAX_WRAP_GAP ? 1 : 0);
    positions[count++] = i;
    previous = i;
  }
  for (const form of present) {
    for (const start of occurrences(bare, form)) {
      // Only the gaps inside the match count, not the one before its first character.
      if (oversized[start + form.length] - oversized[start + 1] !== 0) continue;
      const from = positions[start];
      endAt[from] = Math.max(endAt[from], positions[start + form.length - 1] + 1);
    }
  }
  return endAt;
}

/** Every start of `pattern` in `text`, overlapping ones included (Knuth-Morris-Pratt). */
function* occurrences(text: string, pattern: string): Generator<number> {
  const failure = new Int32Array(pattern.length);
  for (let i = 1, k = 0; i < pattern.length; i++) {
    while (k > 0 && pattern.charCodeAt(i) !== pattern.charCodeAt(k)) k = failure[k - 1];
    if (pattern.charCodeAt(i) === pattern.charCodeAt(k)) k++;
    failure[i] = k;
  }
  for (let i = 0, k = 0; i < text.length; i++) {
    while (k > 0 && text.charCodeAt(i) !== pattern.charCodeAt(k)) k = failure[k - 1];
    if (text.charCodeAt(i) === pattern.charCodeAt(k)) k++;
    if (k === pattern.length) {
      yield i - k + 1;
      k = failure[k - 1];
    }
  }
}

function lastChars(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

/**
 * Where a PEM private-key block that is still open at `start` begins (its END is at or after `start`, or
 * missing), or null. Such a block is masked from its header to its END or the end of the text, so the
 * window must include the header.
 */
function openPrivateKeyStart(text: string, start: number): number | null {
  let from = start;
  for (;;) {
    const begin = text.lastIndexOf('-----BEGIN ', from);
    if (begin < 0) return null;
    PRIVATE_KEY_HEADER.lastIndex = begin;
    const header = PRIVATE_KEY_HEADER.exec(text);
    if (header && header.index === begin) {
      PRIVATE_KEY_FOOTER.lastIndex = begin + header[0].length;
      const footer = PRIVATE_KEY_FOOTER.exec(text);
      return footer && footer.index + footer[0].length <= start ? null : begin;
    }
    if (begin === 0) return null;
    from = begin - 1;
  }
}

type Rule = { kind: string; pattern: RegExp; replace?: (match: string, ...groups: string[]) => string };

const marker = (kind: string): string => `<redacted:${kind}>`;
const NOT_MASKED = '(?!<redacted:)';
/** A terminal line break, with the indentation or box side the next line may start with. */
const LINE_BREAK = '\\r?\\n[ \\t\\u2500-\\u257f|]{0,8}';
const WRAPPED = `(?:${LINE_BREAK}(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{4,})*`;

const RULES: readonly Rule[] = [
  // PEM private-key blocks, including a block cut off before its END line.
  { kind: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/gu },
  // The same token shapes the repository secret audit checks (scripts/audit-secrets.mjs). A key the terminal
  // wrapped goes on over the line break when the next line's run holds a digit (ordinary words rarely do).
  { kind: 'anthropic', pattern: new RegExp(`(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{16,}${WRAPPED}`, 'gu') },
  { kind: 'openai', pattern: new RegExp(`(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}${WRAPPED}`, 'gu') },
  { kind: 'github', pattern: new RegExp(`(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})${WRAPPED}`, 'gu') },
  { kind: 'slack', pattern: new RegExp(`(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{16,}${WRAPPED}`, 'gu') },
  { kind: 'aws', pattern: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![0-9A-Z])/gu },
  { kind: 'jwt', pattern: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu },
  { kind: 'xai', pattern: new RegExp(`(?<![A-Za-z0-9])xai-[A-Za-z0-9_-]{20,}${WRAPPED}`, 'gu') },
  { kind: 'google', pattern: new RegExp(`(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}${WRAPPED}`, 'gu') },
  // Header values: `Authorization: Bearer …`, `Authorization: Basic …`, and a bare `Bearer …`.
  { kind: 'authorization', pattern: new RegExp(`(\\bAuthorization\\s*[:=]\\s*["']?)${NOT_MASKED}(?:(?:Bearer|Basic|Token|Bot)\\s+)?${NOT_MASKED}[^\\s"'<>]{4,}`, 'giu'), replace: (_match, prefix) => `${prefix}${marker('authorization')}` },
  { kind: 'bearer', pattern: new RegExp(`\\bBearer\\s+${NOT_MASKED}[A-Za-z0-9._~+/=-]{8,}`, 'gu'), replace: () => `Bearer ${marker('bearer')}` },
  // URL userinfo (`https://user:secret@host`, or a token alone as the user).
  { kind: 'url-credentials', pattern: /(\b[a-z][a-z0-9+.-]{1,20}:\/\/)([^\s/@<>"']+)@/giu,
    replace: (match, scheme, userinfo) => userinfo!.includes(':') || userinfo!.length >= 16 ? `${scheme}${marker('url-credentials')}@` : match },
  // Query values of secret-looking parameters.
  { kind: 'url-secret', pattern: new RegExp(`([?&](?:[A-Za-z0-9]+[_-])*(?:token|key|secret|password|sig|signature)=)${NOT_MASKED}[^&#\\s"'<>]+`, 'giu'), replace: (_match, prefix) => `${prefix}${marker('url-secret')}` },
  // Assignments whose name contains TOKEN / SECRET / PASSWORD / CREDENTIAL(S) or ends in KEY (`monkey` and
  // `keyboard` stay). The name may be quoted and the separator is `:`, `=` or `=>`. Every repetition is bounded.
  { kind: 'assignment', pattern: new RegExp(`(["']?\\b(?:[A-Za-z0-9_.-]{0,100}(?:[Tt]oken|TOKEN|[Ss]ecret|SECRET|[Pp]assw(?:or)?d|PASSW(?:OR)?D|[Cc]redentials?|CREDENTIALS?)|(?:[A-Za-z0-9]{1,40}[_.-]){0,8}(?:[A-Za-z0-9]{0,40}Key|[A-Z0-9]{1,40}KEY|(?:[Aa][Pp][Ii][_-]?)?(?:key|KEY)))(?![A-Za-z0-9])["']?\\s*(?:=>|[:=])\\s*)(?:"${NOT_MASKED}[^"\\r\\n]{4,}"|'${NOT_MASKED}[^'\\r\\n]{4,}'|\`${NOT_MASKED}[^\`\\r\\n]{4,}\`|${NOT_MASKED}[^\\s"'\`<>,;]{4,})`, 'gu'),
    replace: (_match, prefix) => `${prefix}${marker('assignment')}` },
  // A random run the terminal wrapped over lines, judged as one run.
  { kind: 'high-entropy', pattern: new RegExp(`(?<![A-Za-z0-9+=_-])[A-Za-z0-9+=_-]{12,}(?:${LINE_BREAK}(?=[A-Za-z0-9+=_-]*[0-9])[A-Za-z0-9+=_-]{4,})+(?![A-Za-z0-9+=_-])`, 'gu'),
    replace: (match) => { const joined = match.replace(/[\s\u2500-\u257f|]/gu, ''); return joined.length >= 32 && looksRandom(joined) ? marker('high-entropy') : match; } },
  // A long run that mixes upper case, lower case and digits with high entropy. Pure hex (a commit SHA) has no
  // upper case and survives; paths never form one run because `/` and `.` end it.
  { kind: 'high-entropy', pattern: /(?<![A-Za-z0-9+=_-])[A-Za-z0-9+=_-]{32,}(?![A-Za-z0-9+=_-])/gu,
    replace: (match) => looksRandom(match) ? marker('high-entropy') : match }
];

function looksRandom(value: string): boolean {
  const upper = value.match(/[A-Z]/gu)?.length ?? 0, lower = value.match(/[a-z]/gu)?.length ?? 0, digits = value.match(/[0-9]/gu)?.length ?? 0;
  if (upper < 2 || lower < 2 || digits < 2) return false;
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) { const p = count / value.length; entropy -= p * Math.log2(p); }
  return entropy >= 4.2;
}

/** The generic shapes alone (no registered values). */
export function redactCredentials(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return typeof text === 'string' ? text : '';
  let result = text;
  for (const rule of RULES) {
    result = result.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      // Arguments after the match: the capture groups, then the numeric offset and the whole input.
      const end = rest.findIndex(value => typeof value === 'number');
      const groups = (end < 0 ? [] : rest.slice(0, end)).map(value => typeof value === 'string' ? value : '');
      return rule.replace ? rule.replace(match, ...groups) : marker(rule.kind);
    });
  }
  return result;
}
