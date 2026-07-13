import { describe, expect, it } from "bun:test";
import { parseRepoRemote, type Repo, repoPrRef } from "./repos";

describe("parseRepoRemote", () => {
  it("classifies a GitHub ssh remote", () => {
    expect(parseRepoRemote("git@github.com:acme/web.git")).toEqual({
      provider: "github",
      owner: "acme",
      repo: "web",
    });
  });

  it("classifies a modern Azure DevOps https remote", () => {
    expect(parseRepoRemote("https://dev.azure.com/myorg/MyProject/_git/web")).toEqual({
      provider: "azure",
      org: "myorg",
      project: "MyProject",
      repo: "web",
    });
  });

  it("classifies an Azure DevOps ssh remote", () => {
    expect(parseRepoRemote("git@ssh.dev.azure.com:v3/myorg/MyProject/web")).toEqual({
      provider: "azure",
      org: "myorg",
      project: "MyProject",
      repo: "web",
    });
  });

  it("classifies a legacy visualstudio.com remote", () => {
    expect(parseRepoRemote("https://myorg.visualstudio.com/MyProject/_git/web")).toEqual({
      provider: "azure",
      org: "myorg",
      project: "MyProject",
      repo: "web",
    });
  });

  it("returns null for an unparseable url", () => {
    expect(parseRepoRemote("not-a-url")).toBeNull();
  });
});

describe("repoPrRef", () => {
  const base: Repo = {
    id: "r1",
    name: "web",
    owner: "acme",
    repo: "web",
    cloneUrl: "git@github.com:acme/web.git",
    defaultBranch: "main",
    primaryClonePath: "/tmp/acme-web",
    setupScript: null,
    runScript: null,
    pullIssues: false,
    createdAt: "",
    updatedAt: "",
  };

  it("builds a GitHub ref keyed by the stored owner/repo", () => {
    expect(repoPrRef(base, 7)).toEqual({
      provider: "github",
      owner: "acme",
      repo: "web",
      number: 7,
    });
  });

  it("builds an Azure ref from the clone URL, with prId", () => {
    const azure: Repo = {
      ...base,
      cloneUrl: "https://dev.azure.com/myorg/MyProject/_git/web",
    };
    expect(repoPrRef(azure, 42)).toEqual({
      provider: "azure",
      org: "myorg",
      project: "MyProject",
      repo: "web",
      prId: 42,
    });
  });
});
