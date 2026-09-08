import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A request cache keyed by a string derived from the resource (e.g.
 * `issues:github:assigned` or `detail:<refKey>`). It does two jobs.
 *
 * Several components naming the same key share one network request rather than
 * each calling the sidecar, and components naming different keys stay isolated.
 *
 * And the cache outlives the components reading it, which is what makes moving
 * between app tabs cheap: `App` renders one panel at a time, so every tab switch
 * unmounts a page outright. A remount is seeded from the cache synchronously,
 * then revalidates behind the data already on screen; {@link Resource.refreshing}
 * is what a surface shows while that happens, distinct from
 * {@link Resource.loading}, which means there is genuinely nothing to show yet.
 *
 * An entry is either an in-flight `promise`, which concurrent callers join, or a
 * resolved `value` with the timestamp it landed at, served until it goes stale.
 * A rejection is neither: the entry is dropped so the next caller retries. A
 * loader with an answer worth keeping — "this provider isn't configured" — has
 * to resolve to it rather than throw.
 */

/**
 * How long a cached value is served without a load at all. The default suits a
 * read the sidecar answers from its own Postgres: it is a dedupe window rather
 * than a freshness window, so returning to a tab does refresh in the background
 * — which is the whole point — without a double fetch on a remount that happens
 * to straddle one.
 */
const DEFAULT_TTL_MS = 3_000;

/**
 * For a resource whose load costs a call to GitHub, Azure DevOps or JIRA, all of
 * which rate-limit. Flicking between tabs must not spend the user's quota once
 * per switch, so these are held long enough to make that free.
 */
export const PROVIDER_TTL_MS = 60_000;

/**
 * For a probe of whether a provider is configured at all. Held far longer than
 * the lists, because the answer changes only when the user edits their
 * credentials — and when they do, `KeychainSection` drops the whole cache, so
 * nothing waits this out.
 */
export const PROBE_TTL_MS = 10 * 60_000;

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
    // Looked up again rather than closed over: `clearResourceCache` replaces the
    // whole map, and emptying the set this closure captured would leave a live
    // subscriber's set deleted from under it.
    const current = listeners.get(key);
    if (!current) return;
    current.delete(notify);
    if (current.size === 0) listeners.delete(key);
  };
}

export function cachedFetch<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T> {
  const current = cache.get(key) as CacheEntry<T> | undefined;
  if (current) {
    if (current.promise) return current.promise;
    // Gate on the timestamp, not the value, so a loader that legitimately
    // resolves to `undefined` is still served from cache until it goes stale.
    if (current.ts !== undefined && Date.now() - current.ts < ttlMs) {
      return Promise.resolve(current.value as T);
    }
  }
  // Both handlers write only while this load is still the one the cache is
  // waiting on. An `invalidate` during a load starts a second one, and without
  // the identity check the first to resolve — which may be the older — would
  // install its value under a fresh timestamp, or its rejection would drop the
  // newer load's entry and send the next caller back to the provider.
  const entry: CacheEntry<T> = {};
  entry.promise = loader()
    .then((value) => {
      if (cache.get(key) === entry) cache.set(key, { value, ts: Date.now() });
      return value;
    })
    .catch((err) => {
      // Don't cache failures; let the next caller retry.
      if (cache.get(key) === entry) cache.delete(key);
      throw err;
    });
  cache.set(key, entry);
  return entry.promise;
}

/** A resolved entry and when it landed, or null if there is nothing to serve. */
function peek<T>(key: string): { value: T; ts: number } | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry || entry.ts === undefined) return null;
  return { value: entry.value as T, ts: entry.ts };
}

/**
 * Stores a value a caller already has, as though a load had just returned it,
 * and lets mounted subscribers pick it up. For a surface that fetches on its own
 * schedule — the workspaces list polls its PR badges — so its result outlives
 * the panel rather than being thrown away on the next tab switch.
 */
export function primeCache<T>(key: string, next: T | ((current: T | null) => T)): void {
  // The updater form is the `setState` one, and exists for the same reason: a
  // caller adding to a list it read at render time would otherwise overwrite a
  // load that landed in between. It is handed `null` when there is no *resolved*
  // value — including while a load is in flight — so an updater that edits an
  // existing value has to say what an absent one means rather than treating it
  // as empty.
  const value =
    typeof next === "function"
      ? (next as (current: T | null) => T)(peek<T>(key)?.value ?? null)
      : next;
  cache.set(key, { value, ts: Date.now() });
  const subscribers = listeners.get(key);
  if (subscribers) for (const notify of subscribers) notify();
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

/**
 * Discards the whole cache and every subscription. For a change that invalidates
 * everything at once rather than one key — the sidecar restarting under new
 * credentials — and so tests don't leak entries, or a root a failing case left
 * mounted, into each other. Subscribers are dropped rather than notified: a
 * caller doing this is not asking every mounted surface to refetch at once, and
 * whatever is on screen is replaced on its next mount.
 */
export function clearResourceCache(): void {
  cache.clear();
  listeners.clear();
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
 * The combined state of several resources a surface shows together: it is
 * refreshing while any of them is, has nothing to show while any of them has,
 * and reports the first error in the order given — so callers list the resources
 * in the order they would want a failure attributed.
 */
export function combineResources(resources: Resource<unknown>[]): {
  loading: boolean;
  refreshing: boolean;
  error: string | null;
} {
  return {
    loading: resources.some((r) => r.loading),
    refreshing: resources.some((r) => r.refreshing),
    error: resources.find((r) => r.error !== null)?.error ?? null,
  };
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
