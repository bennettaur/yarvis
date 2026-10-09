import type { ReactNode } from "react";
import WorkspacePrBadges from "../../../src/components/workspaces/WorkspacePrBadges";
import type { WorkspaceSummaryPr } from "../../../src/lib/workspaces";
import { Terminal, type TermLine } from "../components/Terminal";

type Status = "creating" | "active" | "archiving" | "error";

// Copied from WorkspacesPanel's `STATUS_STYLES`, which isn't exported.
const STATUS_STYLES: Record<Status, string> = {
  creating: "bg-amber-900/40 text-amber-200",
  active: "bg-emerald-900/40 text-emerald-200",
  archiving: "bg-amber-900/40 text-amber-200",
  error: "bg-red-900/40 text-red-200",
};

const StatusBadge = ({ status }: { status: Status }) => (
  <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLES[status]}`}>{status}</span>
);

export interface WorkspaceRow {
  name: string;
  status: Status;
  pr?: Omit<WorkspaceSummaryPr, "repoName">;
  attention?: boolean;
}

export interface WorkspaceGroup {
  label: string;
  rows: WorkspaceRow[];
}

/** A PR summary for a list row, from the few fields that decide its badge. */
export const prSummary = (
  prNumber: number,
  checkRollup: WorkspaceSummaryPr["checkRollup"],
  extra: Partial<WorkspaceSummaryPr> = {},
): WorkspaceRow["pr"] => ({
  prNumber,
  checkRollup,
  prState: "open",
  isDraft: false,
  mergeable: "clean",
  reviewDecision: null,
  ...extra,
});

export interface WorkspaceDetail {
  name: string;
  status: Status;
  rootPath: string;
  repos: { name: string; branch: string; ready: boolean }[];
  /** The PR status line under the repo chips. */
  prLine?: ReactNode;
  tasks?: { title: string; done: boolean }[];
  terminal: TermLine[];
  spinnerFrom?: number;
  spinnerLabel?: string;
  /** The agent tab is waiting on the user. */
  agentFlagged?: boolean;
  side: ReactNode;
  sideTab?: "All files" | "Changed" | "Comments" | "PR checks" | "Stack";
  commentCount?: number;
}

/** The Workspaces tab, from `WorkspacesPanel`'s markup: the grouped list and one open workspace. */
export function WorkspacesView({
  groups,
  selected,
  detail,
}: {
  groups: WorkspaceGroup[];
  selected: string | null;
  detail: WorkspaceDetail | null;
}) {
  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-800">
        <div className="flex shrink-0 items-center gap-2 px-3 py-2">
          <h2 className="mr-auto text-sm font-medium text-zinc-200">Workspaces</h2>
          <span className="rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium">New</span>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden px-2 pb-2">
          {groups.map((group) => (
            <div key={group.label} className="mb-3">
              <div className="px-1 py-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
                {group.label}
              </div>
              <ul>
                {group.rows.map((ws) => (
                  <li key={ws.name}>
                    <div
                      className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                        ws.name === selected
                          ? "bg-zinc-800 text-zinc-100"
                          : ws.attention
                            ? "text-amber-300"
                            : "text-zinc-300"
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        {ws.attention && (
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                        )}
                        <span className="truncate">{ws.name}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {ws.pr && <WorkspacePrBadges prs={[{ repoName: group.label, ...ws.pr }]} />}
                        <StatusBadge status={ws.status} />
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        {detail ? (
          <Detail detail={detail} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            Select a workspace or create a new one.
          </div>
        )}
      </main>
    </div>
  );
}

const SIDE_TABS = ["All files", "Changed", "Comments", "PR checks", "Stack"] as const;

function Detail({ detail }: { detail: WorkspaceDetail }) {
  const sideTab = detail.sideTab ?? "Changed";
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-zinc-800 px-4 py-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-zinc-100">{detail.name}</h2>
          <StatusBadge status={detail.status} />
          <span className="ml-auto truncate font-mono text-xs text-zinc-500">
            {detail.rootPath}
          </span>
          <span className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300">
            Archive
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {detail.repos.map((repo) => (
            <div
              key={repo.name}
              className="flex items-center gap-2 rounded-md border border-zinc-800 px-2 py-1 text-xs"
            >
              <span className="text-zinc-200">{repo.name}</span>
              <span className="font-mono text-zinc-500">{repo.branch}</span>
              <span
                className={`rounded px-1.5 py-0.5 text-xs ${
                  repo.ready
                    ? "bg-emerald-900/40 text-emerald-200"
                    : "bg-amber-900/40 text-amber-200"
                }`}
              >
                {repo.ready ? "ready" : "provisioning"}
              </span>
            </div>
          ))}
        </div>
        {detail.prLine && (
          <div className="mt-2 space-y-1.5 border-t border-zinc-800 pt-2">{detail.prLine}</div>
        )}
        {detail.tasks && detail.tasks.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <span className="uppercase tracking-wide">Tasks</span>
            {detail.tasks.map((task) => (
              <span
                key={task.title}
                className="flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-0.5"
              >
                <span className={task.done ? "text-emerald-400" : "text-zinc-300"}>
                  {task.done ? "✓" : "○"} {task.title}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex h-full min-h-0 min-w-0 flex-[0.66] flex-col bg-[#09090b]">
          <div className="flex shrink-0 items-center gap-0.5 border-b border-zinc-800 bg-zinc-950 px-1">
            <div
              className={`flex shrink-0 items-center gap-1 border-b-2 border-indigo-400 px-2 py-1 text-xs ${
                detail.agentFlagged ? "text-amber-300" : "text-zinc-100"
              }`}
            >
              <span className={detail.agentFlagged ? "text-amber-400" : "text-emerald-400"}>●</span>
              Claude
            </div>
            <span className="shrink-0 rounded px-2 py-0.5 text-zinc-400">+</span>
          </div>
          <Terminal
            lines={detail.terminal}
            spinnerFrom={detail.spinnerFrom}
            spinnerLabel={detail.spinnerLabel}
            className="min-h-0 flex-1"
          />
        </div>
        <div className="w-px bg-zinc-800" />
        <div className="flex h-full min-h-0 min-w-0 flex-[0.34] flex-col">
          <div className="flex shrink-0 items-center gap-1 px-3 pt-1.5 text-xs text-zinc-500">
            <span className="shrink-0">Viewing </span>
            <span className="min-w-0 truncate font-mono text-zinc-300">
              {detail.repos[0]?.branch}
            </span>
          </div>
          <div className="flex shrink-0 gap-1 border-b border-zinc-800 px-2 pt-1">
            {SIDE_TABS.map((label) => (
              <span
                key={label}
                className={`whitespace-nowrap border-b-2 px-1.5 py-1.5 text-xs ${
                  label === sideTab
                    ? "border-indigo-400 text-zinc-100"
                    : "border-transparent text-zinc-500"
                }`}
              >
                {label}
                {label === "Comments" && detail.commentCount ? (
                  <span className="ml-1 rounded bg-zinc-800 px-1 text-zinc-300">
                    {detail.commentCount}
                  </span>
                ) : null}
              </span>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-hidden p-2">{detail.side}</div>
        </div>
      </div>
    </div>
  );
}

const CHANGE_COLORS = {
  A: "text-emerald-400",
  M: "text-amber-400",
  D: "text-red-400",
} as const;

/** The right column's Changed view: one row per file with its +/− counts. */
export function ChangedFiles({
  files,
}: {
  files: { path: string; change: keyof typeof CHANGE_COLORS; add: number; del: number }[];
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1 px-2 text-xs text-zinc-500">
        {files.length} changed files
      </div>
      <ul className="space-y-0.5 font-mono text-xs">
        {files.map((file) => (
          <li key={file.path} className="flex w-full items-center gap-2 rounded px-2 py-0.5">
            <span className={`shrink-0 ${CHANGE_COLORS[file.change]}`}>{file.change}</span>
            <span className="min-w-0 flex-1 truncate text-zinc-400">{file.path}</span>
            <span className="shrink-0 text-zinc-500">
              <span className="text-emerald-400">+{file.add}</span>{" "}
              <span className="text-red-400">−{file.del}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const ROLLUP = {
  success: ["✓ checks passing", "text-emerald-400"],
  failure: ["✗ checks failing", "text-red-400"],
  pending: ["● checks running", "text-amber-400"],
} as const;

/** `WorkspacePrStatus`'s line: PR number, state, check rollup, and the Review button. */
export function PrStatusLine({ number, rollup }: { number: number; rollup: keyof typeof ROLLUP }) {
  const [label, color] = ROLLUP[rollup];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span className="flex items-center gap-1.5">
        <span className="font-mono text-zinc-400">#{number}</span>
        <span className="rounded bg-emerald-900/40 px-1.5 py-0.5 text-emerald-200">open</span>
      </span>
      <span className={color}>{label}</span>
      <span className="rounded border border-indigo-700/60 bg-indigo-900/30 px-1.5 py-0.5 text-indigo-200">
        Review
      </span>
      <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-300">Open ↗</span>
    </div>
  );
}
