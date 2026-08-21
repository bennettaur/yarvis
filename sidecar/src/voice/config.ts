import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type VoiceConfigRow, voiceConfig } from "../db/schema.ts";
import type { SynthesisExtras } from "./speech.ts";

/**
 * Singleton store for the speech settings, kept the same way the embeddings
 * provider is: at most one row, the most recent.
 */

export interface VoiceConfigInput {
  sttProvider: string;
  sttModel: string;
  sttLanguage: string;
  ttsProvider: string;
  ttsModel: string;
  ttsVoice: string;
  ttsRefAudio: string;
  ttsExtras: SynthesisExtras;
  speakReplies: boolean;
  handsFree: boolean;
}

/**
 * What every surface sees before anything is configured. Blank providers mean
 * "not set up", which the UI reports rather than failing a request over.
 */
export const DEFAULT_VOICE_CONFIG: VoiceConfigInput = {
  sttProvider: "",
  sttModel: "",
  sttLanguage: "",
  ttsProvider: "",
  ttsModel: "",
  ttsVoice: "",
  ttsRefAudio: "",
  ttsExtras: {},
  speakReplies: true,
  handsFree: false,
};

/** Returns the stored settings, or the defaults when none have been saved. */
export async function getVoiceConfig(db: Db): Promise<VoiceConfigInput> {
  const row = await getVoiceConfigRow(db);
  if (!row) return { ...DEFAULT_VOICE_CONFIG };
  return {
    sttProvider: row.sttProvider,
    sttModel: row.sttModel,
    sttLanguage: row.sttLanguage,
    ttsProvider: row.ttsProvider,
    ttsModel: row.ttsModel,
    ttsVoice: row.ttsVoice,
    ttsRefAudio: row.ttsRefAudio,
    ttsExtras: row.ttsExtras,
    speakReplies: row.speakReplies,
    handsFree: row.handsFree,
  };
}

async function getVoiceConfigRow(db: Db): Promise<VoiceConfigRow | null> {
  const [row] = await db.select().from(voiceConfig).orderBy(desc(voiceConfig.updatedAt)).limit(1);
  return row ?? null;
}

/** Upserts the singleton row, updating in place when one already exists. */
export async function saveVoiceConfig(
  db: Db,
  input: Partial<VoiceConfigInput>,
): Promise<VoiceConfigInput> {
  const existing = await getVoiceConfigRow(db);
  if (existing) {
    await db
      .update(voiceConfig)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(voiceConfig.id, existing.id));
  } else {
    await db.insert(voiceConfig).values({ ...DEFAULT_VOICE_CONFIG, ...input });
  }
  return getVoiceConfig(db);
}
