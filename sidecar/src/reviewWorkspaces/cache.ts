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

interface Entry {
  value: Promise<unknown>;
  /** Known once the value resolves; until then the entry holds no budget. */
  size: number | null;
}

export class ShaCache {
  private readonly entries = new Map<string, Entry>();
  private used = 0;

  constructor(private readonly budget: number) {}

  /**
   * The cached value for `key`, or `load()`'s, sized by `sizeOf` once it
   * resolves. A value bigger than the whole budget is returned but not kept,
   * and evicts nothing.
   */
  get<T>(key: string, load: () => Promise<T>, sizeOf: (value: T) => number): Promise<T> {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value as Promise<T>;
    }
    const value = load();
    const entry: Entry = { value, size: null };
    this.entries.set(key, entry);
    value.then(
      (resolved) => {
        if (this.entries.get(key) !== entry) return;
        const size = sizeOf(resolved);
        if (size > this.budget) {
          this.entries.delete(key);
          return;
        }
        entry.size = size;
        this.used += size;
        this.evictFor(key);
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    return value;
  }

  /** Whether `key` is cached (resolved or in flight). For tests. */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Evicts least recently used resolved entries, other than `keep`, until within budget. */
  private evictFor(keep: string): void {
    for (const [key, entry] of this.entries) {
      if (this.used <= this.budget) return;
      if (key === keep || entry.size === null) continue;
      this.entries.delete(key);
      this.used -= entry.size;
    }
  }
}

/** A rough size for a list of strings: their characters plus per-entry overhead. */
export function stringsSize(values: readonly string[]): number {
  return values.reduce((sum, value) => sum + value.length + 32, 0);
}
