import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WipSourcesConfig } from "../db/schema.ts";
import { readSection, withSection } from "../settings/store.ts";
import { DEFAULT_WIP_CONFIG, getWipConfig, saveWipConfig } from "./config.ts";

let dir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yarvis-wip-config-"));
  originalPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
});

describe("wip config", () => {
  it("returns all-on defaults when nothing is saved", async () => {
    expect(await getWipConfig()).toEqual(DEFAULT_WIP_CONFIG);
  });

  it("saves and reads back the config", async () => {
    const saved = await saveWipConfig({
      sources: { myPrs: false, starredPrs: true, issues: true, tasks: false, workspaces: true },
      issueLabels: ["in-progress", "doing"],
    });
    expect(saved.sources.myPrs).toBe(false);
    expect(saved.issueLabels).toEqual(["in-progress", "doing"]);
    expect(await getWipConfig()).toEqual(saved);
  });

  it("keeps a single row across saves (updates in place)", async () => {
    await saveWipConfig({ ...DEFAULT_WIP_CONFIG, issueLabels: ["a"] });
    await saveWipConfig({ ...DEFAULT_WIP_CONFIG, issueLabels: ["b"] });
    // The section holds one plain object, not an accumulated history of saves.
    expect(await readSection<typeof DEFAULT_WIP_CONFIG>("wipConfig")).toEqual({
      ...DEFAULT_WIP_CONFIG,
      issueLabels: ["b"],
    });
  });

  it("backfills a missing source key from defaults", async () => {
    // Simulate a config saved before a new source key existed (partial sources).
    await withSection<{ sources: Partial<WipSourcesConfig>; issueLabels: string[] }, void>(
      "wipConfig",
      () => ({
        next: { sources: { myPrs: false }, issueLabels: [] },
        result: undefined,
      }),
    );
    const config = await getWipConfig();
    expect(config.sources.myPrs).toBe(false); // saved value wins
    expect(config.sources.workspaces).toBe(true); // missing key defaults on
  });
});
