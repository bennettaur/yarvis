import {
  importSpecifiers,
  isRelativeSpecifier,
  loadTsPathConfig,
  resolveSpecifier,
  type TsPathConfig,
} from "./imports";
import { type AliasShim, aliasShim } from "./shims";

/**
 * How much of a PR's import graph is pulled into the editor. Every file loaded
 * is a model the TypeScript worker re-reads, so the bound is on the whole PR
 * across every file opened in it, not per file.
 */
export interface ImportBudget {
  /** Levels of imports followed from a file that was opened. */
  maxDepth: number;
  maxFiles: number;
  maxBytes: number;
  /** A file bigger than this (a bundle, generated code) is skipped. */
  maxFileBytes: number;
}

export const DEFAULT_IMPORT_BUDGET: ImportBudget = {
  maxDepth: 3,
  maxFiles: 150,
  maxBytes: 4_000_000,
  maxFileBytes: 512_000,
};

/** File reads in flight at once, so a wide import list doesn't flood the sidecar. */
export const READ_CONCURRENCY = 8;

export interface LoadedFile {
  path: string;
  content: string;
}

export interface CollectedImports {
  files: LoadedFile[];
  /** Stand-ins for the tsconfig aliases these files use (`shims.ts`). */
  shims: AliasShim[];
  /** Something was left out because the budget ran out. */
  exhausted: boolean;
}

export interface ImportGraphSource {
  tree: ReadonlySet<string>;
  /** A head file's text; null when it is missing, binary or too large. */
  readFile(path: string): Promise<string | null>;
}

/** `fn` over `items` with at most `limit` running at once, results in order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next++;
      results[at] = await fn(items[at] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Follows imports out of the files a PR opens, breadth first, loading each
 * file once. One collector serves a whole PR, so the budget and the files
 * already loaded carry over from one opened file to the next.
 */
export class ImportCollector {
  /** Every path tried, loaded or not, so none is read twice. */
  private readonly seen = new Set<string>();
  /**
   * Files whose imports were followed, with how many levels below them were.
   * Opening a file that was loaded as someone's deep import follows it again,
   * further, without reading it again.
   */
  private readonly expanded = new Map<string, { content: string; levels: number }>();
  private readonly shimmed = new Set<string>();
  private readonly configs = new Map<string, Promise<TsPathConfig | null>>();
  private files = 0;
  private bytes = 0;

  constructor(
    private readonly source: ImportGraphSource,
    private readonly budget: ImportBudget = DEFAULT_IMPORT_BUDGET,
  ) {}

  /** What `entry` imports, to the budget's depth, that no earlier call loaded. */
  async collect(entry: LoadedFile): Promise<CollectedImports> {
    const result: CollectedImports = { files: [], shims: [], exhausted: false };
    this.seen.add(entry.path);
    this.expanded.set(entry.path, { content: entry.content, levels: this.budget.maxDepth });
    let frontier: LoadedFile[] = [entry];
    for (let depth = 1; depth <= this.budget.maxDepth && frontier.length > 0; depth++) {
      const levels = this.budget.maxDepth - depth;
      const wanted: string[] = [];
      const next: LoadedFile[] = [];
      for (const file of frontier) {
        const config = await this.configFor(file.path);
        for (const spec of importSpecifiers(file.content)) {
          const target = resolveSpecifier(spec, file.path, this.source.tree, config);
          if (!target) continue;
          if (config && !isRelativeSpecifier(spec)) this.addShim(spec, target, config, result);
          const known = this.expanded.get(target);
          if (known) {
            if (known.levels < levels) {
              known.levels = levels;
              next.push({ path: target, content: known.content });
            }
            continue;
          }
          if (this.seen.has(target)) continue;
          if (this.files + wanted.length >= this.budget.maxFiles) {
            result.exhausted = true;
            continue;
          }
          this.seen.add(target);
          wanted.push(target);
        }
      }
      const read = await mapLimit(wanted, READ_CONCURRENCY, (path) => this.source.readFile(path));
      wanted.forEach((path, i) => {
        const content = read[i];
        if (content == null || content.length > this.budget.maxFileBytes) return;
        if (this.bytes + content.length > this.budget.maxBytes) {
          result.exhausted = true;
          return;
        }
        this.files++;
        this.bytes += content.length;
        const file = { path, content };
        this.expanded.set(path, { content, levels });
        result.files.push(file);
        next.push(file);
      });
      frontier = next;
    }
    return result;
  }

  private addShim(
    spec: string,
    target: string,
    config: TsPathConfig,
    result: CollectedImports,
  ): void {
    const shim = aliasShim(spec, target, config.dir, this.source.tree);
    if (!shim || this.shimmed.has(shim.path)) return;
    this.shimmed.add(shim.path);
    result.shims.push(shim);
  }

  /** One tsconfig lookup per directory, shared by every file in it. */
  private configFor(path: string): Promise<TsPathConfig | null> {
    const dir = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    let config = this.configs.get(dir);
    if (!config) {
      config = loadTsPathConfig(path, this.source.tree, (p) => this.source.readFile(p)).catch(
        () => null,
      );
      this.configs.set(dir, config);
    }
    return config;
  }
}
