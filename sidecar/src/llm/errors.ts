/**
 * Builds a readable description of a provider/streaming error for SERVER LOGS,
 * pulling the HTTP status, request URL, response body, and underlying cause that
 * the AI SDK attaches but a bare `error.message` usually omits — so logs explain
 * *why* a generation failed. The raw URL/response body can carry provider-side
 * operational detail (endpoints, account identifiers), so this stays log-only;
 * use `clientError` for anything sent to the browser.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
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
  return parts.join(" ");
}

/**
 * A sanitized error string safe to surface to the client: the human-readable
 * message plus the HTTP status, but never the raw provider URL or response body
 * (which `describeError` keeps for server logs).
 */
export function clientError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const status = (error as unknown as Record<string, unknown>).statusCode;
  return typeof status === "number"
    ? `${error.message} (status ${status})`
    : error.message;
}
