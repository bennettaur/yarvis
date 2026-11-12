import { useCallback, useEffect, useState } from "react";
import {
  getSettings,
  type Settings,
  setAgent,
  setAllowedSlashCommands,
  setChannelMessaging,
} from "../lib/settings";
import AgentHarnessesField from "./AgentHarnessesField";

/**
 * The built-in agent: its tab title and the command its session is launched
 * from, plus the other harnesses a session can run instead. Sits beside
 * Repositories because workspaces are what start agents.
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

      {settings && <AgentHarnessesField settings={settings} onSaved={setSettings} />}
      {settings && <SlashCommandsField settings={settings} onSaved={setSettings} />}
      {settings && <ChannelMessagingField settings={settings} onSaved={setSettings} />}
    </section>
  );
}

const formatCommands = (names: string[] | null) => (names ?? []).map((c) => `/${c}`).join(" ");

/**
 * The slash commands the assistant may run in a workspace's agent session. It
 * saves on its own, so its draft, busy state and messages are kept apart from
 * the agent fields above: saving one must not discard the other's edits.
 */
function SlashCommandsField({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: (next: Settings) => void;
}) {
  const stored = formatCommands(settings.allowedSlashCommands);
  const [draft, setDraft] = useState(stored);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Follows the stored list when it changes, not on every settings update, so
  // saving the agent fields leaves an unsaved draft here alone.
  useEffect(() => setDraft(stored), [stored]);

  const edit = useCallback((value: string) => {
    setDraft(value);
    setNotice(null);
    setError(null);
  }, []);

  const save = useCallback(async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const next = await setAllowedSlashCommands(draft.split(/[\s,]+/).filter(Boolean));
      onSaved(next);
      setDraft(formatCommands(next.allowedSlashCommands));
      setNotice("Saved. Applies to the next slash command sent.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [draft, onSaved]);

  return (
    <div className="mt-5">
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      {notice && <p className="mb-3 text-sm text-emerald-400">{notice}</p>}
      <div className="flex flex-wrap items-start gap-2">
        <label className="min-w-64 flex-1 text-xs text-zinc-400">
          <span className="mb-1 block uppercase tracking-wide">Allowed slash commands</span>
          <input
            type="text"
            value={draft}
            placeholder="/do-code-review"
            onChange={(e) => edit(e.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-sm outline-none focus:border-zinc-500"
          />
        </label>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="mt-5 rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save commands"}
        </button>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        Commands and skills the assistant may run in a workspace's agent session, separated by
        spaces or commas. Always allowed:{" "}
        <span className="font-mono">{formatCommands(settings.defaultAllowedSlashCommands)}</span>.
        Only add ones that are safe to run unasked: the assistant also chooses the text after the
        command. Commands that change what the session may do, like <code>/permissions</code>,{" "}
        <code>/hooks</code>, <code>/mcp</code> or <code>/login</code>, are refused.
      </p>
    </div>
  );
}

/**
 * The experimental switch for messaging sessions over a Claude Code channel.
 * Saves as it is toggled, so it keeps its own busy state and messages.
 */
function ChannelMessagingField({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: (next: Settings) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = settings.channelMessaging === true;

  const toggle = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      onSaved(await setChannelMessaging(!enabled));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [enabled, onSaved]);

  return (
    <div className="mt-5">
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input type="checkbox" checked={enabled} disabled={busy} onChange={toggle} />
        Message sessions over a channel (experimental)
      </label>
      <p className="mt-2 text-xs text-zinc-500">
        Lets the assistant send a workspace session a message it can answer, instead of typing at
        its prompt, and read the answer. It also needs{" "}
        <code>--dangerously-load-development-channels server:yarvis-channel</code> in the command
        above (channels are a Claude Code research preview). A workspace gets the channel's MCP
        server when it is provisioned, or a repo is added, while this is on, and loses it when that
        happens while this is off. Turning it off stops channel messages from the next one.
      </p>
    </div>
  );
}
