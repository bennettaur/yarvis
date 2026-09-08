import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A request cache keyed by a string derived from the resource (e.g.
 * `issues:github` or `detail:<refKey>`). It does two jobs.
 *
 * Several components naming the same key share one network request rather than
 * each calling the sidecar, and components naming different keys stay isolated.
 *
 * And the cache outlives the components reading it, which is what makes moving
 * between app tabs cheap: `App` renders one panel at a time, so every tab switch
 * unmounts a page outright and the old shape — local `useState` plus a
 * fetch-on-mount effect — meant coming back always painted an empty list first.
 * A remount is seeded from the cache synchronously, then revalidates behind the
 * data already on screen; {@link Resource.refreshing} is what a surface shows
 * while that happens, distinct from {@link Resource.loading}, which means there
 * is genuinely nothing to show yet.
 *
 * Three states per entry: an in-flight `promise` (so concurrent callers join
 * it), a resolved `value` with a timestamp (served until it goes stale), or an
 * `error`. Errors are not cached — the next caller retries.
 */

/**
 * How long a cached value is served without a network round trip at all. Short
 * enough that a tab the user keeps flicking between still tracks reality, long
 * enough that flicking between them doesn't re-hit a rate-limited provider once
 * per switch.
 */
export const DEFAULT_TTL_MS = 30_000;

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

/** A resolved entry and when it landed, or null if there is nothing to serve. */
function peek<T>(key: string): { value: T; ts: number } | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry || entry.ts === undefined) return null;
  return { value: entry.value as T, ts: entry.ts };
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
 * Drops every entry whose key starts with `prefix`, for a write that changes
 * more than the one list that issued it — creating an issue moves both the
 * "assigned to me" and the "all open" lists, and starring one moves a list
 * keyed per provider. Mounted subscribers are notified the same way.
 */
export function invalidatePrefix(prefix: string): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) invalidate(key);
  }
  // A key with no cached entry can still have mounted subscribers — it may be
  // mid-flight, or its last load may have failed — and they want the refetch too.
  for (const key of [...listeners.keys()]) {
    if (key.startsWith(prefix) && !cache.has(key)) invalidate(key);
  }
}

/** Discards the whole cache. Exists so tests don't leak entries into each other. */
export function clearResourceCache(): void {
  cache.clear();
}

export interface Resource<T> {
  /** The last value known for this key, cached or freshly loaded. */
  data: T | null;
  error: string | null;
  /** Nothing to show yet: a first load for this key is in flight. */
  loading: boolean;
  /** Cached data is on screen while a load runs behind it. */
  refreshing: boolean;
  /** Forces a reload past the TTL, resolving when it settles. */
  refresh: () => Promise<void>;
}

/**
 * Subscribes a component to a cached resource. `key` may be null to skip
 * fetching (e.g. while a diff is collapsed). The effect re-runs only when `key`
 * changes, so callers MUST encode every value the loader reads into `key`;
 * otherwise the component would keep stale data when those values change.
 */
export function useCachedResource<T>(
  key: string | null,
  loader: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Resource<T> {
  const [data, setData] = useState<T | null>(() =>
    key === null ? null : (peek<T>(key)?.value ?? null),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<boolean>(() => key !== null && peek(key) === null);

  // `loader` is recreated each render but closes over the same values `key`
  // encodes (see the contract above), so we read it through a ref and key the
  // effect on `key` alone — no re-subscribe on every render.
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const ttlRef = useRef(ttlMs);
  ttlRef.current = ttlMs;

  useEffect(() => {
    if (key === null) {
      setData(null);
      setError(null);
      setPending(false);
      return;
    }
    let active = true;
    // A new key names a different resource, so whatever is on screen does not
    // describe it. Seed from that key's own cached value where there is one —
    // that *is* the resource — and blank the view otherwise, rather than
    // leaving the review header titled with the layer the reader just left.
    setData(peek<T>(key)?.value ?? null);
    // An invalidation can fire `load` while a prior load is still in flight;
    // track the latest so an out-of-order resolution can't write back a stale
    // value over the newer one.
    let latest = 0;
    const load = () => {
      const seq = ++latest;
      const hit = peek<T>(key);
      // Announce a load only when one will actually reach the network: a hit
      // inside the TTL resolves on a microtask, and flashing the refreshing
      // indicator for it is the jank this is meant to remove.
      if (hit === null || Date.now() - hit.ts >= ttlRef.current) setPending(true);
      setError(null);
      cachedFetch(key, loaderRef.current, ttlRef.current)
        .then((value) => {
          if (!active || seq !== latest) return;
          setData(value);
          setPending(false);
        })
        .catch((err) => {
          if (!active || seq !== latest) return;
          // The cached value stays on screen beside the error: a failed
          // background refresh is no reason to take the list away.
          setError(err instanceof Error ? err.message : String(err));
          setPending(false);
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

  const refresh = useCallback(async () => {
    if (key === null) return;
    // `invalidate` notifies this hook's own subscriber, which starts the load
    // and owns the resulting state; joining the same in-flight promise here is
    // only so callers can await the settle.
    invalidate(key);
    await cachedFetch(key, loaderRef.current, ttlRef.current).catch(() => {});
  }, [key]);

  return {
    data,
    error,
    loading: pending && data === null,
    refreshing: pending && data !== null,
    refresh,
  };
}
