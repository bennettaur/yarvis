import { useMemo } from "react";
import type { IssueLink, IssueSummary } from "../../lib/issues/types";
import { openExternal } from "../../lib/url";
import { StatusBadge } from "./jiraStatus";
import StartWorkButton from "./StartWorkButton";

/**
 * An issue list grouped by project, then by workflow status, for providers
 * whose rows carry `statusName`/`statusCategory` (JIRA and Azure Boards).
 */

/** Rank status categories so grouped sections read to-do → in-progress → done. */
function categoryRank(category: string | undefined): number {
  if (category === "in_progress") return 1;
  if (category === "done") return 2;
  return 0;
}

interface StatusGroup {
  status: string;
  category: string | undefined;
  issues: IssueSummary[];
}
interface ProjectGroup {
  project: string;
  issues: IssueSummary[];
  statuses: StatusGroup[];
}

/** Groups issues by project (sourceLabel), then by status within each project. */
function groupByProjectAndStatus(issues: IssueSummary[]): ProjectGroup[] {
  const byProject = new Map<string, IssueSummary[]>();
  for (const issue of issues) {
    const list = byProject.get(issue.sourceLabel);
    if (list) list.push(issue);
    else byProject.set(issue.sourceLabel, [issue]);
  }
  const projects = [...byProject.entries()].map(([project, projIssues]) => {
    const byStatus = new Map<string, StatusGroup>();
    for (const issue of projIssues) {
      const name = issue.statusName ?? "No status";
      const group = byStatus.get(name);
      if (group) group.issues.push(issue);
      else byStatus.set(name, { status: name, category: issue.statusCategory, issues: [issue] });
    }
    const statuses = [...byStatus.values()].sort(
      (a, b) =>
        categoryRank(a.category) - categoryRank(b.category) || a.status.localeCompare(b.status),
    );
    return { project, issues: projIssues, statuses };
  });
  projects.sort((a, b) => a.project.localeCompare(b.project));
  return projects;
}

function IssueRow({
  issue,
  providerName,
  starred,
  link,
  busy,
  onToggleStar,
  onOpen,
  onStartWork,
}: {
  issue: IssueSummary;
  providerName: string;
  starred: boolean;
  link: IssueLink | undefined;
  busy: boolean;
  onToggleStar: (issue: IssueSummary, starred: boolean) => void;
  onOpen: (issue: IssueSummary) => void;
  onStartWork: (issue: IssueSummary) => void;
}) {
  const assignee = issue.assignees[0];
  return (
    <li
      onClick={() => onOpen(issue)}
      className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-zinc-800/50"
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleStar(issue, starred);
        }}
        className={starred ? "text-amber-400" : "text-zinc-600 hover:text-zinc-400"}
        title={starred ? "Unstar" : "Star"}
      >
        ★
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm text-zinc-100">{issue.title}</span>
          {issue.labels.slice(0, 3).map((l) => (
            <span
              key={l.name}
              className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400"
            >
              {l.name}
            </span>
          ))}
        </div>
        <div className="text-xs text-zinc-500">
          {issue.displayId}
          {issue.issueType && ` · ${issue.issueType}`} · {issue.author || "no reporter"}
          {assignee ? ` → ${assignee}` : " → unassigned"}
        </div>
      </div>
      <StatusBadge name={issue.statusName ?? ""} category={issue.statusCategory} />
      {link?.localStatus === "in_progress" && (
        <span className="shrink-0 rounded bg-indigo-900 px-1.5 py-0.5 text-xs text-indigo-200">
          in progress
        </span>
      )}
      <StartWorkButton
        busy={busy}
        label="Start work on this ticket"
        onStart={(e) => {
          e.stopPropagation();
          onStartWork(issue);
        }}
      />
      <button
        onClick={(e) => {
          e.stopPropagation();
          openExternal(issue.url);
        }}
        className="shrink-0 text-zinc-600 hover:text-sky-400"
        title={`Open in ${providerName}`}
      >
        ↗
      </button>
    </li>
  );
}

export default function StatusGroupedIssueList({
  issues,
  providerName,
  isStarred,
  linkFor,
  isStarting,
  onToggleStar,
  onOpen,
  onStartWork,
  emptyText,
}: {
  issues: IssueSummary[];
  /** Shown in the row's "Open in …" tooltip, e.g. "JIRA". */
  providerName: string;
  isStarred: (issue: IssueSummary) => boolean;
  linkFor: (issue: IssueSummary) => IssueLink | undefined;
  isStarting: (issue: IssueSummary) => boolean;
  onToggleStar: (issue: IssueSummary, starred: boolean) => void;
  onOpen: (issue: IssueSummary) => void;
  onStartWork: (issue: IssueSummary) => void;
  emptyText: string;
}) {
  const groups = useMemo(() => groupByProjectAndStatus(issues), [issues]);
  if (issues.length === 0) return <p className="text-sm text-zinc-600">{emptyText}</p>;
  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section key={group.project}>
          <h3 className="mb-2 text-sm font-medium text-zinc-300">
            {group.project}
            <span className="ml-2 text-xs text-zinc-600">({group.issues.length})</span>
          </h3>
          <div className="space-y-3">
            {group.statuses.map((s) => (
              <div key={s.status}>
                <div className="mb-1 flex items-center gap-2 px-1">
                  <StatusBadge name={s.status} category={s.category} />
                  <span className="text-xs text-zinc-600">{s.issues.length}</span>
                </div>
                <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/50">
                  {s.issues.map((issue) => (
                    <IssueRow
                      key={issue.externalId}
                      issue={issue}
                      providerName={providerName}
                      starred={isStarred(issue)}
                      link={linkFor(issue)}
                      busy={isStarting(issue)}
                      onToggleStar={onToggleStar}
                      onOpen={onOpen}
                      onStartWork={onStartWork}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
