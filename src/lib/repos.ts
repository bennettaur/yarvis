import { sidecarFetch } from "./api";
import type { PrRef } from "./pr/types";

// Mirrors the sidecar's MAX_PLAYBOOK_CHARS, PLAYBOOK_KEYS and RepoPlaybooks.
export const PLAYBOOK_MAX_CHARS = 4000;

/** The prompts a repo can carry for shipping a PR, in the order Settings shows them. */
export const PLAYBOOK_FIELDS = [
  {
    key: "ci",
    label: "CI",
    hint: "How to handle failing or flaky checks.",
  },
  {
    key: "pickReviewer",
    label: "Pick a reviewer",
    hint: "Who should review a PR here, and how to choose.",
  },
  {
    key: "feedback",
    label: "Review feedback",
    hint: "How to handle review comments and change requests.",
  },
  {
    key: "reviewBeforeMerge",
    label: "Review before merge",
    hint: "What must be true of the review before merging: approvals, checks, sign-offs.",
  },
  {
    key: "testStaging",
    label: "Test in staging",
    hint: "How to check a change once it is on staging.",
  },
  {
    key: "merge",
    label: "Merge",
    hint: "How to merge, e.g. squash or a merge queue. The merge rules still apply.",
  },
  { key: "deploy", label: "Deploy", hint: "The manual steps to deploy, if it isn't automatic." },
  {
    key: "monitorDeploy",
    label: "Monitor the deploy",
    hint: "What to watch while a deploy rolls out.",
  },
  {
    key: "monitorProduction",
    label: "Monitor production",
    hint: "What to watch in production after a deploy.",
  },
  {
    key: "testProduction",
    label: "Test in production",
    hint: "How to check a change is working in production.",
  },
  { key: "revert", label: "Revert", hint: "How to back a change out when it goes wrong." },
] as const;

export type PlaybookKey = (typeof PLAYBOOK_FIELDS)[number]["key"];

/** Only prompts with text are present. */
export type RepoPlaybooks = Partial<Record<PlaybookKey, string>>;

/** A repo yarvis manages a primary clone + worktrees for. */
export interface Repo {
  id: string;
  name: string;
  owner: string;
  repo: string;
  cloneUrl: string;
  defaultBranch: string | null;
  primaryClonePath: string;
  setupScript: string | null;
  runScript: string | null;
  pullIssues: boolean;
  /** Where the repo's tickets are filed; mirrors the sidecar's `RepoTracker`. */
  tracker: RepoTracker | null;
  playbooks: RepoPlaybooks;
  createdAt: string;
  updatedAt: string;
}

export type RepoTracker =
  | { provider: "github" }
  | { provider: "azure-boards"; project: string; areaPath?: string }
  | { provider: "jira"; projectKey: string };

export interface CreateRepoInput {
  cloneUrl: string;
  name?: string;
  setupScript?: string | null;
  runScript?: string | null;
  pullIssues?: boolean;
  tracker?: RepoTracker | null;
  playbooks?: RepoPlaybooks;
}

export interface UpdateRepoInput {
  name?: string;
  cloneUrl?: string;
  setupScript?: string | null;
  runScript?: string | null;
  pullIssues?: boolean;
  tracker?: RepoTracker | null;
  playbooks?: RepoPlaybooks;
}

/**
 * A clone URL classified by provider — mirrors the sidecar's `parseRepoRemote`.
 * The workspace PR cache stores only a PR number, so the UI parses the repo's
 * clone URL to know whether to build a GitHub or Azure DevOps `PrRef`.
 */
export type RepoRemote =
  | { provider: "github"; owner: string; repo: string }
  | { provider: "azure"; org: string; project: string; repo: string };

