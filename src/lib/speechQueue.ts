/**
 * Plays synthesized chunks in the order they were queued, while synthesizing
 * later ones in parallel.
 *
 * Synthesis is the slow half, so it starts the moment a chunk is pushed rather
 * than when its turn to play comes up: by the time one sentence finishes
 * playing the next is usually already audio. Playback still follows push order,
 * which is the part a listener would notice.
 */

export interface SpeechQueueOptions {
  synthesize: (text: string) => Promise<Blob>;
  play: (audio: Blob) => Promise<void>;
  /** Called once per failed chunk; the queue continues with the next one. */
  onError?: (error: unknown) => void;
}

export interface SpeechQueue {
  push(text: string): void;
  /** Resolves once everything queued so far has finished playing. */
  drain(): Promise<void>;
  /** Stops after the chunk currently playing; queued chunks are dropped. */
  cancel(): void;
}

export function createSpeechQueue({ synthesize, play, onError }: SpeechQueueOptions): SpeechQueue {
  let tail: Promise<void> = Promise.resolve();
  let cancelled = false;

  return {
    push(text: string): void {
      if (cancelled || !text) return;
      const audio = synthesize(text);
      // A chunk cancelled before its turn is never awaited below, so mark its
      // rejection handled here; the real handling still happens in the chain.
      audio.catch(() => {});
      tail = tail
        .then(async () => {
          if (cancelled) return;
          await play(await audio);
        })
        .catch((error) => {
          onError?.(error);
        });
    },

    drain(): Promise<void> {
      return tail;
    },

    cancel(): void {
      cancelled = true;
    },
  };
}
