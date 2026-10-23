import { describe, expect, it } from "bun:test";
import { prConflictState } from "./conflicts";
import type { PrDetail } from "./types";

const detail = (over: Partial<PrDetail>) =>
  ({ state: "OPEN", mergeable: "MERGEABLE", ...over }) as PrDetail;

describe("prConflictState", () => {
  it("reports GitHub's CONFLICTING verdict", () => {
    expect(prConflictState(detail({ mergeable: "CONFLICTING" }))).toBe("conflicts");
  });

  // GitHub can say DIRTY before `mergeable` settles.
  it("reports GitHub's DIRTY merge state even while mergeable is unknown", () => {
    expect(prConflictState(detail({ mergeable: "UNKNOWN", mergeStateStatus: "DIRTY" }))).toBe(
      "conflicts",
    );
    expect(prConflictState(detail({ mergeStateStatus: "dirty" }))).toBe("conflicts");
  });

  it("reports an Azure DevOps PR whose merge status is conflicts", () => {
    // The sidecar maps Azure's `conflicts` onto the shared enum.
    expect(prConflictState(detail({ state: "active", mergeable: "CONFLICTING" }))).toBe(
      "conflicts",
    );
  });

  it("treats UNKNOWN as still being computed, not as conflicts", () => {
    expect(prConflictState(detail({ mergeable: "UNKNOWN" }))).toBe("computing");
  });

  it("reports nothing for a clean, behind or blocked PR", () => {
    expect(prConflictState(detail({}))).toBe("none");
    expect(prConflictState(detail({ mergeStateStatus: "BEHIND" }))).toBe("none");
    expect(prConflictState(detail({ mergeStateStatus: "BLOCKED" }))).toBe("none");
  });

  it("reports nothing for a merged or abandoned PR, or none loaded", () => {
    expect(prConflictState(detail({ state: "MERGED", mergeable: "CONFLICTING" }))).toBe("none");
    expect(prConflictState(detail({ state: "abandoned", mergeable: "CONFLICTING" }))).toBe("none");
    expect(prConflictState(null)).toBe("none");
  });
});
