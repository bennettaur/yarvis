import { useCallback, useEffect, useState } from "react";
import {
  type AgentTodo,
  deleteTodo,
  listTodos,
  type TodoStatus,
  updateTodo,
} from "../../lib/todos";

/**
 * The assistant's own todo list, shown so the user can see what it believes it
 * has taken on — and close or drop something it got wrong. The agent writes
 * these through its tools; this view is deliberately read-mostly, with only the
 * corrections a person needs.
 */

const STATUS_LABEL: Record<TodoStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  wont_do: "Won't do",
};

const STATUS_COLOR: Record<TodoStatus, string> = {
  pending: "bg-zinc-700 text-zinc-200",
  in_progress: "bg-indigo-900 text-indigo-200",
  blocked: "bg-amber-900 text-amber-200",
  done: "bg-emerald-900 text-emerald-200",
  wont_do: "bg-zinc-800 text-zinc-500",
};

const PRIORITY_COLOR: Record<string, string> = {
  urgent: "text-red-400",
  high: "text-amber-400",
  medium: "text-zinc-400",
  low: "text-zinc-600",
};

const OPEN_STATUSES: TodoStatus[] = ["pending", "in_progress", "blocked"];
const CLOSED_STATUSES: TodoStatus[] = ["done", "wont_do"];

export default function TodosTab() {
  const [todos, setTodos] = useState<AgentTodo[]>([]);
  const [showClosed, setShowClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setTodos(
        await listTodos(showClosed ? [...OPEN_STATUSES, ...CLOSED_STATUSES] : OPEN_STATUSES),
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [showClosed]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setStatus = async (id: string, status: TodoStatus) => {
    await updateTodo(id, { status });
    await reload();
  };

  const remove = async (id: string) => {
    await deleteTodo(id);
    await reload();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm text-zinc-500">
          What the assistant has taken on. Its own list — your tasks live on the Tasks tab.
        </p>
        <button
          type="button"
          onClick={() => setShowClosed(!showClosed)}
          className="ml-auto rounded-md border border-zinc-700 px-2 py-1 text-sm hover:bg-zinc-800"
        >
          {showClosed ? "Hide closed" : "Show closed"}
        </button>
      </div>

      {todos.length === 0 ? (
        <p className="text-sm text-zinc-600">Nothing on the assistant's list.</p>
      ) : (
        <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/50">
          {todos.map((todo) => (
            <li key={todo.id} className="px-4 py-3">
              <div className="flex items-start gap-2">
                <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_COLOR[todo.status]}`}>
                  {STATUS_LABEL[todo.status]}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-zinc-200">{todo.title}</p>
                  <div className="mt-0.5 text-xs text-zinc-600">
                    <span className={PRIORITY_COLOR[todo.priority]}>{todo.priority}</span>
                    {todo.dueAt ? ` · due ${new Date(todo.dueAt).toLocaleDateString()}` : ""}
                    {todo.details ? ` · ${todo.details}` : ""}
                  </div>
                  {/* The progress log is why a blocked todo is worth keeping:
                      it carries what it is blocked on. */}
                  {todo.notes.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {todo.notes.slice(-3).map((note) => (
                        <li key={note.at} className="text-xs text-zinc-500">
                          {new Date(note.at).toLocaleDateString()} — {note.text}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {!CLOSED_STATUSES.includes(todo.status) && (
                  <button
                    type="button"
                    onClick={() => void setStatus(todo.id, "done")}
                    className="text-xs text-zinc-500 hover:text-emerald-400"
                    title="Mark done"
                  >
                    Done
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void remove(todo.id)}
                  className="text-zinc-600 hover:text-red-400"
                  title="Delete"
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
