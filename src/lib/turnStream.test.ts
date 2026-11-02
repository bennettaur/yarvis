import { describe, expect, it } from "bun:test";
import { createResampler, createTurnMessageHandler, toInt16 } from "./turnStream";

function ramp(length: number): Float32Array {
  return Float32Array.from({ length }, (_, i) => i / length);
}

describe("createResampler", () => {
  it("turns 48 kHz into a third as many samples", () => {
    const out = createResampler(48_000, 16_000)(ramp(4800));
    expect(out.length).toBeGreaterThanOrEqual(1599);
    expect(out.length).toBeLessThanOrEqual(1600);
  });

  it("gives the same output in chunks as in one piece", () => {
    // The worklet posts ~20 ms at a time; a seam between posts would be an
    // audible click every 20 ms, which the VAD could hear as noise.
    const input = ramp(4410);
    const whole = createResampler(44_100, 16_000)(input);

    const chunked = createResampler(44_100, 16_000);
    const parts: number[] = [];
    for (let i = 0; i < input.length; i += 441) parts.push(...chunked(input.subarray(i, i + 441)));

    expect(parts.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) expect(parts[i]).toBeCloseTo(whole[i]!, 5);
  });
});

describe("toInt16", () => {
  it("clamps out-of-range samples instead of wrapping them", () => {
    expect(Array.from(toInt16(Float32Array.from([2, -2, 0])))).toEqual([32767, -32768, 0]);
  });
});

describe("createTurnMessageHandler", () => {
  it("pairs a turn event with the audio message after it", async () => {
    const turns: { audio: Blob; reason: string }[] = [];
    let speechStarts = 0;
    const handle = createTurnMessageHandler({
      onSpeechStart: () => speechStarts++,
      onTurn: (audio, reason) => turns.push({ audio, reason }),
    });

    handle(JSON.stringify({ type: "speech_start" }));
    handle(JSON.stringify({ type: "pause", probability: 0.1 }));
    handle(JSON.stringify({ type: "turn", reason: "silence", probability: null }));
    handle(new Int16Array(1600).buffer);

    expect(speechStarts).toBe(1);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.reason).toBe("silence");
    // 44-byte WAV header plus 1600 16-bit samples.
    expect(turns[0]?.audio.size).toBe(44 + 3200);
    expect(turns[0]?.audio.type).toBe("audio/wav");
  });

  it("ignores audio that no turn event announced", () => {
    const turns: Blob[] = [];
    const handle = createTurnMessageHandler({
      onSpeechStart: () => {},
      onTurn: (audio) => turns.push(audio),
    });
    handle(new Int16Array(10).buffer);
    expect(turns).toHaveLength(0);
  });
});
