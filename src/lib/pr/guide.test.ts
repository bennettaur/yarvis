import { afterAll, describe, expect, it, mock } from "bun:test";
import type { PrRef } from "./types";

/**
 * The guide routes take a ref in the query for GET and DELETE, which can carry
 * no body. These assert the shape the sidecar's `parseRefQuery` reassembles —
 * the two have to agree field for field or a read silently 400s.
 */
const calls: { path: string; init?: RequestInit }[] = [];
mock.module("../api", () => ({
  sidecarFetch: async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return new Response(JSON.stringify({ guide: null, deleted: true }), { status: 200 });
  },
  ensureOk: async () => {},
}));

const { deletePrGuide, fetchPrGuide, setPrGuideProgress } = await import("./guide");

// `mock.module` replaces the whole namespace for the rest of the process, so
// without this every file loaded after this one sees a `../api` reduced to two
// stubbed exports — and a `sidecarFetch` that answers every path with a guide.
afterAll(() => {
  mock.restore();
});

const ghRef: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 7 };
const azRef: PrRef = { provider: "azure", org: "acme", project: "Shop", repo: "web", prId: 7 };

const lastQuery = () => new URLSearchParams(calls[calls.length - 1]!.path.split("?")[1]);

describe("guide ref query", () => {
  it("carries every field of a github ref", async () => {
    await fetchPrGuide(ghRef);
    expect(Object.fromEntries(lastQuery())).toEqual({
      provider: "github",
      owner: "octo",
      repo: "repo",
      number: "7",
    });
  });

  // The organization travels even though the other Azure routes bind it from
  // configuration: the sidecar checks it against the configured org and refuses
  // a ref from anywhere else.
  it("carries every field of an azure ref, organization included", async () => {
    await fetchPrGuide(azRef);
    expect(Object.fromEntries(lastQuery())).toEqual({
      provider: "azure",
      org: "acme",
      project: "Shop",
      repo: "web",
      prId: "7",
    });
  });

  it("escapes values that would otherwise break the query", async () => {
    await fetchPrGuide({ ...azRef, project: "My Project&x=1" });
    expect(lastQuery().get("project")).toBe("My Project&x=1");
  });

  it("puts the ref in the query for a delete too", async () => {
    await deletePrGuide(ghRef);
    const last = calls[calls.length - 1]!;
    expect(last.init?.method).toBe("DELETE");
    expect(last.path).toContain("provider=github");
  });

  // Progress goes in a body, since PATCH can carry one and the ref is nested.
  it("sends progress as a body rather than a query", async () => {
    await setPrGuideProgress(ghRef, 3);
    const last = calls[calls.length - 1]!;
    expect(last.path).not.toContain("?");
    expect(JSON.parse(String(last.init?.body))).toEqual({ ref: ghRef, step: 3 });
  });
});
