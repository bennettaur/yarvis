import type { AzureDevOpsClient } from "../azure/client.ts";
import type { GitHubClient } from "../github/client.ts";
import type { PrDetail, PrFile, PrRef } from "./types.ts";

/**
 * Read-only access to the code a pull request lives in, with the hosting
 * provider abstracted away.
 *
 * An agent reasoning about a PR needs to look past the diff — at the whole
 * file, at the directory around it, at who else calls the thing that changed —
 * and where that code lives differs entirely between GitHub and Azure DevOps.
 * This is the seam: the tools in `codeTools.ts` are written once against this
 * interface, and each provider supplies its own implementation.
 */
export interface PrCodeSource {
  ref: PrRef;
  detail(): Promise<PrDetail>;
  /** The PR's changed files. Patches may be absent until `fileDiff` is called. */
  files(): Promise<PrFile[]>;
  /** One changed file's unified diff. */
  fileDiff(path: string): Promise<PrFile>;
  /** A file's full text at the PR head, or "" when it isn't there. */
  readFile(path: string): Promise<string>;
  /** Entries directly under a directory at the PR head. */
  listDir(path: string): Promise<{ path: string; type: string }[]>;
  /**
   * Repo-scoped code search. Resolves to null when the provider can't offer it
   * — Azure's code search is an optional extension — so a caller can say so
   * rather than reporting "no matches" for a search that never ran.
   */
  searchCode(query: string, limit?: number): Promise<CodeHit[] | null>;
  /** What `searchCode` covers, so a caller can qualify its results. */
  readonly searchScope: string;
}

export interface CodeHit {
  path: string;
  /** Matching snippets, when the provider returns any. */
  fragments?: string[];
}

/**
 * Caches a fetch for the life of a source. Every tool that reads a file needs
 * the head commit, and every diff read needs the file listing; re-fetching
 * either on each of a dozen tool calls would spend most of an agent run
 * repeating the same request.
 */
function memoize<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load();
    return pending;
  };
}

export function githubPrSource(client: GitHubClient, ref: PrRef): PrCodeSource {
  if (ref.provider !== "github") throw new Error("expected a github ref");
  const { owner, repo, number } = ref;
  const detail = memoize(() => client.prDetail(owner, repo, number));
  // The file listing carries every changed file's full patch, so re-fetching it
  // per `read_diff` would pull the whole PR diff over the wire once per tool
  // call — tens of times across a single agent run.
  const files = memoize(() => client.prFiles(owner, repo, number));
  const head = async () => (await detail()).headSha;

  return {
    ref,
    detail,
    files,
    // GitHub returns every patch in that listing, so there is no per-file fetch
    // to make — the diff is already in hand.
    fileDiff: async (path) => {
      const file = (await files()).find((f) => f.filename === path);
      if (!file) throw new Error(`${path} is not changed by this pull request`);
      return file;
    },
    readFile: async (path) => client.fileContent(owner, repo, path, await head()),
    listDir: async (path) => client.listDir(owner, repo, path, await head()),
    searchCode: (query, limit) => client.searchCode(owner, repo, query, limit),
    searchScope: "the repository's default branch (not this pull request's head)",
  };
}

export function azurePrSource(client: AzureDevOpsClient, ref: PrRef): PrCodeSource {
  if (ref.provider !== "azure") throw new Error("expected an azure ref");
  const azRef = { project: ref.project, repo: ref.repo, prId: ref.prId };
  const detail = memoize(() => client.prDetail(azRef));
  const head = async () => (await detail()).headSha;

  return {
    ref,
    detail,
    files: () => client.prFiles(azRef),
    fileDiff: (path) => client.prFileDiff(azRef, path),
    readFile: async (path) => client.fileContent(azRef, path, await head()),
    listDir: async (path) => client.listDir(azRef, path, await head()),
    searchCode: async (query, limit) => client.searchCode(azRef, query, limit),
    searchScope: "the repository, via Azure DevOps code search",
  };
}
