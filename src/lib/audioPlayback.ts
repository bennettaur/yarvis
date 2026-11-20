/**
 * Plays one audio blob to completion.
 *
 * The blob comes from the sidecar in whatever format the TTS provider returned
 * (mp3, wav, flac), so decoding is left to the platform's `<audio>` element
 * rather than to WebAudio, which would need a format-specific decode path.
 */
export function playAudioBlob(blob: Blob, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  let stop = () => {};
  return new Promise<void>((resolve, reject) => {
    stop = () => {
      audio.pause();
      resolve();
    };
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error("audio playback failed"));
    // Stopping counts as finishing: the caller asked for silence, not an error.
    signal?.addEventListener("abort", stop);
    audio.play().catch(reject);
  }).finally(() => {
    signal?.removeEventListener("abort", stop);
    URL.revokeObjectURL(url);
  });
}
