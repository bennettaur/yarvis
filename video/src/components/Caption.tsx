import type { CSSProperties, ReactNode } from "react";
import { useCurrentFrame } from "remotion";
import { SANS } from "../lib/style";
import { enter, pop, progress } from "../lib/timing";

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
  style?: CSSProperties;
}) {
  const frame = useCurrentFrame();
  return (
    <span style={style}>
      {text.split(" ").map((word, i) => {
        const t = pop(frame, start + i * step, 16);
        return (
          <span
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

export interface CaptionProps {
  kicker: string;
  title: string;
  points?: ReactNode[];
  /** Frame the first point lands. Defaults to shortly after the title. */
  pointsAt?: number;
  /** Frames between one point landing and the next. */
  pointStep?: number;
}

/** Frame the caption starts coming in. */
const START = 6;

/**
 * A scene's title: a small coloured kicker over a large headline, then any
 * bullet points, landing one at a time.
 */
export function Caption({ kicker, title, points = [], pointsAt, pointStep = 30 }: CaptionProps) {
  const frame = useCurrentFrame();
  const firstPoint = pointsAt ?? START + 30;
  const rule = progress(frame, START, 18);

  return (
    <div
      style={{ position: "absolute", left: 96, top: 150, width: 560, fontFamily: SANS, zIndex: 40 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          marginBottom: 22,
          ...enter(frame, START, 14, 10),
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
        <StaggerWords text={title} start={START + 4} />
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
