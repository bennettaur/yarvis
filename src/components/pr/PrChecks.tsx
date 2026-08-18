import { usePrDetail } from "../../lib/pr/cache";
import type { CheckItem, PrRef } from "../../lib/pr/types";
import { openExternal } from "../../lib/url";
import CopyButton from "../CopyButton";

function checkColor(check: CheckItem): string {
  if (check.status !== "COMPLETED") return "text-amber-400";
  const conclusion = (check.conclusion ?? "").toUpperCase();
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) return "text-emerald-400";
  return "text-red-400";
}

function checkGlyph(check: CheckItem): string {
  if (check.status !== "COMPLETED") return "○";
  const conclusion = (check.conclusion ?? "").toUpperCase();
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) return "✓";
  return "✕";
}

/** One check as a line of pasteable text: its outcome, its name and its link. */
function checkLine(check: CheckItem): string {
  const outcome = check.conclusion?.toLowerCase() ?? check.status.toLowerCase();
  return [`${checkGlyph(check)} ${check.name} (${outcome})`, check.url].filter(Boolean).join(" ");
}

/** CI/check status for one PR, read from the shared detail cache. */
export default function PrChecks({ prRef }: { prRef: PrRef }) {
  const { data, error, loading } = usePrDetail(prRef);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (loading || !data) return <p className="text-sm text-zinc-500">Loading…</p>;

  const checks = data.checks;
  if (checks.length === 0) {
    return <p className="text-sm text-zinc-600">No checks reported.</p>;
  }
  return (
    <>
      <div className="mb-1 flex items-center gap-1 text-xs text-zinc-600">
        <span>
          {checks.length} check{checks.length === 1 ? "" : "s"}
        </span>
        <CopyButton
          value={() => checks.map(checkLine).join("\n")}
          subject="checks"
          title="Copy every check with its link"
        />
      </div>
      <ul className="space-y-1">
        {checks.map((check, i) => (
          <li key={`${check.name}-${i}`} className="group flex items-center gap-2 text-sm">
            <span className={checkColor(check)}>{checkGlyph(check)}</span>
            {check.url ? (
              <button
                onClick={() => openExternal(check.url)}
                className="text-left text-zinc-300 hover:underline"
              >
                {check.name}
              </button>
            ) : (
              <span className="text-zinc-300">{check.name}</span>
            )}
            <span className="text-xs text-zinc-600">
              {check.conclusion?.toLowerCase() ?? check.status.toLowerCase()}
            </span>
            {check.url && (
              <CopyButton
                value={check.url}
                subject="check link"
                title={`Copy the link to ${check.name}`}
                className="opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
              />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
