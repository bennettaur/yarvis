import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import { AzureDevOpsClient } from "../azure/client.ts";
import { getDb } from "../db/client.ts";
import { repos, workspaceRepoPr, workspaceRepos, workspaces } from "../db/schema.ts";
import { GitHubClient } from "../github/client.ts";
import {
  dueRefresh,
  isDueForRefresh,
  markWorkspaceListViewed,
  markWorkspaceViewed,
  pollDueRepos,
  pollOnce,
  reconcileOrphans,
  refreshWorkspacePrs,
  resetWorkspaceViews,
} from "./poller.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;

/**
 * Builds a GitHubClient whose fetch returns canned payloads keyed by URL. A
 * handler may return `{ __status: <code> }` to simulate an error response.
 * GraphQL gets the same `{}`, which reads as GraphQL being unable to answer,
 * so `pollOnce` tests built on this run the per-repo reads the poller falls
 * back to for branches.
 */
function clientWith(handlers: (path: string) => unknown): GitHubClient {
  const fetchImpl = (async (input: string | URL | Request) => {
    const u = typeof input === "string" ? input : input.toString();
    const body = handlers(u) as { __status?: number };
    const status = body && typeof body === "object" && body.__status ? body.__status : 200;
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return new GitHubClient("test-token", fetchImpl);
}

/** Builds an AzureDevOpsClient whose fetch returns canned payloads keyed by URL,
 *  mirroring `clientWith`, `__status` included. Defaults to org `acme` on
 *  dev.azure.com. */
function azureClientWith(
  handlers: (url: string) => unknown,
  orgUrl = "https://dev.azure.com/acme",
): AzureDevOpsClient {
  const fetchImpl = (async (input: string | URL | Request) => {
    const u = typeof input === "string" ? input : input.toString();
    const body = handlers(u) as { __status?: number };
    const status = body && typeof body === "object" && body.__status ? body.__status : 200;
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return new AzureDevOpsClient("test-token", orgUrl, fetchImpl);
}

/** Seeds one active workspace with one ready repo `r<suffix>` on `yarvis/<suffix>`.
 *  `cloneUrl` defaults to a GitHub remote; pass an Azure URL to exercise routing. */
async function seedReadyRepo(
  suffix = "x",
  cloneUrl = `git@github.com:o${suffix}/r${suffix}.git`,
): Promise<string> {
  const [repo] = await db
    .insert(repos)
    .values({
      name: `r${suffix}`,
      owner: `o${suffix}`,
      repo: `r${suffix}`,
      cloneUrl,
      primaryClonePath: `/tmp/primary-${suffix}`,
    })
    .returning();
  const [ws] = await db
    .insert(workspaces)
    .values({ name: suffix, slug: suffix, rootPath: `/tmp/${suffix}`, status: "active" })
    .returning();
  const [wr] = await db
    .insert(workspaceRepos)
    .values({
      workspaceId: ws!.id,
      repoId: repo!.id,
      branch: `yarvis/${suffix}`,
      baseBranch: "main",
      worktreePath: `/tmp/${suffix}/r${suffix}`,
      status: "ready",
    })
    .returning();
  return wr!.id;
}

beforeEach(async () => {
  await sql`TRUNCATE repos, workspaces, workspace_repos, workspace_repo_pr, tasks RESTART IDENTITY CASCADE`;
  resetWorkspaceViews();
});

afterAll(async () => {
  await sql.end();
});

/** A pulls-list item as returned by `GET /repos/:o/:r/pulls?head=`. */
function pullItem(number: number, state: string) {
  return {
    number,
    title: "t",
    html_url: `https://github.com/acme/widget/pull/${number}`,
    user: { login: "me" },
    draft: false,
    state,
    created_at: "2026-01-01",
    updated_at: "2026-01-02",
  };
}

const CHECKS = (runs: { status: string; conclusion: string }[]) => ({ check_runs: runs });

/** A `GET /pulls/:n/reviews` payload; the poller asks for it on every open PR.
 *  Reviewers are project members, since only their verdicts count. */
const REVIEWS = (states: string[] = []) =>
  states.map((state, i) => ({ state, user: { login: `r${i}` }, author_association: "MEMBER" }));

describe("pollOnce", () => {
  it("caches the PR + failing-check rollup for a ready repo", async () => {
    const wrId = await seedReadyRepo();
    const gh = clientWith((path) => {
      if (path.includes("head=")) return [pullItem(7, "open")];
      if (path.includes("/reviews")) return REVIEWS();
      if (path.includes("/pulls/7")) {
        return {
          state: "open",
          merged: false,
          mergeable: true,
          mergeable_state: "clean",
          head: { sha: "abc" },
        };
      }
      if (path.includes("/check-runs")) {
        return CHECKS([
          { status: "completed", conclusion: "success" },
          { status: "completed", conclusion: "failure" },
        ]);
      }
      return {};
    });

    await pollOnce(db, { github: gh });

    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.prNumber).toBe(7);
    expect(row?.prState).toBe("open");
    expect(row?.checkRollup).toBe("failure");
    expect(row?.checks).toEqual({ total: 2, success: 1, failure: 1, pending: 0 });
    expect(row?.lastError).toBeNull();
  });

  it("counts CI reported only through commit statuses", async () => {
    const wrId = await seedReadyRepo();
    const gh = clientWith((path) => {
      if (path.includes("head=")) return [pullItem(7, "open")];
      if (path.includes("/reviews")) return REVIEWS();
      if (path.includes("/pulls/7")) return { state: "open", merged: false, head: { sha: "abc" } };
      if (path.includes("/check-runs")) return CHECKS([]);
      if (path.includes("/commits/abc/status")) {
        return { statuses: [{ context: "ci/jenkins", state: "failure" }] };
      }
      return {};
    });

    await pollOnce(db, { github: gh });
    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.checkRollup).toBe("failure");
    expect(row?.checks).toEqual({ total: 1, success: 0, failure: 1, pending: 0 });
  });

  it("derives a pending rollup when checks are still running", async () => {
    const wrId = await seedReadyRepo();
    const gh = clientWith((path) => {
      if (path.includes("head=")) return [pullItem(7, "open")];
      if (path.includes("/reviews")) return REVIEWS();
      if (path.includes("/pulls/7")) return { state: "open", merged: false, head: { sha: "abc" } };
      if (path.includes("/check-runs")) {
        return CHECKS([
          { status: "completed", conclusion: "success" },
          { status: "in_progress", conclusion: "" },
        ]);
      }
      return {};
    });

    await pollOnce(db, { github: gh });
    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.checkRollup).toBe("pending");
  });

  // The behavior under test: a follow-up push that retriggers a failing check
  // restarts it as `in_progress`; the rollup must report `pending` (work not
  // finalized) rather than the stale `failure` from before the push. The
  // failing count is still preserved on the row so the UI can surface "1
  // failing · N running" alongside the rollup.
  it("derives pending — not failure — when both failing and running checks coexist", async () => {
    const wrId = await seedReadyRepo();
    const gh = clientWith((path) => {
      if (path.includes("head=")) return [pullItem(7, "open")];
      if (path.includes("/reviews")) return REVIEWS();
      if (path.includes("/pulls/7")) return { state: "open", merged: false, head: { sha: "abc" } };
      if (path.includes("/check-runs")) {
        return CHECKS([
          { status: "completed", conclusion: "success" },
          { status: "completed", conclusion: "failure" },
          { status: "in_progress", conclusion: "" },
        ]);
      }
      return {};
    });

    await pollOnce(db, { github: gh });
    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.checkRollup).toBe("pending");
    expect(row?.checks).toEqual({ total: 3, success: 1, failure: 1, pending: 1 });
  });

  it("records a no-PR state when no PR exists for the branch", async () => {
    const wrId = await seedReadyRepo();
    const gh = clientWith((path) => (path.includes("head=") ? [] : {}));

    await pollOnce(db, { github: gh });

    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.prNumber).toBeNull();
    expect(row?.checkRollup).toBe("none");
    expect(row?.lastPolledAt).not.toBeNull();
  });

  it("marks a merged PR's state as merged", async () => {
    const wrId = await seedReadyRepo();
    let askedForReviews = false;
    const gh = clientWith((path) => {
      if (path.includes("head=")) return [pullItem(9, "closed")];
      if (path.includes("/reviews")) {
        askedForReviews = true;
        return REVIEWS(["APPROVED"]);
      }
      if (path.includes("/pulls/9")) {
        return {
          state: "closed",
          merged: true,
          mergeable: null,
          mergeable_state: "clean",
          head: { sha: "z" },
        };
      }
      if (path.includes("/check-runs")) return CHECKS([]);
      return {};
    });

    await pollOnce(db, { github: gh });
    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(askedForReviews).toBe(false); // nothing is waiting on review any more
    expect(row?.reviewDecision).toBeNull();
    expect(row?.prState).toBe("merged");
    expect(row?.checkRollup).toBe("none");
  });

  it("caches the reviewers' verdict on an open PR", async () => {
    const wrId = await seedReadyRepo();
    const gh = clientWith((path) => {
      if (path.includes("head=")) return [pullItem(7, "open")];
      if (path.includes("/reviews")) return REVIEWS(["APPROVED", "COMMENTED"]);
      if (path.includes("/pulls/7")) return { state: "open", merged: false, head: { sha: "abc" } };
      if (path.includes("/check-runs")) return CHECKS([]);
      return {};
    });

    await pollOnce(db, { github: gh });

    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.reviewDecision).toBe("approved");
  });

  it("leaves the verdict unknown on a draft PR rather than asking for it", async () => {
    const wrId = await seedReadyRepo();
    let askedForReviews = false;
    const gh = clientWith((path) => {
      if (path.includes("head=")) return [{ ...pullItem(7, "open"), draft: true }];
      if (path.includes("/reviews")) {
        askedForReviews = true;
        return REVIEWS(["APPROVED"]);
      }
      if (path.includes("/pulls/7")) return { state: "open", merged: false, head: { sha: "abc" } };
      if (path.includes("/check-runs")) return CHECKS([]);
      return {};
    });

    await pollOnce(db, { github: gh });

    expect(askedForReviews).toBe(false);
    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.reviewDecision).toBeNull();
  });

  it("clears a cached verdict when the PR it belonged to is gone", async () => {
    const wrId = await seedReadyRepo();
    await db
      .insert(workspaceRepoPr)
      .values({ workspaceRepoId: wrId, prNumber: 4, prState: "open", reviewDecision: "approved" });
    const gh = clientWith((path) => (path.includes("head=") ? [] : {}));

    await pollOnce(db, { github: gh });

    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.prNumber).toBeNull();
    expect(row?.reviewDecision).toBeNull();
  });

  it("keeps polling the rest of a repo when the verdict can't be read", async () => {
    // A token without pull-request read on this repo 403s the reviews call. The
    // check rollup is the part the user is watching, so it must still land.
    const wrId = await seedReadyRepo();
    const gh = clientWith((path) => {
      if (path.includes("head=")) return [pullItem(7, "open")];
      if (path.includes("/reviews")) return { __status: 403 };
      if (path.includes("/pulls/7")) return { state: "open", merged: false, head: { sha: "abc" } };
      if (path.includes("/check-runs"))
        return CHECKS([{ status: "completed", conclusion: "failure" }]);
      return {};
    });

    await pollOnce(db, { github: gh });

    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.checkRollup).toBe("failure");
    expect(row?.reviewDecision).toBeNull();
    expect(row?.lastError).toBeNull();
  });

  it("records a per-repo error and keeps polling the rest of the cycle", async () => {
    const a = await seedReadyRepo("a");
    const b = await seedReadyRepo("b");
    // Repo a's lookup 500s; repo b succeeds. The cycle must finish both.
    const gh = clientWith((path) => {
      if (path.includes("/ra/") && path.includes("head=")) return { __status: 500 };
      if (path.includes("head=")) return [pullItem(3, "open")];
      if (path.includes("/reviews")) return REVIEWS();
      if (path.includes("/pulls/3")) return { state: "open", merged: false, head: { sha: "s" } };
      if (path.includes("/check-runs")) return CHECKS([]);
      return {};
    });

    await pollOnce(db, { github: gh });

    const [rowA] = await db.select().from(workspaceRepoPr).where(eqWr(a));
    const [rowB] = await db.select().from(workspaceRepoPr).where(eqWr(b));
    expect(rowA?.lastError).not.toBeNull();
    expect(rowB?.prNumber).toBe(3); // the loop continued past a's failure
  });

  it("caches an Azure repo's PR by routing on the clone URL", async () => {
    const wrId = await seedReadyRepo("z", "https://dev.azure.com/acme/Shop/_git/web");
    const az = azureClientWith((url) =>
      url.includes("/repositories/web/pullrequests")
        ? {
            value: [
              {
                pullRequestId: 55,
                status: "active",
                isDraft: false,
                mergeStatus: "succeeded",
                reviewers: [{ displayName: "Ada", vote: 10 }],
                repository: {
                  name: "web",
                  webUrl: "https://dev.azure.com/acme/Shop/_git/web",
                  project: { name: "Shop" },
                },
              },
            ],
          }
        : {},
    );

    await pollOnce(db, { azure: az });

    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.prNumber).toBe(55);
    expect(row?.prState).toBe("open");
    expect(row?.prUrl).toBe("https://dev.azure.com/acme/Shop/_git/web/pullrequest/55");
    expect(row?.checkRollup).toBe("none");
    expect(row?.reviewDecision).toBe("approved");
    expect(row?.lastError).toBeNull();
  });

  /** An active Azure PR on project `proj-1`, as the branch lookup returns it. */
  const AZURE_PR = {
    value: [
      {
        pullRequestId: 57,
        status: "active",
        mergeStatus: "succeeded",
        repository: { name: "web", project: { name: "Shop", id: "proj-1" } },
      },
    ],
  };

  it("rolls an Azure PR's checks up from its CI policies", async () => {
    const wrId = await seedReadyRepo("z", "https://dev.azure.com/acme/Shop/_git/web");
    const az = azureClientWith((url) => {
      if (url.includes("/repositories/web/pullrequests")) return AZURE_PR;
      if (url.includes("/policy/evaluations")) {
        return {
          value: [
            {
              status: "approved",
              configuration: { type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" } },
            },
            {
              status: "rejected",
              configuration: { type: { id: "x" }, settings: { statusName: "sonar" } },
            },
            // Not CI: a reviewer policy must not turn the rollup red.
            { status: "rejected", configuration: { type: { id: "reviewers" } } },
          ],
        };
      }
      return {};
    });

    await pollOnce(db, { azure: az });

    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.checkRollup).toBe("failure");
    expect(row?.checks).toEqual({ total: 2, success: 1, failure: 1, pending: 0 });
  });

  it("keeps refreshing an Azure PR whose policies the token can't read", async () => {
    const wrId = await seedReadyRepo("z", "https://dev.azure.com/acme/Shop/_git/web");
    const az = azureClientWith((url) => {
      if (url.includes("/repositories/web/pullrequests")) return AZURE_PR;
      if (url.includes("/policy/evaluations")) return { __status: 403 };
      return {};
    });

    await pollOnce(db, { azure: az });

    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.prNumber).toBe(57);
    expect(row?.checkRollup).toBe("none");
    expect(row?.checks).toBeNull();
    expect(row?.lastError).toBeNull();
  });

  it("leaves an Azure PR's checks unknown when its project id is missing", async () => {
    const wrId = await seedReadyRepo("z", "https://dev.azure.com/acme/Shop/_git/web");
    let askedForPolicies = false;
    const az = azureClientWith((url) => {
      if (url.includes("/repositories/web/pullrequests")) {
        return { value: [{ pullRequestId: 58, status: "active", repository: { name: "web" } }] };
      }
      if (url.includes("/policy/evaluations")) askedForPolicies = true;
      return {};
    });

    await pollOnce(db, { azure: az });

    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(askedForPolicies).toBe(false);
    expect(row?.checkRollup).toBe("none");
    expect(row?.checks).toBeNull();
  });

  it("leaves an approved Azure draft's verdict unknown, as GitHub's path does", async () => {
    const wrId = await seedReadyRepo("z", "https://dev.azure.com/acme/Shop/_git/web");
    const az = azureClientWith((url) =>
      url.includes("/repositories/web/pullrequests")
        ? {
            value: [
              {
                pullRequestId: 56,
                status: "active",
                isDraft: true,
                mergeStatus: "succeeded",
                repository: { name: "web", project: { name: "Shop" } },
                reviewers: [{ displayName: "Ada", vote: 10 }],
              },
            ],
          }
        : {},
    );

    await pollOnce(db, { azure: az });

    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.isDraft).toBe(true);
    expect(row?.reviewDecision).toBeNull();
  });

  it("records a no-PR state for an Azure branch with no open PR yet", async () => {
    const wrId = await seedReadyRepo("z", "https://dev.azure.com/acme/Shop/_git/web");
    const az = azureClientWith(() => ({ value: [] }));

    await pollOnce(db, { azure: az });

    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.prNumber).toBeNull();
    expect(row?.checkRollup).toBe("none");
    expect(row?.lastPolledAt).not.toBeNull();
    expect(row?.lastError).toBeNull();
  });

  it("matches a legacy visualstudio.com repo to its subdomain-org client", async () => {
    // Regression: a visualstudio.com config org URL must resolve org "acme" (the
    // subdomain), matching the clone URL's org, so the cross-org guard doesn't
    // skip legacy repos. A host-as-org bug ("acme.visualstudio.com") would skip.
    const wrId = await seedReadyRepo("z", "https://acme.visualstudio.com/Shop/_git/web");
    const az = azureClientWith(
      (url) =>
        url.includes("/repositories/web/pullrequests")
          ? { value: [{ pullRequestId: 7, status: "active", repository: { name: "web" } }] }
          : {},
      "https://acme.visualstudio.com",
    );

    await pollOnce(db, { azure: az });

    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.prNumber).toBe(7);
  });

  it("skips an Azure repo in a different org than the configured client", async () => {
    const wrId = await seedReadyRepo("z", "https://dev.azure.com/other-org/Shop/_git/web");
    let queried = false;
    const az = azureClientWith((url) => {
      if (url.includes("/pullrequests")) queried = true;
      return { value: [] };
    });

    await pollOnce(db, { azure: az });

    expect(queried).toBe(false);
    const rows = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(rows).toHaveLength(0); // untouched — no client for its org
  });

  it("backs off the whole cycle on a 429 rate limit", async () => {
    await seedReadyRepo("a");
    await seedReadyRepo("b");
    // Both repos would 429; the cycle must abort after the first, so only one
    // PR row is ever written (poll order across the two repos is unspecified).
    const gh = clientWith((path) => (path.includes("head=") ? { __status: 429 } : {}));

    await pollOnce(db, { github: gh });

    const rows = await db.select().from(workspaceRepoPr);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastError).toContain("429");
  });

  it("backs off the whole cycle on a 403 GitHub says is a rate limit", async () => {
    await seedReadyRepo("a");
    await seedReadyRepo("b");
    const gh = clientWith((path) =>
      path.includes("head=") ? { __status: 403, message: "API rate limit exceeded" } : {},
    );

    await pollOnce(db, { github: gh });

    expect(await db.select().from(workspaceRepoPr)).toHaveLength(1);
  });

  it("keeps polling the other repos when one 403s for access, not a rate limit", async () => {
    await seedReadyRepo("a");
    await seedReadyRepo("b");
    const gh = clientWith((path) =>
      path.includes("head=")
        ? { __status: 403, message: "Resource protected by organization SAML enforcement" }
        : {},
    );

    await pollOnce(db, { github: gh });

    const rows = await db.select().from(workspaceRepoPr);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.lastError).toContain("SAML");
  });
});

