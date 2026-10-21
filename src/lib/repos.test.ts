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

  it("decodes a percent-encoded Azure DevOps project name", () => {
    expect(parseRepoRemote("https://dev.azure.com/myorg/My%20Project/_git/web")).toEqual({
      provider: "azure",
      org: "myorg",
      project: "My Project",
      repo: "web",
    });
  });

  it("decodes a percent-encoded project in an Azure DevOps ssh remote", () => {
    expect(parseRepoRemote("git@ssh.dev.azure.com:v3/myorg/My%20Project/web")).toEqual({
      provider: "azure",
      org: "myorg",
      project: "My Project",
      repo: "web",
    });
  });

  it("keeps a segment with invalid percent-encoding as written", () => {
    expect(parseRepoRemote("https://dev.azure.com/myorg/Bad%E0%A4%A/_git/web")).toEqual({
      provider: "azure",
      org: "myorg",
      project: "Bad%E0%A4%A",
      repo: "web",
    });
  });

  it("returns null when a decoded segment would escape its path position", () => {
    expect(parseRepoRemote("https://dev.azure.com/myorg/%2e%2e/_git/web")).toBeNull();
    expect(parseRepoRemote("https://dev.azure.com/myorg/MyProject/_git/%2E%2E")).toBeNull();
    expect(parseRepoRemote("https://dev.azure.com/myorg/My%2FProject/_git/web")).toBeNull();
  });

  it("classifies a legacy visualstudio.com remote", () => {
    expect(parseRepoRemote("https://myorg.visualstudio.com/MyProject/_git/web")).toEqual({
      provider: "azure",
      org: "myorg",
      project: "MyProject",
      repo: "web",
    });
  });

  it("classifies a legacy visualstudio.com remote with a DefaultCollection segment", () => {
    expect(
      parseRepoRemote("https://myorg.visualstudio.com/DefaultCollection/MyProject/_git/web"),
    ).toEqual({ provider: "azure", org: "myorg", project: "MyProject", repo: "web" });
  });

  it("returns null for an Azure host with no _git or v3 marker", () => {
    expect(parseRepoRemote("https://dev.azure.com/myorg/MyProject")).toBeNull();
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
