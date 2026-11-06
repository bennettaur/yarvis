/**
 * Hands the microphone's raw samples to the main thread, which resamples them
 * and streams them to the turn detector (`turnStream.ts`).
 *
 * Plain JavaScript loaded with `audioWorklet.addModule`, so it runs in the
 * audio thread's own scope rather than through the app's bundle. Render quanta
 * are only 128 samples, so they're batched into 32 ms posts: one Silero frame
 * each once resampled to 16 kHz.
 */
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(Math.round(sampleRate * 0.032));
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const count = Math.min(channel.length - offset, this.batch.length - this.filled);
      this.batch.set(channel.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === this.batch.length) {
        this.port.postMessage(this.batch.slice());
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
