import { useCurrentFrame } from "remotion";
import { progress } from "../lib/timing";

export interface CursorStop {
  /** Frame the pointer starts moving to this stop. */
  at: number;
  x: number;
  y: number;
  /** Frames the move takes. */
  dur?: number;
  /** Click once it arrives. */
  click?: boolean;
}

const CLICK_FRAMES = 14;

/** A mouse pointer in app coordinates, so it moves with the camera. */
export function Cursor({ stops, hideAfter }: { stops: CursorStop[]; hideAfter?: number }) {
  const frame = useCurrentFrame();
  if (stops.length === 0 || frame < stops[0].at) return null;
  if (hideAfter !== undefined && frame > hideAfter) return null;

  let x = stops[0].x;
  let y = stops[0].y;
  let clickStart: number | null = stops[0].click ? stops[0].at : null;
  for (const stop of stops.slice(1)) {
    if (frame < stop.at) break;
    const dur = stop.dur ?? 18;
    const t = progress(frame, stop.at, dur);
    x += (stop.x - x) * t;
    y += (stop.y - y) * t;
    if (stop.click) clickStart = stop.at + dur;
  }
  const sinceClick = clickStart === null ? Infinity : frame - clickStart;
  const clicking = sinceClick >= 0 && sinceClick < CLICK_FRAMES;
  const ripple = clicking ? sinceClick / CLICK_FRAMES : 0;

  return (
    <div style={{ position: "absolute", left: x, top: y, zIndex: 50, pointerEvents: "none" }}>
      {clicking && (
        <div
          style={{
            position: "absolute",
            left: -22,
            top: -22,
            width: 44,
            height: 44,
            borderRadius: "50%",
            border: "2px solid rgba(129,140,248,.9)",
            transform: `scale(${0.4 + ripple})`,
            opacity: 1 - ripple,
          }}
        />
      )}
      <svg
        width="22"
        height="26"
        viewBox="0 0 22 26"
        style={{
          transform: `scale(${clicking && sinceClick < 5 ? 0.85 : 1})`,
          transformOrigin: "0 0",
          filter: "drop-shadow(0 2px 4px rgba(0,0,0,.5))",
        }}
      >
        <title>Pointer</title>
        <path
          d="M1 1 L1 20 L6 15.5 L9.5 24 L13 22.5 L9.6 14.2 L16 14.2 Z"
          fill="#fafafa"
          stroke="#18181b"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
