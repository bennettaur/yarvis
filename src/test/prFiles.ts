import { mock } from "bun:test";
import type { PrFile } from "../lib/pr/types";

interface FilesResource {
  data: PrFile[] | null;
  error: string | null;
  loading: boolean;
}

let filesResource: FilesResource = { data: null, error: null, loading: false };
let fileContent: string | null = null;

/**
 * Point `usePrFileContent` at a file's full text for the next render — what
 * syntax colouring reads instead of the fragments in a patch. Null (the
 * default) stands for "not fetched", which is also what a render that passes no
 * head commit gets.
 */
export function setPrFileContent(text: string | null): void {
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
  filesResource = { data, error: over.error ?? null, loading: over.loading ?? false };
}

/** A changed file with the boring fields filled in. */
export function prFile(filename: string, over: Partial<PrFile> = {}): PrFile {
  return { filename, status: "modified", additions: 1, deletions: 0, patch: null, ...over };
}

// `mock.module` is process-global in bun, so the stub for `lib/pr/cache` has to
// be registered exactly once for the whole run — two test files each installing
// their own would race, and the loser would read the winner's file set. Every
// test that renders a PR component imports this module instead. The rest of the
// cache's exports pass through untouched so tests of those still see the real
// implementations.
const actualCache = await import("../lib/pr/cache");
mock.module("../lib/pr/cache", () => ({
  ...actualCache,
  usePrFiles: () => filesResource,
  usePrFileContent: (_ref: unknown, _path: string, sha: string, enabled: boolean) => ({
    data: enabled && sha ? fileContent : null,
    error: null,
    loading: false,
  }),
}));

// `PrFileDiffs` mounts `usePrInsights`, which loads through `lib/pr/insights`.
// Sibling test files mock `lib/api` with partial factories, leaving that fetch
// resolving `undefined` and the hook bucketing a non-array. Stub the one call
// so a diff render doesn't depend on which other test file ran first.
//
// This registration is process-global like the one above, so a future test of
// the real `fetchPrInsights` would be stubbed out merely by sharing a process
// with something that imports this helper. Nothing exercises it today; if that
// changes, the stub belongs behind an opt-in rather than at import time.
const actualInsights = await import("../lib/pr/insights");
mock.module("../lib/pr/insights", () => ({
  ...actualInsights,
  fetchPrInsights: async () => [],
}));
