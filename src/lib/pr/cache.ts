import { useEffect, useState } from "react";
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

/** Drops a cached entry so the next subscriber refetches (e.g. after a write). */
export function invalidate(key: string): void {
  cache.delete(key);
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

  useEffect(() => {
    if (key === null) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    cachedFetch(key, loader)
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
    return () => {
      active = false;
    };
    // `loader` is recreated each render and is deliberately excluded; `key` is
    // the resource's full identity (see the contract above).
  }, [key, loader]);

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
