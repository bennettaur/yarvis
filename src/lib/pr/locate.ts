import type { PrRef } from "./types";

/**
 * Turns whatever the user has on their clipboard into a {@link PrRef}. PRs get
 * shared in chat as a link or as "repo #123", so the jump-to-PR box accepts both
 * rather than making the user hunt through a list for something they can already
 * name.
 *
 * Recognized forms:
 * - `https://github.com/owner/repo/pull/123` (any trailing path, query or hash)
 * - `owner/repo#123`, `owner/repo 123`, `owner/repo/123`
 * - `repo#123` / `repo 123`, resolved against the registered repos
 *
 * A bare number is deliberately not accepted: there is no repo to attach it to.
 * GitHub only — the Azure DevOps side of the dashboard has no equivalent
 * single-PR lookup wired up.
 */

/** A registered repo's identity, enough to resolve a bare repo name. */
export interface KnownRepo {
  owner: string;
  repo: string;
}

// Same character classes the sidecar's route validation enforces, so a locator
// can't produce a ref the API would reject.
const OWNER = "[A-Za-z0-9][A-Za-z0-9-]{0,38}";
const REPO = "[A-Za-z0-9._-]{1,100}";

const GITHUB_URL = new RegExp(
  `^(?:https?://)?(?:www\\.)?github\\.com/(${OWNER})/(${REPO})/pull/(\\d+)`,
  "i",
);
const OWNER_REPO_NUMBER = new RegExp(`^(${OWNER})/(${REPO})(?:/|#|\\s+)#?(\\d+)$`);
const REPO_NUMBER = new RegExp(`^(${REPO})(?:#|\\s+)#?(\\d+)$`);

function githubRef(owner: string, repo: string, number: string | number): PrRef {
  return { provider: "github", owner, repo, number: Number(number) };
}

/**
 * Resolves one locator input to the PRs it could mean. Empty means nothing was
 * recognized; more than one means a bare repo name matched several registered
 * owners, and the caller should make the user choose.
 *
 * `knownRepos` only matters for the bare-repo-name form — every other form
 * carries its own owner.
 */
export function resolvePrLocator(input: string, knownRepos: KnownRepo[] = []): PrRef[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const url = trimmed.match(GITHUB_URL);
  if (url) return [githubRef(url[1]!, url[2]!, url[3]!)];

  const qualified = trimmed.match(OWNER_REPO_NUMBER);
  if (qualified) return [githubRef(qualified[1]!, qualified[2]!, qualified[3]!)];

  const bare = trimmed.match(REPO_NUMBER);
  if (bare) {
    const name = bare[1]!.toLowerCase();
    return knownRepos
      .filter((r) => r.repo.toLowerCase() === name)
      .map((r) => githubRef(r.owner, r.repo, bare[2]!));
  }

  return [];
}
