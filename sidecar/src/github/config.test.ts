import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GITHUB_PR_CONFIG, getGithubPrConfig, saveGithubPrConfig } from "./config.ts";

let dir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yarvis-github-config-"));
  originalPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
});

describe("github pr config", () => {
  it("returns the built-in defaults when nothing is saved", async () => {
    expect(await getGithubPrConfig()).toEqual(DEFAULT_GITHUB_PR_CONFIG);
  });

  it("saves and reads back the config", async () => {
    const saved = await saveGithubPrConfig({
      reviewQuery: "is:open is:pr review-requested:@me -is:draft org:acme",
      reviewingLookbackDays: 7,
    });
    expect(saved.reviewQuery).toContain("org:acme");
    expect(saved.reviewingLookbackDays).toBe(7);
    expect(await getGithubPrConfig()).toEqual(saved);
  });

  it("keeps a single stored config across saves (overwrites in place)", async () => {
    await saveGithubPrConfig({ reviewQuery: "is:pr a", reviewingLookbackDays: 10 });
    await saveGithubPrConfig({ reviewQuery: "is:pr b", reviewingLookbackDays: 20 });
    expect(await getGithubPrConfig()).toEqual({
      reviewQuery: "is:pr b",
      reviewingLookbackDays: 20,
    });
  });
});
