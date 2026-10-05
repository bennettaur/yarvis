import type { ReactNode } from "react";
import { useCurrentFrame } from "remotion";
import { enter, pop, progress } from "../lib/timing";

const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Inter, sans-serif';

/** Words that rise in one after another. */
export function StaggerWords({
  text,
  start,
  step = 3,
  style,
}: {
  text: string;
  start: number;
  step?: number;
  style?: React.CSSProperties;
}) {
  const frame = useCurrentFrame();
  return (
    <span style={style}>
      {text.split(" ").map((word, i) => {
        const t = pop(frame, start + i * step, 16);
        return (
          <span
            // Words in a fixed caption never reorder.
            // biome-ignore lint/suspicious/noArrayIndexKey: static text
            key={i}
            style={{
              display: "inline-block",
              marginRight: "0.26em",
              opacity: Math.min(1, t * 1.4),
              transform: `translateY(${(1 - t) * 26}px)`,
            }}
          >
            {word}
          </span>
        );
      })}
    </span>
  );
}

/**
 * A scene's title: a small coloured kicker over a large headline, and in the
 * walkthrough a few bullet points that land one at a time.
 */
export function Caption({
  kicker,
  title,
  points = [],
  start = 6,
  pointsAt,
  pointStep = 30,
  width = 560,
  left = 96,
  top = 150,
}: {
  kicker: string;
  title: string;
  points?: ReactNode[];
  start?: number;
  /** Frame the first point lands. Defaults to shortly after the title. */
  pointsAt?: number;
  pointStep?: number;
  width?: number;
  left?: number;
  top?: number;
}) {
  const frame = useCurrentFrame();
  const firstPoint = pointsAt ?? start + 30;
  const rule = progress(frame, start, 18);

  return (
    <div style={{ position: "absolute", left, top, width, fontFamily: SANS, zIndex: 40 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          marginBottom: 22,
          ...enter(frame, start, 14, 10),
        }}
      >
        <div
          style={{
            height: 3,
            width: 44 * rule,
            background: "linear-gradient(90deg, #22d3ee, #818cf8)",
          }}
        />
        <span
          style={{
            fontSize: 20,
            letterSpacing: 4,
            textTransform: "uppercase",
            fontWeight: 700,
            color: "#a5b4fc",
          }}
        >
          {kicker}
        </span>
      </div>
      <div
        style={{
          fontSize: 58,
          lineHeight: 1.06,
          fontWeight: 750,
          letterSpacing: -1.6,
          color: "#fafafa",
          textShadow: "0 4px 30px rgba(0,0,0,.6)",
        }}
      >
        <StaggerWords text={title} start={start + 4} />
      </div>
      {points.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: "36px 0 0" }}>
          {points.map((point, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: static list
              key={i}
              style={{
                position: "relative",
                paddingLeft: 30,
                marginBottom: 18,
                fontSize: 25,
                lineHeight: 1.4,
                color: "#d4d4d8",
                ...enter(frame, firstPoint + i * pointStep, 14, 14),
              }}
            >
              <span
                style={{
                  position: "absolute",
                  left: 2,
                  top: 13,
                  width: 10,
                  height: 10,
                  background: "#818cf8",
                  transform: `scale(${pop(frame, firstPoint + i * pointStep)})`,
                }}
              />
              {point}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Bold, highlighted text inside a caption point. */
export const Em = ({ children }: { children: ReactNode }) => (
  <b style={{ color: "#fafafa", fontWeight: 650 }}>{children}</b>
);