describe("isDueForRefresh", () => {
  // Halfway through a quarter-hour window, which known PRs are read on.
  const now = Date.parse("2026-10-30T12:07:30Z");
  const polledAgo = (ms: number) => new Date(now - ms);
  /** A branch with a PR in `prState`, or with none when it is null. */
  const candidate = (workspaceId: string, prState: string | null, lastPolledAt: Date | null) => ({
    workspaceId,
    prNumber: prState ? 7 : null,
    prState,
    lastPolledAt,
  });
  const due = (workspaceId: string, prState: string | null, lastPolledAt: Date | null) =>
    isDueForRefresh(candidate(workspaceId, prState, lastPolledAt), now);
  const mode = (workspaceId: string, prState: string | null) =>
    dueRefresh(candidate(workspaceId, prState, null), now);

  it("skips a branch with no PR while nothing is on screen", () => {
    expect(due("w", null, null)).toBe(false);
  });

  it("re-reads every known PR once per quarter hour, whether or not it's on screen", () => {
    for (const prState of ["open", "closed"]) {
      // 12:02:30 is in this window; 11:57:30 is in the last one.
      expect(due("w", prState, polledAgo(5 * 60_000))).toBe(false);
      expect(due("w", prState, polledAgo(10 * 60_000))).toBe(true);
    }
  });

  it("brings known PRs read at different times due on the same tick", () => {
    expect(due("a", "open", polledAgo(21 * 60_000))).toBe(true);
    expect(due("b", "open", polledAgo(8 * 60_000))).toBe(true);
  });

  it("reads a known PR by number while only the list is on screen", () => {
    markWorkspaceListViewed(now);
    expect(mode("w", "open")).toBe("number");
  });

  it("never refreshes a merged PR nobody is looking at", () => {
    markWorkspaceListViewed(now);
    expect(due("w", "merged", null)).toBe(false);
  });

  it("re-reads a known PR by number, and a branch on screen by branch", () => {
    expect(mode("w", "open")).toBe("number");
    markWorkspaceViewed("w", now);
    expect(mode("w", "open")).toBe("branch");
    expect(mode("w", null)).toBe("branch");
  });

  it("refreshes the open workspace's PR about once a minute", () => {
    markWorkspaceViewed("w", now - 10_000);
    expect(due("w", "open", polledAgo(30_000))).toBe(false);
    // A poll stamped as its provider call finished is due on the tick a minute later.
    expect(due("w", "open", polledAgo(55_000))).toBe(true);
  });

  it("polls a viewed repo with nothing cached yet straight away", () => {
    markWorkspaceViewed("w", now);
    expect(due("w", null, null)).toBe(true);
  });

  it("refreshes a branch with no PR yet at the open workspace's pace", () => {
    markWorkspaceViewed("w", now);
    expect(due("w", null, polledAgo(60_000))).toBe(true);
  });

  it("leaves other workspaces' branches alone while one is open", () => {
    markWorkspaceViewed("w", now);
    expect(due("other", null, null)).toBe(false);
    expect(due("other", "open", polledAgo(60_000))).toBe(false);
  });

  it("drops a workspace back to the slow pace a minute after its last read", () => {
    markWorkspaceViewed("w", now - 60_000);
    expect(due("w", null, null)).toBe(false);
    expect(due("w", "open", polledAgo(60_000))).toBe(false);
    expect(due("w", "open", polledAgo(10 * 60_000))).toBe(true);
  });

  it("looks for new PRs on the list's branches every fifteen minutes", () => {
    markWorkspaceListViewed(now);
    expect(due("listed", null, polledAgo(10 * 60_000))).toBe(false);
    expect(due("listed", null, polledAgo(15 * 60_000))).toBe(true);
    expect(mode("listed", null)).toBe("branch");
  });

  it("stops looking for new PRs a minute after the list was last read", () => {
    markWorkspaceListViewed(now - 60_000);
    expect(due("listed", null, null)).toBe(false);
  });

  it("keeps the open workspace at its own pace while the list is also on screen", () => {
    markWorkspaceListViewed(now);
    markWorkspaceViewed("w", now);
    expect(due("w", "open", polledAgo(90_000))).toBe(true);
  });

  it("refreshes a settled PR in the open workspace every fifteen minutes", () => {
    markWorkspaceViewed("w", now);
    for (const prState of ["merged", "closed"]) {
      expect(due("w", prState, polledAgo(10 * 60_000))).toBe(false);
      expect(due("w", prState, polledAgo(15 * 60_000))).toBe(true);
    }
  });
});

