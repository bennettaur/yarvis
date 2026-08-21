import type { UseVoiceResult } from "../../lib/useVoice";
import MicButton from "./MicButton";

/**
 * The voice affordances a chat surface offers: talk instead of typing, hear
 * replies, and go hands-free. Sits beside the composer on both the Chat tab and
 * Omni Chat; what each backend is set to lives in Settings → Voice, because it
 * is shared with everything else that speaks.
 */

const PHASE_LABEL: Record<string, string> = {
  transcribing: "Transcribing…",
  speaking: "Speaking…",
};

export default function VoiceControls({
  voice,
  compact = false,
}: {
  voice: UseVoiceResult;
  /** Drops the labels, for a surface with less room (the Omni Chat overlay). */
  compact?: boolean;
}) {
  const { config, updateConfig, ready, recording, phase } = voice;
  const status = recording ? "Listening…" : PHASE_LABEL[phase];

  if (!ready.stt && !ready.tts) {
    return (
      <p className="text-xs text-zinc-600">
        Set up speech under Settings → Voice to talk to this chat.
      </p>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <MicButton
        recording={recording}
        level={voice.level}
        disabled={!ready.stt || phase === "transcribing"}
        size="sm"
        onStart={voice.startListening}
        onStop={voice.stopListening}
      />

      {status && <span className="text-xs text-zinc-400">{status}</span>}

      {!compact && (
        <label
          className="flex items-center gap-1.5 text-xs text-zinc-400"
          title={
            ready.tts
              ? "Speak each finished sentence as the reply streams in."
              : "Set a text-to-speech provider under Settings → Voice first."
          }
        >
          <input
            type="checkbox"
            checked={config.speakReplies && ready.tts}
            disabled={!ready.tts}
            onChange={(e) => void updateConfig({ speakReplies: e.target.checked })}
          />
          Speak replies
        </label>
      )}

      <label
        className="flex items-center gap-1.5 text-xs text-zinc-400"
        title="End a turn on silence and re-open the mic once the reply finishes. Anything audible in the room can start a turn."
      >
        <input
          type="checkbox"
          checked={config.handsFree}
          disabled={!ready.stt}
          onChange={(e) => void updateConfig({ handsFree: e.target.checked })}
        />
        {compact ? "Hands-free" : "Hands-free"}
      </label>

      {(recording || phase !== "idle") && (
        <button
          type="button"
          onClick={voice.cancel}
          className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
        >
          Stop
        </button>
      )}

      {voice.error && <span className="truncate text-xs text-red-400">{voice.error}</span>}
    </div>
  );
}
