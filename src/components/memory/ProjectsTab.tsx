import { useCallback, useEffect, useState } from "react";
import {
  getProject,
  listProjects,
  type Project,
  type ProjectOverview,
  updateProject,
  updateProjectItem,
} from "../../lib/projects";

/**
 * The projects the assistant tracks work against: what each is for, what it is
 * focused on this week, and the tickets hanging off it with the priority the
 * user gave them. Created and filled in through conversation — this view is for
 * seeing the state and fixing it when the agent got something wrong.
 */

const PRIORITY_COLOR: Record<string, string> = {
  urgent: "bg-red-900 text-red-200",
  high: "bg-amber-900 text-amber-200",
  medium: "bg-zinc-700 text-zinc-300",
  low: "bg-zinc-800 text-zinc-500",
};

const STATUS_COLOR: Record<string, string> = {
  active: "bg-indigo-900 text-indigo-200",
  paused: "bg-amber-900 text-amber-200",
  shipped: "bg-emerald-900 text-emerald-200",
  abandoned: "bg-zinc-800 text-zinc-500",
};

export default function ProjectsTab() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const rows = await listProjects();
      setProjects(rows);
      setError(null);
      // Keep whatever is selected if it survived, otherwise fall to the first.
      setSelected((current) =>
        current && rows.some((p) => p.id === current) ? current : (rows[0]?.id ?? null),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!selected) {
      setOverview(null);
      return;
    }
    getProject(selected)
      .then(setOverview)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [selected]);

  const refreshOverview = async () => {
    if (selected) setOverview(await getProject(selected));
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-500">
        Tell the assistant about a project in chat and it appears here, with the tickets and
        priorities it is tracking.
      </p>

      {projects.length === 0 ? (
        <p className="text-sm text-zinc-600">No projects yet.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {projects.map((project) => (
            <button
              type="button"
              key={project.id}
              onClick={() => setSelected(project.id)}
              className={`rounded-md border px-2 py-1 text-sm ${
                project.id === selected
                  ? "border-indigo-500 bg-zinc-800 text-zinc-100"
                  : "border-zinc-700 text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              {project.name}
              <span
                className={`ml-2 rounded px-1 text-[10px] ${STATUS_COLOR[project.status] ?? ""}`}
              >
                {project.status}
              </span>
            </button>
          ))}
        </div>
      )}

      {overview && (
        <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium text-zinc-200">{overview.project.name}</h3>
              <select
                value={overview.project.status}
                onChange={async (e) => {
                  await updateProject(overview.project.id, {
                    status: e.target.value as Project["status"],
                  });
                  await reload();
                  await refreshOverview();
                }}
                className="ml-auto rounded-md border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs"
              >
                {["active", "paused", "shipped", "abandoned"].map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>
            {overview.project.summary && (
              <p className="mt-1 text-sm text-zinc-400">{overview.project.summary}</p>
            )}
            {overview.project.focus && (
              <p className="mt-1 text-sm text-indigo-300">Focus: {overview.project.focus}</p>
            )}
          </div>

          <div>
            <h4 className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Tracked tickets</h4>
            {overview.items.length === 0 ? (
              <p className="text-sm text-zinc-600">Nothing tracked yet.</p>
            ) : (
              <ul className="space-y-1">
                {overview.items.map((item) => (
                  <li key={item.id} className="flex items-start gap-2 text-sm">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${PRIORITY_COLOR[item.priority] ?? ""}`}
                    >
                      {item.priority}
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="text-zinc-200">
                        {item.externalKey ? `${item.externalKey} · ` : ""}
                        {item.title}
                      </span>
                      {item.note && <p className="text-xs text-zinc-500">{item.note}</p>}
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        await updateProjectItem(item.id, { done: true });
                        await refreshOverview();
                      }}
                      className="text-xs text-zinc-500 hover:text-emerald-400"
                    >
                      Done
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {overview.openTasks.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
                Your open tasks
              </h4>
              <ul className="space-y-0.5">
                {overview.openTasks.map((task) => (
                  <li key={task.id} className="text-sm text-zinc-300">
                    {task.title}
                    <span className="ml-2 text-xs text-zinc-600">
                      {task.scope}
                      {task.targetDate ? ` · ${task.targetDate}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
