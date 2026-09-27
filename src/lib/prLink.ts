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

  // A malformed `%` escape (not necessarily on a PR link — any link in an
  // assistant reply runs through this) throws in decodeURIComponent, so a
  // segment that doesn't decode is treated as unrecognized rather than
  // crashing the render.
  let parts: string[];
  try {
    parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }

  if (url.hostname === "github.com") {
    const [owner, repo, kind, num] = parts;
    if (kind !== "pull" || !owner || !repo) return null;
    const number = positiveInt(num);
    if (number === null) return null;
    return toSummary({ provider: "github", owner, repo, number }, href, title);
  }

  // dev.azure.com carries the org as a path segment; a legacy account instead
  // carries it in the `{org}.visualstudio.com` subdomain (see
  // sidecar/src/azure/client.ts's orgFromOrgUrl) — both are real URLs Azure
  // still hands out today.
  if (url.hostname === "dev.azure.com") {
    // /{org}/{project}/_git/{repo}/pullrequest/{id}
    const [org, project, git, repo, kind, id] = parts;
    if (!org || !project || git !== "_git" || !repo || kind !== "pullrequest") return null;
    const prId = positiveInt(id);
    if (prId === null) return null;
    return toSummary({ provider: "azure", org, project, repo, prId }, href, title);
  }

  if (url.hostname.endsWith(".visualstudio.com")) {
    // /{project}/_git/{repo}/pullrequest/{id}
    const org = url.hostname.split(".")[0] ?? "";
    const [project, git, repo, kind, id] = parts;
    if (!org || !project || git !== "_git" || !repo || kind !== "pullrequest") return null;
    const prId = positiveInt(id);
    if (prId === null) return null;
    return toSummary({ provider: "azure", org, project, repo, prId }, href, title);
  }

  return null;
}

/** A PR/id segment as a positive integer, or null for anything else — a
 * hallucinated `pull/0` or `pull/-1` is not a PR reference worth opening. */
function positiveInt(segment: string | undefined): number | null {
  if (!segment || !/^\d+$/.test(segment)) return null;
  const n = Number(segment);
  return n > 0 ? n : null;
}

function toSummary(ref: PrSummary["ref"], url: string, title: string): PrSummary {
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
