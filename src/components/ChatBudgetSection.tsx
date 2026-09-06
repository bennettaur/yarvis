import { useEffect, useState } from "react";
import { type ChatConfig, getChatConfig, saveChatConfig } from "../lib/chat";
import { type DisplayError, formatError } from "../lib/errors";
import ErrorNotice from "./ErrorNotice";

/**
 * How much room one chat turn gets. Both surfaces and the Telegram bot read
 * this per turn, so a change applies to the next message with no restart.
 *
 * The step budget is the one users hit: a turn that runs out mid-chain returns
 * no reply at all, having already paid for the tool calls it made, so the
 * useful setting is generous. The output limit is offered as an override rather
 * than a default because the provider already enforces one.
 */
export default function ChatBudgetSection() {
  const [config, setConfig] = useState<ChatConfig | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getChatConfig()
      .then(setConfig)
      .catch((e) => setError(formatError(e)));
  }, []);

  const save = async () => {
    if (!config) return;
    setSaving(true);
    setSaved(false);
    try {
      setConfig(await saveChatConfig(config));
      setError(null);
      setSaved(true);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-zinc-500">
        Turn budget
      </h2>
      <p className="mb-4 text-xs text-zinc-500">
        How far the agent may go answering one message. Applies to Chat, Omni Chat and Telegram,
        from the next turn onwards.
      </p>

      {error && <ErrorNotice error={error} onDismiss={() => setError(null)} className="mb-3" />}

      {config && (
        <div className="space-y-4">
          <label className="block">
            <span className="block text-sm text-zinc-100">Tool-calling steps per turn</span>
            <span className="mb-1 block text-xs text-zinc-500">
              A turn that runs out of steps stops without a reply, so leave room for multi-step
              work.
            </span>
            <input
              type="number"
              min={1}
              max={500}
              value={config.maxSteps}
              onChange={(e) => setConfig({ ...config, maxSteps: Number(e.target.value) })}
              className="w-32 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm outline-none focus:border-zinc-500"
            />
          </label>

          <div>
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={config.maxOutputTokens !== null}
                onChange={(e) =>
                  setConfig({ ...config, maxOutputTokens: e.target.checked ? 8000 : null })
                }
                className="mt-0.5 h-4 w-4 accent-indigo-500"
              />
              <span>
                <span className="block text-sm text-zinc-100">Cap the reply length</span>
                <span className="block text-xs text-zinc-500">
                  Off by default: the provider already has its own limit, and a second, lower one
                  only truncates a long answer.
                </span>
              </span>
            </label>
            {config.maxOutputTokens !== null && (
              <input
                type="number"
                min={256}
                max={200000}
                aria-label="Output tokens per reply"
                value={config.maxOutputTokens}
                onChange={(e) => setConfig({ ...config, maxOutputTokens: Number(e.target.value) })}
                className="mt-2 ml-7 w-32 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm outline-none focus:border-zinc-500"
              />
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm hover:bg-indigo-500 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {saved && <span className="text-xs text-zinc-500">Saved</span>}
          </div>
        </div>
      )}
    </section>
  );
}
