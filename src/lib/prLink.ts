import type { PrSummary } from "./pr/types";

/**
 * Reads a GitHub or Azure DevOps pull request URL into the summary the PRs tab
 * opens on. Returns null for anything else, so the caller falls back to the
 * browser. Only identity is known from a URL; the detail view loads the rest.
 */
export function parsePrLink(href: string | undefined, title = ""): PrSummary | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (url.hostname === "github.com") {
    const [owner, repo, kind, num] = parts;
    const number = Number(num);
    if (kind !== "pull" || !owner || !repo || !Number.isInteger(number)) return null;
    return summary({ provider: "github", owner, repo, number }, href, title);
  }

  if (url.hostname === "dev.azure.com") {
    // /{org}/{project}/_git/{repo}/pullrequest/{id}
    const [org, project, git, repo, kind, id] = parts;
    const prId = Number(id);
    if (git !== "_git" || kind !== "pullrequest" || !org || !project || !repo) return null;
    if (!Number.isInteger(prId)) return null;
    return summary({ provider: "azure", org, project, repo, prId }, href, title);
  }

  return null;
}

function summary(ref: PrSummary["ref"], url: string, title: string): PrSummary {
  return {
    ref,
    title,
    url,
    author: "",
    draft: false,
    state: "open",
    createdAt: "",
    updatedAt: "",
  };
}
