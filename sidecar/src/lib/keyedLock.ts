/**
 * A lock per key: work under one key runs one at a time, in the order it was
 * asked for, while different keys run freely. A failure releases the key like a
 * success does, so one bad run never wedges the ones queued behind it.
 */
export type KeyedLock = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

export function createKeyedLock(): KeyedLock {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    // Store a never-rejecting tail so a failure doesn't poison the chain, and
    // drop it once nothing else has queued behind it.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}
