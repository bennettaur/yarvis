import { describe, expect, it } from "bun:test";
import { prConflictState } from "./conflicts";
import type { PrDetail } from "./types";

const detail = (over: Partial<PrDetail>) =>
  ({ state: "OPEN", mergeable: "MERGEABLE", hasConflicts: false, ...over }) as PrDetail;

describe("prConflictState", () => {
  it("reports a PR the sidecar says conflicts", () => {
    expect(prConflictState(detail({ mergeable: "CONFLICTING", hasConflicts: true }))).toBe(
      "conflicts",
    );
  });

  // GitHub's DIRTY can arrive while `mergeable` is still UNKNOWN.
  it("reports conflicts even while mergeable is unknown", () => {
    expect(prConflictState(detail({ mergeable: "UNKNOWN", hasConflicts: true }))).toBe("conflicts");
  });

  it("reports an Azure DevOps PR with conflicts", () => {
    expect(
      prConflictState(detail({ state: "active", mergeable: "CONFLICTING", hasConflicts: true })),
    ).toBe("conflicts");
  });

  // Azure maps a policy rejection onto CONFLICTING too; there is nothing to resolve.
  it("does not read an Azure policy rejection as conflicts", () => {
    expect(prConflictState(detail({ state: "active", mergeable: "CONFLICTING" }))).toBe("none");
  });

  it("treats UNKNOWN as still being computed, not as conflicts", () => {
    expect(prConflictState(detail({ mergeable: "UNKNOWN" }))).toBe("computing");
  });

  it("reports nothing for a mergeable PR", () => {
    expect(prConflictState(detail({}))).toBe("none");
  });

  it("reports nothing for a merged or abandoned PR, or none loaded", () => {
    expect(prConflictState(detail({ state: "MERGED", hasConflicts: true }))).toBe("none");
    expect(prConflictState(detail({ state: "abandoned", hasConflicts: true }))).toBe("none");
    expect(prConflictState(null)).toBe("none");
  });
});
