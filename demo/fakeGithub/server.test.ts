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

  it("serves a PR's files with their patches", () => {
    const files = get("/repos/acme/checkout-web/pulls/477/files").json as { patch: string }[];
    expect(files.length).toBeGreaterThan(0);
    expect(files[0].patch).toContain("@@");
  });
});
