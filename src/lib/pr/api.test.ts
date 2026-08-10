import { describe, expect, it } from "bun:test";
import { disableAutoMerge, enableAutoMerge, mergePr } from "./api";
import type { PrRef } from "./types";

const azureRef: PrRef = { provider: "azure", org: "acme", project: "Shop", repo: "web", prId: 7 };

// Merge is GitHub-only; the dispatch must refuse an Azure ref rather than route
// it to a non-existent Azure transport. The UI already hides the buttons for
// Azure, so this guards the boundary in case a caller reaches it directly.
describe("merge dispatch rejects non-github refs", () => {
  it("mergePr throws for an azure ref", () => {
    expect(() => mergePr(azureRef, "MERGE")).toThrow(/only supported for GitHub/);
  });

  it("enableAutoMerge throws for an azure ref", () => {
    expect(() => enableAutoMerge(azureRef, "SQUASH")).toThrow(/only supported for GitHub/);
  });

  it("disableAutoMerge throws for an azure ref", () => {
    expect(() => disableAutoMerge(azureRef)).toThrow(/only supported for GitHub/);
  });
});
