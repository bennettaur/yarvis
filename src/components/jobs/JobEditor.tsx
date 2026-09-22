import { useState } from "react";
import type { Specialist } from "../../lib/agents";
import {
  type AgentJobKind,
  type ClaudePermissionMode,
  cronPresets,
  type ScheduledJobInput,
} from "../../lib/scheduledJobs";

/**
 * The form for one scheduled job: when it runs, what it is told to do, and
 * which agent does it.
 *
 * The backend choice changes what else has to be answered — a specialist for
 * the in-app agent, a working directory for Claude Code — so the two sets of
 * fields swap rather than both being shown greyed out.
 */

const PERMISSION_MODES: ClaudePermissionMode[] = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
];

const FIELD =
  "w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none";
const LABEL = "block text-xs font-medium uppercase tracking-wide text-zinc-500";

export interface JobEditorProps {
  value: ScheduledJobInput;
  specialists: Specialist[];
  /** Null while the job has never been saved. */
  savedId: string | null;
  saving: boolean;
  error: string | null;
  onChange: (next: ScheduledJobInput) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}

export default function JobEditor({
  value,
  specialists,
  savedId,
  saving,
  error,
  onChange,
  onSave,
  onCancel,
  onDelete,
}: JobEditorProps) {
  // A second click on Delete is the confirmation; the prompt and the history go
  // with the job, which is not something to lose to a stray click. The caller
  // keys this component by job, so switching jobs remounts it and the armed
  // state does not follow the user to a job they did not arm.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const setKind = (kind: AgentJobKind) => {
    onChange({
      ...value,
      target:
        kind === "yarvis"
          ? { kind: "yarvis", specialist: null }
          : { kind: "claude-code", cwd: "", model: null, permissionMode: null },
    });
  };

  const canSave = Boolean(value.name.trim() && value.cron.trim() && value.prompt.trim()) && !saving;

  // Narrowed once here: inside a JSX callback the union widens again, and every
  // spread of it would have to be re-asserted.
  const claude = value.target.kind === "claude-code" ? value.target : null;

  return (
    <div className="space-y-4">
      {error ? (
        <p className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className={LABEL}>Name</span>
          <input
            className={FIELD}
            value={value.name}
            placeholder="Morning sweep"
            onChange={(e) => onChange({ ...value, name: e.target.value })}
          />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>Schedule (cron)</span>
          <input
            className={FIELD}
            value={value.cron}
            placeholder="0 9 * * 1-5"
            onChange={(e) => onChange({ ...value, cron: e.target.value })}
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        {cronPresets().map((preset) => (
          <button
            key={preset.cron}
            type="button"
            className="rounded-full border border-zinc-800 px-3 py-1 text-xs text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
            onClick={() => onChange({ ...value, cron: preset.cron })}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <label className="space-y-1 block">
        <span className={LABEL}>Description</span>
        <input
          className={FIELD}
          value={value.description ?? ""}
          placeholder="What this job is for"
          onChange={(e) => onChange({ ...value, description: e.target.value || null })}
        />
      </label>

      <label className="space-y-1 block">
        <span className={LABEL}>Prompt</span>
        <textarea
          className={`${FIELD} min-h-32 font-mono`}
          value={value.prompt}
          placeholder="What the agent should do on every run"
          onChange={(e) => onChange({ ...value, prompt: e.target.value })}
        />
      </label>

      <div className="space-y-3 rounded-lg border border-zinc-800 p-3">
        <label className="space-y-1 block">
          <span className={LABEL}>Agent</span>
          <select
            className={FIELD}
            value={value.target.kind}
            onChange={(e) => setKind(e.target.value as AgentJobKind)}
          >
            <option value="yarvis">Yarvis</option>
            <option value="claude-code">Claude Code</option>
          </select>
        </label>

        {value.target.kind === "yarvis" ? (
          <label className="space-y-1 block">
            <span className={LABEL}>Specialist</span>
            <select
              className={FIELD}
              value={value.target.specialist ?? ""}
              onChange={(e) =>
                onChange({
                  ...value,
                  target: { kind: "yarvis", specialist: e.target.value || null },
                })
              }
            >
              <option value="">Default agent</option>
              {specialists.map((specialist) => (
                <option key={specialist.name} value={specialist.name}>
                  {specialist.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 sm:col-span-2">
              <span className={LABEL}>Working directory</span>
              <input
                className={FIELD}
                value={claude?.cwd ?? ""}
                placeholder="/Users/you/dev/project"
                onChange={(e) =>
                  claude && onChange({ ...value, target: { ...claude, cwd: e.target.value } })
                }
              />
            </label>
            <label className="space-y-1">
              <span className={LABEL}>Model</span>
              <input
                className={FIELD}
                value={claude?.model ?? ""}
                placeholder="default"
                onChange={(e) =>
                  claude &&
                  onChange({ ...value, target: { ...claude, model: e.target.value || null } })
                }
              />
            </label>
            <label className="space-y-1">
              <span className={LABEL}>Permissions</span>
              <select
                className={FIELD}
                value={claude?.permissionMode ?? ""}
                onChange={(e) =>
                  claude &&
                  onChange({
                    ...value,
                    target: {
                      ...claude,
                      permissionMode: (e.target.value || null) as ClaudePermissionMode | null,
                    },
                  })
                }
              >
                <option value="">Claude Code's default</option>
                {PERMISSION_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs text-zinc-500 sm:col-span-2">
              The session runs headless with nobody to answer a permission prompt, so it can only do
              what this mode allows without asking.
            </p>
          </div>
        )}
      </div>

      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
        />
        Run on this schedule
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          disabled={!canSave}
          onClick={onSave}
        >
          {saving ? "Saving…" : savedId ? "Save changes" : "Create job"}
        </button>
        <button
          type="button"
          className="rounded-lg border border-zinc-800 px-3 py-1.5 text-sm text-zinc-300"
          onClick={onCancel}
        >
          Cancel
        </button>
        {savedId ? (
          <button
            type="button"
            className="ml-auto rounded-lg border border-red-900 px-3 py-1.5 text-sm text-red-300"
            onClick={() => {
              if (confirmingDelete) onDelete();
              else setConfirmingDelete(true);
            }}
          >
            {confirmingDelete ? "Delete for good?" : "Delete"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
