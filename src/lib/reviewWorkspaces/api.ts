import { ensureOk, sidecarFetch, streamSSE } from "../api";
import type { PrRef } from "../pr/types";

/** Typed client for the sidecar's `/api/review-workspaces` routes. */

const BASE = "/api/review-workspaces";

export type ReviewWorkspaceStatus = "active" | "archiving" | "archived";
export type ReviewPrStatus = "pending" | "cloning" | "ready" | "error";
export type SetupConsent = "granted" | "declined";
export type SetupStatus = "running" | "succeeded" | "failed" | "skipped";

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
  /** Why the last clone or refresh failed. A failed refresh stays `ready`. */
  error: string | null;
  worktreePath: string;
  headSha: string | null;
  baseSha: string | null;
  mergeBaseSha: string | null;
  setupConsent: SetupConsent | null;
  setupStatus: SetupStatus | null;
  setupLog: string | null;
  addedAt: string;
}

export interface ReviewWorkspace {
  id: string;
  name: string;
  status: ReviewWorkspaceStatus;
  /** What an archive left behind, if anything. */
  error: string | null;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  prs: ReviewWorkspacePr[];
}

export interface ReviewChangedFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface ReviewFileContent {
  content: string;
  binary: boolean;
  tooLarge: boolean;
  size: number;
}

export interface ReviewFileDiff {
  path: string;
  oldPath?: string;
  patch: string;
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
  | { type: "start"; phase: "clone" | "refresh" | "setup" }
  | { type: "log"; text: string }
  | {
      type: "done";
      phase: "clone" | "refresh" | "setup";
      status: string;
      error: string | null;
    };

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

const pr = (workspaceId: string, prId: string) => `${BASE}/${workspaceId}/prs/${prId}`;

export function listReviewWorkspaces(opts: { archived?: boolean } = {}) {
  return json<ReviewWorkspace[]>(
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
  await json(pr(workspaceId, prId), "remove pull request", send("DELETE"));
}

/** Fetches the PR's latest head and moves its checkout there, in the background. */
export function refreshReviewPr(workspaceId: string, prId: string) {
  return json<ReviewWorkspacePr>(
    `${pr(workspaceId, prId)}/refresh`,
    "refresh pull request",
    send("POST"),
  );
}

/**
 * Replays the PR's latest clone/refresh/setup run and yields the rest of it.
 * Ends at once when nothing has run since the sidecar started.
 */
export async function* followReviewPrProgress(
  workspaceId: string,
  prId: string,
): AsyncGenerator<ReviewProgressEvent> {
  for await (const data of streamSSE(`${pr(workspaceId, prId)}/progress`)) {
    yield JSON.parse(data) as ReviewProgressEvent;
  }
}

export function reviewChangedFiles(workspaceId: string, prId: string) {
  return json<ReviewChangedFile[]>(`${pr(workspaceId, prId)}/changed-files`, "list changed files");
}

/** Every path in the tree at the PR's head. */
export function reviewTree(workspaceId: string, prId: string) {
  return json<string[]>(`${pr(workspaceId, prId)}/tree`, "list files");
}

/** A file at the PR's head, or at the merge-base for `base`. */
export function reviewFile(workspaceId: string, prId: string, path: string, side: "base" | "head") {
  const query = new URLSearchParams({ path, side });
  return json<ReviewFileContent>(`${pr(workspaceId, prId)}/file?${query}`, "read file");
}

export function reviewFileDiff(workspaceId: string, prId: string, path: string, oldPath?: string) {
  const query = new URLSearchParams({ path, ...(oldPath ? { oldPath } : {}) });
  return json<ReviewFileDiff>(`${pr(workspaceId, prId)}/diff?${query}`, "read diff");
}

export function reviewSetupInfo(workspaceId: string, prId: string) {
  return json<ReviewSetupInfo>(`${pr(workspaceId, prId)}/setup`, "read setup");
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
    `${pr(workspaceId, prId)}/setup`,
    "answer setup",
    send("POST", answer),
  );
}
