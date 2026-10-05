import { useCurrentFrame } from "remotion";
import VoiceControls from "../../../src/components/voice/VoiceControls";
import type { UseVoiceResult } from "../../../src/lib/useVoice";
import { DEFAULT_VOICE_CONFIG } from "../../../src/lib/voiceConfig";
import { AppScene } from "../components/AppScene";
import { Em } from "../components/Caption";
import { closeUp, framed, swingIn } from "../components/shots";
import { doneAt, type ScriptTurn, sentAt } from "../lib/chatScript";
import { asyncNoop, noop } from "../lib/style";
import { enter, sec } from "../lib/timing";
import { ChatView } from "../screens/ChatView";

// Frames the mic opens and the first question is heard.
const LISTEN_AT = 40;
const HEARD_AT = 120;

const ASK: ScriptTurn = {
  typeAt: HEARD_AT,
  user: "Where did we leave off on PROJ-415?",
  metadata: { source: "voice" },
  tools: [
    { name: "recall", after: 6 },
    { name: "search_events", after: 14 },
  ],
  replyAfter: 34,
  replyCps: 70,
  reply:
    "The retry spec is still red. Its session changed the backoff yesterday and is waiting on you to approve a test run.",
};

// Frames the mic opens again and the second request is heard.
const SECOND_LISTEN_AT = doneAt(ASK) + 30;
const SECOND_HEARD_AT = SECOND_LISTEN_AT + 70;

// The archive waits on the approval prompt for the rest of the scene, so the
// call never settles and no reply streams.
const ARCHIVE: ScriptTurn = {
  typeAt: SECOND_HEARD_AT,
  user: "Archive the flaky test workspace.",
  metadata: { source: "voice" },
  tools: [{ name: "archive_workspace", after: 6, pendingFrames: Infinity }],
  replyAfter: Infinity,
  reply: "",
};

const TURNS = [ASK, ARCHIVE];

/** What was heard, as subtitles: each line and the frames it is on screen. */
const SUBTITLES = [
  { text: ASK.user, from: LISTEN_AT + 10, to: HEARD_AT + 10 },
  { text: ARCHIVE.user, from: SECOND_LISTEN_AT + 10, to: SECOND_HEARD_AT + 10 },
];

/** What the voice hook would report at this frame: listening, then speaking the reply. */
function voiceAt(frame: number): UseVoiceResult {
  const listening =
    (frame >= LISTEN_AT && frame < HEARD_AT) ||
    (frame >= SECOND_LISTEN_AT && frame < SECOND_HEARD_AT);
  const speaking = frame >= sentAt(ASK) + ASK.replyAfter && frame < doneAt(ASK) + 20;
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
  const line = SUBTITLES.find((s) => frame >= s.from && frame < s.to);
  if (!line) return null;
  return (
    <div
      className="absolute bottom-20 z-40 text-center"
      style={{ left: 660, right: 40, ...enter(frame, line.from, 8, 10) }}
    >
      <span className="bg-black/85 px-5 py-3 text-4xl font-semibold text-zinc-50">
        “{line.text}”
      </span>
    </div>
  );
}

export const voiceFrames = () => SECOND_HEARD_AT + sec(4);

/** A spoken turn, a spoken reply, and the approval prompt a spoken irreversible action gets. */
export function Voice() {
  const frame = useCurrentFrame();
  const asking = frame >= sentAt(ARCHIVE) + 10;

  return (
    <AppScene
      tab="chat"
      shots={[
        ...swingIn(),
        closeUp(LISTEN_AT - 10, 300, 690, 1.6),
        closeUp(HEARD_AT, 620, 520, 1.12),
        closeUp(sentAt(ARCHIVE) + 4, 720, 580, 1.2),
        framed(sentAt(ARCHIVE) + 70),
      ]}
      cursor={[
        { at: LISTEN_AT - 20, x: 500, y: 600 },
        { at: LISTEN_AT - 14, x: 108, y: 718, dur: 12, click: true },
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
      hideCursorAfter={HEARD_AT}
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
