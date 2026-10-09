import { describe, expect, it } from "bun:test";
import type { Config } from "../config.ts";
import {
  assertSafeCloneUrl,
  isSafePathSegment,
  parseGitUrl,
  parseRepoRemote,
  primaryClonePath,
  slugify,
  workspaceRepoFolder,
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

  it("rejects an scp-style remote whose user starts with -", () => {
    // git ls-remote reads -ox@host:path as the -o server option.
    expect(() => assertSafeCloneUrl("-ox@github.com:acme/widget.git")).toThrow(
      "unsupported clone URL transport",
    );
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

describe("isSafePathSegment", () => {
  it("accepts a plain folder name", () => {
    expect(isSafePathSegment("widget")).toBe(true);
  });

  it("refuses empty, dot and dot-dot", () => {
    for (const bad of ["", ".", ".."]) expect(isSafePathSegment(bad)).toBe(false);
  });

  it("refuses a slash or a backslash", () => {
    for (const bad of ["a/b", "a\\b", "/", "\\"]) expect(isSafePathSegment(bad)).toBe(false);
  });
});

describe("workspaceRepoFolder", () => {
  const repo = { name: "Widget", owner: "Acme" };

  it("uses the lowercased display name when free", () => {
    expect(workspaceRepoFolder(repo, new Set())).toBe("widget");
  });

  it("falls back to name-owner when the name is taken", () => {
    expect(workspaceRepoFolder(repo, new Set(["widget"]))).toBe("widget-acme");
  });

  it("refuses when both names are taken", () => {
    expect(() => workspaceRepoFolder(repo, new Set(["widget", "widget-acme"]))).toThrow(
      "both in use",
    );
  });

  it("refuses an unsafe folder name", () => {
    for (const name of ["..", ".", "a/b", "a\\b"]) {
      expect(() => workspaceRepoFolder({ name, owner: "acme" }, new Set())).toThrow(
        "unsafe folder name",
      );
    }
  });
});
