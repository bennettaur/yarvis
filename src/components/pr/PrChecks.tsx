import { usePrDetail } from "../../lib/githubCache";
import { type CheckItem } from "../../lib/github";
import { openExternal } from "../../lib/url";
import type { PrRef } from "./shared";

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

/** CI/check status for one PR, read from the shared detail cache. */
export default function PrChecks({ owner, repo, number }: PrRef) {
  const { data, error, loading } = usePrDetail(owner, repo, number);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (loading || !data) return <p className="text-sm text-zinc-500">Loading…</p>;

  const checks = data.checks;
  if (checks.length === 0) {
    return <p className="text-sm text-zinc-600">No checks reported.</p>;
  }
  return (
    <ul className="space-y-1">
      {checks.map((check, i) => (
        <li key={`${check.name}-${i}`} className="flex items-center gap-2 text-sm">
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
        </li>
      ))}
    </ul>
  );
}