describe("pollOnce with a due filter", () => {
  it("calls the provider only for the repos the filter accepts", async () => {
    await seedReadyRepo("a");
    await seedReadyRepo("b");
    const [skipped] = await db.select().from(workspaces).where(eq(workspaces.slug, "b"));
    const asked: string[] = [];
    const gh = clientWith((path) => {
      asked.push(path);
      return path.includes("head=") ? [] : {};
    });

    await pollOnce(db, { github: gh }, (c) => (c.workspaceId !== skipped!.id ? "branch" : null));

    expect(asked.some((p) => p.includes("/oa/ra/"))).toBe(true);
    expect(asked.some((p) => p.includes("/ob/rb/"))).toBe(false);
    expect(await db.select().from(workspaceRepoPr)).toHaveLength(1);
  });

  it("reads each repo's cached poll time to decide whether it's due", async () => {
    const wrId = await seedReadyRepo();
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, "x"));
    const now = Date.now();
    markWorkspaceViewed(ws!.id, now);
    let asked = 0;
    const gh = clientWith((path) => {
      asked++;
      return path.includes("head=") ? [] : {};
    });
    const pollAt = (lastPolledAt: Date) =>
      db
        .insert(workspaceRepoPr)
        .values({ workspaceRepoId: wrId, prState: "open", lastPolledAt })
        .onConflictDoUpdate({ target: workspaceRepoPr.workspaceRepoId, set: { lastPolledAt } });

    await pollAt(new Date(now - 20_000));
    await pollOnce(db, { github: gh }, (c) => dueRefresh(c, now));
    expect(asked).toBe(0);

    await pollAt(new Date(now - 2 * 60_000));
    await pollOnce(db, { github: gh }, (c) => dueRefresh(c, now));
    expect(asked).toBeGreaterThan(0);
    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row!.lastPolledAt!.getTime()).toBeGreaterThanOrEqual(now);
  });
});

