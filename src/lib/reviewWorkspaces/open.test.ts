import { afterAll, describe, expect, it } from "bun:test";
import { resetReviewApi, stubReviewApi } from "../../test/reviewWorkspacesApi";
import { resolvePrLocator } from "../pr/locate";
import type { PrRef } from "../pr/types";
import type { ReviewWorkspacePr, ReviewWorkspaceSummary } from "./api";
import { addStackLayers, findWorkspaceWithPr, prWebUrl, shortPrName } from "./open";

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

describe("addStackLayers", () => {
  afterAll(resetReviewApi);
  const layer = (number: number): PrRef => ({ provider: "github", owner: "o", repo: "r", number });

  it("adds each layer in order, waiting for the one before it", async () => {
    const order: string[] = [];
    let inFlight = 0;
    stubReviewApi({
      addReviewPr: async (_ws, ref) => {
        inFlight++;
        expect(inFlight).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 1));
        order.push(shortPrName(ref));
        inFlight--;
        return {} as ReviewWorkspacePr;
      },
    });
    await addStackLayers("ws", [layer(1), layer(2), layer(3)]);
    expect(order).toEqual(["r#1", "r#2", "r#3"]);
  });

  it("keeps going past layers that fail, then names each one", async () => {
    const added: string[] = [];
    stubReviewApi({
      addReviewPr: async (_ws, ref) => {
        const name = shortPrName(ref);
        if (name === "r#2") throw new Error("already in the workspace");
        if (name === "r#3") throw new Error("not found");
        added.push(name);
        return {} as ReviewWorkspacePr;
      },
    });
    await expect(addStackLayers("ws", [layer(1), layer(2), layer(3), layer(4)])).rejects.toThrow(
      "Couldn't add r#2: already in the workspace; r#3: not found",
    );
    expect(added).toEqual(["r#1", "r#4"]);
  });
});
