import { useLevel } from "../../lib/levelMeter";
import type { UseVoiceResult } from "../../lib/useVoice";
import MicButton from "./MicButton";

/**
 * The voice affordances a chat surface offers: talk instead of typing, hear
 * replies, and talk continuously. Sits beside the composer on both the Chat
 * tab and Omni Chat; what each backend is set to lives in Settings → Voice,
 * because it is shared with everything else that speaks.
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
  const status = listeningStatus(voice) ?? PHASE_LABEL[phase];
  const level = useLevel(voice.level);

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
        level={level}
        // Continuous mode transcribes while the mic stays open, so only
        // push-to-talk waits for a transcription before recording again.
        disabled={!ready.stt || (phase === "transcribing" && !config.continuous)}
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
        title="Keep the mic open and send each turn when you finish talking. Talking over a spoken reply stops it. Anything audible in the room can start a turn."
      >
        <input
          type="checkbox"
          checked={config.continuous}
          disabled={!ready.stt}
          onChange={(e) => void updateConfig({ continuous: e.target.checked })}
        />
        Continuous
      </label>

      {voice.queued > 0 && (
        <span className="text-xs text-zinc-400" title="Sent when the current reply finishes.">
          {voice.queued} queued
        </span>
      )}

      {(recording || voice.starting || phase !== "idle") && (
        <button
          type="button"
          onClick={voice.cancel}
          title="Stop listening or speaking and discard any recording in progress."
          className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
        >
          Stop
        </button>
      )}

      {voice.error && <span className="truncate text-xs text-red-400">{voice.error}</span>}
    </div>
  );
}

/** What the microphone is doing, or undefined when it is closed. */
function listeningStatus(voice: UseVoiceResult): string | undefined {
  if (voice.starting) return "Starting turn detection…";
  if (!voice.recording) return undefined;
  if (voice.hearing) return "Hearing you…";
  if (voice.phase === "transcribing") return "Transcribing…";
  return "Listening…";
}
