import { describe, expect, it } from "bun:test";
import type { PrRef } from "../pr/types.ts";
import { headSourceFor, httpsRemoteFor, ReviewWorkspaceError, reviewClonePath } from "./service.ts";

const azure: PrRef = { provider: "azure", org: "Org", project: "My Project", repo: "R&D", prId: 7 };

describe("headSourceFor", () => {
  it("uses GitHub's pull ref, Azure's branch in the same repo, and Azure's merge preview for a fork", () => {
    const github: PrRef = { provider: "github", owner: "o", repo: "r", number: 3 };
    expect(headSourceFor(github, { headRef: "feature", fromFork: false })).toEqual({
      kind: "ref",
      ref: "refs/pull/3/head",
    });
    expect(headSourceFor(azure, { headRef: "feature/x", fromFork: false })).toEqual({
      kind: "ref",
      ref: "refs/heads/feature/x",
    });
    expect(headSourceFor(azure, { headRef: "feature/x", fromFork: true })).toEqual({
      kind: "merge-parent",
      ref: "refs/pull/7/merge",
    });
  });
});

describe("reviewClonePath", () => {
  it("gives Azure four lower-cased segments and GitHub three", () => {
    expect(reviewClonePath({ workspacesRoot: "/root" }, azure)).toBe(
      "/root/.review-repos/azure/org/my project/r&d",
    );
    expect(
      reviewClonePath(
        { workspacesRoot: "/root" },
        { provider: "github", owner: "A-b", repo: "C", number: 1 },
      ),
    ).toBe("/root/.review-repos/github/a-b/c");
  });
});

describe("httpsRemoteFor", () => {
  const secrets = (s: Record<string, string>) =>
    ({ secrets: s }) as Parameters<typeof httpsRemoteFor>[0];

  it("encodes Azure's project and repo, and ignores a trailing slash on the org URL", () => {
    const remote = httpsRemoteFor(
      secrets({ azureDevopsOrgUrl: "https://dev.azure.com/Org/", azureDevopsToken: "pat" }),
      azure,
    );
    expect(remote).toEqual({
      url: "https://dev.azure.com/Org/My%20Project/_git/R%26D",
      credentials: { host: "dev.azure.com", username: "yarvis", token: "pat" },
    });
  });

  it("refuses a missing or non-Azure org URL", () => {
    for (const orgUrl of [undefined, "https://evil.example/Org", "http://dev.azure.com/Org"]) {
      const call = () =>
        httpsRemoteFor(secrets(orgUrl ? { azureDevopsOrgUrl: orgUrl } : {}), azure);
      expect(call).toThrow(ReviewWorkspaceError);
      try {
        call();
      } catch (e) {
        expect((e as ReviewWorkspaceError).status).toBe(400);
      }
    }
  });

  it("offers no credentials without a token", () => {
    expect(
      httpsRemoteFor(secrets({}), { provider: "github", owner: "o", repo: "r", number: 1 }),
    ).toEqual({ url: "https://github.com/o/r.git" });
  });
});
