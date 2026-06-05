import { useEffect, useState } from "react";
import { listTasks, type Task } from "../../lib/tasks";
import { linkWorkspaceTask } from "../../lib/workspaces";

/** A small picker to link an existing open task to a workspace after creation. */
export default function LinkTaskControl({
  workspaceId,
  linkedIds,
  onLinked,
}: {
  workspaceId: string;
  linkedIds: string[];
  onLinked: () => Promise<void>;
}) {
  const [openTasks, setOpenTasks] = useState<Task[]>([]);
  useEffect(() => {
    listTasks({ status: "open" })
      .then(setOpenTasks)
      .catch(() => setOpenTasks([]));
  }, []);

  const available = openTasks.filter((t) => !linkedIds.includes(t.id));
  if (available.length === 0) return null;

  return (
    <select
      value=""
      onChange={(e) => {
        const taskId = e.target.value;
        if (taskId) void linkWorkspaceTask(workspaceId, taskId).then(onLinked);
      }}
      className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none"
    >
      <option value="">+ Link a task…</option>
      {available.map((t) => (
        <option key={t.id} value={t.id}>
          {t.title}
        </option>
      ))}
    </select>
  );
}
