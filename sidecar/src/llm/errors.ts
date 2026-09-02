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

/** How much of a provider response body a log line keeps. */
const LOG_BODY_CHARS = 500;
/** How much of it the user-facing detail view keeps — enough to read a gateway's JSON error. */
const DETAIL_BODY_CHARS = 4000;
/** Cap on a serialized non-Error value, so one bad throw can't flood a log. */
const SERIALIZED_CHARS = 2000;
/** How deep to follow `cause` / nested `error` wrappers before giving up. */
const MAX_DEPTH = 4;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * JSON for a value that was thrown but isn't an `Error`. Own non-enumerable
 * properties are included (an `Error` subclass keeps `message` there) and
 * cycles are broken, because the alternative — `String(value)` — is the
 * `[object Object]` that makes a failure unreadable.
 */
function serialize(value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  const seen = new WeakSet<object>();
  const expand = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input)) return "[circular]";
    seen.add(input);
    const out: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(input)) {
      if (key === "stack") continue;
      out[key] = expand((input as Record<string, unknown>)[key]);
    }
    return out;
  };
  let json: string;
  try {
    json = JSON.stringify(expand(value)) ?? "";
  } catch {
    json = "";
  }
  if (!json || json === "{}")
    return `<${value.constructor?.name ?? "object"} with no readable fields>`;
  return truncate(json, SERIALIZED_CHARS);
}

/**
 * The most human-readable one-line message available for anything that was
 * thrown or handed to an `onError` hook. Providers and gateways throw plain
 * objects as often as `Error`s — `{ error: { message } }` from an
 * OpenAI-compatible proxy is the common shape — so the usual message fields are
 * unwrapped before falling back to a serialization.
 */
export function errorMessage(error: unknown, depth = 0): string {
  if (typeof error === "string") return error;
  if (error === null || typeof error !== "object") return String(error);
  const rec = error as Record<string, unknown>;
  if (typeof rec.message === "string" && rec.message) return rec.message;
  if (depth < MAX_DEPTH) {
    const nested = rec.error;
    if (typeof nested === "string" && nested) return nested;
    if (nested && typeof nested === "object") return errorMessage(nested, depth + 1);
  }
  if (typeof rec.detail === "string" && rec.detail) return rec.detail;
  if (typeof rec.statusText === "string" && rec.statusText) return rec.statusText;
  return serialize(error);
}

/**
 * The fields the AI SDK and provider clients attach beside the message, in the
 * order they help a reader: what the server said, where it was said, and what
 * went wrong underneath. `bodyChars` decides how much of a response body is
 * kept — a log line wants a taste, the detail view wants the whole error JSON.
 */
function detailParts(error: unknown, bodyChars: number, depth = 0): string[] {
  const parts: string[] = [errorMessage(error)];
  if (error === null || typeof error !== "object") return parts;
  const fields = error as Record<string, unknown>;
  if (typeof fields.name === "string" && fields.name && fields.name !== "Error") {
    parts.push(`name=${fields.name}`);
  }
  const status = fields.statusCode ?? fields.status;
  if (typeof status === "number") parts.push(`status=${status}`);
  if (typeof fields.url === "string") parts.push(`url=${fields.url}`);
  if (typeof fields.responseBody === "string" && fields.responseBody) {
    parts.push(`body=${truncate(fields.responseBody, bodyChars)}`);
  }
  const cause = fields.cause;
  if (cause && cause !== error && depth < MAX_DEPTH) {
    parts.push(`cause=${detailParts(cause, bodyChars, depth + 1).join(" ")}`);
  }
  return parts;
}

/**
 * Builds a readable description of a provider/streaming error for SERVER LOGS,
 * pulling the HTTP status, request URL, response body, and underlying cause that
 * the AI SDK attaches but a bare `error.message` usually omits — so logs explain
 * *why* a generation failed.
 */
export function describeError(error: unknown): string {
  if (error === null || typeof error !== "object") return redactSecrets(errorMessage(error));
  return redactSecrets(detailParts(error, LOG_BODY_CHARS).join(" "));
}

/**
 * The one-line error shown inline in the UI: the human-readable message plus the
 * HTTP status. Everything else — the provider URL, the response body, the cause
 * chain — is in {@link errorDetail}, behind an expander, so a failure reads as a
 * sentence first and a diagnosis second.
 */
export function clientError(error: unknown): string {
  const message = redactSecrets(errorMessage(error));
  if (error === null || typeof error !== "object") return message;
  const fields = error as Record<string, unknown>;
  const status = fields.statusCode ?? fields.status;
  return typeof status === "number" ? `${message} (status ${status})` : message;
}

/**
 * The full redacted diagnosis for the UI's error detail view: status, endpoint,
 * the provider's own response body and the cause chain. This goes to the same
 * user who can read the sidecar's logs on their own machine, so it carries what
 * those logs carry — a gateway's "model not found" body is exactly what turns an
 * unexplained failure into a config fix — but every credential shape
 * `redactSecrets` knows is stripped first, since the string is meant to be
 * copied into a bug report.
 */
export function errorDetail(error: unknown): string {
  if (error === null || typeof error !== "object") return redactSecrets(errorMessage(error));
  return redactSecrets(detailParts(error, DETAIL_BODY_CHARS).join("\n"));
}
