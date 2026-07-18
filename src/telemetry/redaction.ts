export const REDACTED = '[redacted]';

const SECRET_PLACEHOLDER_RE = /\{\{secret:([A-Za-z0-9_-]+)\}\}/g;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const API_KEY_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{8,})\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
// Catches secret-shaped substrings inside otherwise-unlabeled attributes (e.g. a
// task/url string, not just a known header) — "token=...", "password: ..." — but
// never inside a {{secret:NAME}} placeholder (handled separately below).
const LABELED_SECRET_RE = /(?<!\{)\b(api[-_]?key|authorization|password|passwd|pwd|secret|token)(\s*[:=]\s*)(['"]?)([^\s'"&,;{}]+)/gi;
const URL_WITH_SCHEME_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"<>]+/g;
const SENSITIVE_KEY_RE = /(^|[-_.])(api[-_]?key|authorization|cookie|password|secret|token|x-api-key)([-_.]|$)/i;

/** Strip the query string, fragment, and userinfo (user:pass@) off a URL-shaped
 * substring before it's attached anywhere — these are the parts of a URL most
 * likely to carry a token, session id, or basic-auth credential. Leaves the
 * scheme/host/path intact for readability. Non-URL input passes through. */
function stripUrlSecrets(candidate: string): string {
  try {
    const u = new URL(candidate);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return candidate;
  }
}

export interface RedactionOptions {
  /** Exact secret values known to the caller. Empty strings are ignored. */
  secretValues?: string[];
  /** Telemetry defaults to hiding secret names too; reports may keep placeholders. */
  redactSecretPlaceholders?: boolean;
  /** Prevent very large prompts/responses from becoming span attributes. */
  maxStringLength?: number;
  /** Recursion cap for arbitrary attributes. */
  maxDepth?: number;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

export function redactString(input: string, opts: RedactionOptions = {}): string {
  let out = input;
  for (const secret of opts.secretValues ?? []) {
    if (!secret) continue;
    out = out.split(secret).join(REDACTED);
  }
  out = out.replace(URL_WITH_SCHEME_RE, (m) => stripUrlSecrets(m));
  out = out.replace(BEARER_RE, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(API_KEY_RE, REDACTED);
  out = out.replace(JWT_RE, REDACTED);
  out = out.replace(
    LABELED_SECRET_RE,
    (_m, label: string, sep: string, quote: string) => `${label}${sep}${quote}${REDACTED}${quote}`,
  );
  if (opts.redactSecretPlaceholders ?? true) {
    out = out.replace(SECRET_PLACEHOLDER_RE, `{{secret:${REDACTED}}}`);
  }
  const max = opts.maxStringLength ?? 4_000;
  return out.length > max ? `${out.slice(0, max)}...` : out;
}

export function redactValue(value: unknown, opts: RedactionOptions = {}): unknown {
  return redactAny(value, opts, 0, new WeakSet<object>(), undefined);
}

function redactAny(
  value: unknown,
  opts: RedactionOptions,
  depth: number,
  seen: WeakSet<object>,
  key: string | undefined,
): unknown {
  if (key && isSensitiveKey(key)) return REDACTED;
  if (typeof value === 'string') return redactString(value, opts);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[buffer:${value.length} bytes]`;
  if (typeof value !== 'object') return String(value);

  const maxDepth = opts.maxDepth ?? 6;
  if (depth >= maxDepth) return '[max-depth]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactAny(item, opts, depth + 1, seen, undefined));
  }

  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    out[childKey] = redactAny(childValue, opts, depth + 1, seen, childKey);
  }
  return out;
}
