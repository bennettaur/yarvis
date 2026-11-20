import { describe, expect, it } from "bun:test";
import type { PrCodeSource, UpstackLayer } from "./source.ts";
import { baseRanges, upstackChanges } from "./upstack.ts";

const sourceWith = (upstackLayers: PrCodeSource["upstackLayers"]) =>
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

  it("gives a new file no lines of this PR's", () => {
    expect(baseRanges("@@ -0,0 +1,3 @@\n+a\n+b\n+c")).toEqual([]);
  });
});

describe("upstackChanges", () => {
  it("lists each layer's files by this PR's path, with the head the layers are against", async () => {
    const changes = await upstackChanges(
      sourceWith(async () => ({
        headSha: "h",
        layers: [
          {
            number: 8,
            url: "u",
            incomplete: false,
            stale: true,
            files: [
              file({}),
              file({ filename: "src/b.ts", status: "removed", patch: null }),
              file({ filename: "src/big.ts", patch: null }),
              file({ filename: "src/new.ts", previousFilename: "src/old.ts", status: "renamed" }),
              file({
                filename: "src/moved.ts",
                previousFilename: "src/was.ts",
                status: "renamed",
                additions: 0,
                deletions: 0,
                patch: null,
              }),
            ],
          },
        ],
      })),
    );
    expect(changes).toEqual({
      headSha: "h",
      layers: [
        {
          number: 8,
          url: "u",
          stale: true,
          files: [
            { path: "src/a.ts", ranges: [{ start: 1, end: 1 }] },
            // Deleted, or a patch too big to send: any line may have changed.
            { path: "src/b.ts", ranges: null },
            { path: "src/big.ts", ranges: null },
            { path: "src/old.ts", ranges: [{ start: 1, end: 1 }] },
            // A pure rename changes no lines.
            { path: "src/was.ts", ranges: [] },
          ],
        },
      ],
      note: null,
    });
  });

  it("says when the provider has no stacks, or the layers can't be read", async () => {
    expect(await upstackChanges(sourceWith(async () => null))).toEqual({
      headSha: null,
      layers: [],
      note: "This provider has no stacked PRs.",
    });
    expect(
      await upstackChanges(
        sourceWith(async () => {
          throw new Error("GraphQL said no about branch evil/name");
        }),
      ),
    ).toEqual({ headSha: null, layers: [], note: "The layers above couldn't be read." });
  });
});
