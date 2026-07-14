import { useCallback, useEffect, useMemo, useState } from "react";
import { completeTask, createTask, deleteTask, listTasks, type Task } from "../lib/tasks";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Friendly date label for a task's target date, relative to today. */
function describeDate(target: string): string {
  const today = todayIso();
  if (target === today) return "Today";
  const t = new Date(`${target}T00:00:00`);
  const now = new Date(`${today}T00:00:00`);
  const diff = Math.round((t.getTime() - now.getTime()) / 86_400_000);
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff < 7) return t.toLocaleDateString(undefined, { weekday: "long" });
  if (diff < 0) return `${-diff}d ago`;
  return t.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function isOverdue(target: string | null): boolean {
  if (!target) return false;
  return target < todayIso();
}

function TaskRow({
  task,
  onComplete,
  onDelete,
}: {
  task: Task;
  onComplete: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const overdue = task.status === "open" && isOverdue(task.targetDate);
  return (
    <li className="group flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-zinc-800/40">
      <button
        type="button"
        onClick={() => onComplete(task.id)}
        aria-label={task.status === "done" ? "Completed" : "Mark complete"}
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors ${
          task.status === "done"
            ? "border-emerald-500 bg-emerald-500/20 text-emerald-300"
            : "border-zinc-600 text-transparent hover:border-indigo-400 hover:text-indigo-300"
        }`}
      >
        <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden="true">
          <path
            d="M3.5 8.5l3 3 6-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <span
        className={`min-w-0 flex-1 truncate text-sm ${
          task.status === "done" ? "text-zinc-500 line-through" : "text-zinc-100"
        }`}
        title={task.title}
      >
        {task.title}
      </span>
      {task.targetDate && (
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
            overdue
              ? "bg-red-900/40 text-red-200"
              : task.targetDate === todayIso()
                ? "bg-indigo-900/40 text-indigo-200"
                : "bg-zinc-800 text-zinc-400"
          }`}
        >
          {describeDate(task.targetDate)}
        </span>
      )}
      <button
        type="button"
        onClick={() => onDelete(task.id)}
        aria-label="Delete task"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-600 opacity-0 transition-opacity hover:text-red-400 focus:opacity-100 group-hover:opacity-100"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
          <path
            d="M4 4l8 8M12 4l-8 8"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </li>
  );
}

function TaskGroup({
  title,
  caption,
  tasks,
  onComplete,
  onDelete,
  accent,
}: {
  title: string;
  caption?: string;
  tasks: Task[];
  onComplete: (id: string) => void;
  onDelete: (id: string) => void;
  accent: "indigo" | "violet" | "zinc";
}) {
  const accentBar: Record<typeof accent, string> = {
    indigo: "bg-indigo-500",
    violet: "bg-violet-500",
    zinc: "bg-zinc-600",
  };
  return (
    <section className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-5 py-3">
        <span aria-hidden="true" className={`h-5 w-1 rounded-full ${accentBar[accent]}`} />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
          {caption && <p className="text-xs text-zinc-500">{caption}</p>}
        </div>
        <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
          {tasks.length}
        </span>
      </header>
      {tasks.length === 0 ? (
        <p className="px-5 py-4 text-sm text-zinc-600">Nothing here yet.</p>
      ) : (
        <ul className="divide-y divide-zinc-800/60 px-2 py-1">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} onComplete={onComplete} onDelete={onDelete} />
          ))}
        </ul>
      )}
    </section>
  );
}

export default function TasksPanel() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState<"daily" | "weekly">("daily");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setTasks(await listTasks({ status: "open" }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onAdd = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    await createTask({
      title: trimmed,
      scope,
      targetDate: scope === "daily" ? todayIso() : null,
    });
    setTitle("");
    await refresh();
  }, [title, scope, refresh]);

  const onComplete = useCallback(
    async (id: string) => {
      await completeTask(id);
      await refresh();
    },
    [refresh],
  );

  const onDelete = useCallback(
    async (id: string) => {
      await deleteTask(id);
      await refresh();
    },
    [refresh],
  );

  const { daily, weekly, overdue } = useMemo(() => {
    const today = todayIso();
    return {
      overdue: tasks.filter((t) => t.targetDate && t.targetDate < today),
      daily: tasks.filter((t) => t.scope === "daily" && t.targetDate === today),
      weekly: tasks.filter((t) => t.scope === "weekly" || (t.scope === "daily" && !t.targetDate)),
    };
  }, [tasks]);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 shadow-sm">
        <div className="flex gap-2">
          <input
            value={title}
            placeholder="Add a task..."
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void onAdd();
            }}
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm outline-none transition-colors focus:border-indigo-500"
          />
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as "daily" | "weekly")}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm outline-none focus:border-indigo-500"
          >
            <option value="daily">Today</option>
            <option value="weekly">This week</option>
          </select>
          <button
            onClick={() => void onAdd()}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-500"
          >
            Add
          </button>
        </div>
      </div>

      {overdue.length > 0 && (
        <TaskGroup
          title="Overdue"
          caption="Carry over or complete to clear"
          tasks={overdue}
          onComplete={onComplete}
          onDelete={onDelete}
          accent="zinc"
        />
      )}

      <TaskGroup
        title="Today"
        tasks={daily}
        onComplete={onComplete}
        onDelete={onDelete}
        accent="indigo"
      />
      <TaskGroup
        title="This week"
        caption="No fixed day"
        tasks={weekly}
        onComplete={onComplete}
        onDelete={onDelete}
        accent="violet"
      />

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