/**
 * A GitHubClient whose GraphQL endpoint answers through `graphql`, recording
 * each query's variables and any REST path asked for.
 */
function graphqlClient(graphql: (variables: Record<string, unknown>) => unknown) {
  const queries: Record<string, unknown>[] = [];
  const rest: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname !== "/graphql") {
      rest.push(url.pathname);
      return new Response("{}", { status: 404 });
    }
    const { variables } = JSON.parse(String(init?.body));
    queries.push(variables);
    return new Response(JSON.stringify(graphql(variables)));
  }) as typeof fetch;
  return { gh: new GitHubClient("batch-token", fetchImpl), queries, rest };
}

/** An open PR as the batched poll query returns it, with one failing check. */
const POLLED_PR = (number: number) => ({
  number,
  url: `https://github.com/o/r/pull/${number}`,
  isDraft: false,
  state: "OPEN",
  merged: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  headRefOid: "abc",
  headRepositoryOwner: { login: "oa" },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }],
            },
          },
        },
      },
    ],
  },
  reviews: { nodes: [] },
});

describe("batched GitHub reads", () => {
  it("reads branches in one request and known PRs in another", async () => {
    const branchWr = await seedReadyRepo("a");
    const knownWr = await seedReadyRepo("b");
    await db
      .insert(workspaceRepoPr)
      .values({ workspaceRepoId: knownWr, prNumber: 12, prState: "open" });
    const { gh, queries, rest } = graphqlClient((variables) =>
      "b0" in variables
        ? { data: { p0: { pullRequests: { nodes: [POLLED_PR(5)] } } } }
        : { data: { p0: { pullRequest: { ...POLLED_PR(12), state: "CLOSED", merged: true } } } },
    );

    await pollOnce(db, { github: gh }, (c) => (c.prNumber === null ? "branch" : "number"));

    expect(queries).toEqual([
      { o0: "oa", r0: "ra", b0: "yarvis/a" },
      { o0: "ob", r0: "rb", n0: 12 },
    ]);
    expect(rest).toEqual([]);
    const [branchRow] = await db.select().from(workspaceRepoPr).where(eqWr(branchWr));
    expect(branchRow).toMatchObject({ prNumber: 5, prState: "open", checkRollup: "failure" });
    expect(branchRow?.reviewDecision).toBe("review_required");
    const [knownRow] = await db.select().from(workspaceRepoPr).where(eqWr(knownWr));
    expect(knownRow).toMatchObject({ prNumber: 12, prState: "merged", reviewDecision: null });
  });

  it("records one repo's error without failing the rest of the batch", async () => {
    const okWr = await seedReadyRepo("a");
    const goneWr = await seedReadyRepo("b");
    const { gh } = graphqlClient(() => ({
      data: { p0: { pullRequests: { nodes: [POLLED_PR(5)] } }, p1: null },
      errors: [{ type: "NOT_FOUND", path: ["p1"], message: "Could not resolve to a Repository" }],
    }));

    await pollOnce(db, { github: gh });

    const [okRow] = await db.select().from(workspaceRepoPr).where(eqWr(okWr));
    expect(okRow).toMatchObject({ prNumber: 5, lastError: null });
    const [goneRow] = await db.select().from(workspaceRepoPr).where(eqWr(goneWr));
    expect(goneRow?.lastError).toContain("Not found");
  });

  it("waits out a spent GraphQL limit, without REST, while Azure carries on", async () => {
    const branchWr = await seedReadyRepo("a");
    const knownWr = await seedReadyRepo("b");
    await db
      .insert(workspaceRepoPr)
      .values({ workspaceRepoId: knownWr, prNumber: 12, prState: "open" });
    const azureWr = await seedReadyRepo("z", "https://dev.azure.com/acme/Shop/_git/web");
    const { gh, queries, rest } = graphqlClient(() => ({
      data: null,
      errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
    }));
    const az = azureClientWith((u) => (u.includes("/pullrequests") ? { value: [] } : {}));

    await pollOnce(db, { github: gh, azure: az }, (c) =>
      c.prNumber === null ? "branch" : "number",
    );

    expect(queries).toHaveLength(1); // the known-PR read never goes out
    expect(rest).toEqual([]);
    expect(await db.select().from(workspaceRepoPr).where(eqWr(branchWr))).toEqual([]);
    const [knownRow] = await db.select().from(workspaceRepoPr).where(eqWr(knownWr));
    expect(knownRow?.lastPolledAt).toBeNull();
    const [azureRow] = await db.select().from(workspaceRepoPr).where(eqWr(azureWr));
    expect(azureRow?.lastPolledAt).not.toBeNull();
  });

  it("records a batch-wide refusal on every repo in it, without REST", async () => {
    const a = await seedReadyRepo("a");
    const b = await seedReadyRepo("b");
    const { gh, rest } = graphqlClient(() => ({
      data: null,
      errors: [
        { type: "FORBIDDEN", message: "Resource protected by organization SAML enforcement" },
      ],
    }));

    await pollOnce(db, { github: gh });

    expect(rest).toEqual([]);
    for (const wrId of [a, b]) {
      const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
      expect(row?.lastError).toContain("SAML");
    }
  });

  it("reads the open workspace one repo at a time when GraphQL can't answer", async () => {
    const wrId = await seedReadyRepo();
    const { gh, rest } = graphqlClient(() => ({}));

    await pollOnce(db, { github: gh });

    // The per-repo read reaches REST once GraphQL fails it too.
    expect(rest.some((p) => p.endsWith("/pulls"))).toBe(true);
    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.lastError).not.toBeNull();
  });

  it("leaves known PRs for the next window when GraphQL can't answer", async () => {
    const wrId = await seedReadyRepo();
    await db
      .insert(workspaceRepoPr)
      .values({ workspaceRepoId: wrId, prNumber: 12, prState: "open" });
    const { gh, rest } = graphqlClient(() => ({}));

    await pollOnce(db, { github: gh }, () => "number");

    expect(rest).toEqual([]);
    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.lastError).toContain("empty");
    expect(row?.prNumber).toBe(12);
  });

  it("caches each batch as it's read, so a later one failing costs only itself", async () => {
    const wrIds: string[] = [];
    for (let i = 0; i < 26; i++) {
      const wrId = await seedReadyRepo(`k${i}`);
      await db
        .insert(workspaceRepoPr)
        .values({ workspaceRepoId: wrId, prNumber: i + 1, prState: "open" });
      wrIds.push(wrId);
    }
    const { gh, queries } = graphqlClient((variables) =>
      Object.keys(variables).length / 3 === 25
        ? {
            data: Object.fromEntries(
              Array.from({ length: 25 }, (_, i) => [`p${i}`, { pullRequest: POLLED_PR(i + 1) }]),
            ),
          }
        : { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
    );

    await pollOnce(db, { github: gh }, () => "number");

    expect(queries).toHaveLength(2);
    const rows = await db.select().from(workspaceRepoPr);
    const read = rows.filter((r) => r.lastPolledAt !== null);
    expect(read).toHaveLength(25);
    expect(read.every((r) => r.checkRollup === "failure")).toBe(true);
  });
});

