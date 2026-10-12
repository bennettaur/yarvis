import { AbsoluteFill, Img, useCurrentFrame } from "remotion";
import icon from "../assets/yarvis-icon.png";
import { Backdrop } from "../components/Backdrop";
import { StaggerWords } from "../components/Caption";
import { SANS } from "../lib/style";
import { caretOn, enter, pop, sec, typed, typingFrames } from "../lib/timing";

export const outroFrames = () => sec(7);

const COMMANDS = [
  "git clone https://github.com/bennettaur/yarvis.git",
  "cd yarvis && claude",
  "> /yarvis-setup",
];

/** "Get started", with the three commands that set Yarvis up typed into a terminal. */
export function Outro() {
  const frame = useCurrentFrame();
  let at = 30;
  const rows = COMMANDS.map((cmd) => {
    const start = at;
    at += typingFrames(cmd, 45) + 8;
    return { cmd, start };
  });

  return (
    <AbsoluteFill style={{ fontFamily: SANS }}>
      <Backdrop />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <Img
          src={icon}
          style={{ width: 96, height: 96, marginBottom: 30, transform: `scale(${pop(frame, 0)})` }}
        />
        <div style={{ fontSize: 92, fontWeight: 800, letterSpacing: -3, color: "#fafafa" }}>
          <StaggerWords text="Get started" start={6} step={4} />
        </div>
        <div style={{ fontSize: 30, color: "#a1a1aa", marginTop: 18, ...enter(frame, 16) }}>
          Clone it, open Claude Code, and run the setup skill.
        </div>
        <div
          className="font-mono"
          style={{
            marginTop: 54,
            width: 980,
            padding: "28px 36px",
            background: "rgba(24,24,27,.9)",
            border: "1px solid #3f3f46",
            borderRadius: 14,
            fontSize: 30,
            lineHeight: 1.7,
            color: "#e4e4e7",
            boxShadow: "0 30px 80px rgba(0,0,0,.6)",
            ...enter(frame, 22, 14, 30),
          }}
        >
          {rows.map(({ cmd, start }, i) => {
            const text = typed(cmd, frame, start, 45);
            const active = frame >= start && (text.length < cmd.length || i === rows.length - 1);
            return (
              <div
                key={cmd}
                style={{ minHeight: 51, color: cmd.startsWith(">") ? "#a5b4fc" : undefined }}
              >
                {!cmd.startsWith(">") && frame >= start && (
                  <span style={{ color: "#4ade80" }}>$ </span>
                )}
                {text}
                {active && caretOn(frame) && (
                  <span style={{ background: "#e4e4e7", color: "transparent" }}>_</span>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 22, color: "#71717a", marginTop: 40, ...enter(frame, at + 10) }}>
          docs/getting-started.md · docs/features/ · github.com/bennettaur/yarvis
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
