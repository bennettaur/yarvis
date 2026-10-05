import type { ReactNode } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Backdrop } from "../components/Backdrop";
import { StaggerWords } from "../components/Caption";
import { SANS } from "../lib/style";
import { enter, pop, progress, sec } from "../lib/timing";

/** A full-stage title over a grid of cards that land one after another. */
function CardSlide({
  kicker,
  title,
  columns,
  cards,
  step = 14,
  footer,
}: {
  kicker: string;
  title: string;
  columns: number;
  cards: { title: string; body: ReactNode; accent?: string }[];
  step?: number;
  footer?: ReactNode;
}) {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ fontFamily: SANS }}>
      <Backdrop />
      <AbsoluteFill style={{ padding: "0 130px", justifyContent: "center" }}>
        <div
          style={{
            fontSize: 20,
            letterSpacing: 4,
            textTransform: "uppercase",
            fontWeight: 700,
            color: "#a5b4fc",
            marginBottom: 18,
            ...enter(frame, 4),
          }}
        >
          {kicker}
        </div>
        <div
          style={{
            fontSize: 60,
            fontWeight: 780,
            letterSpacing: -1.8,
            color: "#fafafa",
            marginBottom: 50,
          }}
        >
          <StaggerWords text={title} start={8} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: 26 }}>
          {cards.map((card, i) => {
            const at = 30 + i * step;
            return (
              <div
                key={card.title}
                style={{
                  background: "rgba(24,24,27,.88)",
                  border: "1px solid #3f3f46",
                  borderTop: `3px solid ${card.accent ?? "#818cf8"}`,
                  padding: "26px 30px",
                  boxShadow: "0 24px 60px rgba(0,0,0,.45)",
                  // Fades in on the frame, and rises on a spring so it settles with a bounce.
                  opacity: progress(frame, at, 14),
                  transform: `translateY(${(1 - Math.min(1, pop(frame, at))) * 40}px)`,
                }}
              >
                <div
                  style={{
                    fontSize: 28,
                    fontWeight: 680,
                    color: card.accent ?? "#a5b4fc",
                    marginBottom: 12,
                  }}
                >
                  {card.title}
                </div>
                <div style={{ fontSize: 23, lineHeight: 1.45, color: "#a1a1aa" }}>{card.body}</div>
              </div>
            );
          })}
        </div>
        {footer && (
          <div style={{ marginTop: 34, ...enter(frame, 30 + cards.length * step + 10) }}>
            {footer}
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

const Code = ({ children }: { children: ReactNode }) => (
  <code
    style={{
      fontFamily: "Menlo, monospace",
      fontSize: "0.85em",
      color: "#e4e4e7",
      background: "#27272a",
      padding: "1px 7px",
    }}
  >
    {children}
  </code>
);

export const visibilityFrames = () => sec(11);

/** What reaches the assistant, when, and how to close the gaps. */
export function Visibility() {
  return (
    <CardSlide
      kicker="What the assistant can see"
      title="It sees logs and memory, not your terminals"
      columns={3}
      step={16}
      cards={[
        {
          title: "Right away",
          accent: "#4ade80",
          body: "Tasks, projects, todos and memories. The activity log as it happens. PR state and CI, polled every minute. Anything a session saved to memory.",
        },
        {
          title: "After nightly jobs",
          accent: "#fbbf24",
          body: "What happened in each Claude Code session (the opt-in transcript digest). 4-hourly and daily activity summaries.",
        },
        {
          title: "Not at all",
          accent: "#f87171",
          body: "Terminal output and live transcripts. Whether a sent instruction was carried out. PRs reviewed on github.com.",
        },
      ]}
      footer={
        <div style={{ fontSize: 26, color: "#d4d4d8", lineHeight: 1.5 }}>
          Close the gap: tell sessions to save notes with <Code>take_note</Code> in your{" "}
          <Code>CLAUDE.md</Code>, and turn on the transcript digest.
        </div>
      }
    />
  );
}

export const edgesFrames = () => sec(11);

/** The smaller integrations, one card each. */
export function Edges() {
  return (
    <CardSlide
      kicker="Around the edges"
      title="Clipboard, MCP, Telegram and scheduled jobs"
      columns={2}
      step={18}
      cards={[
        {
          title: "Clipboard · ⌃⇧V",
          body: "Copy buttons on every path, PR link and check. Saved snippets and this session's history. It refuses anything that looks like a credential.",
        },
        {
          title: "MCP, both ways",
          accent: "#22d3ee",
          body: "Connect MCP servers with OAuth, per-tool on, search or off. Yarvis also serves its memory over MCP, so every session can recall and remember.",
        },
        {
          title: "Telegram",
          accent: "#60a5fa",
          body: "The same assistant from your phone: “what's failing?”, “start work on PROJ-420”. Allowlisted by chat id, with optional TOTP.",
        },
        {
          title: "Scheduled jobs",
          accent: "#fbbf24",
          body: "A prompt on a cron schedule, run by Yarvis or headless Claude Code. “Every weekday at 8:45, list what's waiting on me.”",
        },
      ]}
    />
  );
}

export const habitsFrames = () => sec(11);

/** The four habits that make the assistant's answers good. */
export function Habits() {
  return (
    <CardSlide
      kicker="Getting the most out of it"
      title="Habits that make the assistant useful"
      columns={2}
      step={18}
      cards={[
        {
          title: "Say priorities out loud",
          body: "“X is urgent, Y can wait” is stored and used all week. Correct it when things change, and the memory is updated, not duplicated.",
        },
        {
          title: "Bookend the day",
          accent: "#22d3ee",
          body: "Start with “where did we leave off?” End with “note what's left for tomorrow”. The note feeds tomorrow's answer.",
        },
        {
          title: "Start work through Yarvis",
          accent: "#fbbf24",
          body: "That's what puts the work in the activity log, links the task, and gives the session memory.",
        },
        {
          title: "Let sessions report back",
          accent: "#4ade80",
          body: "The assistant can only recall what reached memory. A take_note line and the digest close the loop.",
        },
      ]}
    />
  );
}
