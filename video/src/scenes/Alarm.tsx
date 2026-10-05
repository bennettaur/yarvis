import { AbsoluteFill, useCurrentFrame } from "remotion";
import { AppScene } from "../components/AppScene";
import { Em, StaggerWords } from "../components/Caption";
import { centred, closeUp, framed, swingIn } from "../components/shots";
import { enter, FPS, pop, sec } from "../lib/timing";

const EVENTS = [
  { title: "Standup", time: "9:30 AM" },
  { title: "Billing sync", time: "2:00 PM" },
  { title: "1:1 with Priya", time: "3:30 PM" },
  { title: "Auth design review", time: "4:15 PM" },
];

const BellIcon = ({ filled }: { filled: boolean }) => (
  <svg
    viewBox="0 0 24 24"
    className="h-3.5 w-3.5"
    fill={filled ? "currentColor" : "none"}
    stroke="currentColor"
    strokeWidth="1.8"
  >
    <title>Alarm</title>
    <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
);

/** The calendar's Agenda view, from `CalendarPanel`'s markup. */
function Agenda({ armedFrom }: { armedFrom: number }) {
  const frame = useCurrentFrame();
  return (
    <div className="h-full overflow-hidden p-6">
      <div className="mb-3 flex items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-md border border-zinc-700">
          {["Agenda", "Week", "Month", "Day"].map((v) => (
            <span
              key={v}
              className={`px-3 py-1.5 text-sm ${v === "Agenda" ? "bg-indigo-600 text-white" : "text-zinc-300"}`}
            >
              {v}
            </span>
          ))}
        </div>
      </div>
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            Upcoming ({EVENTS.length})
          </h2>
          <span className="ml-auto rounded-md border border-zinc-700 px-2 py-1 text-xs">
            Set alarms for all
          </span>
          <span className="text-xs text-zinc-500">Disconnect</span>
        </div>
        <div className="space-y-1">
          <h3 className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Today · Wednesday, October 7
          </h3>
          <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/50">
            {EVENTS.map((event, i) => {
              const armed = frame >= armedFrom + i * 4;
              return (
                <li key={event.title} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-zinc-100">{event.title}</div>
                    <div className="text-xs text-zinc-500">
                      {event.time} · <span className="text-indigo-400">join</span>
                    </div>
                  </div>
                  {armed ? (
                    <span
                      className="inline-flex items-center gap-1 text-xs text-emerald-400"
                      style={{ transform: `scale(${pop(frame, armedFrom + i * 4)})` }}
                    >
                      <BellIcon filled /> alarm set
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-xs">
                      <BellIcon filled={false} /> Set alarm
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

/**
 * `AlarmOverlay`'s markup, with its seconds-overdue counter and red pulse driven
 * by the frame rather than the wall clock.
 */
function AlarmTakeover({ from }: { from: number }) {
  const frame = useCurrentFrame();
  if (frame < from) return null;
  const overdue = 60 + Math.floor((frame - from) / FPS);
  const pulse = 0.5 + 0.5 * Math.sin(((frame - from) / FPS) * Math.PI * 2);
  return (
    <div
      className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-8"
      style={{
        background: `rgb(${69 + pulse * 30}, ${10 + pulse * 6}, ${10 + pulse * 6})`,
      }}
    >
      <div
        className="text-sm uppercase tracking-[0.3em] text-zinc-400"
        style={enter(frame, from + 2)}
      >
        Alarm
      </div>
      <div
        className="max-w-2xl px-8 text-center text-5xl font-semibold text-zinc-50"
        style={{ transform: `scale(${0.6 + 0.4 * pop(frame, from + 4, 10)})` }}
      >
        Meeting: Billing sync
      </div>
      <div className="text-red-300" style={enter(frame, from + 10)}>
        Overdue by {overdue}s — please acknowledge
      </div>
      <div className="flex gap-4" style={enter(frame, from + 14)}>
        <span className="rounded-lg bg-emerald-600 px-8 py-3 text-lg font-medium">
          Join meeting
        </span>
        <span className="rounded-lg bg-indigo-600 px-8 py-3 text-lg font-medium">Acknowledge</span>
        <span className="rounded-lg border border-zinc-600 px-8 py-3 text-lg text-zinc-200">
          Snooze 5 min
        </span>
      </div>
    </div>
  );
}

/** Frame "Set alarms for all" is clicked. */
const ARM_AT = 54;

export const alarmFrames = (walkthrough: boolean) => (walkthrough ? sec(11) : sec(5));

/** Alarms armed for every meeting, then one takes over the whole screen until you act. */
export function Alarm({ walkthrough = false }: { walkthrough?: boolean }) {
  const takeoverAt = walkthrough ? 150 : 24;
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill>
      <AppScene
        tab="calendar"
        tint={frame >= takeoverAt ? "red" : "indigo"}
        shots={
          walkthrough
            ? [
                ...swingIn(),
                closeUp(40, 820, 200, 1.4),
                framed(takeoverAt - 20, 16),
                closeUp(takeoverAt + 4, 600, 400, 1.12, 14),
              ]
            : [{ ...centred(0, 0.9), rotY: -14 }, centred(4, 1.3, 20), centred(30, 1.18, 120)]
        }
        cursor={
          walkthrough
            ? [
                { at: ARM_AT - 26, x: 600, y: 300 },
                { at: ARM_AT - 18, x: 1000, y: 160, dur: 14, click: true },
              ]
            : []
        }
        caption={
          walkthrough
            ? {
                kicker: "Calendar and alarms",
                title: "A full-screen alarm before each meeting",
                pointsAt: 40,
                pointStep: 36,
                points: [
                  <>Google Calendar, with Meet links</>,
                  <>
                    <Em>Set alarms for all</Em> arms every meeting
                  </>,
                  <>
                    The assistant can <Em>book</Em> events, after asking
                  </>,
                ],
              }
            : undefined
        }
        overlay={<AlarmTakeover from={takeoverAt} />}
      >
        <Agenda armedFrom={walkthrough ? ARM_AT : 0} />
      </AppScene>
      {!walkthrough && (
        <div
          className="absolute inset-x-0 bottom-16 text-center"
          style={{
            fontSize: 46,
            fontWeight: 750,
            letterSpacing: -1,
            color: "#fafafa",
            textShadow: "0 4px 30px rgba(0,0,0,.9)",
          }}
        >
          <StaggerWords text="And it won't let you miss the meeting." start={30} />
        </div>
      )}
    </AbsoluteFill>
  );
}
