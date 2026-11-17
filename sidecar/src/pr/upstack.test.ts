import { describe, expect, it } from "bun:test";
import type { PrCodeSource, UpstackLayer } from "./source.ts";
import { baseRanges, upstackChanges } from "./upstack.ts";

const sourceWith = (upstackLayers: () => Promise<UpstackLayer[] | null>) =>
  ({ upstackLayers }) as unknown as PrCodeSource;

const file = (over: Partial<UpstackLayer["files"][number]>) => ({
  filename: "src/a.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-a\n+b",
  ...over,
});

describe("baseRanges", () => {
  it("reads each hunk's base side, an insertion as the line it follows", () => {
    expect(
      baseRanges("@@ -10,3 +10,4 @@ fn\n x\n@@ -40 +41 @@\n-y\n@@ -50,0 +52,2 @@\n+z"),
    ).toEqual([
      { start: 10, end: 12 },
      { start: 40, end: 40 },
      { start: 50, end: 50 },
    ]);
  });
});

describe("upstackChanges", () => {
  it("lists each layer's files by this PR's path, a deleted or unreadable one as wholly changed", async () => {
    const changes = await upstackChanges(
      sourceWith(async () => [
        {
          number: 8,
          url: "u",
          incomplete: true,
          files: [
            file({}),
            file({ filename: "src/b.ts", status: "removed", patch: null }),
            file({ filename: "src/big.ts", patch: null }),
            file({ filename: "src/new.ts", previousFilename: "src/old.ts", status: "renamed" }),
          ],
        },
      ]),
    );
    expect(changes).toEqual({
      layers: [
        {
          number: 8,
          url: "u",
          incomplete: true,
          files: [
            { path: "src/a.ts", ranges: [{ start: 1, end: 1 }] },
            { path: "src/b.ts", ranges: null },
            { path: "src/big.ts", ranges: null },
            { path: "src/old.ts", ranges: [{ start: 1, end: 1 }] },
          ],
        },
      ],
      note: null,
    });
  });

  it("says when the provider has no stacks, or the layers can't be read", async () => {
    expect(await upstackChanges(sourceWith(async () => null))).toEqual({
      layers: [],
      note: "This provider has no stacked PRs.",
    });
    expect(
      await upstackChanges(
        sourceWith(async () => {
          throw new Error("GraphQL said no about branch evil/name");
        }),
      ),
    ).toEqual({ layers: [], note: "The layers above couldn't be read." });
  });
});
