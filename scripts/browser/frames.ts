/**
 * Chrome's native-messaging framing: each message is a 4-byte little-endian
 * length (native byte order, which is little-endian on every platform Yarvis
 * runs on) followed by that many bytes of UTF-8 JSON.
 */

/** Chrome refuses a message to the extension over 1 MiB, so the host never sends one. */
export const MAX_OUTGOING_BYTES = 1024 * 1024;

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_OUTGOING_BYTES) {
    throw new Error(`native message of ${body.length} bytes exceeds Chrome's 1 MiB limit`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Chrome allows a message to the host far larger than this, but a page is capped
 * well under it — so a length beyond it is a corrupt header, not a big page.
 */
export const MAX_INCOMING_BYTES = 8 * 1024 * 1024;

/** Reassembles messages from stdin chunks, which can split or join frames anywhere. */
export class FrameDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const messages: unknown[] = [];
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32LE(0);
      if (length > MAX_INCOMING_BYTES) throw new Error(`native message of ${length} bytes refused`);
      if (this.buffered.length < 4 + length) break;
      const body = this.buffered.subarray(4, 4 + length);
      this.buffered = this.buffered.subarray(4 + length);
      messages.push(JSON.parse(body.toString("utf8")));
    }
    return messages;
  }
}
