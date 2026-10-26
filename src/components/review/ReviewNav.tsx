import { type ReactNode, useState } from "react";
import { usePrDetail } from "../../lib/pr/cache";
import { refNumber } from "../../lib/pr/ref";
import type { ReviewWorkspacePr } from "../../lib/reviewWorkspaces/api";
import { useReviewChangedFiles } from "../../lib/reviewWorkspaces/cache";
import { useCommitsSinceLastReview } from "../../lib/reviewWorkspaces/sinceReview";
import AllFilesTree from "./nav/AllFilesTree";
import ChangedFilesTree from "./nav/ChangedFilesTree";
import CommitsList from "./nav/CommitsList";
import { prColor } from "./prColors";
import { STATIC_TAB_LABEL } from "./tabs/registry";
import type { PrColor, StaticTabKind, TabSpec } from "./tabs/types";

/** "repo#12": the short name a PR goes by in the nav and before its tab titles. */
export function prLabel(pr: Pick<ReviewWorkspacePr, "ref">): string {
  return `${pr.ref.repo}#${refNumber(pr.ref)}`;
}

/** Sorted the way the workspace lists them, so colours and groups stay put. */
export function navGroups(prs: ReviewWorkspacePr[]): { pr: ReviewWorkspacePr; color: PrColor }[] {
  return [...prs]
    .sort((a, b) => a.position - b.position)
    .map((pr) => ({ pr, color: prColor(pr.colorIndex) }));
}

/**
 * What the PR's header says about its checkout: nothing once it is ready,
 * otherwise the clone's progress or why it failed. Everything that reads from
 * the provider (description, reviewers, checks, comments) works before then.
 */
export function cloneStatusText(pr: ReviewWorkspacePr, lastLog: string | null): string | null {
  if (pr.status === "error") return pr.error ?? "Clone failed";
  if (pr.status === "pending") return "Waiting to clone…";
  if (pr.status === "cloning") return lastLog ? `Cloning · ${lastLog}` : "Cloning…";
  if (pr.worktreeStatus === "checking-out") return "Checking out…";
  if (pr.worktreeStatus === "error") return pr.error ?? "Checkout failed";
  return null;
}

const NAV_ITEMS: StaticTabKind[] = [
  "description",
  "reviewers",
  "checks",
  "comments",
  "since-review",
];

function Item({
  label,
  active,
  disabled,
  title,
  badge,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  title?: string;
  badge?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex w-full items-center justify-between gap-2 px-3 py-1 text-left text-sm disabled:cursor-default disabled:text-zinc-600 ${
        active ? "bg-zinc-800 text-zinc-100" : "text-zinc-300 hover:bg-zinc-800/60"
      }`}
    >
      <span className="truncate">{label}</span>
      {badge}
    </button>
  );
}

function Section({
  title,
  count,
  defaultOpen,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  // Follows `defaultOpen` (which can change, as commits arrive) until the user
  // opens or closes it; from then on it stays as they left it.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? defaultOpen;
  return (
    <div>
      <button
        type="button"
        onClick={() => setChosen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 hover:text-zinc-300"
      >
        <span className={`text-zinc-600 transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
        {title}
        {count !== undefined && <span className="font-normal text-zinc-600">{count}</span>}
      </button>
      {open && <div className="pb-1 pl-2">{children}</div>}
    </div>
  );
}

/**
 * One PR's part of the left nav: a coloured header with its checkout state,
 * then its sections. Clicking a section opens it as a tab.
 */
