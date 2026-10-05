import { AbsoluteFill, Easing, Img, interpolate, useCurrentFrame } from "remotion";
import icon from "../assets/yarvis-icon.png";
import { Backdrop } from "../components/Backdrop";
import { StaggerWords } from "../components/Caption";
import { SANS } from "../lib/style";
import { enter, pop, progress, sec } from "../lib/timing";

export const introFrames = () => sec(5);

/** The icon spins in and settles, then the name and tagline land. */
export function Intro() {
  const frame = useCurrentFrame();
  const settle = pop(frame, 4, 11);
  const spin = interpolate(settle, [0, 1], [-140, 0]);
  const glow = progress(frame, 10, 30, Easing.out(Easing.quad));
  const exit = progress(frame, introFrames() - 14, 14);

  return (
    <AbsoluteFill style={{ fontFamily: SANS, opacity: 1 - exit }}>
      <Backdrop />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            position: "absolute",
            width: 520,
            height: 520,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(34,211,238,.25), rgba(251,191,36,.10) 45%, transparent 70%)",
            opacity: glow,
            transform: `scale(${0.6 + glow * 0.6})`,
            top: 120,
          }}
        />
        <Img
          src={icon}
          style={{
            width: 190,
            height: 190,
            marginBottom: 40,
            transform: `scale(${settle}) rotate(${spin}deg)`,
          }}
        />
        <div
          style={{
            fontSize: 150,
            fontWeight: 800,
            letterSpacing: -6,
            lineHeight: 1,
            background: "linear-gradient(180deg, #ffffff, #a1a1aa)",
            WebkitBackgroundClip: "text",
            color: "transparent",
            ...enter(frame, 18, 18, 30),
          }}
        >
          Yarvis
        </div>
        <div style={{ fontSize: 40, color: "#d4d4d8", marginTop: 26, fontWeight: 500 }}>
          <StaggerWords
            text="Run your week with an assistant that can start the work."
            start={34}
            step={3}
          />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
