import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_VOICE_CONFIG, getVoiceConfig, saveVoiceConfig } from "./config.ts";

/**
 * The speech settings live in `~/.yarvis/settings.json` rather than the
 * frontend because the Telegram bot runs in this process and cannot read a
 * browser's localStorage (see issue #226). These cover the round trip every
 * surface depends on.
 */

let dir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yarvis-voice-config-"));
  originalPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
});

describe("voice config", () => {
  it("answers defaults before anything is configured", async () => {
    expect(await getVoiceConfig()).toEqual(DEFAULT_VOICE_CONFIG);
  });

  it("saves and reads back a partial configuration merged onto the defaults", async () => {
    const saved = await saveVoiceConfig({
      sttProvider: "custom:abc",
      sttModel: "gemma4:latest",
      sttLanguage: "en",
      ttsProvider: "custom:abc",
      ttsModel: "mlx-community/Soprano-1.1-80M-bf16",
      ttsExtras: { response_format: "wav" },
      handsFree: true,
    });
    expect(saved).toEqual({
      ...DEFAULT_VOICE_CONFIG,
      sttProvider: "custom:abc",
      sttModel: "gemma4:latest",
      sttLanguage: "en",
      ttsProvider: "custom:abc",
      ttsModel: "mlx-community/Soprano-1.1-80M-bf16",
      ttsExtras: { response_format: "wav" },
      handsFree: true,
    });

    expect(await getVoiceConfig()).toEqual(saved);
  });

  it("keeps a single merged object across repeated saves", async () => {
    await saveVoiceConfig({ sttModel: "first" });
    await saveVoiceConfig({ ttsModel: "second" });

    // A later save must not wipe what an earlier one set.
    const config = await getVoiceConfig();
    expect(config.sttModel).toBe("first");
    expect(config.ttsModel).toBe("second");
  });

  it("treats blank as clearing a selection", async () => {
    await saveVoiceConfig({
      sttProvider: "huggingface",
      ttsRefAudio: "data:audio/wav;base64,AAAA",
    });
    await saveVoiceConfig({ sttProvider: "", ttsRefAudio: "" });

    const config = await getVoiceConfig();
    expect(config.sttProvider).toBe("");
    expect(config.ttsRefAudio).toBe("");
  });
});
