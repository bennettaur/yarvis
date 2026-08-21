import { describe, expect, it } from "bun:test";
import { encodeWav, SPEECH_SAMPLE_RATE } from "./audioEncoding";

/**
 * The WAV header is the part a backend's decoder actually reads, and a wrong
 * field there is invisible until a provider answers "failed to load audio
 * file". These assert the bytes directly rather than through a decoder.
 */

async function headerOf(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

const ascii = (view: DataView, offset: number, length: number) =>
  Array.from({ length }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join("");

describe("encodeWav", () => {
  it("writes a RIFF/WAVE header a decoder will accept", async () => {
    const samples = new Float32Array(8);
    const view = await headerOf(encodeWav(samples, SPEECH_SAMPLE_RATE));

    expect(ascii(view, 0, 4)).toBe("RIFF");
    expect(ascii(view, 8, 4)).toBe("WAVE");
    expect(ascii(view, 12, 4)).toBe("fmt ");
    expect(ascii(view, 36, 4)).toBe("data");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(SPEECH_SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
  });

  it("states the sizes the container claims", async () => {
    const samples = new Float32Array(100);
    const blob = encodeWav(samples, SPEECH_SAMPLE_RATE);
    const view = await headerOf(blob);

    // 44-byte header + 2 bytes per sample.
    expect(blob.size).toBe(44 + 200);
    expect(view.getUint32(4, true)).toBe(36 + 200); // RIFF size
    expect(view.getUint32(40, true)).toBe(200); // data size
    expect(view.getUint32(28, true)).toBe(SPEECH_SAMPLE_RATE * 2); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
  });

  it("declares audio/wav so the sidecar's content-type allowlist admits it", () => {
    expect(encodeWav(new Float32Array(4), SPEECH_SAMPLE_RATE).type).toBe("audio/wav");
  });

  it("scales samples across the signed 16-bit range", async () => {
    const view = await headerOf(encodeWav(Float32Array.from([0, 1, -1]), SPEECH_SAMPLE_RATE));
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32768);
  });

  it("clamps out-of-range samples instead of letting them wrap", async () => {
    // Wrapping would turn a loud passage into a burst of noise, which reads to
    // a speech model as anything but speech.
    const view = await headerOf(encodeWav(Float32Array.from([2, -2]), SPEECH_SAMPLE_RATE));
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
  });

  it("encodes an empty recording as a valid, empty file", async () => {
    const blob = encodeWav(new Float32Array(0), SPEECH_SAMPLE_RATE);
    const view = await headerOf(blob);
    expect(blob.size).toBe(44);
    expect(view.getUint32(40, true)).toBe(0);
  });
});
