import { afterEach, describe, expect, it } from "bun:test";
import { playAudioBlob } from "./audioPlayback";

/**
 * happy-dom's Audio never fires `ended`, so playback would hang forever here.
 * These install a fake Audio plus object-URL bookkeeping as globals — no
 * `mock.module`, so nothing leaks into another test file — and check the URL is
 * released on every exit path. Over a long hands-free conversation a leaked URL
 * per spoken sentence is the failure that would actually bite.
 */

interface FakeAudio {
  src: string;
  onended: (() => void) | null;
  onerror: (() => void) | null;
}

let created: FakeAudio[] = [];
let revoked: string[] = [];
let issued = 0;
let playBehavior: "resolve" | "reject" = "resolve";

const originals = {
  Audio: (globalThis as Record<string, unknown>).Audio,
  createObjectURL: URL.createObjectURL,
  revokeObjectURL: URL.revokeObjectURL,
};

function install(): void {
  created = [];
  revoked = [];
  issued = 0;
  playBehavior = "resolve";

  (globalThis as Record<string, unknown>).Audio = class {
    src: string;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(src: string) {
      this.src = src;
      created.push(this as unknown as FakeAudio);
    }
    play() {
      return playBehavior === "resolve" ? Promise.resolve() : Promise.reject(new Error("no codec"));
    }
  };
  URL.createObjectURL = () => `blob:fake-${++issued}`;
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
}

afterEach(() => {
  (globalThis as Record<string, unknown>).Audio = originals.Audio;
  URL.createObjectURL = originals.createObjectURL;
  URL.revokeObjectURL = originals.revokeObjectURL;
});

describe("playAudioBlob", () => {
  it("resolves when playback finishes and releases the url", async () => {
    install();
    const playing = playAudioBlob(new Blob(["audio"]));
    await Promise.resolve();

    created[0]?.onended?.();
    await playing;

    expect(revoked).toEqual(["blob:fake-1"]);
  });

  it("releases the url when the audio fails to decode", async () => {
    install();
    const playing = playAudioBlob(new Blob(["audio"]));
    await Promise.resolve();

    created[0]?.onerror?.();

    await expect(playing).rejects.toThrow(/audio playback failed/);
    expect(revoked).toEqual(["blob:fake-1"]);
  });

  it("releases the url when play() is refused outright", async () => {
    install();
    playBehavior = "reject";

    await expect(playAudioBlob(new Blob(["audio"]))).rejects.toThrow(/no codec/);
    expect(revoked).toEqual(["blob:fake-1"]);
  });

  it("does not leak a url per chunk across a long reply", async () => {
    install();
    for (let i = 0; i < 5; i++) {
      const playing = playAudioBlob(new Blob([`chunk-${i}`]));
      await Promise.resolve();
      created[i]?.onended?.();
      await playing;
    }
    expect(revoked).toHaveLength(5);
    expect(new Set(revoked).size).toBe(5);
  });
});
