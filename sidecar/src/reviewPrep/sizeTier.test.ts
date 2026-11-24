import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SECTIONS } from "../reviewWorkspaces/verification.ts";
import {
  DEFAULT_SIZE_TIERS,
  getSizeTierConfig,
  isGenerated,
  measure,
  pickTier,
  tierLine,
  tierSections,
} from "./sizeTier.ts";

const file = (path: string, lines: number, binary = false) => ({
  path,
  binary,
  additions: lines,
  deletions: 0,
});
const skim = (kind: string) => ({ skim: kind, markedByPr: false });

describe("measuring a PR for its tier", () => {
  it("leaves lockfiles, snapshots and migration metadata out of the counted size", () => {
    const files = [
      file("src/a.ts", 10),
      file("bun.lock", 900),
      file("src/__snapshots__/a.test.ts.snap", 300),
      file("sidecar/drizzle/meta/0063_snapshot.json", 4000),
      file("sidecar/drizzle/meta/_journal.json", 7),
      file("image.png", 0, true),
    ];
    const bulk = new Map([["bun.lock", skim("lockfile")]]);
    expect(measure(files, bulk)).toEqual({
      counted: { files: 2, changedLines: 10 },
      total: { files: 6, changedLines: 5217 },
    });
  });

  it("counts a file the PR marked generated itself", () => {
    expect(isGenerated("src/evil.ts", { skim: null, markedByPr: true })).toBe(false);
    expect(isGenerated("src/meta/0001_snapshot.json")).toBe(true);
    expect(isGenerated("src/snapshot.ts")).toBe(false);
  });
});

describe("picking a tier", () => {
  const size = (counted: [number, number], total: [number, number]) => ({
    counted: { files: counted[0], changedLines: counted[1] },
    total: { files: total[0], changedLines: total[1] },
  });

  it("is small at or under both small limits, counting every file", () => {
    expect(pickTier(size([1, 20], [2, 20]), DEFAULT_SIZE_TIERS)).toBe("small");
    // A two-line change beside a lockfile bump isn't small.
    expect(pickTier(size([1, 2], [2, 400]), DEFAULT_SIZE_TIERS)).toBe("normal");
    expect(pickTier(size([3, 3], [3, 3]), DEFAULT_SIZE_TIERS)).toBe("normal");
  });

  it("is big at either big limit, counting only written files", () => {
    expect(pickTier(size([1, 500], [1, 500]), DEFAULT_SIZE_TIERS)).toBe("big");
    expect(pickTier(size([10, 30], [10, 30]), DEFAULT_SIZE_TIERS)).toBe("big");
    expect(pickTier(size([2, 40], [3, 9000]), DEFAULT_SIZE_TIERS)).toBe("normal");
  });

  it("runs the summary and risk when small, the repo's set when normal, and adds the diagram when big", () => {
    const repo = ["summary", "tests", "repoVerify"] as const;
    expect(tierSections("small", repo)).toEqual(["summary", "risk"]);
    expect(tierSections("normal", repo)).toEqual([...repo]);
    expect(tierSections("big", repo)).toEqual(["summary", "tests", "repoVerify", "flow"]);
    expect(tierSections("big", [...DEFAULT_SECTIONS, "flow"])).toEqual([
      ...DEFAULT_SECTIONS,
      "flow",
    ]);
  });

  it("says which tier ran", () => {
    const sized = { sections: [], size: { files: 1, changedLines: 1 } };
    expect(tierLine({ ...sized, tier: "small" }, null)).toBe(
      "Small PR (1 changed line in 1 file, generated files left out): only the summary and risk checks ran, since reading it is quicker.",
    );
    expect(tierLine({ tier: "normal", sections: [], size: null }, null)).toBe(
      "Normal PR (size unknown): the repo's default checks ran.",
    );
    expect(tierLine({ ...sized, tier: "big" }, "The Story walkthrough is ready.")).toEndWith(
      "the flow diagram ran too. The Story walkthrough is ready.",
    );
  });
});

describe("the size thresholds", () => {
  let dir: string;
  let previous: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yarvis-size-tiers-"));
    previous = process.env.YARVIS_SETTINGS_PATH;
    process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
  });

  afterEach(() => {
    process.env.YARVIS_SETTINGS_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to 20 lines and 2 files for small, 500 lines or 10 files for big", async () => {
    expect(await getSizeTierConfig()).toEqual({
      smallMaxLines: 20,
      smallMaxFiles: 2,
      bigMinLines: 500,
      bigMinFiles: 10,
    });
  });

  it("reads reviewPrep.sizeTiers, falling back per value on anything that isn't a count", async () => {
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ reviewPrep: { sizeTiers: { smallMaxLines: 5, bigMinFiles: "lots" } } }),
    );
    expect(await getSizeTierConfig()).toEqual({ ...DEFAULT_SIZE_TIERS, smallMaxLines: 5 });
  });
});
