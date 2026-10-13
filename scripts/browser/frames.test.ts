import { describe, expect, it } from "bun:test";
import { encodeFrame, FrameDecoder, MAX_INCOMING_BYTES, MAX_OUTGOING_BYTES } from "./frames.ts";

describe("native messaging frames", () => {
  it("round-trips a message, including non-ASCII text", () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(encodeFrame({ text: "héllo ✓" }))).toEqual([{ text: "héllo ✓" }]);
  });

  it("reassembles a frame split across chunks and splits frames joined in one", () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame({ a: 1 });
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.push(frame.subarray(3, 6))).toEqual([]);
    expect(decoder.push(frame.subarray(6))).toEqual([{ a: 1 }]);

    expect(decoder.push(Buffer.concat([encodeFrame({ b: 1 }), encodeFrame({ c: 2 })]))).toEqual([
      { b: 1 },
      { c: 2 },
    ]);
  });

  it("refuses a length header no page could account for", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_INCOMING_BYTES + 1, 0);
    expect(() => new FrameDecoder().push(header)).toThrow("refused");
  });

  it("refuses to send what Chrome would drop", () => {
    expect(() => encodeFrame({ text: "x".repeat(MAX_OUTGOING_BYTES) })).toThrow("1 MiB");
  });
});
