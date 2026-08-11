import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as api from "../api";
import {
  deletePrGuide,
  fetchPrGuide,
  type PrGuideStep,
  setPrGuideProgress,
  stepPaths,
} from "./guide";
import type { PrRef } from "./types";

/**
 * The guide routes take a ref in the query for GET and DELETE, which can carry
 * no body. These assert the shape the sidecar's `parseRefQuery` reassembles —
 * the two have to agree field for field or a read silently 400s.
 */
const calls: { path: string; init?: RequestInit }[] = [];

// A spy, not `mock.module`: that patches the `../api` namespace for the rest of
// the process — and `mock.restore()` does not undo it — so a stub registered
// here would go on answering for every file loaded afterwards. Only the
// transport is replaced, which leaves the real `ensureOk` guarding these calls.
const sidecarFetch = spyOn(api, "sidecarFetch").mockImplementation(
  async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return new Response(JSON.stringify({ guide: null, deleted: true }), { status: 200 });
  },
);

afterAll(() => {
  sidecarFetch.mockRestore();
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

/**
 * Advancing past a step marks everything it accounted for as viewed, so this
 * has to name every file — a sanity-check step stands in for all of them.
 */
describe("stepPaths", () => {
  const step = (over: Partial<PrGuideStep> = {}): PrGuideStep => ({
    path: "src/api.ts",
    startLine: null,
    endLine: null,
    explanation: "",
    ...over,
  });

  it("is just the step's own file when it covers nothing else", () => {
    expect(stepPaths(step())).toEqual(["src/api.ts"]);
  });

  it("includes the files a sanity check covered", () => {
    expect(stepPaths(step({ covers: ["a.test.ts", "b.test.ts"] }))).toEqual([
      "src/api.ts",
      "a.test.ts",
      "b.test.ts",
    ]);
  });

  // The step's own path repeated in `covers` would mark the same file twice.
  it("does not repeat the step's own file", () => {
    expect(stepPaths(step({ covers: ["src/api.ts", "a.test.ts"] }))).toEqual([
      "src/api.ts",
      "a.test.ts",
    ]);
  });
});