describe("refreshWorkspacePrs", () => {
  it("reads the named workspaces' branches unless they were polled since freshSince", async () => {
    const stale = await seedReadyRepo("a");
    const recent = await seedReadyRepo("c");
    const other = await seedReadyRepo("b");
    const freshSince = new Date(Date.now() - 30_000);
    await db.insert(workspaceRepoPr).values([
      { workspaceRepoId: stale, prNumber: 5, lastPolledAt: new Date(Date.now() - 5 * 60_000) },
      { workspaceRepoId: recent, prNumber: 6, lastPolledAt: new Date() },
    ]);
    const named = await db
      .select()
      .from(workspaces)
      .where(inArray(workspaces.slug, ["a", "c"]));
    const { gh, queries } = graphqlClient(() => ({
      data: { p0: { pullRequests: { nodes: [POLLED_PR(5)] } } },
    }));

    await refreshWorkspacePrs(
      db,
      { github: gh },
      named.map((w) => w.id),
      freshSince,
    );

    expect(queries).toEqual([{ o0: "oa", r0: "ra", b0: "yarvis/a" }]);
    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(stale));
    expect(row?.checkRollup).toBe("failure");
    expect(await db.select().from(workspaceRepoPr).where(eqWr(other))).toEqual([]);
  });
});

