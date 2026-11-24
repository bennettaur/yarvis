import type { RiskLevel } from "../../lib/attention";

/** Tinted rather than solid, so the text keeps its contrast in every theme. */
const RISK_CLASS: Record<RiskLevel, string> = {
  high: "border-red-700 bg-red-950/60 text-red-300",
  medium: "border-amber-700 bg-amber-950/50 text-amber-300",
  low: "border-emerald-800 bg-emerald-950/40 text-emerald-300",
};

const RISK_LABEL: Record<RiskLevel, string> = {
  high: "High risk",
  medium: "Medium risk",
  low: "Low risk",
};

/** The left edge of a row, so a high-risk PR stands out in a list before its badge is read. */
export const RISK_ACCENT: Record<RiskLevel, string> = {
  high: "border-l-2 border-l-red-500",
  medium: "border-l-2 border-l-amber-400",
  // Same width as the others, so every prepared PR's text lines up.
  low: "border-l-2 border-l-transparent",
};

/** A verification report's risk level, in words as well as colour. */
export default function RiskBadge({ risk }: { risk: RiskLevel }) {
  return (
    <span
      title="The risk the PR's verification report assessed"
      className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${RISK_CLASS[risk]}`}
    >
      {RISK_LABEL[risk]}
    </span>
  );
}
