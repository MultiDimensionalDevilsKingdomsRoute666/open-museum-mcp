/**
 * Per-source outcome of a federated query.
 *
 * Federation tolerates a failing museum (the others still answer), but a source
 * that errors must not read as "no results": every search and facets result
 * carries one {@link SourceStatus} per source queried, so a client can tell a
 * museum with nothing to show from a museum that is down.
 */

/** The status vocabulary for a queried source. Hosts may extend it with their own states. */
export const SOURCE_STATUSES = ['ok', 'error', 'timeout'] as const;
export type SourceStatusKind = (typeof SOURCE_STATUSES)[number];

export interface SourceStatus {
  /** Museum code, e.g. `getty`. */
  museum: string;
  status: SourceStatusKind;
  /**
   * Why the source failed, sanitised: no URLs beyond their origin, no keys,
   * tokens or headers, no stack trace, single line, length-capped. Present only
   * when `status` is not `ok`.
   */
  error?: string;
  /**
   * Wall-clock milliseconds the source's search took. Absent when the answer
   * came from the query cache: a cache entry is written only when every source
   * answered, so a cached query reports each source as `ok` without a timing.
   */
  ms?: number;
}

const MAX_ERROR_LENGTH = 300;

/** Names and codes Node's fetch / undici / AbortSignal.timeout use for a timeout. */
const TIMEOUT_NAMES = new Set(['TimeoutError', 'AbortError']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

function codeOf(value: unknown): string | undefined {
  if (value && typeof value === 'object' && 'code' in value) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** `timeout` for a timeout-shaped failure (own or wrapped `cause`), otherwise `error`. */
export function classifyFailure(err: unknown): 'error' | 'timeout' {
  for (let e: unknown = err, depth = 0; e && depth < 3; depth += 1) {
    if (e instanceof Error && TIMEOUT_NAMES.has(e.name)) return 'timeout';
    const code = codeOf(e);
    if (code && TIMEOUT_CODES.has(code)) return 'timeout';
    e = e instanceof Error ? (e as Error & { cause?: unknown }).cause : undefined;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /\btim(ed|e)[ -]?out\b/i.test(message) ? 'timeout' : 'error';
}

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;
const HEADER_LINE = /\b(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)\b\s*[:=]\s*[^\n,;]*/gi;
const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_PAIR = /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|passwd|key|signature|sig)\b\s*[=:]\s*[^\s&,;"']+/gi;
const STACK_FRAME = /\s+at\s+[^\n]*(\([^\n]*\)|:\d+:\d+)[^\n]*/g;

/**
 * Make an upstream error message safe to hand to a client and a log line. A
 * museum's error text can echo the request URL (with an API key in the query
 * string), a header value, or a stack trace; none of that may leave the engine.
 * URLs are cut to their origin, key/token pairs and credential headers are
 * replaced, only the first line survives, and the result is length-capped.
 */
export function sanitizeSourceError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : 'source failed';
  const firstLine = raw.replace(STACK_FRAME, '').split(/\r?\n/)[0] ?? '';
  const cleaned = firstLine
    .replace(URL_PATTERN, (url) => {
      try {
        return new URL(url).origin;
      } catch {
        return '[url]';
      }
    })
    .replace(HEADER_LINE, (_m, name: string) => `${name}: [redacted]`)
    .replace(BEARER, (_m, scheme: string) => `${scheme} [redacted]`)
    .replace(SECRET_PAIR, (_m, name: string) => `${name}=[redacted]`)
    .replace(/\s+/g, ' ')
    .trim();
  const text = cleaned || 'source failed';
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

/** Build the failed-source entry for a thrown search error. */
export function failedSource(museum: string, err: unknown, ms: number): SourceStatus {
  return { museum, status: classifyFailure(err), error: sanitizeSourceError(err), ms };
}

/** True when sources were queried and not one of them answered. */
export function allSourcesFailed(sources: readonly SourceStatus[]): boolean {
  return sources.length > 0 && sources.every((s) => s.status !== 'ok');
}