function PrGroup({
  workspaceId,
  pr,
  color,
  active,
  progress,
  openTab,
  onSetup,
}: {
  workspaceId: string;
  pr: ReviewWorkspacePr;
  color: PrColor;
  active: TabSpec | null;
  progress: string | null;
  openTab: (spec: TabSpec) => void;
  onSetup: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const { data: detail } = usePrDetail(pr.ref);
  const changed = useReviewChangedFiles(workspaceId, pr);
  const commits = useCommitsSinceLastReview(workspaceId, pr);
  const commitList = commits.data?.commits ?? null;
  const newCommits = commitList?.filter((c) => c.isNew).length ?? 0;
  const openThreads = (detail?.reviewThreads ?? []).filter((t) => !t.isResolved).length;
  const status = cloneStatusText(pr, progress);
  const failed = pr.status === "error" || pr.worktreeStatus === "error";
  const isActive = (kind: string) => active?.prId === pr.id && active.kind === kind;
  const activePath = active?.prId === pr.id && "path" in active ? active.path : null;
  const open = (kind: StaticTabKind) => openTab({ kind, prId: pr.id });
  const needsSetupAnswer =
    pr.worktreeStatus === "ready" && pr.setupConsent === null && pr.setupStatus === null;

  return (
    <section className="border-b border-zinc-800" aria-label={prLabel(pr)}>
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className={`flex w-full items-start gap-2 border-l-4 ${color.border} bg-zinc-900/60 px-2 py-2 text-left hover:bg-zinc-900`}
      >
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${color.bg}`} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className={`block text-xs font-medium ${color.text}`}>{prLabel(pr)}</span>
          <span className="block truncate text-sm text-zinc-200" title={pr.title}>
            {detail?.title || pr.title || "Loading…"}
          </span>
          {status && (
            <span
              className={`block truncate text-xs ${failed ? "text-red-400" : "animate-pulse text-indigo-300"}`}
              title={status}
            >
              {status}
            </span>
          )}
        </span>
      </button>
      {!collapsed && (
        <div className="py-1">
          {NAV_ITEMS.map((kind) => (
            <Item
              key={kind}
              label={STATIC_TAB_LABEL[kind]}
              active={isActive(kind)}
              onClick={() => open(kind)}
              badge={
                kind === "comments" && openThreads ? (
                  <span className="rounded bg-amber-900/40 px-1.5 text-xs text-amber-200">
                    {openThreads}
                  </span>
                ) : kind === "since-review" && newCommits ? (
                  <span
                    className="rounded bg-emerald-900/40 px-1.5 text-xs text-emerald-200"
                    title={`${newCommits} new since your last review`}
                  >
                    {newCommits} new
                  </span>
                ) : undefined
              }
            />
          ))}
          {needsSetupAnswer && (
            <button
              type="button"
              onClick={onSetup}
              className="mx-3 my-1 block text-left text-xs text-amber-300 hover:text-amber-200"
            >
              Setup hasn't run · review the script…
            </button>
          )}
          <Section title="Changed files" count={changed.data?.files.length} defaultOpen>
            <ChangedFilesTree
              workspaceId={workspaceId}
              pr={pr}
              color={color}
              activePath={active?.kind === "diff" ? activePath : null}
              openTab={openTab}
            />
          </Section>
          <Section title="Commits" count={commitList?.length} defaultOpen={newCommits > 0}>
            {commitList ? (
              <CommitsList
                prId={pr.id}
                commits={commitList}
                truncated={commits.data?.truncated ?? false}
                activeSha={active?.prId === pr.id && active.kind === "commit" ? active.sha : null}
                openTab={openTab}
              />
            ) : (
              <p className="px-3 py-1 text-xs text-zinc-500">
                {commits.error ?? (pr.headSha ? "Loading…" : "Waiting for the clone…")}
              </p>
            )}
          </Section>
          <Section title="All files" defaultOpen={false}>
            <AllFilesTree
              workspaceId={workspaceId}
              pr={pr}
              color={color}
              activePath={active?.kind === "file" ? activePath : null}
              openTab={openTab}
            />
          </Section>
        </div>
      )}
    </section>
  );
}

/** The left nav: one group per PR, in the workspace's order and colours. */
export default function ReviewNav({
  workspaceId,
  prs,
  active,
  progress,
  openTab,
  onSetup,
}: {
  workspaceId: string;
  prs: ReviewWorkspacePr[];
  active: TabSpec | null;
  /** The latest clone log line per PR id, while one is running. */
  progress: ReadonlyMap<string, string>;
  openTab: (spec: TabSpec) => void;
  onSetup: (pr: ReviewWorkspacePr) => void;
}) {
  return (
    <nav className="h-full overflow-y-auto bg-zinc-950" aria-label="Pull requests">
      {prs.length === 0 && (
        <p className="p-3 text-xs text-zinc-500">Paste a PR link above to start reviewing.</p>
      )}
      {navGroups(prs).map(({ pr, color }) => (
        <PrGroup
          key={pr.id}
          workspaceId={workspaceId}
          pr={pr}
          color={color}
          active={active}
          progress={progress.get(pr.id) ?? null}
          openTab={openTab}
          onSetup={() => onSetup(pr)}
        />
      ))}
    </nav>
  );
}
