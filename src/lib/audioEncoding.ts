/**
 * Converts a recording into 16 kHz mono PCM WAV before it is uploaded.
 *
 * MediaRecorder only emits compressed containers — Opus in WebM, or AAC in MP4
 * in the macOS WKWebView — and what a speech backend can decode varies more
 * than the OpenAI audio API suggests. Whisper servers take the compressed forms;
 * Ollama's transcription endpoint takes WAV and answers "Failed to load image or
 * audio file" for AAC. WAV is the one format every backend here accepts, and
 * the platform already has a decoder for whatever was recorded, so the
 * conversion costs one decode on a clip that is at most a minute long.
 *
 * 16 kHz mono is what speech models want: Whisper resamples to it internally,
 * and sending 48 kHz stereo just makes the upload four times bigger for no gain
 * in recognition.
 */

/** Sample rate every speech model here works in. */
export const SPEECH_SAMPLE_RATE = 16_000;

const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;
/** PCM. The only format written here. */
const WAV_FORMAT_PCM = 1;

/**
 * Wraps mono float samples in a RIFF/WAVE container as signed 16-bit PCM.
 * Exported for its own sake: the header is fiddly and worth testing directly.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + samples.length * BYTES_PER_SAMPLE);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  const dataBytes = samples.length * BYTES_PER_SAMPLE;
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size for PCM
  view.setUint16(20, WAV_FORMAT_PCM, true);
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 8 * BYTES_PER_SAMPLE, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    // Clamp before scaling: a sample outside [-1, 1] would otherwise wrap and
    // come back as a loud click.
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(
      WAV_HEADER_BYTES + i * BYTES_PER_SAMPLE,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/** Averages the channels of a decoded buffer down to one. */
function toMono(decoded: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = decoded;
  if (numberOfChannels === 1) return decoded.getChannelData(0);
  const mono = new Float32Array(length);
  for (let channel = 0; channel < numberOfChannels; channel++) {
    const data = decoded.getChannelData(channel);
    for (let i = 0; i < length; i++) mono[i]! += data[i]! / numberOfChannels;
  }
  return mono;
}

/**
 * Resamples with linear interpolation. Speech recognition is unbothered by the
 * imaging artifacts a proper low-pass would remove, and this keeps the
 * conversion to a few lines with no filter design.
 */
function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const next = Math.min(index + 1, samples.length - 1);
    const weight = position - index;
    out[i] = samples[index]! * (1 - weight) + samples[next]! * weight;
  }
  return out;
}

/**
 * Decodes a recorded blob and re-encodes it as 16 kHz mono WAV. Decoding is the
 * platform's job — it already understands whatever the recorder produced.
 */
export async function toSpeechWav(recording: Blob): Promise<Blob> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await recording.arrayBuffer());
    const mono = toMono(decoded);
    return encodeWav(resample(mono, decoded.sampleRate, SPEECH_SAMPLE_RATE), SPEECH_SAMPLE_RATE);
  } finally {
    await context.close().catch(() => {});
  }
}
