import { describeError } from "../llm/errors.ts";

/** Result builders shared by every tool on the MCP endpoint. */

/** Every tool answers with a single JSON text block. */
export function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** A failure whose message is safe to show the caller as is. */
export function toolMessage(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

/** A tool failure the caller can act on, with the detail kept in the logs. */
export function toolError(label: string, error: unknown) {
  // The SDK returns a thrown error's `message` verbatim, and the messages
  // reaching here are database and provider errors — a failed drizzle query
  // carries the SQL and its bound parameters. The token holding this endpoint is
  // meant to be *less* privileged than the bearer, so the detail stays in the
  // sidecar log and the caller gets the failure without the internals.
  console.error(`[mcp] ${label} failed:`, describeError(error));
  return toolMessage(`${label} failed — see the Yarvis sidecar log.`);
}
