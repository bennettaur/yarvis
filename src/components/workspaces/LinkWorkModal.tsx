import { useEffect, useMemo, useState } from "react";
import { issuesAll } from "../../lib/issues/api";
import { type IssueSummary, issueKey } from "../../lib/issues/types";
import { listTasks, type Task } from "../../lib/tasks";
import { linkWorkspaceIssue, linkWorkspaceTask, type WorkspaceDetail } from "../../lib/workspaces";

type Tab = "tasks" | "github" | "jira";

/**
 * The modal behind a workspace's "Link work" button. Three sources on one
 * surface: internal tasks, GitHub issues from the workspace's issue-enabled
 * repos, and JIRA tickets entered by key/URL (live JQL search lands later).
 */
export default function LinkWorkModal({
  detail,
  onClose,
  onLinked,
}: {
  detail: WorkspaceDetail;
  onClose: () => void;
  onLinked: () => Promise<void>;
}) {
  // Only workspace repos with issues enabled can source GitHub issues; when none
  // qualify the GitHub tab shows an empty state instead of an idle fetch.
  const githubRepoKeys = useMemo(
    () =>
      new Set(
        detail.repos
          .filter((wr) => wr.repo.pullIssues)
          .map((wr) => `${wr.repo.owner}/${wr.repo.repo}`),
      ),
    [detail.repos],
  );

  const [tab, setTab] = useState<Tab>("tasks");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const linkedIssueKeys = useMemo(
    () => new Set(detail.issues.map((i) => issueKey(i.provider, i.sourceKey, i.externalId))),
    [detail.issues],
  );

  const runLink = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onLinked();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 p-6">
      <div className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h3 className="text-sm font-medium text-zinc-100">Link work</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="flex gap-1 border-b border-zinc-800 px-3 pt-2">
          <TabButton active={tab === "tasks"} onClick={() => setTab("tasks")}>
            Tasks
          </TabButton>
          <TabButton active={tab === "github"} onClick={() => setTab("github")}>
            GitHub
          </TabButton>
          <TabButton active={tab === "jira"} onClick={() => setTab("jira")}>
            JIRA
          </TabButton>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
          {tab === "tasks" && (
            <TasksTab
              linkedIds={detail.tasks.map((t) => t.id)}
              disabled={busy}
              onPick={(taskId) => runLink(() => linkWorkspaceTask(detail.id, taskId))}
            />
          )}
          {tab === "github" && (
            <GithubTab
              repoKeys={githubRepoKeys}
              linkedKeys={linkedIssueKeys}
              disabled={busy}
              onPick={(issue) =>
                runLink(() =>
                  linkWorkspaceIssue(detail.id, {
                    provider: "github",
                    sourceKey: issue.sourceKey,
                    externalId: issue.externalId,
                    title: issue.title,
                    url: issue.url,
                  }),
                )
              }
            />
          )}
          {tab === "jira" && (
            <JiraTab
              disabled={busy}
              onSubmit={(input) => runLink(() => linkWorkspaceIssue(detail.id, input))}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-t-md px-3 py-1.5 text-xs font-medium ${
        active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}

function TasksTab({
  linkedIds,
  disabled,
  onPick,
}: {
  linkedIds: string[];
  disabled: boolean;
  onPick: (taskId: string) => void;
}) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    listTasks({ status: "open" })
      .then(setTasks)
      .catch(() => setTasks([]));
  }, []);

  const available = (tasks ?? [])
    .filter((t) => !linkedIds.includes(t.id))
    .filter((t) => t.title.toLowerCase().includes(query.toLowerCase()));

  if (tasks === null) return <Hint>Loading tasks…</Hint>;
  if (tasks.length === 0 || linkedIds.length === (tasks?.length ?? 0)) {
    return <Hint>No open tasks to link.</Hint>;
  }

  return (
    <div className="space-y-2">
      <SearchInput value={query} onChange={setQuery} placeholder="Filter tasks…" />
      {available.length === 0 ? (
        <Hint>No matching tasks.</Hint>
      ) : (
        <ul className="space-y-1">
          {available.map((t) => (
            <li key={t.id}>
              <PickRow disabled={disabled} onClick={() => onPick(t.id)}>
                <span className="truncate text-zinc-200">{t.title}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-zinc-500">
                  {t.scope}
                </span>
              </PickRow>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GithubTab({
  repoKeys,
  linkedKeys,
  disabled,
  onPick,
}: {
  repoKeys: Set<string>;
  linkedKeys: Set<string>;
  disabled: boolean;
  onPick: (issue: IssueSummary) => void;
}) {
  const [issues, setIssues] = useState<IssueSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const hasRepos = repoKeys.size > 0;

  useEffect(() => {
    if (!hasRepos) return;
    issuesAll()
      .then((all) => setIssues(all.filter((i) => repoKeys.has(i.sourceKey))))
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [hasRepos, repoKeys]);

  if (!hasRepos) {
    return <Hint>No repo in this workspace has issues enabled.</Hint>;
  }
  if (loadError) return <Hint>Couldn’t load issues: {loadError}</Hint>;
  if (issues === null) return <Hint>Loading issues…</Hint>;

  const available = issues
    .filter((i) => !linkedKeys.has(issueKey("github", i.sourceKey, i.externalId)))
    .filter(
      (i) =>
        i.title.toLowerCase().includes(query.toLowerCase()) ||
        i.displayId.toLowerCase().includes(query.toLowerCase()),
    );

  if (issues.length === 0) return <Hint>No open issues in this workspace’s repos.</Hint>;

  return (
    <div className="space-y-2">
      <SearchInput value={query} onChange={setQuery} placeholder="Filter issues…" />
      {available.length === 0 ? (
        <Hint>No matching issues.</Hint>
      ) : (
        <ul className="space-y-1">
          {available.map((i) => (
            <li key={issueKey("github", i.sourceKey, i.externalId)}>
              <PickRow disabled={disabled} onClick={() => onPick(i)}>
                <span className="truncate text-zinc-200">{i.title}</span>
                <span className="shrink-0 font-mono text-[10px] text-zinc-500">{i.displayId}</span>
              </PickRow>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function JiraTab({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (input: {
    provider: "jira";
    sourceKey: string;
    externalId: string;
    title?: string | null;
    url?: string | null;
  }) => void;
}) {
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");

  const parsed = parseJiraKey(key);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!parsed) return;
    onSubmit({
      provider: "jira",
      sourceKey: parsed.project,
      externalId: parsed.key,
      title: title.trim() || null,
      url: url.trim() || null,
    });
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-xs text-zinc-500">
        Enter a JIRA issue by key or URL. Searching by JQL comes later.
      </p>
      <label className="block text-xs text-zinc-400">
        <span className="mb-1 block uppercase tracking-wide">Issue key or URL</span>
        <input
          value={key}
          placeholder="PROJ-123"
          onChange={(e) => setKey(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="block text-xs text-zinc-400">
        <span className="mb-1 block uppercase tracking-wide">Title (optional)</span>
        <input
          value={title}
          placeholder="Short description"
          onChange={(e) => setTitle(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="block text-xs text-zinc-400">
        <span className="mb-1 block uppercase tracking-wide">URL (optional)</span>
        <input
          value={url}
          placeholder="https://your-org.atlassian.net/browse/PROJ-123"
          onChange={(e) => setUrl(e.target.value)}
          className={inputClass}
        />
      </label>
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-zinc-600">
          {parsed ? `Links ${parsed.key}` : "Expecting e.g. PROJ-123"}
        </span>
        <button
          type="submit"
          disabled={disabled || !parsed}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium hover:bg-indigo-500 disabled:opacity-40"
        >
          Link ticket
        </button>
      </div>
    </form>
  );
}

/**
 * Pulls a JIRA issue key out of raw entry: a bare "PROJ-123" or a browse URL
 * ending in one. The project key (the part before the number) is the sourceKey
 * used across the issue tables.
 */
export function parseJiraKey(raw: string): { project: string; key: string } | null {
  const match = raw.trim().match(/([A-Za-z][A-Za-z0-9]+)-(\d+)\s*$/);
  if (!match) return null;
  const project = match[1].toUpperCase();
  return { project, key: `${project}-${match[2]}` };
}

const inputClass =
  "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500";

function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={inputClass}
    />
  );
}

function PickRow({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center justify-between gap-2 rounded-md border border-zinc-800 px-2 py-1.5 text-left text-xs hover:border-zinc-600 hover:bg-zinc-800 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="py-4 text-center text-xs text-zinc-500">{children}</p>;
}
