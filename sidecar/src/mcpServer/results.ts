import { z } from "zod";
import { describeError } from "../llm/errors.ts";

/**
 * A uuid argument lands in a `uuid` column, so a non-uuid would surface as a
 * database error rather than a schema rejection. Matched by shape rather than
 * with zod's `.uuid()`, which additionally enforces RFC version/variant bits
 * that Postgres itself does not — the same check `attention/routes.ts` applies.
 */
export const UUID = z
  .string()
  .regex(/^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/, "must be a uuid");

/** Every tool answers with a single JSON text block. */
export function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** A refusal the caller caused and can fix, so its message is safe to return. */
export function callerError(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

/** An internal failure, reported without its detail; the detail goes to the sidecar log. */
export function toolError(label: string, error: unknown) {
  // The SDK returns a thrown error's `message` verbatim, and the messages
  // reaching here are database and provider errors — a failed drizzle query
  // carries the SQL and its bound parameters. The token holding this endpoint is
  // meant to be *less* privileged than the bearer, so the detail stays in the
  // sidecar log and the caller gets the failure without the internals.
  console.error(`[mcp] ${label} failed:`, describeError(error));
  return callerError(`${label} failed — see the Yarvis sidecar log.`);
}