describe("pollDueRepos", () => {
  it("re-reads a known PR nobody is looking at once its window has turned", async () => {
    const wrId = await seedReadyRepo();
    await db.insert(workspaceRepoPr).values({
      workspaceRepoId: wrId,
      prNumber: 12,
      prState: "open",
      lastPolledAt: new Date(Date.now() - 20 * 60_000),
    });
    const { gh, queries } = graphqlClient(() => ({ data: { p0: { pullRequest: POLLED_PR(12) } } }));

    await pollDueRepos(db, { github: gh });

    expect(queries).toEqual([{ o0: "ox", r0: "rx", n0: 12 }]);
    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.checkRollup).toBe("failure");
  });

  it("asks the provider only about the repos in the workspace the user has open", async () => {
    await seedReadyRepo("a");
    await seedReadyRepo("b");
    const [open] = await db.select().from(workspaces).where(eq(workspaces.slug, "a"));
    markWorkspaceViewed(open!.id);
    const asked: string[] = [];
    const gh = clientWith((path) => {
      asked.push(path);
      return path.includes("head=") ? [] : {};
    });

    await pollDueRepos(db, { github: gh });

    expect(asked.some((p) => p.includes("/oa/ra/"))).toBe(true);
    expect(asked.some((p) => p.includes("/ob/rb/"))).toBe(false);
  });
});

