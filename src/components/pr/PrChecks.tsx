import { clipboardSafeText, clipboardSafeUrl } from "../../lib/clipboard";
import { usePrDetail } from "../../lib/pr/cache";
import type { CheckItem, PrRef } from "../../lib/pr/types";
import { openExternal } from "../../lib/url";
import CopyButton from "../CopyButton";
import CopyLinkButton from "../CopyLinkButton";

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

/** The check's conclusion, or its status while it is still running. */
function checkOutcome(check: CheckItem): string {
  return check.conclusion?.toLowerCase() ?? check.status.toLowerCase();
}

/**
 * One check as a line of pasteable text: its outcome, its name and its link.
 * The name is provider-supplied — anyone who can add a workflow or a status app
 * picks it — so it is stripped before it can forge a line of its own in the
 * block these are joined into.
 */
export function checkLine(check: CheckItem): string {
  const line = `${checkGlyph(check)} ${clipboardSafeText(check.name)} (${checkOutcome(check)})`;
  const url = clipboardSafeUrl(check.url);
  return url ? `${line} ${url}` : line;
}

/** Every check as one pasteable block, one line each. */
export const checksClipboardText = (checks: CheckItem[]): string =>
  checks.map(checkLine).join("\n");

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
          value={() => checksClipboardText(checks)}
          subject="checks"
          title="Copy every check with its link"
        />
      </div>
      <ul className="space-y-1">
        {checks.map((check, i) => (
          <li key={`${check.name}-${i}`} className="group/check flex items-center gap-2 text-sm">
            <span className={checkColor(check)}>{checkGlyph(check)}</span>
            {check.url ? (
              <button
                type="button"
                onClick={() => openExternal(check.url)}
                className="text-left text-zinc-300 hover:underline"
              >
                {check.name}
              </button>
            ) : (
              <span className="text-zinc-300">{check.name}</span>
            )}
            <span className="text-xs text-zinc-600">{checkOutcome(check)}</span>
            {check.url && (
              <CopyLinkButton
                url={check.url}
                subject="check link"
                title={`Copy the link to ${check.name}`}
                className="opacity-0 transition-opacity focus:opacity-100 group-hover/check:opacity-100"
              />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
