import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getReviewPrepConfig } from "./config.ts";

let dir: string;
let previous: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yarvis-prep-config-"));
  previous = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
});

afterEach(() => {
  if (previous === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = previous;
  rmSync(dir, { recursive: true, force: true });
});

const save = (reviewPrep: unknown) =>
  writeFileSync(process.env.YARVIS_SETTINGS_PATH as string, JSON.stringify({ reviewPrep }));

describe("getReviewPrepConfig", () => {
  it("defaults to two verifications at once and five PRs ready", async () => {
    expect(await getReviewPrepConfig()).toEqual({ maxConcurrentVerifications: 2, maxReady: 5 });
  });

  it("rounds and clamps hand-edited values rather than refusing them", async () => {
    save({ maxConcurrentVerifications: 9, maxReady: 7.6 });
    expect(await getReviewPrepConfig()).toEqual({ maxConcurrentVerifications: 5, maxReady: 8 });
    save({ maxConcurrentVerifications: 0, maxReady: 500 });
    expect(await getReviewPrepConfig()).toEqual({ maxConcurrentVerifications: 1, maxReady: 50 });
  });

  it("falls back to the default for a value that isn't a number", async () => {
    save({ maxReady: "lots" });
    expect((await getReviewPrepConfig()).maxReady).toBe(5);
  });
});
