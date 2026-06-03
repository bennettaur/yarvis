import { useEffect, useState } from "react";
import {
  ghPrDetail,
  ghPrFiles,
  ghPrStatus,
  type PrDetail,
  type PrFile,
  type PrStatus,
} from "./github";

/**
 * A tiny request cache for GitHub data, keyed by a string the caller derives
 * from the resource (e.g. `detail:owner/repo/number`). Its whole job is to make
 * the decomposed PR components cheap to compose: several components that name
 * the same PR share one network request rather than each calling GitHub, and
 * components naming different PRs stay isolated because their keys differ.
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

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * Subscribes a component to a cached resource. `key` may be null to skip
 * fetching (e.g. while required ids are missing). The effect re-runs only when
 * `key` changes, so callers MUST encode every value the loader reads into `key`
 * (the `usePrXxx` hooks below put owner/repo/number into it); otherwise the
 * component would keep stale data when those values change.
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

function prKey(prefix: string, owner: string, repo: string, number: number) {
  return owner && repo ? `${prefix}:${owner}/${repo}/${number}` : null;
}

export function usePrDetail(owner: string, repo: string, number: number): Resource<PrDetail> {
  return useCachedResource(prKey("detail", owner, repo, number), () =>
    ghPrDetail(owner, repo, number),
  );
}

export function usePrFiles(owner: string, repo: string, number: number): Resource<PrFile[]> {
  return useCachedResource(prKey("files", owner, repo, number), () =>
    ghPrFiles(owner, repo, number),
  );
}

export function usePrStatus(owner: string, repo: string, number: number): Resource<PrStatus> {
  return useCachedResource(prKey("status", owner, repo, number), () =>
    ghPrStatus(owner, repo, number),
  );
}
