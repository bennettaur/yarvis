import { useCallback, useEffect, useState } from "react";
import { getSettings, type Settings, setAgent, setResumeAgentSessions } from "../lib/settings";

/**
 * The agent every workspace opens with: its tab title and the command its
 * session is launched from. Sits beside Repositories because workspaces are what
 * start agents.
 */
export default function AgentSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [commandDraft, setCommandDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const adopt = useCallback((next: Settings) => {
    setSettings(next);
    setNameDraft(next.agentName ?? "");
    setCommandDraft(next.agentCommand ?? "");
  }, []);

  useEffect(() => {
    getSettings()
      .then(adopt)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [adopt]);

  // A stale "Saved." next to an edited field would claim the new value is stored.
  const clearNotices = useCallback(() => {
    setNotice(null);
    setError(null);
  }, []);

  const editName = useCallback(
    (value: string) => {
      setNameDraft(value);
      clearNotices();
    },
    [clearNotices],
  );

  const editCommand = useCallback(
    (value: string) => {
      setCommandDraft(value);
      clearNotices();
    },
    [clearNotices],
  );

  const save = useCallback(async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      // An empty field means "use the default", which the core stores as null.
      adopt(await setAgent(nameDraft.trim() || null, commandDraft.trim() || null));
      setNotice("Saved. Applies to the next agent session started.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [adopt, commandDraft, nameDraft]);

  // Saved as it is toggled. This sets `settings` directly rather than going
  // through `adopt`, which would reset the fields above and lose unsaved edits.
  const saveResume = useCallback(
    async (value: boolean) => {
      clearNotices();
      try {
        setSettings(await setResumeAgentSessions(value));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [clearNotices],
  );

  // Unset means on, matching the core's default.
  const resumesSessions = settings?.resumeAgentSessions ?? true;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-zinc-500">Agent</h2>
      <p className="mb-4 text-xs text-zinc-500">
        Every provisioned workspace opens with an agent tab. The command is run in a shell at the
        workspace root, so flags you want on by default (permission mode, model) belong here.
        Sessions started from Telegram also get <code>--remote-control</code> appended so you can
        drive them while away; ones started here don't, since they open in a tab in front of you.
      </p>

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      {notice && <p className="mb-3 text-sm text-emerald-400">{notice}</p>}
      {settings?.agentCommandOverriddenByEnv && (
        <p className="mb-3 text-xs text-amber-400">
          <code>YARVIS_CLAUDE_COMMAND</code> is set in the environment and takes precedence, so the
          command below is stored but not in force.
        </p>
      )}

      <div className="flex flex-wrap items-start gap-2">
        <label className="text-xs text-zinc-400">
          <span className="mb-1 block uppercase tracking-wide">Tab title</span>
          <input
            type="text"
            value={nameDraft}
            placeholder={settings?.defaultAgentName ?? ""}
            onChange={(e) => editName(e.target.value)}
            className="w-36 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm outline-none focus:border-zinc-500"
          />
        </label>
        <label className="min-w-64 flex-1 text-xs text-zinc-400">
          <span className="mb-1 block uppercase tracking-wide">Command</span>
          <input
            type="text"
            value={commandDraft}
            placeholder={settings?.defaultAgentCommand ?? ""}
            onChange={(e) => editCommand(e.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-sm outline-none focus:border-zinc-500"
          />
        </label>
        <button
          type="button"
          onClick={save}
          disabled={settings === null || busy}
          className="mt-5 rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {settings && (
        <p className="mt-2 text-xs text-zinc-500">
          Blank uses the defaults: {settings.defaultAgentName} /{" "}
          <span className="font-mono">{settings.defaultAgentCommand}</span>.
        </p>
      )}

      <label className="mt-4 flex items-start gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          className="mt-1"
          checked={resumesSessions}
          disabled={settings === null}
          onChange={(e) => void saveResume(e.target.checked)}
        />
        <span>
          Resume the last session when reopening a workspace
          <span className="block text-xs text-zinc-600">
            When a workspace's agent tab starts again, for example after Yarvis restarts, it picks
            up the Claude Code session it last ran with <code>--resume</code>. A new session starts
            when there is nothing to resume, when Claude Code no longer has the transcript, or when
            the command above isn't a plain <code>claude …</code> command.
          </span>
        </span>
      </label>
    </section>
  );
}
