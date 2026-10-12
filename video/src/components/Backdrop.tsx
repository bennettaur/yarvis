import { AbsoluteFill, useCurrentFrame } from "remotion";

/**
 * The dark stage behind everything: a slow-drifting indigo glow (red for
 * alarms), plus smaller ones in the icon's cyan and amber.
 */
export function Backdrop({ tint = "indigo" }: { tint?: "indigo" | "red" }) {
  const frame = useCurrentFrame();
  const drift = (period: number, amp: number, phase = 0) =>
    Math.sin((frame / period) * Math.PI * 2 + phase) * amp;
  const primary = tint === "red" ? "rgba(239,68,68,.28)" : "rgba(99,102,241,.30)";

  return (
    <AbsoluteFill style={{ background: "#050507", overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          width: 1400,
          height: 1400,
          left: -300 + drift(420, 80),
          top: -700 + drift(360, 60, 1),
          background: `radial-gradient(circle, ${primary}, transparent 60%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 1200,
          height: 1200,
          right: -400 + drift(480, 90, 2),
          bottom: -700 + drift(400, 70, 3),
          background: "radial-gradient(circle, rgba(34,211,238,.16), transparent 60%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 900,
          height: 900,
          right: 200 + drift(540, 120, 4),
          top: -500 + drift(300, 40, 5),
          background: "radial-gradient(circle, rgba(251,191,36,.08), transparent 60%)",
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: "radial-gradient(rgba(255,255,255,.07) 1px, transparent 1px)",
          backgroundSize: "36px 36px",
          backgroundPosition: `0 ${-frame * 0.3}px`,
          maskImage: "radial-gradient(ellipse at center, black 30%, transparent 75%)",
        }}
      />
      <AbsoluteFill
        style={{
          background: "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,.6))",
        }}
      />
    </AbsoluteFill>
  );
}
