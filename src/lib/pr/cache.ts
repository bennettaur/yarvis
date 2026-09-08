import { invalidate, PROVIDER_TTL_MS, type Resource, useCachedResource } from "../resourceCache";
import {
  fetchPrDetail,
  fetchPrFileContent,
  fetchPrFileDiff,
  fetchPrFiles,
  fetchPrStatus,
} from "./api";
import { refKey } from "./ref";
import { fetchPrStack } from "./stack";
import type { PrDetail, PrFile, PrRef, PrStack, PrStatus } from "./types";

/**
 * The PR feature's view of the shared resource cache in `lib/resourceCache`:
 * the key naming for each PR resource, plus the request ceiling the providers
 * need. Several of the decomposed PR components name the same PR, so they share
 * one request; components naming different PRs stay isolated because their keys
 * differ.
 */

// Re-exported because the PR components reach the cache through this module,
// which owns the key names they would be invalidating.
export { invalidate };

/**
 * Ceiling on provider requests in flight at once. Both providers throttle, and
 * the per-file fetches below can be triggered en masse — expanding every file
 * of a review at once, say — so they queue behind this instead of arriving as
 * one burst. High enough that ordinary scrolling never waits on it.
 */
const MAX_IN_FLIGHT = 6;

let inFlight = 0;
const waiting: (() => void)[] = [];

/**
 * Runs `task` once a slot is free. Slots are released in a `finally` so a failed
 * request can't strand one — a few rejections would otherwise wedge the queue
 * permanently and the review would simply stop loading files.
 */
async function queued<T>(task: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  inFlight++;
  try {
    return await task();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

export const prDetailKey = (ref: PrRef) => `detail:${refKey(ref)}`;

/**
 * Named alongside {@link prDetailKey} because the two go stale together: a
 * merge or a review verdict changes how this pull request reads *and* how its
 * layer reads in the stack, so anything invalidating one invalidates both.
 */
export const prStackKey = (ref: PrRef) => `stack:${refKey(ref)}`;

export function usePrDetail(ref: PrRef | null): Resource<PrDetail> {
  return useCachedResource(
    ref ? prDetailKey(ref) : null,
    () => fetchPrDetail(ref!),
    PROVIDER_TTL_MS,
  );
}

export function usePrFiles(ref: PrRef | null): Resource<PrFile[]> {
  return useCachedResource(
    ref ? `files:${refKey(ref)}` : null,
    () => fetchPrFiles(ref!),
    PROVIDER_TTL_MS,
  );
}

export function usePrStatus(ref: PrRef | null): Resource<PrStatus> {
  return useCachedResource(
    ref ? `status:${refKey(ref)}` : null,
    () => fetchPrStatus(ref!),
    PROVIDER_TTL_MS,
  );
}

/**
 * The stack a pull request belongs to. Walking it costs a provider round trip
 * per layer, so it sits behind the same cache as everything else here rather
 * than being refetched by each surface that shows it.
 */
export function usePrStack(ref: PrRef | null): Resource<PrStack | null> {
  return useCachedResource(ref ? prStackKey(ref) : null, () => fetchPrStack(ref!), PROVIDER_TTL_MS);
}

/**
 * One file's diff, loaded only when `enabled` (the file's diff is open or among
 * the first few prefetched). For GitHub the patch is already on `file`, so this
 * resolves without a request.
 *
 * Queued rather than fired immediately: Azure has no unified-diff endpoint, so
 * each file costs two content fetches, and "Expand all" on a large PR would
 * otherwise open hundreds of connections at once and collect rate-limit errors.
 */
export function usePrFileDiff(ref: PrRef, file: PrFile, enabled: boolean): Resource<PrFile> {
  const key = enabled ? `filediff:${refKey(ref)}:${file.filename}` : null;
  return useCachedResource(key, () => queued(() => fetchPrFileDiff(ref, file)), PROVIDER_TTL_MS);
}

/**
 * A file's full text at a commit, for revealing the context a patch omits.
 * Keyed by the commit so a push invalidates it rather than serving the reader
 * lines from a version of the file the diff no longer describes.
 */
export function usePrFileContent(
  ref: PrRef,
  path: string,
  sha: string,
  enabled: boolean,
): Resource<string> {
  const key = enabled && sha ? `content:${refKey(ref)}:${sha}:${path}` : null;
  return useCachedResource(
    key,
    () => queued(() => fetchPrFileContent(ref, path, sha)),
    PROVIDER_TTL_MS,
  );
}
