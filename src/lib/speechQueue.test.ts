import { describe, expect, it } from "bun:test";
import { createSpeechQueue } from "./speechQueue";

/** A blob stand-in; the queue only passes it from `synthesize` to `play`. */
function audioFor(text: string): Blob {
  return new Blob([text]);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createSpeechQueue", () => {
  it("plays chunks in push order", async () => {
    const played: string[] = [];
    const queue = createSpeechQueue({
      synthesize: async (text) => audioFor(text),
      play: async (audio) => {
        played.push(await audio.text());
      },
    });

    queue.push("one");
    queue.push("two");
    queue.push("three");
    await queue.drain();

    expect(played).toEqual(["one", "two", "three"]);
  });

  it("synthesizes the next chunk while the current one is still playing", async () => {
    const synthesized: string[] = [];
    const firstPlay = deferred<void>();
    const queue = createSpeechQueue({
      synthesize: async (text) => {
        synthesized.push(text);
        return audioFor(text);
      },
      play: async () => {
        await firstPlay.promise;
      },
    });

    queue.push("one");
    queue.push("two");
    // Playback of "one" is still blocked, yet both chunks have been sent for
    // synthesis — that overlap is the point of the queue.
    await Promise.resolve();
    expect(synthesized).toEqual(["one", "two"]);

    firstPlay.resolve();
    await queue.drain();
  });

  it("reports a failed chunk and carries on with the next", async () => {
    const played: string[] = [];
    const errors: unknown[] = [];
    const queue = createSpeechQueue({
      synthesize: async (text) => {
        if (text === "bad") throw new Error("synthesis failed");
        return audioFor(text);
      },
      play: async (audio) => {
        played.push(await audio.text());
      },
      onError: (error) => errors.push(error),
    });

    queue.push("good");
    queue.push("bad");
    queue.push("also good");
    await queue.drain();

    expect(played).toEqual(["good", "also good"]);
    expect(errors).toHaveLength(1);
  });

  it("lets the chunk already playing finish but drops the queued ones", async () => {
    const played: string[] = [];
    const firstStarted = deferred<void>();
    const firstPlay = deferred<void>();
    const queue = createSpeechQueue({
      synthesize: async (text) => audioFor(text),
      play: async (audio) => {
        played.push(await audio.text());
        if (played.length === 1) {
          firstStarted.resolve();
          await firstPlay.promise;
        }
      },
    });

    queue.push("one");
    queue.push("two");
    await firstStarted.promise;
    queue.cancel();
    firstPlay.resolve();
    await queue.drain();

    expect(played).toEqual(["one"]);
  });

  it("ignores pushes after cancel", async () => {
    const played: string[] = [];
    const queue = createSpeechQueue({
      synthesize: async (text) => audioFor(text),
      play: async (audio) => {
        played.push(await audio.text());
      },
    });

    queue.cancel();
    queue.push("one");
    await queue.drain();

    expect(played).toEqual([]);
  });
});
