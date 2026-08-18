import { describe, expect, it } from "bun:test";
import { prFileUrl } from "./links";

describe("prFileUrl", () => {
  it("points at the file at the PR's head commit on GitHub", () => {
    expect(
      prFileUrl("https://github.com/acme/web/pull/12", "github", "abc123", "src/app/main.ts"),
    ).toBe("https://github.com/acme/web/blob/abc123/src/app/main.ts");
  });

  // The header links from a URL the user is already looking at, which can carry
  // the tab or an anchor the reader left it on.
  it("ignores a trailing tab, query or fragment on the PR URL", () => {
    expect(
      prFileUrl("https://github.com/acme/web/pull/12/files#diff-1", "github", "abc123", "a.ts"),
    ).toBe("https://github.com/acme/web/blob/abc123/a.ts");
  });

  // Self-hosted GitHub lives on its own domain; nothing here assumes github.com.
  it("keeps an enterprise host", () => {
    expect(prFileUrl("https://git.corp.test/acme/web/pull/3", "github", "sha", "a.ts")).toBe(
      "https://git.corp.test/acme/web/blob/sha/a.ts",
    );
  });

  it("uses Azure's path + version query", () => {
    expect(
      prFileUrl(
        "https://dev.azure.com/acme/proj/_git/web/pullrequest/9",
        "azure",
        "abc123",
        "src/a.ts",
      ),
    ).toBe("https://dev.azure.com/acme/proj/_git/web?path=%2Fsrc%2Fa.ts&version=GCabc123");
  });

  it("escapes path characters that would otherwise change the URL", () => {
    expect(prFileUrl("https://github.com/acme/web/pull/1", "github", "sha", "a b/c?d.ts")).toBe(
      "https://github.com/acme/web/blob/sha/a%20b/c%3Fd.ts",
    );
  });

  // A link to the branch tip would drift the moment someone pushes, so no head
  // commit means no link at all.
  it("has no link before the head commit is known", () => {
    expect(prFileUrl("https://github.com/acme/web/pull/1", "github", "", "a.ts")).toBeNull();
  });

  it("has no link when the URL isn't a PR of that provider", () => {
    expect(prFileUrl("https://github.com/acme/web", "github", "sha", "a.ts")).toBeNull();
    expect(prFileUrl("https://github.com/acme/web/pull/1", "azure", "sha", "a.ts")).toBeNull();
  });
});
