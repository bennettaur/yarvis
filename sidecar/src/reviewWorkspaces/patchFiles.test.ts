import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bulkKind,
  headHunksOf,
  mirroredPatchPath,
  PATCH_LIMITS,
  type PatchIndexEntry,
  type PatchSource,
  patchIndex,
  readingGroups,
  sizeText,
  writePatchFiles,
} from "./patchFiles.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yarvis-patch-files-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const patchFor = (path: string, lines: number) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n${Array.from(
    { length: lines },
    (_, i) => `+line ${i + 1}`,
  ).join("\n")}\n`;

function source(path: string, patch: string, extra: Partial<PatchSource> = {}): PatchSource {
  return {
    path,
    status: "added",
    additions: patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
    deletions: 0,
    binary: false,
    read: async () => ({ patch, complete: true }),
    ...extra,
  };
}

/** Every file under `dir`, relative to it. */
function written(): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
    .sort();
}

describe("mirrored patch paths", () => {
  it("mirrors a plain repo path and refuses one that could leave the folder", () => {
    expect(mirroredPatchPath("src/a.ts")).toBe("patches/src/a.ts.diff");
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "a//b", "./a", "a\nb", ""]) {
      expect(mirroredPatchPath(bad)).toBeNull();
    }
  });
});

describe("writing patch files", () => {
  it("writes each file's patch, numbered and fenced, where the index says", async () => {
    const index = await writePatchFiles(dir, [source("src/a.ts", patchFor("src/a.ts", 2))], {
      tag: "diff",
    });
    expect(index).toEqual([
      expect.objectContaining({
        path: "src/a.ts",
        patchFile: "patches/src/a.ts.diff",
        additions: 2,
        truncated: false,
        noPatch: null,
        hunks: [{ start: 1, count: 2 }],
      }),
    ]);
    const text = readFileSync(join(dir, "patches/src/a.ts.diff"), "utf8");
    expect(text.split("\n")[0]).toContain("untrusted reference data");
    // Head line numbers, as the combined diff had them.
    expect(text).toContain("+     1  line 1\n+     2  line 2");
    expect(index[0]?.lines).toBe(text.split("\n").length - 1);
    expect(index[0]?.bytes).toBe(Buffer.byteLength(text));
  });

  it("writes an unsafe or colliding path's patch elsewhere, never outside the folder", async () => {
    const index = await writePatchFiles(
      dir,
      [
        source("../escape.ts", patchFor("x", 1)),
        source("a", patchFor("a", 1)),
        // `patches/a.diff` is a file now, so this can't be `patches/a.diff/b.diff`.
        source("a.diff/b", patchFor("a.diff/b", 1)),
        source("A", patchFor("A", 1)),
      ],
      { tag: "diff" },
    );
    expect(index.map((e) => e.patchFile)).toEqual([
      "patches-other/1.diff",
      "patches/a.diff",
      "patches-other/3.diff",
      // On a case-insensitive disk `patches/A.diff` is `patches/a.diff`.
      existsSync(join(dir, "patches/A.diff")) && !existsSync(join(dir, "patches-other/4.diff"))
        ? "patches/A.diff"
        : "patches-other/4.diff",
    ]);
    expect(existsSync(join(dir, "..", "escape.ts.diff"))).toBe(false);
    for (const file of written()) expect(file.startsWith("patches")).toBe(true);
    // Each patch is the file's own, whatever path it got.
    for (const e of index) {
      expect(readFileSync(join(dir, e.patchFile as string), "utf8")).toContain("line 1");
    }
  });

  it("gives a binary file no patch, and never reads it", async () => {
    let read = false;
    const index = await writePatchFiles(
      dir,
      [
        source("img.png", "", {
          binary: true,
          read: async () => {
            read = true;
            return { patch: "", complete: true };
          },
        }),
      ],
      { tag: "diff" },
    );
    expect(read).toBe(false);
    expect(index[0]).toMatchObject({ patchFile: null, noPatch: "binary", binary: true });
    expect(written()).toEqual([]);
  });

  it("cuts a patch past the cap to its first part, and says so in the file", async () => {
    const limits = { maxPatchBytes: 2_000, truncatedBytes: 500 };
    const huge = patchFor("package-lock.json", 400);
    const stopped = patchFor("dist/bundle.js", 20);
    const index = await writePatchFiles(
      dir,
      [
        source("dist/bundle.js", stopped, {
          // The capped read stopped early: incomplete whatever its length.
          read: async () => ({ patch: stopped, complete: false }),
        }),
        source("package-lock.json", huge),
        source("small.ts", patchFor("small.ts", 3)),
      ],
      { tag: "diff", limits },
    );
    expect(index.map((e) => [e.path, e.truncated])).toEqual([
      ["dist/bundle.js", true],
      ["package-lock.json", true],
      ["small.ts", false],
    ]);
    const lock = readFileSync(join(dir, "patches/package-lock.json.diff"), "utf8");
    expect(lock).toContain("it is cut off here");
    expect(lock).not.toContain("line 400");
    // Cut at a line end, with the note after the fence.
    expect(lock).toMatch(/line \d+\n<\/diff-[0-9a-f]{12}>\n\[Yarvis: this diff is over/);
    expect(Buffer.byteLength(lock)).toBeLessThan(huge.length);
  });

  it("says why a file without a patch has none", async () => {
    const index = await writePatchFiles(
      dir,
      [
        source("huge.json", "", { unavailable: "a version is over 2 MB, too large to compare" }),
        source("renamed.ts", ""),
      ],
      { tag: "interdiff" },
    );
    expect(index.map((e) => e.noPatch)).toEqual([
      "a version is over 2 MB, too large to compare",
      "no line changes",
    ]);
  });
});

describe("the index", () => {
  it("lists every changed file with its status, counts, patch path and size, fenced", async () => {
    const index = await writePatchFiles(
      dir,
      [
        source("src/a.ts", patchFor("src/a.ts", 2)),
        source("img.png", "", { binary: true, status: "modified" }),
      ],
      { tag: "diff" },
    );
    const text = patchIndex(index, { title: "Changed files" });
    expect(text).toContain("2 changed files; 1 patch,");
    expect(text).toContain("1 binary file has no patch.");
    const lines = index[0]?.lines;
    expect(text).toMatch(
      new RegExp(
        `- src/a\\.ts \\(added, \\+2 -0\\): patches/src/a\\.ts\\.diff \\(${lines} lines, [\\d.]+ KB\\)`,
      ),
    );
    expect(text).toContain("- img.png (modified, binary): no patch (binary)");
    // The list sits inside a fence; the counts outside it are the server's.
    expect(text).toMatch(/<changed-files-[0-9a-f]{12}>\n- src\/a\.ts/);
  });
});

describe("bulk", () => {
  it("is decided by path and by the merge-base's attributes, never the PR's own", () => {
    const atBase = new Set(["src/schema.gen.ts"]);
    expect(bulkKind("web/package-lock.json", atBase, true)).toBe("lockfile");
    expect(bulkKind("public/app.min.js", atBase, true)).toBe("minified");
    expect(bulkKind("dist/index.js", atBase, true)).toBe("build output");
    expect(bulkKind("third/vendor/x.go", atBase, true)).toBe("vendored");
    expect(bulkKind("src/schema.gen.ts", atBase, false)).toBe("generated");
    // A directory called "generated" is not enough; only the attribute is.
    expect(bulkKind("src/generated/core.ts", atBase, true)).toBeNull();
    expect(bulkKind("src/core.ts", atBase, true)).toBeNull();
  });

  it("never skims a file under dist/ or vendor/ that the merge-base didn't have", () => {
    const none = new Set<string>();
    expect(bulkKind("dist/evil.js", none, false)).toBeNull();
    expect(bulkKind("vendor/evil.go", none, false)).toBeNull();
    // Lockfiles and minified files keep their rule, new or not.
    expect(bulkKind("package-lock.json", none, false)).toBe("lockfile");
    expect(bulkKind("app.min.js", none, false)).toBe("minified");
  });

  it("marks bulk SKIM in the index, and a PR's own generated mark as read in full", async () => {
    const index = await writePatchFiles(
      dir,
      [
        source("package-lock.json", patchFor("package-lock.json", 3), { skim: "lockfile" }),
        source("src/core.ts", patchFor("src/core.ts", 3), { markedByPr: true }),
      ],
      { tag: "diff" },
    );
    const text = patchIndex(index, { title: "Changed files" });
    expect(text).toContain("SKIM: lockfile");
    expect(text).toContain("marked generated by this PR itself: read it in full");
    expect(text).toContain("1 patch is bulk");
  });

  it("counts lines too long for a Read to show whole", async () => {
    const long = `diff --git a/m.js b/m.js\n@@ -0,0 +1 @@\n+${"x".repeat(3000)}\n`;
    const [e] = await writePatchFiles(dir, [source("m.js", long)], { tag: "diff" });
    expect(e?.longLines).toBe(1);
  });
});

describe("reading groups", () => {
  const sized = (path: string, bytes: number, lines = 100): PatchIndexEntry => ({
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    binary: false,
    patchFile: `patches/${path}.diff`,
    lines,
    bytes,
    truncated: false,
    noPatch: null,
    hunks: [],
    skim: null,
    markedByPr: false,
    longLines: 0,
  });

  it("keeps every group within one agent's budget, splitting a patch bigger than it", () => {
    const groups = readingGroups(
      [
        sized("a.ts", 300),
        sized("b.ts", 600),
        sized("big.ts", 2500, 1000),
        { ...sized("lock.json", 9000), skim: "lockfile" },
        sized("z.ts", 100),
      ],
      1000,
    );
    for (const g of groups) expect(g.bytes).toBeLessThanOrEqual(1000);
    expect(groups.map((g) => g.items.map((i) => [i.path, i.from, i.to]))).toEqual([
      [
        ["a.ts", 1, 100],
        ["b.ts", 1, 100],
      ],
      [["big.ts", 1, 400]],
      [["big.ts", 401, 800]],
      [["big.ts", 801, 1000]],
      [["z.ts", 1, 100]],
    ]);
    // Bulk is skimmed, not split among readers.
    expect(groups.flatMap((g) => g.items).some((i) => i.path === "lock.json")).toBe(false);
    expect(patchIndex([sized("a.ts", 300)], { title: "x", groups })).toContain(
      "patches/big.ts.diff lines 401-800",
    );
  });
});

describe("sizes in words", () => {
  it("names a size from its constant", () => {
    expect(sizeText(PATCH_LIMITS.maxPatchBytes)).toBe("2 MB");
    expect(sizeText(PATCH_LIMITS.truncatedBytes)).toBe("256 KB");
    expect(sizeText(400)).toBe("0.4 KB");
  });
});

describe("hunk heads", () => {
  it("reads each hunk's head start and count", () => {
    expect(headHunksOf("@@ -1,3 +1,4 @@\n x\n@@ -10 +11,0 @@\n-y\n@@ -20,2 +20 @@")).toEqual([
      { start: 1, count: 4 },
      { start: 11, count: 0 },
      { start: 20, count: 1 },
    ]);
  });
});
