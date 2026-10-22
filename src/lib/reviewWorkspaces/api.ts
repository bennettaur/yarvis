import { ensureOk, sidecarFetch, streamSSE } from "../api";
import type { PrRef } from "../pr/types";

/** Typed client for the sidecar's `/api/review-workspaces` routes. */

const BASE = "/api/review-workspaces";

export type ReviewWorkspaceStatus = "active" | "archiving" | "archived";
/** `ready` once the PR's commits are fetched: every review read works from then on. */
export type ReviewPrStatus = "pending" | "cloning" | "ready" | "error";
/** The checkout on disk, which only setup and code navigation wait for. */
export type ReviewWorktreeStatus = "pending" | "checking-out" | "ready" | "error";
export type SetupConsent = "granted" | "declined";
export type SetupStatus = "running" | "succeeded" | "failed" | "skipped";
export type ReviewRunPhase = "clone" | "refresh" | "setup";

export interface ReviewWorkspacePr {
  id: string;
  workspaceId: string;
  refKey: string;
  ref: PrRef;
  title: string;
  author: string | null;
  headRef: string | null;
  baseRef: string | null;
  /** Stable per workspace: the lowest index unused when the PR was added. */
  colorIndex: number;
  position: number;
  status: ReviewPrStatus;
  /** Why the last clone, refresh or checkout failed. A failed refresh stays `ready`. */
  error: string | null;
  worktreePath: string;
  worktreeStatus: ReviewWorktreeStatus;
  headSha: string | null;
  baseSha: string | null;
  mergeBaseSha: string | null;
  setupConsent: SetupConsent | null;
  setupStatus: SetupStatus | null;
  setupLog: string | null;
  addedAt: string;
}

interface ReviewWorkspaceFields {
  id: string;
  name: string;
  status: ReviewWorkspaceStatus;
  /** What an archive left behind, if anything. */
  error: string | null;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
}

export interface ReviewWorkspace extends ReviewWorkspaceFields {
  prs: ReviewWorkspacePr[];
}

/** A workspace as the list shows it: its PRs without their setup logs. */
export interface ReviewWorkspaceSummary extends ReviewWorkspaceFields {
  prs: Omit<ReviewWorkspacePr, "setupLog">[];
}

/** The commits a read answered from; a cache keyed by them never goes stale. */
export interface ReadShas {
  headSha: string;
  mergeBaseSha: string;
}

export interface ReviewChangedFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface ReviewChangedFiles extends ReadShas {
  files: ReviewChangedFile[];
}

export interface ReviewTree {
  headSha: string;
  paths: string[];
}

export interface ReviewFileContent {
  content: string;
  binary: boolean;
  tooLarge: boolean;
  size: number;
  /** The commit it was read from. */
  sha: string;
}

export interface ReviewFileDiff extends ReadShas {
  path: string;
  /** Where a renamed file came from. */
  oldPath?: string;
  patch: string;
  /** Either side is over the size cap, so `patch` is empty. */
  tooLarge: boolean;
}

export interface ReviewSetupInfo {
  /** The registered repo's setup script, exactly as it would run; null when none. */
  script: string | null;
  author: string | null;
  branch: string | null;
  consent: SetupConsent | null;
  status: SetupStatus | null;
  log: string | null;
}

export type ReviewProgressEvent =
  | { type: "start"; phase: ReviewRunPhase }
  | { type: "log"; text: string }
  | { type: "done"; phase: ReviewRunPhase; status: string; error: string | null };

async function json<T>(path: string, context: string, init?: RequestInit): Promise<T> {
  const res = await sidecarFetch(path, init);
  await ensureOk(res, context);
  return res.json() as Promise<T>;
}

