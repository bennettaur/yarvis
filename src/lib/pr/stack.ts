import { ensureOk, sidecarFetch } from "../api";
import { prRefQuery } from "./guide";
import { refKey } from "./ref";
import type { PrRef, PrStack, StackEntry } from "./types";

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

/**
 * The number a layer carries when it has no pull request. Mirrors the sidecar's
 * constant of the same name; pull request numbers start at 1, so zero cannot
 * collide with a real one.
 */
const NO_PULL_REQUEST = 0;

/**
 * Whether a layer has a pull request at all. `gh stack` tracks a branch from
 * the moment it is created, so a stack can hold a layer with nothing to open,
 * merge or link to.
 */
export const hasPullRequest = (entry: StackEntry): boolean => entry.number !== NO_PULL_REQUEST;

/**
 * Where a pull request sits in a stack, or -1 when it is not one of the layers.
 *
 * The stack is fetched per layer and each copy marks its own subject with
 * `isCurrent`, so a surface that already knows which pull request it is showing
 * should ask this instead: it answers before the refetch for the layer just
 * opened lands.
 */
export function layerIndexOf(stack: PrStack, ref: PrRef): number {
  const key = refKey(ref);
  return stack.entries.findIndex((e) => hasPullRequest(e) && refKey(e.ref) === key);
}

/**
 * The layer a "merge the stack" action should stop at: the one the workspace is
 * on. Null when that layer has already merged, or has no pull request to name.
 */
export function currentLayer(stack: PrStack | null): StackEntry | null {
  return (stack?.entries ?? []).find((e) => e.isCurrent && !e.merged && hasPullRequest(e)) ?? null;
}

/**
 * The layers `gh stack merge <upToPrNumber>` would actually land: that pull
 * request and everything below it not already merged, bottom-first.
 *
 * This is what the confirm button counts, and it travels with the merge so the
 * sidecar can recompute it and refuse if the stack moved in between — see
 * `mergeWorkspaceRepoStack`. Counting entries up to the target instead would
 * over-promise, since a stack whose bottom has already landed merges fewer
 * layers than it holds.
 */
export function mergePlan(stack: PrStack, upToPrNumber: number): number[] {
  if (upToPrNumber === NO_PULL_REQUEST) return [];
  const top = stack.entries.findIndex((e) => e.number === upToPrNumber);
  if (top === -1) return [];
  return stack.entries
    .slice(0, top + 1)
    .filter((e) => hasPullRequest(e) && !e.merged)
    .map((e) => e.number);
}
