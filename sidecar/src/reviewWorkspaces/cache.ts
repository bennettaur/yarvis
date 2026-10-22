/**
 * A least-recently-used cache with a size budget, for review reads. Every key
 * names commits by sha, so an entry never goes stale — a refresh reads under new
 * keys and the old entries simply age out.
 *
 * A value still being computed is cached as its promise, so concurrent requests
 * for the same thing (the file list opening while the sync that computes it is
 * still running) share one git process. A rejected promise is dropped rather
 * than kept, so a failure is retried next time.
 */
export class ShaCache {
  private readonly entries = new Map<string, { value: Promise<unknown>; size: number }>();
  private used = 0;

  constructor(private readonly budget: number) {}

  /**
   * The cached value for `key`, or `load()`'s, sized by `sizeOf` once it
   * resolves. A value bigger than the whole budget is returned but not kept.
   */
  get<T>(key: string, load: () => Promise<T>, sizeOf: (value: T) => number): Promise<T> {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value as Promise<T>;
    }
    const value = load();
    const entry = { value: value as Promise<unknown>, size: 0 };
    this.entries.set(key, entry);
    value.then(
      (resolved) => {
        if (this.entries.get(key) !== entry) return;
        entry.size = sizeOf(resolved);
        this.used += entry.size;
        this.evict();
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    return value;
  }

  private evict(): void {
    for (const [key, entry] of this.entries) {
      if (this.used <= this.budget) return;
      this.entries.delete(key);
      this.used -= entry.size;
    }
  }
}

/** A rough size for a list of strings: their characters plus per-entry overhead. */
export function stringsSize(values: readonly string[]): number {
  return values.reduce((sum, value) => sum + value.length + 32, 0);
}