// Legacy org lives in the subdomain (`{org}.visualstudio.com`), so bare
// `visualstudio.com` is not a real remote host and is intentionally excluded.
function isAzureHost(host: string): boolean {
  return (
    host === "dev.azure.com" ||
    host === "ssh.dev.azure.com" ||
    host === "vs-ssh.visualstudio.com" ||
    host.endsWith(".visualstudio.com")
  );
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// A decoded `.`, `..`, or slash would escape its place in the API paths built from it.
function isUnsafeSegment(segment: string): boolean {
  return segment === "." || segment === ".." || /[/\\]/.test(segment);
}

function splitRemote(url: string): { host: string; segments: string[] } | null {
  const trimmed = url.trim().replace(/\.git$/, "");
  const scp = trimmed.match(/^[^/]+@([^/:]+):(.+)$/);
  let host = "";
  let path = "";
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const u = new URL(trimmed);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  if (!host) return null;
  const segments = path.split("/").filter(Boolean).map(decodeSegment);
  if (segments.some(isUnsafeSegment)) return null;
  return { host, segments };
}

/**
 * Classifies a clone URL as GitHub {owner, repo} or Azure DevOps
 * {org, project, repo}. Handles Azure's modern HTTPS (`dev.azure.com/{org}/
 * {project}/_git/{repo}`), SSH (`v3/{org}/{project}/{repo}`), and legacy
 * `{org}.visualstudio.com` forms; any other host falls back to GitHub.
 */
export function parseRepoRemote(url: string): RepoRemote | null {
  const parts = splitRemote(url);
  if (!parts) return null;
  const { host, segments } = parts;

  if (isAzureHost(host)) {
    if (segments[0] === "v3" && segments.length >= 4) {
      return { provider: "azure", org: segments[1]!, project: segments[2]!, repo: segments[3]! };
    }
    const gitIdx = segments.indexOf("_git");
    if (gitIdx >= 1 && segments.length > gitIdx + 1) {
      const org = host.endsWith(".visualstudio.com") ? host.split(".")[0]! : segments[0]!;
      return {
        provider: "azure",
        org,
        project: segments[gitIdx - 1]!,
        repo: segments[gitIdx + 1]!,
      };
    }
    return null;
  }

  const match = url
    .trim()
    .replace(/\.git$/, "")
    .match(/[:/]([^/:]+)\/([^/]+)$/);
  return match ? { provider: "github", owner: match[1]!, repo: match[2]! } : null;
}

/**
 * Builds the {@link PrRef} for a workspace repo's cached PR. The provider comes
 * from the clone URL; an Azure clone yields an Azure ref, everything else a
 * GitHub ref keyed by the repo's stored owner/repo. `prNumber` is the PR number
 * for GitHub and the pull-request id for Azure.
 */
export function repoPrRef(repo: Repo, prNumber: number): PrRef {
  const remote = parseRepoRemote(repo.cloneUrl);
  if (remote?.provider === "azure") {
    return {
      provider: "azure",
      org: remote.org,
      project: remote.project,
      repo: remote.repo,
      prId: prNumber,
    };
  }
  return { provider: "github", owner: repo.owner, repo: repo.repo, number: prNumber };
}

async function readError(res: Response, action: string): Promise<never> {
  const body = await res.json().catch(() => null);
  const detail = body && typeof body === "object" && "error" in body ? body.error : res.status;
  throw new Error(
    `${action} failed: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`,
  );
}

export async function listRepos(): Promise<Repo[]> {
  const res = await sidecarFetch("/api/repos");
  if (!res.ok) return readError(res, "list repos");
  return res.json();
}

export async function createRepo(input: CreateRepoInput): Promise<Repo> {
  const res = await sidecarFetch("/api/repos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) return readError(res, "create repo");
  return res.json();
}

export async function updateRepo(id: string, patch: UpdateRepoInput): Promise<Repo> {
  const res = await sidecarFetch(`/api/repos/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return readError(res, "update repo");
  return res.json();
}

export async function deleteRepo(id: string): Promise<void> {
  const res = await sidecarFetch(`/api/repos/${id}`, { method: "DELETE" });
  if (!res.ok) return readError(res, "delete repo");
}

/** The repo's remote branch names, for creating a workspace on an existing branch. */
export async function listRepoBranches(id: string): Promise<string[]> {
  const res = await sidecarFetch(`/api/repos/${id}/branches`);
  if (!res.ok) return readError(res, "list branches");
  return res.json();
}
