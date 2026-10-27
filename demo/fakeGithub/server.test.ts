import { describe, expect, it } from "bun:test";
import { PULLS, VIEWER } from "./data";
import { handleGithubRequest } from "./server";

const get = (path: string) =>
  handleGithubRequest({ method: "GET", url: new URL(path, "http://fake"), body: undefined });
const graphql = (query: string, variables: Record<string, unknown>) =>
  handleGithubRequest({
    method: "POST",
    url: new URL("/graphql", "http://fake"),
    body: { query, variables },
  }).json as { data: Record<string, any> };

describe("fake GitHub", () => {
  it("lists the viewer's PRs and the ones waiting on their review separately", () => {
    const search = (q: string) =>
      (
        get(`/search/issues?q=${encodeURIComponent(q)}`).json as {
          items: { user: { login: string } }[];
        }
      ).items;
    expect(search("is:open is:pr author:@me").every((i) => i.user.login === VIEWER)).toBe(true);
    expect(search("is:open is:pr review-requested:@me").length).toBeGreaterThan(0);
    expect(search("is:open is:pr review-requested:@me").some((i) => i.user.login === VIEWER)).toBe(
      false,
    );
  });

  it("answers a PR detail query with the PR it names", () => {
    const { data } = graphql("query { repository { mergeCommitAllowed pullRequest { title } } }", {
      owner: "acme",
      repo: "checkout-web",
      number: 477,
    });
    expect(data.repository.pullRequest.title).toBe(PULLS[0].title);
    expect(data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup).toBeDefined();
  });

  it("keeps a thread reply and its resolve state for the next detail read", () => {
    const thread = () =>
      graphql("query { repository { pullRequest { reviewThreads } } }", { number: 477 }).data
        .repository.pullRequest.reviewThreads.nodes[0];
    const id = thread().id;

    graphql("mutation { addPullRequestReviewThreadReply }", { id, body: "on it" });
    graphql("mutation { resolveReviewThread }", { id });
    expect(thread().isResolved).toBe(true);
    expect(thread().comments.nodes.at(-1)).toMatchObject({
      body: "on it",
      author: { login: VIEWER },
    });

    graphql("mutation { unresolveReviewThread }", { id });
    expect(thread().isResolved).toBe(false);
  });

  it("fills aliased lookups from their numbered variables", () => {
    const { data } = graphql("query { pr0: repository { pullRequest { headRefName } } }", {
      o0: "acme",
      r0: "checkout-web",
      n0: 471,
      o1: "acme",
      r1: "checkout-web",
      n1: 1,
    });
    expect(data.pr0.pullRequest.number).toBe(471);
    expect(data.pr1.pullRequest).toBeNull();
  });

  it("has the viewer's review at an older commit, and how far the head moved since", () => {
    const pr = PULLS[0];
    const { data } = graphql("query { repository { pullRequest { reviews } } }", {
      number: pr.number,
    });
    const own = data.repository.pullRequest.reviews.nodes.find(
      (n: { commit?: unknown }) => n.commit,
    );
    expect(own.commit.oid).toBe(pr.viewerReview?.commit);
    expect(data.repository.pullRequest.headRefOid).toBe(pr.headSha);
    const compare = get(
      `/repos/acme/checkout-web/compare/${pr.viewerReview?.commit}...${pr.headSha}`,
    ).json as { ahead_by: number };
    expect(compare.ahead_by).toBe(pr.viewerReview?.commitsSince ?? -1);
    expect(get(`/repos/acme/checkout-web/compare/${"a".repeat(40)}...${pr.headSha}`).status).toBe(
      404,
    );
  });

  it("REST agrees with GraphQL on the head, and serves its checks under either form", () => {
    const pr = PULLS[0];
    const rest = get(`/repos/acme/checkout-web/pulls/${pr.number}`).json as {
      head: { sha: string };
    };
    expect(rest.head.sha).toBe(pr.headSha ?? `sha-${pr.number}`);
    for (const sha of [rest.head.sha, `sha-${pr.number}`]) {
      const runs = get(`/repos/acme/checkout-web/commits/${sha}/check-runs`).json as {
        check_runs: unknown[];
      };
      expect(runs.check_runs.length).toBe(pr.checks.length);
    }
  });

  it("serves a PR's files with their patches", () => {
    const files = get("/repos/acme/checkout-web/pulls/477/files").json as { patch: string }[];
    expect(files.length).toBeGreaterThan(0);
    expect(files[0].patch).toContain("@@");
  });
});
