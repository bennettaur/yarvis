import { useCallback, useEffect, useState } from "react";
import {
  type CcPlan,
  type CcProject,
  type CcSession,
  type CcTranscriptEntry,
  getPlan,
  getTranscript,
  listPlans,
  listProjects,
  listSessions,
} from "../lib/cc";

type View = "sessions" | "plans";

export default function SessionsPanel() {
  const [view, setView] = useState<View>("sessions");
  const [projects, setProjects] = useState<CcProject[]>([]);
  const [projectDir, setProjectDir] = useState<string>("");
  const [sessions, setSessions] = useState<CcSession[]>([]);
  const [transcript, setTranscript] = useState<CcTranscriptEntry[] | null>(null);
  const [plans, setPlans] = useState<CcPlan[]>([]);
  const [planContent, setPlanContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const p = await listProjects();
        setProjects(p);
        if (p[0]) {
          setProjectDir(p[0].dir);
          setSessions(await listSessions(p[0].dir));
        }
        setPlans(await listPlans());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const selectProject = useCallback(async (dir: string) => {
    setProjectDir(dir);
    setTranscript(null);
    setSessions(await listSessions(dir));
  }, []);

  const openTranscript = useCallback(
    async (id: string) => {
      setTranscript(await getTranscript(projectDir, id));
    },
    [projectDir],
  );

  const openPlan = useCallback(async (name: string) => {
    setPlanContent((await getPlan(name)).content);
  }, []);

  const tab = (v: View, label: string) => (
    <button
      onClick={() => setView(v)}
      className={`rounded-md px-3 py-1 text-sm ${
        view === v ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-1">
        {tab("sessions", "Sessions")}
        {tab("plans", "Plans")}
      </div>

      {view === "sessions" && (
        <div className="space-y-3">
          <select
            value={projectDir}
            onChange={(e) => void selectProject(e.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
          >
            {projects.map((p) => (
              <option key={p.dir} value={p.dir}>
                {p.path ?? p.dir} ({p.sessionCount})
              </option>
            ))}
          </select>

          {transcript ? (
            <div className="space-y-3">
              <button
                onClick={() => setTranscript(null)}
                className="text-sm text-zinc-400 hover:text-zinc-200"
              >
                ← back to sessions
              </button>
              <div className="max-h-[55vh] space-y-3 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                {transcript.map((e, i) => (
                  <div key={i} className="text-sm">
                    <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
                      {e.role}
                    </div>
                    <div className="whitespace-pre-wrap text-zinc-200">{e.text}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/50">
              {sessions.map((s) => (
                <li key={s.id ?? Math.random()}>
                  <button
                    onClick={() => s.id && void openTranscript(s.id)}
                    className="w-full px-4 py-3 text-left hover:bg-zinc-800/50"
                  >
                    <div className="text-sm text-zinc-100">
                      {s.title ?? s.firstPrompt?.slice(0, 70) ?? s.id}
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      {s.gitBranch ? `${s.gitBranch} · ` : ""}
                      {s.messageCount} msgs
                      {s.updatedAt ? ` · ${s.updatedAt.slice(0, 10)}` : ""}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {view === "plans" && (
        <div className="space-y-3">
          {planContent ? (
            <div className="space-y-3">
              <button
                onClick={() => setPlanContent(null)}
                className="text-sm text-zinc-400 hover:text-zinc-200"
              >
                ← back to plans
              </button>
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-xs text-zinc-200">
                {planContent}
              </pre>
            </div>
          ) : (
            <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/50">
              {plans.map((p) => (
                <li key={p.name}>
                  <button
                    onClick={() => void openPlan(p.name)}
                    className="w-full px-4 py-3 text-left hover:bg-zinc-800/50"
                  >
                    <div className="text-sm text-zinc-100">{p.title ?? p.name}</div>
                    <div className="mt-0.5 text-xs text-zinc-500">{p.updatedAt.slice(0, 10)}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
