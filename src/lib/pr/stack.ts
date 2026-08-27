import { ensureOk, sidecarFetch } from "../api";
import { prRefQuery } from "./guide";
import type { PrRef, PrStack } from "./types";

/**
 * Client for a pull request's stack. Like the guide routes and unlike the rest
 * of this directory, one call serves both providers: the ref travels in the
 * query and the sidecar decides what, if anything, the provider can answer.
 */

/**
 * The stack a pull request sits in, or null when the provider has no notion of
 * one (Azure DevOps). A pull request that is not stacked comes back as a
 * one-entry stack, which is what lets a caller tell "not stacked" apart from
 * "we couldn't look".
 */
export async function fetchPrStack(ref: PrRef): Promise<PrStack | null> {
  const path = `/api/pr/stack?${prRefQuery(ref)}`;
  const res = await sidecarFetch(path);
  await ensureOk(res, path);
  const body = (await res.json()) as { stack: PrStack | null };
  return body.stack;
}

/**
 * Whether a stack is worth showing. A single layer is just the pull request the
 * reader already has open, and a section repeating it back adds nothing.
 */
export function isStacked(stack: PrStack | null): stack is PrStack {
  return (stack?.entries.length ?? 0) > 1;
}

/**
 * How many layers still need restacking. This is the stack's one actionable
 * summary — the reader can see the rest from the list, but "something below you
 * moved" is the thing that is easy to miss and expensive to discover late.
 */
export function needsUpdateCount(stack: PrStack | null): number {
  return (stack?.entries ?? []).filter((e) => e.needsUpdate).length;
}
