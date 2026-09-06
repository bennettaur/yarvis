import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSection, withSection } from "../settings/store.ts";
import { DEFAULT_CHAT_CONFIG, getChatConfig, saveChatConfig } from "./config.ts";

let dir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yarvis-chat-config-"));
  originalPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
});

describe("chat config", () => {
  it("returns the defaults when nothing is saved", async () => {
    expect(await getChatConfig()).toEqual(DEFAULT_CHAT_CONFIG);
  });

  it("saves and reads back the budget", async () => {
    const saved = await saveChatConfig({ maxSteps: 40, maxOutputTokens: 8000 });
    expect(saved).toEqual({ maxSteps: 40, maxOutputTokens: 8000 });
    expect(await getChatConfig()).toEqual(saved);
  });

  // Null is a value here, not an absent field: it means "leave the provider's
  // own limit alone", which is not the same as "fall back to a default cap".
  it("keeps an explicit null output cap", async () => {
    await saveChatConfig({ maxSteps: 40, maxOutputTokens: 8000 });
    expect(await saveChatConfig({ maxSteps: 40, maxOutputTokens: null })).toEqual({
      maxSteps: 40,
      maxOutputTokens: null,
    });
  });

  it("leaves the other sections of the settings file alone", async () => {
    await withSection<{ keep: boolean }, void>("voiceConfig", () => ({
      next: { keep: true },
      result: undefined,
    }));
    await saveChatConfig({ maxSteps: 12, maxOutputTokens: null });
    expect(await readSection<{ keep: boolean }>("voiceConfig")).toEqual({ keep: true });
  });
});
