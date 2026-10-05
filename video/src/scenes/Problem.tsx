import type { ReactNode } from "react";
import { AbsoluteFill, Easing, useCurrentFrame } from "remotion";
import { Backdrop } from "../components/Backdrop";
import { StaggerWords } from "../components/Caption";
import { SANS } from "../lib/style";
import { enter, pop, progress, sec } from "../lib/timing";

export const problemFrames = (walkthrough: boolean) => (walkthrough ? sec(9) : sec(6));

interface Shard {
  x: number;
  y: number;
  rot: number;
  w: number;
  at: number;
  body: ReactNode;
}

const Win = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="border border-zinc-700 bg-zinc-900 text-zinc-300 shadow-2xl">
    <div className="flex items-center gap-1.5 border-b border-zinc-800 bg-zinc-950 px-2 py-1.5 text-[11px] text-zinc-500">
      <span className="h-2 w-2 rounded-full bg-zinc-700" />
      <span className="h-2 w-2 rounded-full bg-zinc-700" />
      <span className="h-2 w-2 rounded-full bg-zinc-700" />
      <span className="ml-2 truncate">{title}</span>
    </div>
    <div className="p-3 text-[13px] leading-relaxed">{children}</div>
  </div>
);

const SHARDS: Shard[] = [
  {
    x: 140,
    y: 120,
    rot: -6,
    w: 380,
    at: 0,
    body: (
      <Win title="zsh — billing-api">
        <div className="font-mono text-orange-300">✻ Waiting for permission…</div>
        <div className="font-mono text-zinc-500">Allow Bash(rm -rf tmp/)? (y/n)</div>
      </Win>
    ),
  },
  {
    x: 1380,
    y: 110,
    rot: 5,
    w: 400,
    at: 4,
    body: (
      <Win title="github.com — Pull requests">
        <div>
          <span className="text-red-400">✕</span> #234 webhook retries · checks failing
        </div>
        <div>
          <span className="text-amber-400">✎</span> #218 auth refresh · changes requested
        </div>
        <div>
          <span className="text-sky-400">●</span> 3 reviews requested
        </div>
      </Win>
    ),
  },
  {
    x: 110,
    y: 660,
    rot: 4,
    w: 360,
    at: 8,
    body: (
      <Win title="JIRA — PROJ board">
        <div>
          <span className="text-red-400">Urgent</span> PROJ-412 Ledger backfill
        </div>
        <div>
          <span className="text-red-400">Urgent</span> PROJ-415 Webhook retries
        </div>
        <div>
          <span className="text-zinc-500">Low</span> PROJ-420 CSV export
        </div>
      </Win>
    ),
  },
  {
    x: 1450,
    y: 640,
    rot: -5,
    w: 340,
    at: 12,
    body: (
      <Win title="Calendar">
        <div className="text-zinc-200">Billing sync · 2:00 PM</div>
        <div className="text-zinc-500">starts in 1 minute</div>
      </Win>
    ),
  },
  {
    x: 760,
    y: 820,
    rot: -2,
    w: 400,
    at: 16,
    body: (
      <Win title="zsh — web-checkout">
        <div className="font-mono text-zinc-400">FAIL checkout.spec.ts (flaky)</div>
        <div className="font-mono text-zinc-500">✻ Idle · waiting for input</div>
      </Win>
    ),
  },
  {
    x: 820,
    y: 60,
    rot: 3,
    w: 300,
    at: 20,
    body: (
      <Win title="notes.md">
        <div className="text-zinc-400">- where did I leave PROJ-412?</div>
        <div className="text-zinc-400">- finish Sam's review!!</div>
      </Win>
    ),
  },
];

const QUESTIONS = [
  "“What was I doing last week?”",
  "“Which agent is waiting on me?”",
  "“What did I actually ship?”",
];

/** The work scattered across terminals, GitHub, JIRA and a calendar, then pulled into one place. */
export function Problem({ walkthrough = false }: { walkthrough?: boolean }) {
  const frame = useCurrentFrame();
  const total = problemFrames(walkthrough);
  const collapse = progress(frame, total - 26, 22, Easing.in(Easing.cubic));
  const qStep = walkthrough ? 40 : 22;

  return (
    <AbsoluteFill style={{ fontFamily: SANS }}>
      <Backdrop />
      {SHARDS.map((s) => {
        const t = pop(frame, s.at, 12);
        const bob = Math.sin((frame + s.at * 7) / 24) * 6;
        // Every shard is pulled to the centre and shrinks as the scene ends.
        const cx = 960 - s.w / 2;
        const x = s.x + (cx - s.x) * collapse;
        const y = s.y + bob + (480 - s.y) * collapse;
        return (
          <div
            key={`${s.x}-${s.y}`}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: s.w,
              opacity: Math.min(1, t) * (1 - collapse),
              transform: `rotate(${s.rot * (1 - collapse)}deg) scale(${(0.7 + t * 0.3) * (1 - collapse * 0.7)})`,
            }}
          >
            {s.body}
          </div>
        );
      })}
      <AbsoluteFill
        style={{ alignItems: "center", justifyContent: "center", opacity: 1 - collapse }}
      >
        <div
          style={{
            fontSize: 22,
            letterSpacing: 4,
            textTransform: "uppercase",
            color: "#a5b4fc",
            fontWeight: 700,
            marginBottom: 20,
            ...enter(frame, 10),
          }}
        >
          The problem
        </div>
        <div
          style={{
            fontSize: 66,
            fontWeight: 780,
            letterSpacing: -2,
            color: "#fafafa",
            textAlign: "center",
            maxWidth: 1100,
            lineHeight: 1.08,
            textShadow: "0 6px 40px rgba(0,0,0,.9)",
          }}
        >
          <StaggerWords
            text="The agents do the work. Nothing keeps track of the work around them."
            start={14}
            step={3}
          />
        </div>
        <div style={{ marginTop: 40, display: "flex", gap: 36 }}>
          {QUESTIONS.map((q, i) => (
            <div
              key={q}
              style={{
                fontSize: 26,
                color: "#d4d4d8",
                background: "rgba(24,24,27,.85)",
                border: "1px solid #3f3f46",
                padding: "10px 18px",
                ...enter(frame, 50 + i * qStep),
              }}
            >
              {q}
            </div>
          ))}
        </div>
      </AbsoluteFill>
      <AbsoluteFill
        style={{
          background: "radial-gradient(circle, rgba(129,140,248,.6), transparent 40%)",
          opacity: Math.sin(collapse * Math.PI) * 0.9,
        }}
      />
    </AbsoluteFill>
  );
}
