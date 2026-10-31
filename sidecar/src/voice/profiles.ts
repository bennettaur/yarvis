import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "../config.ts";
import { readSection, settingsPath, withSection } from "../settings/store.ts";
import { resolveSpeechClient } from "./providers.ts";
import type { SpeechAudio, SynthesisExtras } from "./speech.ts";

/**
 * Saved voices: a named text-to-speech setup the user can switch replies to, or
 * pick several of in the Voice Studio.
 *
 * The settings live under `voiceProfiles` in `~/.yarvis/settings.json` like the
 * rest of the speech config. A cloning clip does not: it is up to a few
 * megabytes of audio, so it sits beside the settings file as `voices/<id>.wav`
 * and the profile only records that it has one.
 */

/**
 * How a cloning clip reaches the speech server. mlx-audio reads `ref_audio` as
 * a path on its own disk; vLLM-Omni wants the audio itself as a data URI.
 */
export type RefAudioMode = "path" | "inline";

export interface VoiceProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  /** Provider-specific voice id. Cloning models ignore it. */
  voice: string;
  hasClip: boolean;
  refAudioMode: RefAudioMode;
  extras: SynthesisExtras;
  createdAt: string;
  updatedAt: string;
}

export type VoiceProfileInput = Pick<
  VoiceProfile,
  "name" | "provider" | "model" | "voice" | "refAudioMode" | "extras"
>;

const SETTINGS_KEY = "voiceProfiles";

type ProfilesSection = Record<string, VoiceProfile>;

/** Largest clip accepted. Ten seconds of 48 kHz mono 16-bit WAV is under 1 MB. */
export const MAX_CLIP_BYTES = 3 * 1024 * 1024;

/**
 * Sample rates a cloning model handles. 44.1 kHz is left out on purpose:
 * MOSS-TTS-Nano accepts it without an error and then rambles for a minute.
 */
const CLIP_SAMPLE_RATES = new Set([16_000, 24_000, 48_000]);

/** Folder holding the cloning clips, next to `settings.json` so tests that move one move both. */
export function voicesDir(): string {
  return join(dirname(settingsPath()), "voices");
}

/** Profile ids come from `crypto.randomUUID`, and only that shape is ever joined onto a path. */
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function clipPath(id: string): string {
  if (!PROFILE_ID.test(id)) throw new Error(`invalid voice id: ${id}`);
  return join(voicesDir(), `${id}.wav`);
}

export async function listVoiceProfiles(): Promise<VoiceProfile[]> {
  const section = await readSection<ProfilesSection>(SETTINGS_KEY);
  return Object.values(section ?? {}).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Ids arrive from requests, so a lookup must not land on an inherited key:
 * `constructor` would read as a profile and an update would store one.
 */
function ownProfile(section: ProfilesSection | undefined, id: string): VoiceProfile | null {
  if (!PROFILE_ID.test(id) || !section || !Object.hasOwn(section, id)) return null;
  return section[id] ?? null;
}

export async function getVoiceProfile(id: string): Promise<VoiceProfile | null> {
  return ownProfile(await readSection<ProfilesSection>(SETTINGS_KEY), id);
}

export async function createVoiceProfile(input: VoiceProfileInput): Promise<VoiceProfile> {
  return withSection<ProfilesSection, VoiceProfile>(SETTINGS_KEY, (current) => {
    const now = new Date().toISOString();
    const row: VoiceProfile = {
      id: crypto.randomUUID(),
      ...input,
      hasClip: false,
      createdAt: now,
      updatedAt: now,
    };
    return { next: { ...current, [row.id]: row }, result: row };
  });
}

export async function updateVoiceProfile(
  id: string,
  patch: Partial<VoiceProfileInput> & { hasClip?: boolean },
): Promise<VoiceProfile | null> {
  return withSection<ProfilesSection, VoiceProfile | null>(SETTINGS_KEY, (current) => {
    const existing = ownProfile(current, id);
    if (!existing) return { next: current ?? {}, result: null };
    const row = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    return { next: { ...current, [id]: row }, result: row };
  });
}

/** Removes the profile and its clip. */
export async function deleteVoiceProfile(id: string): Promise<boolean> {
  const removed = await withSection<ProfilesSection, boolean>(SETTINGS_KEY, (current) => {
    if (!current || !ownProfile(current, id)) return { next: current ?? {}, result: false };
    const { [id]: _, ...rest } = current;
    return { next: rest, result: true };
  });
  if (removed) await rm(clipPath(id), { force: true });
  return removed;
}

/**
 * Reads the sample rate out of a PCM WAV header, or throws when the bytes are
 * not one. Only the fixed 44-byte canonical header is read, which is what the
 * app's own encoder (`src/lib/audioEncoding.ts`) writes.
 */
export function wavSampleRate(bytes: Uint8Array): number {
  const ascii = (start: number) => String.fromCharCode(...bytes.subarray(start, start + 4));
  if (bytes.byteLength < 44 || ascii(0) !== "RIFF" || ascii(8) !== "WAVE") {
    throw new Error("the clip must be a WAV file");
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(24, true);
}

/** Stores a cloning clip for the profile, replacing any earlier one. */
export async function saveVoiceClip(id: string, wav: Uint8Array): Promise<VoiceProfile | null> {
  if (!(await getVoiceProfile(id))) return null;
  if (wav.byteLength > MAX_CLIP_BYTES) {
    throw new Error(`the clip exceeds ${MAX_CLIP_BYTES} bytes; a few seconds of speech is enough`);
  }
  const rate = wavSampleRate(wav);
  if (!CLIP_SAMPLE_RATES.has(rate)) {
    throw new Error(`the clip is ${rate} Hz; use 16, 24 or 48 kHz`);
  }
  await mkdir(voicesDir(), { recursive: true, mode: 0o700 });
  const path = clipPath(id);
  await writeFile(path, wav, { mode: 0o600 });
  await chmod(path, 0o600);
  return updateVoiceProfile(id, { hasClip: true });
}

export async function deleteVoiceClip(id: string): Promise<VoiceProfile | null> {
  if (!(await getVoiceProfile(id))) return null;
  await rm(clipPath(id), { force: true });
  return updateVoiceProfile(id, { hasClip: false });
}

/** The `ref_audio` value for a profile's clip, in the form its server reads. */
async function refAudioFor(profile: VoiceProfile): Promise<string | undefined> {
  if (!profile.hasClip) return undefined;
  const path = clipPath(profile.id);
  if (profile.refAudioMode === "path") return path;
  const bytes = await readFile(path);
  return `data:audio/wav;base64,${bytes.toString("base64")}`;
}

/** Speaks `text` in a saved voice. */
export async function speakWithProfile(
  config: Config,
  profile: VoiceProfile,
  text: string,
): Promise<SpeechAudio> {
  const client = await resolveSpeechClient(config, profile.provider);
  return client.synthesize({
    text,
    model: profile.model,
    voice: profile.voice || undefined,
    refAudio: await refAudioFor(profile),
    extras: profile.extras,
  });
}
