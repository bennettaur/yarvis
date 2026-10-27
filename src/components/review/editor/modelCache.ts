interface Disposable {
  dispose(): void;
}

interface Entry<T> {
  value: T;
  refs: number;
}

/**
 * Reference-counted models, keyed by URI, with a few unused ones kept back.
 *
 * Monaco keeps every model it has made until it is disposed, and the TypeScript
 * worker re-checks every TypeScript model it knows on each change, so a model
 * nobody shows has to go. Disposing the moment the last view lets go would
 * throw away the tokenization and the worker's copy on every tab switch,
 * though, so the last `keepIdle` released models stay until something newer
 * pushes them out.
 */
export class ModelCache<T extends Disposable> {
  private readonly entries = new Map<string, Entry<T>>();
  /** Unreferenced keys, oldest first. */
  private readonly idle: string[] = [];

  constructor(private readonly keepIdle = 8) {}

  /** The model for `key`, made with `create` when there is none, held until {@link release}. */
  acquire(key: string, create: () => T): T {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { value: create(), refs: 0 };
      this.entries.set(key, entry);
    }
    if (entry.refs === 0) this.dropIdle(key);
    entry.refs++;
    return entry.value;
  }

  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || entry.refs === 0) return;
    entry.refs--;
    if (entry.refs > 0) return;
    this.idle.push(key);
    while (this.idle.length > this.keepIdle) {
      const oldest = this.idle.shift();
      if (oldest !== undefined) this.evict(oldest);
    }
  }

  /** Forgets a model that was disposed elsewhere, so it is never handed out again. */
  forget(key: string): void {
    this.entries.delete(key);
    this.dropIdle(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    entry.value.dispose();
  }

  private dropIdle(key: string): void {
    const at = this.idle.indexOf(key);
    if (at >= 0) this.idle.splice(at, 1);
  }
}
