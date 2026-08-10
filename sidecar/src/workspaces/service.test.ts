import { describe, expect, it } from "bun:test";
import type { Config } from "../config.ts";
import {
  assertSafeCloneUrl,
  parseGitUrl,
  parseRepoRemote,
  primaryClonePath,
  slugify,
} from "./service.ts";

const config = { workspacesRoot: "/home/me/dev/yarvis-workspaces" } as Config;

describe("parseGitUrl", () => {
  it("parses an ssh remote", () => {
    expect(parseGitUrl("git@github.com:acme/widget.git")).toEqual({
      owner: "acme",
      repo: "widget",
    });
  });

  it("parses an https remote", () => {
    expect(parseGitUrl("https://github.com/acme/widget")).toEqual({
      owner: "acme",
      repo: "widget",
    });
  });

  it("strips a trailing .git", () => {
    expect(parseGitUrl("https://github.com/acme/widget.git")?.repo).toBe("widget");
  });

  it("returns null for an unparseable url", () => {
    expect(parseGitUrl("not-a-url")).toBeNull();
  });
});

describe("parseRepoRemote", () => {
  it("classifies a GitHub ssh remote", () => {
    expect(parseRepoRemote("git@github.com:acme/widget.git")).toEqual({
      provider: "github",
      owner: "acme",
      repo: "widget",
    });
  });

  it("classifies a GitHub https remote", () => {
    expect(parseRepoRemote("https://github.com/acme/widget")).toEqual({
      provider: "github",
      owner: "acme",
      repo: "widget",
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

  it("classifies an Azure DevOps https remote with an org in the userinfo", () => {
    expect(parseRepoRemote("https://myorg@dev.azure.com/myorg/MyProject/_git/web")).toEqual({
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

  it("classifies a legacy visualstudio.com remote (org in the subdomain)", () => {
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
    // dev.azure.com host but not a repo clone URL — reaches the Azure block's
    // own null return, not the earlier splitRemote bail.
    expect(parseRepoRemote("https://dev.azure.com/myorg/MyProject")).toBeNull();
  });

  it("strips a trailing .git from an Azure repo name", () => {
    expect(parseRepoRemote("https://dev.azure.com/myorg/MyProject/_git/web.git")?.repo).toBe("web");
  });

  it("returns null for an unparseable url", () => {
    expect(parseRepoRemote("not-a-url")).toBeNull();
  });
});

describe("slugify", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(slugify("Rename the API!")).toBe("rename-the-api");
  });

  it("trims leading/trailing separators", () => {
    expect(slugify("  --Hello--  ")).toBe("hello");
  });

  it("falls back to 'workspace' for an empty result", () => {
    expect(slugify("!!!")).toBe("workspace");
  });
});

describe("assertSafeCloneUrl", () => {
  it("accepts https, ssh, and scp-style remotes", () => {
    expect(() => assertSafeCloneUrl("https://github.com/a/b.git")).not.toThrow();
    expect(() => assertSafeCloneUrl("git@github.com:a/b.git")).not.toThrow();
    expect(() => assertSafeCloneUrl("ssh://git@host/a/b")).not.toThrow();
  });

  it("rejects ext:: remote helpers and flag-like values", () => {
    // git's ext:: transport runs arbitrary commands; a leading - is read as a flag.
    expect(() => assertSafeCloneUrl("ext::sh -c touch/owner/repo")).toThrow();
    expect(() => assertSafeCloneUrl("--upload-pack=evil")).toThrow();
  });
});

describe("primaryClonePath", () => {
  it("places clones under <root>/.repos/<owner>-<repo>", () => {
    expect(primaryClonePath(config, "acme", "widget")).toBe(
      "/home/me/dev/yarvis-workspaces/.repos/acme-widget",
    );
  });

  it("lowercases the owner and repo names", () => {
    expect(primaryClonePath(config, "Acme", "Widget")).toBe(
      "/home/me/dev/yarvis-workspaces/.repos/acme-widget",
    );
  });
});
