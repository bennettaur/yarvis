import type { ReactNode } from "react";
import { useCurrentFrame } from "remotion";
import { APP_HEIGHT, APP_WIDTH, HEIGHT, progress, WIDTH } from "../lib/timing";

export interface Shot {
  /** Frame the move to this shot starts. */
  at: number;
  /** Frames the move takes. */
  dur?: number;
  /** The point in the app (its own CSS pixels) to frame. */
  x: number;
  y: number;
  zoom: number;
  /** Where on the 1920x1080 stage that point lands. Defaults to the centre. */
  sx?: number;
  sy?: number;
  /** Degrees of turn around the vertical and horizontal axes. */
  rotY?: number;
  rotX?: number;
}

type Pose = Required<Omit<Shot, "at" | "dur">>;

const pose = (s: Shot): Pose => ({
  x: s.x,
  y: s.y,
  zoom: s.zoom,
  sx: s.sx ?? WIDTH / 2,
  sy: s.sy ?? HEIGHT / 2,
  rotY: s.rotY ?? 0,
  rotX: s.rotX ?? 0,
});

const lerp = (a: Pose, b: Pose, t: number): Pose => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  zoom: a.zoom + (b.zoom - a.zoom) * t,
  sx: a.sx + (b.sx - a.sx) * t,
  sy: a.sy + (b.sy - a.sy) * t,
  rotY: a.rotY + (b.rotY - a.rotY) * t,
  rotX: a.rotX + (b.rotX - a.rotX) * t,
});

/**
 * Pans and zooms over the app window. Shots are visited in order; each move
 * eases from wherever the previous one ended.
 */
export function Camera({
  shots,
  fadeLeft,
  children,
}: {
  shots: Shot[];
  /** Stage x left of which the picture fades to transparent, so it doesn't run under the caption. */
  fadeLeft?: number;
  children: ReactNode;
}) {
  const frame = useCurrentFrame();
  let current = pose(shots[0]);
  for (const shot of shots.slice(1)) {
    if (frame < shot.at) break;
    current = lerp(current, pose(shot), progress(frame, shot.at, shot.dur ?? 24));
  }
  const { x, y, zoom, sx, sy, rotY, rotX } = current;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        perspective: 2400,
        maskImage:
          fadeLeft === undefined
            ? undefined
            : `linear-gradient(90deg, transparent ${fadeLeft - 40}px, black ${fadeLeft + 60}px)`,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: APP_WIDTH,
          height: APP_HEIGHT,
          transformOrigin: `${x}px ${y}px`,
          transform: `translate(${sx - x}px, ${sy - y}px) rotateY(${rotY}deg) rotateX(${rotX}deg) scale(${zoom})`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
