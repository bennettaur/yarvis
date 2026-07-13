import type { WorkspaceRepoDetail } from "../../lib/workspaces";

/**
 * A setup-log tab's body: shows a workspace repo's provisioning outcome — the
 * captured setup-script output plus any error — so a failed provision can be
 * diagnosed after the fact. The data is already on the repo detail (streamed in
 * during provisioning and persisted), so this is a pure read; the tab re-renders
 * as the surrounding detail view re-polls, picking up a retry's fresh output.
 */
export default function WorkspaceSetupLog({ repo }: { repo: WorkspaceRepoDetail }) {
  const failed = repo.status === "error";
  const exitLine = repo.setupExitCode !== null ? `setup script exited ${repo.setupExitCode}` : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-xs">
        <span className="font-medium text-zinc-200">{repo.repo.name}</span>
        <span className={failed ? "text-red-300" : "text-zinc-500"}>
          {exitLine ?? (failed ? "provisioning failed" : "setup output")}
        </span>
      </div>
      {repo.error && (
        <p className="shrink-0 border-b border-zinc-800 px-3 py-2 font-mono text-xs text-red-400">
          {repo.error}
        </p>
      )}
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs text-zinc-300">
        {repo.setupLog || "No setup output was captured."}
      </pre>
    </div>
  );
}
