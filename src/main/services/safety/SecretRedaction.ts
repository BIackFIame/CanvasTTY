/**
 * The secret redaction registry (EP-8): every text the core hands to another agent (canvastty_agents
 * observe/result, the control CLI's screen, result and failure details) passes through `redact` first.
 * Always on; nothing switches it off. It never touches what a person or an agent writes *to* an agent.
 *
 * 1. Known values: keys from the provider secret vault as this process reads them, plugin `secretEnv` values
 *    of open cards, and values a trusted plugin service registers. Each is removed where it stands, also when
 *    the terminal's wrapping put a line break, indentation or a box side between its characters, and in its
 *    JSON-escaped form.
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
const MAX_SECRET_CHARS = 4_096;
const MAX_VALUES_PER_OWNER = 64;
const MAX_OWNERS = 512;
/** What wrapping may put between two characters of a key: whitespace and line breaks, box-drawing sides. */
const WRAP_GAP = '[\\s\\u2500-\\u257f]{0,64}';
const JSON_SECRET_VALUE = /("(?:[A-Za-z0-9_.-]{0,40}(?:api[_-]?key|token|secret|password|authorization))"\s*:\s*")(?!<redacted:)[^"]{1,2048}("?)/giu;

export class SecretRedactionRegistry {
  private readonly owners = new Map<string, Set<string>>();
  private pattern: RegExp | null = null;
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
    let result = text;
    const known = this.knownPattern();
    if (known) result = result.replace(known, SECRET_MARKER);
    result = result.replace(JSON_SECRET_VALUE, (_match, prefix: string, closing: string) => `${prefix}${SECRET_MARKER}${closing}`);
    return redactCredentials(result);
  }

  /** One pattern for every held value and its JSON-escaped form, longest first; rebuilt only after a change. */
  private knownPattern(): RegExp | null {
    if (!this.dirty) return this.pattern;
    const forms = new Set<string>();
    for (const values of this.owners.values()) {
      for (const value of values) {
        forms.add(value);
        forms.add(JSON.stringify(value).slice(1, -1));
      }
    }
    const sources = [...forms].sort((a, b) => b.length - a.length).map(form => [...form].map(escapeCharacter).join(WRAP_GAP));
    this.pattern = sources.length ? new RegExp(sources.join('|'), 'gu') : null;
    this.dirty = false;
    return this.pattern;
  }
}

function escapeCharacter(character: string): string {
  return character.replace(/[\\^$.*+?()[\]{}|/]/gu, '\\$&');
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
