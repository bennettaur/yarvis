/** Reading the text GitHub writes when a PR or commit is reverted. */

const REVERT_COMMIT = /This reverts commit ([0-9a-f]{7,40})/i;

/** The sha a revert commit's message names, or null for any other commit. */
export function revertedShaOf(message: string): string | null {
  return REVERT_COMMIT.exec(message)?.[1] ?? null;
}

/**
 * The PR number a revert PR undoes. GitHub's revert button writes
 * `Reverts owner/repo#N` in the body; a hand-written one may say `#N` alone.
 * A reference into another repo is not this repo's PR, so it gives null.
 */
export function revertedPrNumber(
  pr: { title: string; body: string },
  owner: string,
  repo: string,
): number | null {
  if (!pr.title.startsWith("Revert")) return null;
  const named = /\bReverts?\s+(?:([\w.-]+)\/([\w.-]+))?#(\d+)/i.exec(pr.body);
  if (named) {
    const [, o, r, n] = named;
    if (
      o &&
      r &&
      (o.toLowerCase() !== owner.toLowerCase() || r.toLowerCase() !== repo.toLowerCase())
    ) {
      return null;
    }
    return Number(n);
  }
  // The title first: GitHub puts the PR number there, while a body may name unrelated issues.
  const loose = /(?:^|[^\w/])#(\d+)\b/.exec(`${pr.title}\n${pr.body}`);
  return loose ? Number(loose[1]) : null;
}
