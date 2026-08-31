import { useCallback, useEffect, useState } from "react";
import { listSpecialists, reloadSpecialists, type SpecialistCatalog } from "../lib/agents";
import { writeClipboard } from "../lib/clipboard";

/**
 * The specialists the chat agent delegates to.
 *
 * Each one is a markdown file — YAML frontmatter for its tools, model and step
 * budget, the body as its system prompt — either shipped with the app or written
 * by the user in the agents directory. So this panel is a reader: it lists what
 * loaded, says where to add more, reports any file that failed to parse, and
 * reloads. Editing happens in the file, which is also what makes a definition
 * reviewable in git.
 *
 * The one thing called out beyond name and description is whether a specialist
 * may write where other people can see it without being asked. A delegated run
 * has no way to prompt, so that is the only property here with consequences off
 * this machine.
 */
export default function SpecialistSection() {
  const [catalog, setCatalog] = useState<SpecialistCatalog | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setCatalog(await listSpecialists());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reload = async () => {
    try {
      const next = await reloadSpecialists();
      setCatalog(next);
      setStatus(`Loaded ${next.specialists.length} specialist(s).`);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Delegation specialists
        </h2>
        <button
          type="button"
          onClick={() => void reload()}
          className="ml-auto rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
        >
          Reload from disk
        </button>
      </div>

      <p className="mb-3 text-sm text-zinc-500">
        The assistant hands multi-step work to these, each in its own context with only the tools
        its file lists. Add your own by dropping a markdown file in{" "}
        <code className="text-zinc-400">{catalog?.userDir ?? "~/.yarvis/agents"}</code> — YAML
        frontmatter for <code>tools</code>, <code>model</code> and <code>maxSteps</code>, and the
        body as the prompt. A file named after one that ships replaces it.
        {catalog?.userDir && (
          <button
            type="button"
            onClick={() => void writeClipboard(catalog.userDir)}
            className="ml-2 text-xs text-zinc-500 underline hover:text-zinc-300"
          >
            copy path
          </button>
        )}
      </p>

      {catalog && catalog.problems.length > 0 && (
        <ul className="mb-3 space-y-1 rounded-xl border border-red-900 bg-red-950/40 p-3">
          {catalog.problems.map((problem) => (
            <li key={problem.path} className="text-xs text-red-300">
              {problem.message}
            </li>
          ))}
        </ul>
      )}

      <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/50">
        {(catalog?.specialists ?? []).map((specialist) => (
          <li key={specialist.name} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-sm text-zinc-200">{specialist.name}</span>
              <span className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-500">
                {specialist.source === "user" ? "yours" : "built-in"}
              </span>
              <span className="text-xs text-zinc-600">{specialist.tools.length} tool(s)</span>
              <span className="text-xs text-zinc-600">
                {specialist.provider && specialist.model
                  ? `${specialist.provider}/${specialist.model}`
                  : "default model"}
              </span>
              <span className="text-xs text-zinc-600">{specialist.maxSteps} steps</span>
              {!specialist.enabled && (
                <span className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-500">disabled</span>
              )}
              {specialist.unattended.length > 0 && (
                <span
                  className="rounded bg-amber-900 px-1 text-[10px] text-amber-200"
                  title={`Acts without asking: ${specialist.unattended.join(", ")}`}
                >
                  acts unattended
                </span>
              )}
              <button
                type="button"
                onClick={() => setExpanded(expanded === specialist.name ? null : specialist.name)}
                className="ml-auto text-xs text-zinc-500 hover:text-zinc-300"
              >
                {expanded === specialist.name ? "Hide" : "Show prompt"}
              </button>
            </div>
            <p className="mt-1 text-sm text-zinc-400">{specialist.description}</p>
            {specialist.unattended.length > 0 && (
              <p className="mt-0.5 text-xs text-amber-300/80">
                Can {specialist.unattended.join(", ")} on its own — a delegated run has no way to
                ask you first.
              </p>
            )}
            {expanded === specialist.name && (
              <div className="mt-2 space-y-2">
                <p className="font-mono text-[11px] text-zinc-600">{specialist.path}</p>
                {specialist.tools.length > 0 && (
                  <p className="font-mono text-[11px] text-zinc-500">
                    {specialist.tools.join(", ")}
                  </p>
                )}
                <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-400">
                  {specialist.prompt}
                </pre>
              </div>
            )}
          </li>
        ))}
      </ul>

      {catalog?.specialists.length === 0 && (
        <p className="text-sm text-zinc-600">No specialists loaded.</p>
      )}
      {status && <p className="mt-2 text-sm text-zinc-500">{status}</p>}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </section>
  );
}
