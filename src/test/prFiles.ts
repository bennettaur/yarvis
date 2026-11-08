import { mock } from "bun:test";
import type { PrFile } from "../lib/pr/types";
import { passThrough } from "./passThrough";

interface FilesResource {
  data: PrFile[] | null;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
}

const inertRefresh = async () => {};

let filesResource: FilesResource = {
  data: null,
  error: null,
  loading: false,
  refreshing: false,
  refresh: inertRefresh,
};
let fileContent: string | null = null;

/**
 * Point `usePrFileContent` at a file's full text for the next render — what
 * syntax colouring reads instead of the fragments in a patch. Null (the
 * default) stands for "not fetched", which is also what a render that passes no
 * head commit gets.
 */
export function setPrFileContent(text: string | null): void {
  stubPrFiles();
  fileContent = text;
}

/**
 * Point every component reading `usePrFiles` at a fixed file set for the next
 * render. Returns nothing — call it before `renderToHtml`.
 */
export function setPrFiles(
  data: PrFile[] | null,
  over: Partial<Omit<FilesResource, "data">> = {},
): void {
  stubPrFiles();
  filesResource = {
    data,
    error: over.error ?? null,
    loading: over.loading ?? false,
    refreshing: over.refreshing ?? false,
    refresh: inertRefresh,
  };
}

/** A changed file with the boring fields filled in. */
export function prFile(filename: string, over: Partial<PrFile> = {}): PrFile {
  return { filename, status: "modified", additions: 1, deletions: 0, patch: null, ...over };
}

// `lib/pr/cache` and `lib/pr/insights` are registered once here, passing
// through to the real modules (see `passThrough.ts`), so other files see the
// real cache unless they ask for these stubs.
const cache = passThrough({ ...(await import("../lib/pr/cache")) });
mock.module("../lib/pr/cache", () => cache.module);
const insights = passThrough({ ...(await import("../lib/pr/insights")) });
mock.module("../lib/pr/insights", () => insights.module);

/**
 * Answers `usePrFiles` and `usePrFileContent` from `setPrFiles` and
 * `setPrFileContent`, and gives `PrFileDiffs`' `usePrInsights` an empty list so
 * a diff render never reaches the sidecar client. `setPrFiles` and
 * `setPrFileContent` call it too. Call it at the top of a suite that renders
 * PR components, and `resetPrCache` in its `afterAll`.
 */
export function stubPrFiles(): void {
  cache.stub({
    usePrFiles: () => filesResource,
    usePrFileContent: (_ref, _path, sha, enabled) => ({
      data: enabled && sha ? fileContent : null,
      error: null,
      loading: false,
      refreshing: false,
      refresh: inertRefresh,
    }),
  });
  insights.stub({ fetchPrInsights: async () => [] });
}

/** Overrides for other `lib/pr/cache` exports; they last until `resetPrCache`. */
export const stubPrCache = cache.stub;

/** Clears every override and the file set and content `stubPrFiles` serves. */
export function resetPrCache(): void {
  cache.reset();
  insights.reset();
  filesResource = {
    data: null,
    error: null,
    loading: false,
    refreshing: false,
    refresh: inertRefresh,
  };
  fileContent = null;
}