function send(method: string, body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

const prPath = (workspaceId: string, prId: string) => `${BASE}/${workspaceId}/prs/${prId}`;

export function listReviewWorkspaces(opts: { archived?: boolean } = {}) {
  return json<ReviewWorkspaceSummary[]>(
    opts.archived ? `${BASE}?archived=true` : BASE,
    "list review workspaces",
  );
}

export function getReviewWorkspace(id: string) {
  return json<ReviewWorkspace>(`${BASE}/${id}`, "get review workspace");
}

export function createReviewWorkspace(input: { name: string; refs?: PrRef[] }) {
  return json<ReviewWorkspace>(BASE, "create review workspace", send("POST", input));
}

export function renameReviewWorkspace(id: string, name: string) {
  return json<ReviewWorkspace>(`${BASE}/${id}`, "rename review workspace", send("PATCH", { name }));
}

/** Records the open, which orders the workspace list. */
export function openReviewWorkspace(id: string) {
  return json<ReviewWorkspace>(`${BASE}/${id}/open`, "open review workspace", send("POST"));
}

/** Answers with the workspace `archiving`; it reads `archived` once worktrees are gone. */
export function archiveReviewWorkspace(id: string) {
  return json<ReviewWorkspace>(`${BASE}/${id}/archive`, "archive review workspace", send("POST"));
}

/** Adds a PR and starts cloning it; follow {@link followReviewPrProgress}. */
export function addReviewPr(workspaceId: string, ref: PrRef) {
  return json<ReviewWorkspacePr>(
    `${BASE}/${workspaceId}/prs`,
    "add pull request",
    send("POST", { ref }),
  );
}

export async function removeReviewPr(workspaceId: string, prId: string): Promise<void> {
  await json(prPath(workspaceId, prId), "remove pull request", send("DELETE"));
}

/** Fetches the PR's latest head and moves its checkout there, in the background. */
export function refreshReviewPr(workspaceId: string, prId: string) {
  return json<ReviewWorkspacePr>(
    `${prPath(workspaceId, prId)}/refresh`,
    "refresh pull request",
    send("POST"),
  );
}

/**
 * Replays the PR's latest clone/refresh/setup run and yields the rest of it.
 * Ends at once when there is no recent run to show.
 */
export async function* followReviewPrProgress(
  workspaceId: string,
  prId: string,
): AsyncGenerator<ReviewProgressEvent> {
  for await (const data of streamSSE(`${prPath(workspaceId, prId)}/progress`)) {
    yield JSON.parse(data) as ReviewProgressEvent;
  }
}

export function reviewChangedFiles(workspaceId: string, prId: string) {
  return json<ReviewChangedFiles>(
    `${prPath(workspaceId, prId)}/changed-files`,
    "list changed files",
  );
}

/** Every path in the tree at the PR's head. */
export function reviewTree(workspaceId: string, prId: string) {
  return json<ReviewTree>(`${prPath(workspaceId, prId)}/tree`, "list files");
}

/** A file at the PR's head, or at the merge-base for `base`. */
export function reviewFile(workspaceId: string, prId: string, path: string, side: "base" | "head") {
  const query = new URLSearchParams({ path, side });
  return json<ReviewFileContent>(`${prPath(workspaceId, prId)}/file?${query}`, "read file");
}

/** The patch for one file the PR changes; a rename's old path comes back with it. */
export function reviewFileDiff(workspaceId: string, prId: string, path: string) {
  const query = new URLSearchParams({ path });
  return json<ReviewFileDiff>(`${prPath(workspaceId, prId)}/diff?${query}`, "read diff");
}

export function reviewSetupInfo(workspaceId: string, prId: string) {
  return json<ReviewSetupInfo>(`${prPath(workspaceId, prId)}/setup`, "read setup");
}

/**
 * Answers the setup prompt. `script` must be the script the user was shown: a
 * script changed since is refused (409) rather than run. Output streams on
 * {@link followReviewPrProgress}.
 */
export function answerReviewSetup(
  workspaceId: string,
  prId: string,
  answer: { grant: boolean; script: string | null },
) {
  return json<ReviewWorkspacePr>(
    `${prPath(workspaceId, prId)}/setup`,
    "answer setup",
    send("POST", answer),
  );
}
