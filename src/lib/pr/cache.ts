import { useEffect, useRef, useState } from "react";
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
 * A tiny request cache for PR data, keyed by a string derived from the resource
 * (e.g. `detail:<refKey>`). Its whole job is to make the decomposed PR
 * components cheap to compose: several components that name the same PR share
 * one network request rather than each calling the provider, and components
 * naming different PRs stay isolated because their keys differ.
 *
 * Three states per entry: an in-flight `promise` (so concurrent callers join
 * it), a resolved `value` with a timestamp (served until it goes stale), or an
 * `error`. Errors are not cached — the next caller retries.
 */

const DEFAULT_TTL_MS = 60_000;

interface CacheEntry<T> {
  value?: T;
  ts?: number;
  promise?: Promise<T>;
}

const cache = new Map<string, CacheEntry<unknown>>();

/**
 * Subscribers currently mounted against each key. `invalidate` notifies them so
 * a component already showing a resource refetches immediately, rather than the
 * dropped entry only being reloaded the next time the key is mounted.
 */
const listeners = new Map<string, Set<() => void>>();

function subscribe(key: string, notify: () => void): () => void {
  let subscribers = listeners.get(key);
  if (!subscribers) {
    subscribers = new Set();
    listeners.set(key, subscribers);
  }
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0) listeners.delete(key);
  };
}

export function cachedFetch<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T> {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (entry) {
    if (entry.promise) return entry.promise;
    // Gate on the timestamp, not the value, so a loader that legitimately
    // resolves to `undefined` is still served from cache until it goes stale.
    if (entry.ts !== undefined && Date.now() - entry.ts < ttlMs) {
      return Promise.resolve(entry.value as T);
    }
  }
  const promise = loader()
    .then((value) => {
      cache.set(key, { value, ts: Date.now() });
      return value;
    })
    .catch((err) => {
      // Don't cache failures; let the next caller retry.
      cache.delete(key);
      throw err;
    });
  cache.set(key, { promise });
  return promise;
}

/**
 * Drops a cached entry and notifies any mounted subscribers so they refetch
 * now (e.g. after a write). Without the notification a component already
 * showing the resource would keep its stale value until the key next mounts —
 * so publishing a draft PR wouldn't flip the header's status badge to open.
 */
export function invalidate(key: string): void {
  cache.delete(key);
  const subscribers = listeners.get(key);
  if (subscribers) for (const notify of subscribers) notify();
}

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

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * Subscribes a component to a cached resource. `key` may be null to skip
 * fetching (e.g. while a diff is collapsed). The effect re-runs only when `key`
 * changes, so callers MUST encode every value the loader reads into `key` (the
 * `usePrXxx` hooks below put the ref into it); otherwise the component would
 * keep stale data when those values change.
 */
function useCachedResource<T>(key: string | null, loader: () => Promise<T>): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(key !== null);

  // `loader` is recreated each render but closes over the same values `key`
  // encodes (see the contract above), so we read it through a ref and key the
  // effect on `key` alone — no re-subscribe on every render.
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    if (key === null) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    let active = true;
    // An invalidation can fire `load` while a prior load is still in flight;
    // track the latest so an out-of-order resolution can't write back a stale
    // value over the newer one.
    let latest = 0;
    const load = () => {
      const seq = ++latest;
      setLoading(true);
      setError(null);
      cachedFetch(key, loaderRef.current)
        .then((value) => {
          if (!active || seq !== latest) return;
          setData(value);
          setLoading(false);
        })
        .catch((err) => {
          if (!active || seq !== latest) return;
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        });
    };
    load();
    // Refetch in place when this key is invalidated by a write elsewhere, so a
    // component already showing the resource updates without remounting.
    const unsubscribe = subscribe(key, load);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [key]);

  return { data, error, loading };
}

export const prDetailKey = (ref: PrRef) => `detail:${refKey(ref)}`;

export function usePrDetail(ref: PrRef | null): Resource<PrDetail> {
  return useCachedResource(ref ? prDetailKey(ref) : null, () => fetchPrDetail(ref!));
}

export function usePrFiles(ref: PrRef | null): Resource<PrFile[]> {
  return useCachedResource(ref ? `files:${refKey(ref)}` : null, () => fetchPrFiles(ref!));
}

export function usePrStatus(ref: PrRef | null): Resource<PrStatus> {
  return useCachedResource(ref ? `status:${refKey(ref)}` : null, () => fetchPrStatus(ref!));
}

/**
 * The stack a pull request belongs to. Walking it costs a provider round trip
 * per layer, so it sits behind the same cache as everything else here rather
 * than being refetched by each surface that shows it.
 */
export function usePrStack(ref: PrRef | null): Resource<PrStack | null> {
  return useCachedResource(ref ? `stack:${refKey(ref)}` : null, () => fetchPrStack(ref!));
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
  return useCachedResource(key, () => queued(() => fetchPrFileDiff(ref, file)));
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
  return useCachedResource(key, () => queued(() => fetchPrFileContent(ref, path, sha)));
}
