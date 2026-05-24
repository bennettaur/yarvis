import { useCallback, useEffect, useState } from "react";
import {
  completeTask,
  createTask,
  listTasks,
  type Task,
} from "../lib/tasks";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function TaskItem({ task, onComplete }: { task: Task; onComplete: (id: string) => void }) {
  return (
    <li className="flex items-center gap-3 py-1.5">
      <input
        type="checkbox"
        checked={task.status === "done"}
        onChange={() => onComplete(task.id)}
        className="h-4 w-4 accent-emerald-500"
      />
      <span className={task.status === "done" ? "text-zinc-500 line-through" : ""}>
        {task.title}
      </span>
      {task.targetDate && (
        <span className="ml-auto text-xs text-zinc-500">{task.targetDate}</span>
      )}
    </li>
  );
}

function TaskGroup({
  title,
  tasks,
  onComplete,
}: {
  title: string;
  tasks: Task[];
  onComplete: (id: string) => void;
}) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
        {title}
      </h2>
      {tasks.length === 0 ? (
        <p className="text-sm text-zinc-600">Nothing here.</p>
      ) : (
        <ul className="text-sm">
          {tasks.map((t) => (
            <TaskItem key={t.id} task={t} onComplete={onComplete} />
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

  const daily = tasks.filter((t) => t.scope === "daily");
  const weekly = tasks.filter((t) => t.scope === "weekly");

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        <input
          value={title}
          placeholder="Add a task..."
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onAdd();
          }}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-zinc-500"
        />
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as "daily" | "weekly")}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
        <button
          onClick={() => void onAdd()}
          className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium hover:bg-emerald-500"
        >
          Add
        </button>
      </div>

      <TaskGroup title="Today" tasks={daily} onComplete={onComplete} />
      <TaskGroup title="This week" tasks={weekly} onComplete={onComplete} />

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
