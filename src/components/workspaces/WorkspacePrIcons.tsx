import { prGlanceBadge } from "../../lib/workspacePrStatus";
import type { WorkspaceSummaryPr } from "../../lib/workspaces";

/**
 * One glyph per PR in a workspace, for the list row beside the workspace
 * status. Multi-repo workspaces get one glyph per repo with a PR, in list
 * order, so a single failing repo is still visible.
 */
export default function WorkspacePrIcons({ prs }: { prs: WorkspaceSummaryPr[] }) {
  if (prs.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {prs.map((pr) => {
        const badge = prGlanceBadge(pr);
        return (
          <span
            key={`${pr.repoName}#${pr.prNumber}`}
            role="img"
            title={badge.label}
            aria-label={badge.label}
            className={`text-xs leading-none ${badge.className}`}
          >
            {badge.icon}
          </span>
        );
      })}
    </span>
  );
}
