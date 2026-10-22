import { describe, expect, it } from "bun:test";
import { resolvePrLocator } from "../pr/locate";
import type { ReviewWorkspaceSummary } from "./api";
import { findWorkspaceWithPr, prWebUrl, shortPrName } from "./open";

const ws = (
  id: string,
  over: Partial<ReviewWorkspaceSummary>,
  prs: { id: string; refKey: string }[],
): ReviewWorkspaceSummary =>
  ({
    id,
    name: id,
    status: "active",
    error: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    lastOpenedAt: null,
    prs,
    ...over,
  }) as ReviewWorkspaceSummary;

describe("findWorkspaceWithPr", () => {
  // The paste box's own parser feeds this, so a link and a shorthand land on
  // the same workspace.
  const [ref] = resolvePrLocator("https://github.com/acme/widgets/pull/7");

  it("finds the most recently opened active workspace holding the PR", () => {
    const list = [
      ws("old", { lastOpenedAt: "2026-10-02T00:00:00.000Z" }, [
        { id: "p1", refKey: "gh:acme/widgets/7" },
      ]),
      ws("new", { lastOpenedAt: "2026-10-05T00:00:00.000Z" }, [
        { id: "p2", refKey: "gh:acme/widgets/7" },
      ]),
      ws("gone", { status: "archived", lastOpenedAt: "2026-10-09T00:00:00.000Z" }, [
        { id: "p3", refKey: "gh:acme/widgets/7" },
      ]),
    ];
    expect(findWorkspaceWithPr(list, ref!)).toEqual({ workspaceId: "new", prId: "p2" });
    expect(findWorkspaceWithPr(list, resolvePrLocator("acme/widgets#7")[0]!)).toEqual({
      workspaceId: "new",
      prId: "p2",
    });
  });

  it("finds nothing for a PR no workspace holds", () => {
    expect(
      findWorkspaceWithPr([ws("w", {}, [{ id: "p", refKey: "gh:acme/widgets/8" }])], ref!),
    ).toBeNull();
  });
});

describe("prWebUrl and shortPrName", () => {
  it("links each provider's PR page", () => {
    expect(prWebUrl({ provider: "github", owner: "acme", repo: "widgets", number: 7 })).toBe(
      "https://github.com/acme/widgets/pull/7",
    );
    expect(
      prWebUrl({ provider: "azure", org: "contoso", project: "Web App", repo: "svc", prId: 12 }),
    ).toBe("https://dev.azure.com/contoso/Web%20App/_git/svc/pullrequest/12");
  });

  it("names a workspace after the repo and number", () => {
    expect(shortPrName({ provider: "github", owner: "acme", repo: "widgets", number: 7 })).toBe(
      "widgets#7",
    );
  });
});
