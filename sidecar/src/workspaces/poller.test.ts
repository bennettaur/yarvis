import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { AzureDevOpsClient } from "../azure/client.ts";
import { getDb } from "../db/client.ts";
import { repos, workspaceRepoPr, workspaceRepos, workspaces } from "../db/schema.ts";
import { GitHubClient } from "../github/client.ts";
import {
  isDueForRefresh,
  markWorkspaceListViewed,
  markWorkspaceViewed,
  pollOnce,
  reconcileOrphans,
  resetWorkspaceViews,
} from "./poller.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;

/**
 * Builds a GitHubClient whose fetch returns canned payloads keyed by URL. A
 * handler may return `{ __status: <code> }` to simulate an error response.
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
  const now = Date.parse("2026-10-30T12:00:00Z");
  const polledAgo = (ms: number) => new Date(now - ms);

  beforeEach(() => resetWorkspaceViews());

  it("skips every repo while nothing is on screen", () => {
    expect(isDueForRefresh({ workspaceId: "w", prState: "open", lastPolledAt: null }, now)).toBe(
      false,
    );
  });

  it("refreshes the open workspace's PR every minute", () => {
    markWorkspaceViewed("w", now - 10_000);
    const candidate = { workspaceId: "w", prState: "open" };
    expect(isDueForRefresh({ ...candidate, lastPolledAt: polledAgo(30_000) }, now)).toBe(false);
    expect(isDueForRefresh({ ...candidate, lastPolledAt: polledAgo(60_000) }, now)).toBe(true);
    expect(isDueForRefresh({ ...candidate, lastPolledAt: null }, now)).toBe(true);
  });

  it("stops refreshing a workspace a minute after its last read", () => {
    markWorkspaceViewed("w", now - 60_000);
    expect(isDueForRefresh({ workspaceId: "w", prState: "open", lastPolledAt: null }, now)).toBe(
      false,
    );
  });

  it("refreshes list badges and settled PRs only every ten minutes", () => {
    markWorkspaceListViewed(now);
    markWorkspaceViewed("open-merged", now);
    for (const candidate of [
      { workspaceId: "listed", prState: "open" },
      { workspaceId: "open-merged", prState: "merged" },
    ]) {
      expect(isDueForRefresh({ ...candidate, lastPolledAt: polledAgo(5 * 60_000) }, now)).toBe(
        false,
      );
      expect(isDueForRefresh({ ...candidate, lastPolledAt: polledAgo(10 * 60_000) }, now)).toBe(
        true,
      );
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

    await pollOnce(db, { github: gh }, (c) => c.workspaceId !== skipped!.id);

    expect(asked.some((p) => p.includes("/oa/ra/"))).toBe(true);
    expect(asked.some((p) => p.includes("/ob/rb/"))).toBe(false);
    expect(await db.select().from(workspaceRepoPr)).toHaveLength(1);
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
