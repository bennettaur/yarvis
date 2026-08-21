/**
 * Patterns redacted from error text before it reaches logs or `/health`. Covers
 * Authorization headers, common API-key header shapes, Set-Cookie, and a
 * Postgres connection string with embedded credentials.
 */
const REDACT_PATTERNS: Array<[RegExp, string]> = [
  [/(authorization:\s*bearer\s+)[^\s",]+/gi, "$1[redacted]"],
  [/(authorization:\s*basic\s+)[^\s",]+/gi, "$1[redacted]"],
  [/(x-api-key:\s*)[^\s",]+/gi, "$1[redacted]"],
  [/(api-key:\s*)[^\s",]+/gi, "$1[redacted]"],
  [/(set-cookie:\s*)[^\r\n]+/gi, "$1[redacted]"],
  [/(postgres(?:ql)?:\/\/[^:@/\s]+:)[^@\s]+(@)/gi, "$1[redacted]$2"],
  // sk-, ghp_, github_pat_, etc. style tokens that sometimes show up in error bodies.
  // The optional `c` covers Cerebras keys: `\b` won't fire between `c` and `sk-`,
  // so a bare `sk-` pattern silently misses them.
  [/\b(c?sk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{16,})\b/g, "[redacted-token]"],
  [/\b(hf_[A-Za-z0-9]{16,})\b/g, "[redacted-token]"],
  [/\b(ghp_[A-Za-z0-9_]{16,})\b/g, "[redacted-token]"],
  [/\b(github_pat_[A-Za-z0-9_]{16,})\b/g, "[redacted-token]"],
];

/** Strips known credential shapes from a string before it lands in a log line. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACT_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Builds a readable description of a provider/streaming error for SERVER LOGS,
 * pulling the HTTP status, request URL, response body, and underlying cause that
 * the AI SDK attaches but a bare `error.message` usually omits — so logs explain
 * *why* a generation failed. The raw URL/response body can carry provider-side
 * operational detail (endpoints, account identifiers), so this stays log-only;
 * use `clientError` for anything sent to the browser.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return redactSecrets(String(error));
  const parts = [error.message];
  const fields = error as unknown as Record<string, unknown>;
  if (typeof fields.statusCode === "number") parts.push(`status=${fields.statusCode}`);
  if (typeof fields.url === "string") parts.push(`url=${fields.url}`);
  if (typeof fields.responseBody === "string" && fields.responseBody) {
    parts.push(`body=${fields.responseBody.slice(0, 500)}`);
  }
  const cause = fields.cause;
  if (cause && cause !== error) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    parts.push(`cause=${causeMsg}`);
  }
  return redactSecrets(parts.join(" "));
}

/**
 * A sanitized error string safe to surface to the client: the human-readable
 * message plus the HTTP status, but never the raw provider URL or response body
 * (which `describeError` keeps for server logs).
 */
export function clientError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const status = (error as unknown as Record<string, unknown>).statusCode;
  return typeof status === "number" ? `${error.message} (status ${status})` : error.message;
}
