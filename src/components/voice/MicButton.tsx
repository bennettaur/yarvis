import { Icon } from "../shell/icons";

/**
 * The push-to-talk control. The ring around it tracks the microphone's current
 * loudness, which is the only feedback that distinguishes "listening" from "the
 * mic is muted and nothing is getting through".
 */
export default function MicButton({
  recording,
  level,
  disabled,
  onStart,
  onStop,
}: {
  recording: boolean;
  /** Current input loudness, 0..1. */
  level: number;
  disabled?: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  // Loudness rarely passes ~0.3 at normal speech, so scale before clamping or
  // the ring barely moves.
  const ring = recording ? Math.min(1, level * 3) : 0;

  return (
    <button
      type="button"
      onClick={() => (recording ? onStop() : onStart())}
      disabled={disabled}
      aria-label={recording ? "Stop listening" : "Start listening"}
      className={`relative flex h-20 w-20 items-center justify-center rounded-full border-2 transition-colors disabled:opacity-40 ${
        recording
          ? "border-red-500 bg-red-500/10 text-red-300"
          : "border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-500"
      }`}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full bg-red-500/20"
        style={{ transform: `scale(${1 + ring * 0.35})`, opacity: ring }}
      />
      <Icon name="voice" className="relative h-8 w-8" />
    </button>
  );
}
