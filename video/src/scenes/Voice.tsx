import { useCurrentFrame } from "remotion";
import VoiceControls from "../../../src/components/voice/VoiceControls";
import type { UseVoiceResult } from "../../../src/lib/useVoice";
import { DEFAULT_VOICE_CONFIG } from "../../../src/lib/voiceConfig";
import { AppScene } from "../components/AppScene";
import { Em } from "../components/Caption";
import { closeUp, framed, swingIn } from "../components/shots";
import { doneAt, type ScriptTurn, sentAt } from "../lib/chatScript";
import { enter, sec } from "../lib/timing";
import { ChatView } from "../screens/ChatView";

const noop = () => {};
const asyncNoop = async () => {};

const LISTEN = 40;
const HEARD = 120;

const TURNS: ScriptTurn[] = [
  {
    typeAt: HEARD,
    user: "Where did we leave off on PROJ-415?",
    metadata: { source: "voice" },
    tools: [
      { name: "recall", at: 6 },
      { name: "search_events", at: 14 },
    ],
    replyAt: 34,
    replyCps: 70,
    reply:
      "The retry spec is still red. Its session changed the backoff yesterday and is waiting on you to approve a test run.",
  },
];
const SECOND = doneAt(TURNS[0]) + 30;
TURNS.push({
  typeAt: SECOND + 70,
  user: "Archive the flaky test workspace.",
  metadata: { source: "voice" },
  tools: [{ name: "archive_workspace", at: 6, runs: 9999 }],
  replyAt: 9999,
  reply: "",
});

/** What the voice hook would report at this frame: listening, then speaking the reply. */
function voiceAt(frame: number): UseVoiceResult {
  const listening = (frame >= LISTEN && frame < HEARD) || (frame >= SECOND && frame < SECOND + 70);
  const speaking = frame >= sentAt(TURNS[0]) + TURNS[0].replyAt && frame < doneAt(TURNS[0]) + 20;
  // A loudness that rises and falls like speech.
  const level = listening
    ? 0.12 + 0.1 * Math.abs(Math.sin(frame / 3.1) * Math.cos(frame / 7.3))
    : 0;
  return {
    config: { ...DEFAULT_VOICE_CONFIG, speakReplies: true, handsFree: false },
    updateConfig: asyncNoop,
    ready: { stt: true, tts: true },
    recording: listening,
    level,
    phase: speaking ? "speaking" : "idle",
    error: null,
    startListening: noop,
    stopListening: noop,
    cancel: noop,
  };
}

/** What was heard, shown big under the window as subtitles. */
function Heard() {
  const frame = useCurrentFrame();
  const line =
    frame >= LISTEN + 10 && frame < HEARD + 10
      ? { text: TURNS[0].user, at: LISTEN + 10 }
      : frame >= SECOND + 10 && frame < SECOND + 80
        ? { text: TURNS[1].user, at: SECOND + 10 }
        : null;
  if (!line) return null;
  return (
    <div
      className="absolute bottom-20 z-40 text-center"
      style={{ left: 660, right: 40, ...enter(frame, line.at, 8, 10) }}
    >
      <span className="bg-black/85 px-5 py-3 text-4xl font-semibold text-zinc-50">
        “{line.text}”
      </span>
    </div>
  );
}

export const voiceFrames = () => SECOND + 70 + sec(4);

/** A spoken turn, a spoken reply, and the approval prompt a spoken irreversible action gets. */
export function Voice() {
  const frame = useCurrentFrame();
  const asking = frame >= sentAt(TURNS[1]) + 10;

  return (
    <AppScene
      tab="chat"
      shots={[
        ...swingIn(),
        closeUp(LISTEN - 10, 300, 690, 1.6),
        closeUp(HEARD, 620, 520, 1.12),
        closeUp(sentAt(TURNS[1]) + 4, 720, 580, 1.2),
        framed(sentAt(TURNS[1]) + 70),
      ]}
      cursor={[
        { at: LISTEN - 20, x: 500, y: 600 },
        { at: LISTEN - 14, x: 108, y: 718, dur: 12, click: true },
      ]}
      caption={{
        kicker: "Voice",
        title: "Talk to it, and hear it answer, on your machine",
        pointsAt: 50,
        pointStep: 60,
        points: [
          <>A mic on the Chat tab and in Omni Chat</>,
          <>
            <Em>Speak replies</Em> reads the answer as it streams
          </>,
          <>Local Whisper and Kokoro via mlx-audio, or Gemini</>,
          <>
            On a spoken turn, anything irreversible <Em>asks first</Em>
          </>,
        ],
      }}
      stage={<Heard />}
      hideCursorAfter={HEARD}
    >
      <ChatView
        turns={TURNS}
        session="Thursday 8:10"
        approvals={
          asking
            ? [
                {
                  id: "a1",
                  name: "archive_workspace",
                  server: "",
                  args: { name: "fix-flaky-checkout-test" },
                },
              ]
            : []
        }
        footer={<VoiceControls voice={voiceAt(frame)} />}
      />
    </AppScene>
  );
}
