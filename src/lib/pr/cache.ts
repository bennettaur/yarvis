import { useEffect, useRef, useState } from "react";
import { fetchPrDetail, fetchPrFileDiff, fetchPrFiles, fetchPrStatus } from "./api";
import { refKey } from "./ref";
import type { PrDetail, PrFile, PrRef, PrStatus } from "./types";

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

function subscribe(key: string, fn: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(key);
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
  const set = listeners.get(key);
  if (set) for (const fn of set) fn();
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
    const load = () => {
      setLoading(true);
      setError(null);
      cachedFetch(key, loaderRef.current)
        .then((value) => {
          if (!active) return;
          setData(value);
          setLoading(false);
        })
        .catch((err) => {
          if (!active) return;
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
 * One file's diff, loaded only when `enabled` (the file's diff is open or among
 * the first few prefetched). For GitHub the patch is already on `file`, so this
 * resolves without a request.
 */
export function usePrFileDiff(ref: PrRef, file: PrFile, enabled: boolean): Resource<PrFile> {
  const key = enabled ? `filediff:${refKey(ref)}:${file.filename}` : null;
  return useCachedResource(key, () => fetchPrFileDiff(ref, file));
}