describe("reconcileOrphans", () => {
  it("errors a stranded creating workspace but leaves a fresh one", async () => {
    const old = new Date(Date.now() - 5 * 60_000);
    const [stranded] = await db
      .insert(workspaces)
      .values({
        name: "old",
        slug: "old",
        rootPath: "/tmp/old",
        status: "creating",
        updatedAt: old,
      })
      .returning();
    const [fresh] = await db
      .insert(workspaces)
      .values({ name: "new", slug: "new", rootPath: "/tmp/new", status: "creating" })
      .returning();

    await reconcileOrphans(db);

    const [a] = await db.select().from(workspaces).where(eq(workspaces.id, stranded!.id));
    const [b] = await db.select().from(workspaces).where(eq(workspaces.id, fresh!.id));
    expect(a?.status).toBe("error");
    expect(b?.status).toBe("creating"); // within the age margin, untouched
  });

  it("keeps an interrupted archive in the archive flow, and leaves a failed one alone", async () => {
    const old = new Date(Date.now() - 5 * 60_000);
    const [interrupted] = await db
      .insert(workspaces)
      .values({ name: "a", slug: "a", rootPath: "/tmp/a", status: "archiving", updatedAt: old })
      .returning();
    const [failed] = await db
      .insert(workspaces)
      .values({
        name: "b",
        slug: "b",
        rootPath: "/tmp/b",
        status: "archiving",
        error: "one or more worktrees could not be removed",
        updatedAt: old,
      })
      .returning();

    await reconcileOrphans(db);

    const [a] = await db.select().from(workspaces).where(eq(workspaces.id, interrupted!.id));
    const [b] = await db.select().from(workspaces).where(eq(workspaces.id, failed!.id));
    expect(a?.status).toBe("archiving");
    expect(a?.error).toContain("archive again");
    expect(b?.status).toBe("archiving");
    expect(b?.error).toBe("one or more worktrees could not be removed");
  });

  it("leaves an archive that may still be running alone", async () => {
    const [running] = await db
      .insert(workspaces)
      .values({ name: "c", slug: "c", rootPath: "/tmp/c", status: "archiving" })
      .returning();

    await reconcileOrphans(db);

    const [c] = await db.select().from(workspaces).where(eq(workspaces.id, running!.id));
    expect(c?.status).toBe("archiving");
    expect(c?.error).toBeNull();
  });
});

function eqWr(wrId: string) {
  return eq(workspaceRepoPr.workspaceRepoId, wrId);
}
