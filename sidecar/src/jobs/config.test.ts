import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_JOB_CONFIG, getJobConfig, saveJobConfig } from "./config.ts";

let dir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yarvis-jobs-config-"));
  originalPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
});

describe("job config", () => {
  it("returns the built-in defaults when nothing is saved", async () => {
    expect(await getJobConfig()).toEqual(DEFAULT_JOB_CONFIG);
  });

  it("saves and reads back the config", async () => {
    const saved = await saveJobConfig({
      ccDigestEnabled: true,
      ccDigestProjectDirs: ["/Users/me/project"],
    });
    expect(saved.ccDigestEnabled).toBe(true);
    expect(saved.ccDigestProjectDirs).toEqual(["/Users/me/project"]);
    expect(await getJobConfig()).toEqual(saved);
  });

  it("keeps a single stored config across saves (overwrites in place)", async () => {
    await saveJobConfig({ ccDigestEnabled: true, ccDigestProjectDirs: ["a"] });
    await saveJobConfig({ ccDigestEnabled: true, ccDigestProjectDirs: ["b"] });
    expect(await getJobConfig()).toEqual({
      ccDigestEnabled: true,
      ccDigestProjectDirs: ["b"],
    });
  });
});
