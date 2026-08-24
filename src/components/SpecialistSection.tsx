import { useCallback, useEffect, useState } from "react";
import { listSpecialists, resetSpecialist, type Specialist, updateSpecialist } from "../lib/agents";

/**
 * The specialists the chat agent delegates to. A specialist is a prompt plus a
 * subset of the tool registry, stored as a row — so retuning one is editing text
 * here rather than shipping a build. Built-ins are seeded once and never
 * overwritten, which is why "Reset" exists: without it, an edit that went wrong
 * would be permanent.
 *
 * The one thing surfaced beyond name and description is whether a specialist can
 * write somewhere other people can see without the user approving the call. That
 * is the only property here with consequences outside this machine, so it is on
 * the row rather than inside a tool list.
 */
export default function SpecialistSection() {
  const [specialists, setSpecialists] = useState<Specialist[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSpecialists(await listSpecialists());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const savePrompt = async (specialist: Specialist) => {
    try {
      await updateSpecialist(specialist.id, { prompt: draft });
      setEditing(null);
      setStatus(`Saved ${specialist.name}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section>
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
        Delegation specialists
      </h2>
      <p className="mb-3 text-sm text-zinc-500">
        The assistant hands multi-step work to these. Each has its own prompt and can only call the
        tools listed for it — a summarizer with no ability to start work cannot start work, whatever
        it reads.
      </p>

      <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/50">
        {specialists.map((specialist) => (
          <li key={specialist.id} className="px-4 py-3">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-sm text-zinc-200">{specialist.name}</span>
              {specialist.builtin && (
                <span className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-500">built-in</span>
              )}
              <span className="text-xs text-zinc-600">{specialist.toolIds.length} tool(s)</span>
              {/* A delegated run can't stop to ask, so a specialist that writes
                  where other people can see it is worth naming on the row rather
                  than leaving in a tool list. */}
              {specialist.unattendedToolIds.length > 0 && (
                <span
                  className="rounded bg-amber-900 px-1 text-[10px] text-amber-200"
                  title={`Acts without asking: ${specialist.unattendedToolIds
                    .map((id) => id.replace("builtin:", ""))
                    .join(", ")}`}
                >
                  acts unattended
                </span>
              )}
              <span className="text-xs text-zinc-600">
                {specialist.provider && specialist.model
                  ? `${specialist.provider}/${specialist.model}`
                  : "default model"}
              </span>
              <label className="ml-auto flex items-center gap-1 text-xs text-zinc-500">
                <input
                  type="checkbox"
                  checked={specialist.enabled}
                  onChange={async () => {
                    await updateSpecialist(specialist.id, { enabled: !specialist.enabled });
                    await load();
                  }}
                />
                Enabled
              </label>
            </div>
            <p className="mt-1 text-sm text-zinc-400">{specialist.description}</p>
            {specialist.unattendedToolIds.length > 0 && (
              <p className="mt-0.5 text-xs text-amber-300/80">
                Can{" "}
                {specialist.unattendedToolIds.map((id) => id.replace("builtin:", "")).join(", ")} on
                its own — a delegated run has no way to ask you first.
              </p>
            )}

            {editing === specialist.id ? (
              <div className="mt-2 space-y-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={6}
                  className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-xs"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void savePrompt(specialist)}
                    className="rounded-md border border-zinc-700 px-2 py-1 text-sm hover:bg-zinc-800"
                  >
                    Save prompt
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className="text-sm text-zinc-500 hover:text-zinc-300"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-1 flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setEditing(specialist.id);
                    setDraft(specialist.prompt);
                  }}
                  className="text-xs text-zinc-500 hover:text-zinc-300"
                >
                  Edit prompt
                </button>
                {specialist.builtin && (
                  <button
                    type="button"
                    onClick={async () => {
                      await resetSpecialist(specialist.name);
                      setStatus(`Reset ${specialist.name} to its default.`);
                      await load();
                    }}
                    className="text-xs text-zinc-500 hover:text-zinc-300"
                  >
                    Reset to default
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {specialists.length === 0 && (
        <p className="text-sm text-zinc-600">
          None yet — they are seeded when the sidecar starts with a database configured.
        </p>
      )}
      {status && <p className="mt-2 text-sm text-zinc-500">{status}</p>}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </section>
  );
}
