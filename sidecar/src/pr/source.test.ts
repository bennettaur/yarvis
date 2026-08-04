import { describe, expect, it } from "bun:test";
import type { AzureDevOpsClient } from "../azure/client.ts";
import type { GitHubClient } from "../github/client.ts";
import { azurePrSource, githubPrSource } from "./source.ts";
import { type PrRef, refKey } from "./types.ts";

const ghRef: PrRef = { provider: "github", owner: "o", repo: "r", number: 7 };
const azRef: PrRef = { provider: "azure", org: "acme", project: "Shop", repo: "web", prId: 7 };

describe("refKey", () => {
  // These strings key rows the frontend writes and the sidecar reads, so they
  // have to match the frontend's `refKey` exactly.
  it("matches the frontend's identity strings", () => {
    expect(refKey(ghRef)).toBe("gh:o/r/7");
    expect(refKey(azRef)).toBe("az:acme/Shop/web/7");
  });
});

describe("githubPrSource", () => {
  it("rejects a ref from the other provider", () => {
    expect(() => githubPrSource({} as GitHubClient, azRef)).toThrow("expected a github ref");
  });

  // Every file read needs the head commit, and re-fetching the PR on each of a
  // dozen tool calls would spend the run on one repeated request.
  it("fetches the PR detail once however many reads follow", async () => {
    let details = 0;
    const client = {
      prDetail: async () => {
        details++;
        return { headSha: "a".repeat(40) };
      },
      fileContent: async () => "contents",
      listDir: async () => [],
    } as unknown as GitHubClient;

    const source = githubPrSource(client, ghRef);
    await source.readFile("a.ts");
    await source.readFile("b.ts");
    await source.listDir("src");
    expect(details).toBe(1);
  });

  it("reads files at the head commit", async () => {
    const seen: string[] = [];
    const client = {
      prDetail: async () => ({ headSha: "b".repeat(40) }),
      fileContent: async (_o: string, _r: string, _p: string, ref: string) => {
        seen.push(ref);
        return "x";
      },
    } as unknown as GitHubClient;
    await githubPrSource(client, ghRef).readFile("a.ts");
    expect(seen).toEqual(["b".repeat(40)]);
  });

  // GitHub ships every patch in the file listing, so a per-file diff is a
  // lookup rather than a request.
  it("takes a changed file's diff from the file listing", async () => {
    const client = {
      prFiles: async () => [
        { filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@" },
      ],
    } as unknown as GitHubClient;
    expect(await githubPrSource(client, ghRef).fileDiff("a.ts")).toMatchObject({ patch: "@@" });
  });

  // The listing carries every changed file's full patch, so re-fetching it per
  // diff read would pull the whole PR diff over the wire once per tool call.
  it("fetches the file listing once however many diffs are read", async () => {
    let listings = 0;
    const client = {
      prFiles: async () => {
        listings++;
        return [
          { filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ a" },
          { filename: "b.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ b" },
        ];
      },
    } as unknown as GitHubClient;

    const source = githubPrSource(client, ghRef);
    await source.files();
    await source.fileDiff("a.ts");
    await source.fileDiff("b.ts");
    await source.fileDiff("a.ts");
    expect(listings).toBe(1);
  });

  it("says so when asked for a file the pull request does not change", async () => {
    const client = { prFiles: async () => [] } as unknown as GitHubClient;
    expect(githubPrSource(client, ghRef).fileDiff("a.ts")).rejects.toThrow("is not changed");
  });

  // The scope is stated on the tool so a caller can qualify its findings:
  // GitHub only indexes the default branch, so a symbol the PR introduces
  // will not turn up.
  it("declares that search does not cover the pull request's head", () => {
    expect(githubPrSource({} as GitHubClient, ghRef).searchScope).toContain("default branch");
  });
});

describe("azurePrSource", () => {
  it("rejects a ref from the other provider", () => {
    expect(() => azurePrSource({} as AzureDevOpsClient, ghRef)).toThrow("expected an azure ref");
  });

  // The Azure client already holds the organization, so the ref it takes is
  // the project/repo/id triple without it.
  it("drops the organization when calling the client", async () => {
    const seen: unknown[] = [];
    const client = {
      prFiles: async (ref: unknown) => {
        seen.push(ref);
        return [];
      },
    } as unknown as AzureDevOpsClient;
    await azurePrSource(client, azRef).files();
    expect(seen).toEqual([{ project: "Shop", repo: "web", prId: 7 }]);
  });

  it("passes an unavailable search straight through as null", async () => {
    const client = {
      searchCode: async () => null,
    } as unknown as AzureDevOpsClient;
    expect(await azurePrSource(client, azRef).searchCode("q")).toBeNull();
  });
});
