import { useState } from "react";
import type { NewRoutine, Routine, RoutinesResponse } from "../../lib/headsDown";
import { formatRelativeTime } from "../../lib/time";

/** `everyMinutes` back in the `30m`/`3h`/`1d` form the file was written in. */
function cadence(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `every ${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `every ${minutes / 60}h`;
  return `every ${minutes}m`;
}

/** How often it runs, and when it is allowed to. */
function describeCadence(r: Routine): string {
  const parts = [r.once ? "once" : cadence(r.everyMinutes)];
  if (r.workingHoursOnly) parts.push("working hours");
  if (r.nightShift !== "run") parts.push(`${r.nightShift} at night`);
  return parts.join(", ");
}

type Tone = "next" | "due" | "waiting" | "off";

const TONE_CLASS: Record<Tone, string> = {
  next: "bg-emerald-500/15 text-emerald-300",
  due: "bg-amber-500/15 text-amber-300",
  waiting: "bg-zinc-800 text-zinc-400",
  off: "bg-zinc-800/60 text-zinc-500",
};

/** Where a routine stands, in words: on the next pass, waiting and why, or off and why. */
export function routineStatus(r: Routine): { label: string; tone: Tone } {
  if (!r.enabled) {
    return r.source === "builtin"
      ? { label: "Off: ships turned off", tone: "off" }
      : { label: "Off in your file", tone: "off" };
  }
  if (r.nextPass) return { label: "Runs on the next pass", tone: "next" };
  if (r.queued) return { label: "Due, waiting for a free slot", tone: "due" };
  if (r.heldBy === "working-hours") return { label: "Waits for working hours", tone: "waiting" };
  if (r.heldBy === "night-shift") return { label: "Skipped during night shift", tone: "waiting" };
  if (r.heldBy === "retry") {
    return {
      label: `Didn't finish last time; tries again ${formatRelativeTime(r.dueAt)}`,
      tone: "due",
    };
  }
  if (r.dueAt) return { label: `Due ${formatRelativeTime(r.dueAt)}`, tone: "waiting" };
  return { label: "Done", tone: "off" };
}

function configValue(value: string | string[]): string {
  return Array.isArray(value) ? value.join(", ") : value;
}

/** Asks once more before deleting, since the file goes with it. */
function DeleteButton({ routine, onDelete }: { routine: Routine; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-xs text-zinc-400 hover:text-red-300"
      >
        Delete file
      </button>
    );
  }
  return (
    <span className="flex items-center gap-2 text-xs text-zinc-400">
      Delete {routine.path}? If it replaced a shipped routine, the shipped one comes back.
      <button
        type="button"
        onClick={() => {
          setConfirming(false);
          onDelete();
        }}
        className="rounded bg-red-600/80 px-2 py-0.5 font-medium text-white hover:bg-red-500"
      >
        Yes, delete
      </button>
      <button type="button" onClick={() => setConfirming(false)} className="hover:text-zinc-200">
        Cancel
      </button>
    </span>
  );
}

function RoutineRow({
  routine: r,
  busy,
  onToggle,
  onDelete,
}: {
  routine: Routine;
  busy: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const status = routineStatus(r);
  const configEntries = Object.entries(r.config);
  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-900/40">
      <div className="flex items-start gap-3 p-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} ${r.name}`}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-mono text-sm text-zinc-200">{r.name}</span>
            {r.source === "user" && <span className="text-xs text-zinc-500">yours</span>}
            <span className="text-xs text-zinc-500">{describeCadence(r)}</span>
            <span className={`rounded px-1.5 py-0.5 text-xs ${TONE_CLASS[status.tone]}`}>
              {status.label}
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-400">{r.description}</p>
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onToggle}
          className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {r.enabled ? "Turn off" : "Turn on"}
        </button>
      </div>
      {open && (
        <div className="space-y-2 border-t border-zinc-800 p-3 text-xs">
          {r.enabled && (
            <p className="text-zinc-500">
              {r.lastDoneAt
                ? `Last done ${formatRelativeTime(r.lastDoneAt)}`
                : "Not done in the last 30 days"}
            </p>
          )}
          {r.tools.length > 0 && (
            <p className="text-zinc-500">
              Tools: <span className="font-mono text-zinc-300">{r.tools.join(", ")}</span>
            </p>
          )}
          {configEntries.length > 0 && (
            <div className="text-zinc-500">
              Settings:
              <ul className="ml-3">
                {configEntries.map(([key, value]) => (
                  <li key={key}>
                    <span className="font-mono">{key}</span>:{" "}
                    <span className="text-zinc-300">{configValue(value)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <p className="text-zinc-500">What a pass is told to do:</p>
            <pre className="mt-1 whitespace-pre-wrap rounded bg-zinc-950/60 p-2 font-sans text-zinc-300">
              {r.body}
            </pre>
          </div>
          {r.path ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="break-all font-mono text-zinc-500">{r.path}</span>
              <DeleteButton routine={r} onDelete={onDelete} />
            </div>
          ) : (
            <p className="text-zinc-500">
              Shipped with Yarvis. Turning it on copies it into your routines folder, where you can
              edit it.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

const EMPTY_FORM = {
  name: "",
  description: "",
  once: false,
  every: "1d",
  workingHours: false,
  nightShift: "run" as "run" | "slow" | "skip",
  tools: "",
  body: "",
};

/** A new routine, written to the user's routines folder. */
function AddRoutineForm({
  onSave,
  onCancel,
}: {
  onSave: (routine: NewRoutine) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof EMPTY_FORM>(key: K, value: (typeof EMPTY_FORM)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    const tools = form.tools
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    try {
      await onSave({
        name: form.name.trim(),
        description: form.description.trim(),
        ...(form.once ? { once: true } : { every: form.every.trim() }),
        workingHours: form.workingHours || undefined,
        nightShift: form.nightShift === "run" ? undefined : form.nightShift,
        tools: tools.length ? tools : undefined,
        body: form.body,
      });
      setForm(EMPTY_FORM);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const input = "rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm";
  return (
    <form
      className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
        <label className="space-y-1 text-xs text-zinc-400">
          Name
          <input
            value={form.name}
            onChange={(e) => set("name", e.target.value.toLowerCase())}
            placeholder="check-release"
            aria-label="Routine name"
            className={`${input} block w-full font-mono`}
          />
        </label>
        <label className="space-y-1 text-xs text-zinc-400">
          Description
          <input
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="One line, shown in this list"
            aria-label="Routine description"
            className={`${input} block w-full`}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm text-zinc-300">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="routine-schedule"
            checked={!form.once}
            onChange={() => set("once", false)}
          />
          Repeats every
          <input
            value={form.every}
            onChange={(e) => set("every", e.target.value)}
            disabled={form.once}
            aria-label="Repeats every"
            title="Such as 30m, 3h or 1d. 15m to 30d."
            className={`${input} w-20 disabled:opacity-50`}
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="routine-schedule"
            checked={form.once}
            onChange={() => set("once", true)}
          />
          Once, on the next pass with room
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.workingHours}
            onChange={(e) => set("workingHours", e.target.checked)}
          />
          Working hours only
        </label>
        <label className="flex items-center gap-2">
          Night shift
          <select
            value={form.nightShift}
            onChange={(e) => set("nightShift", e.target.value as typeof form.nightShift)}
            aria-label="Night shift"
            className={input}
          >
            <option value="run">runs as usual</option>
            <option value="slow">runs less often</option>
            <option value="skip">skipped</option>
          </select>
        </label>
      </div>
      <label className="block space-y-1 text-xs text-zinc-400">
        Tools it uses (optional, comma-separated names from the Tool manager)
        <input
          value={form.tools}
          onChange={(e) => set("tools", e.target.value)}
          placeholder="slack_read_channel, list_events"
          aria-label="Routine tools"
          className={`${input} block w-full font-mono`}
        />
      </label>
      <label className="block space-y-1 text-xs text-zinc-400">
        What a pass should do, in your own words
        <textarea
          value={form.body}
          onChange={(e) => set("body", e.target.value)}
          rows={6}
          placeholder="Read the #releases channel since yesterday and leave me a note in the bell listing what shipped. If nothing shipped, count it as done."
          aria-label="Routine instructions"
          className={`${input} block w-full`}
        />
      </label>
      <p className="text-xs text-zinc-500">
        A pass runs this with nobody watching. Anything that reaches other people still waits for
        your approval. You can also ask the assistant in a chat to write one for you.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || !form.name.trim() || !form.description.trim() || !form.body.trim()}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          Save routine
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-zinc-400 hover:text-zinc-200"
        >
          Cancel
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </form>
  );
}

/**
 * The routines passes take on: which ones the next pass runs, why the rest
 * wait, each one's instructions, and a way to turn one on or off or add one.
 */
export default function RoutineList({
  data,
  loadError,
  running,
  onReload,
  onCreate,
  onToggle,
  onDelete,
}: {
  data: RoutinesResponse | null;
  /** Why the list couldn't be loaded, shown in place of it with the reload button to retry. */
  loadError: string | null;
  /** Heads-down mode has a run going, paused or not. Routines only run inside one. */
  running: boolean;
  onReload: () => Promise<void>;
  onCreate: (routine: NewRoutine) => Promise<void>;
  onToggle: (name: string, enabled: boolean) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reloadButton = (
    <button
      type="button"
      disabled={busy}
      onClick={() => void act(onReload)}
      className="text-sm text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
    >
      Reload files
    </button>
  );

  if (!data) {
    if (!loadError) return <p className="text-xs text-zinc-500">Loading…</p>;
    return (
      <div className="space-y-2">
        <p className="text-xs text-red-400">Couldn't load the routines: {loadError}</p>
        <div className="flex items-center gap-3">
          {reloadButton}
          {error && <span className="text-xs text-red-400">{error}</span>}
        </div>
      </div>
    );
  }

  const next = data.routines.filter((r) => r.nextPass);
  const on = data.routines.filter((r) => r.enabled);
  const off = data.routines.filter((r) => !r.enabled);

  return (
    <div className="space-y-4">
      <div className="space-y-1 text-sm">
        {!running && (
          <p className="text-amber-300">
            Heads-down mode is off, so no routine runs until you start it or tick Always on in
            Settings.
          </p>
        )}
        {data.maxRoutinesPerPass === 0 ? (
          <p className="text-amber-300">Routines per pass is 0 in Settings, so none of them run.</p>
        ) : (
          <p className="text-zinc-300">
            {next.length > 0
              ? `Next pass runs: ${next.map((r) => r.name).join(", ")}.`
              : "Nothing is due for the next pass."}{" "}
            <span className="text-zinc-500">
              Up to {data.maxRoutinesPerPass} per pass, most overdue first.
            </span>
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4">
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500"
          >
            Add routine
          </button>
        )}
        {reloadButton}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>

      {adding && (
        <AddRoutineForm
          onSave={async (routine) => {
            await onCreate(routine);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          On ({on.length})
        </h3>
        {on.length === 0 ? (
          <p className="text-xs text-zinc-500">No routines are on.</p>
        ) : (
          <ul className="space-y-2">
            {on.map((r) => (
              <RoutineRow
                key={r.name}
                routine={r}
                busy={busy}
                onToggle={() => void act(() => onToggle(r.name, false))}
                onDelete={() => void act(() => onDelete(r.name))}
              />
            ))}
          </ul>
        )}
      </section>

      {off.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Off ({off.length})
          </h3>
          <p className="text-xs text-zinc-500">
            Most shipped routines start off because they need setup or reach other people. Open one
            to read what it does and what it needs before you turn it on.
          </p>
          <ul className="space-y-2">
            {off.map((r) => (
              <RoutineRow
                key={r.name}
                routine={r}
                busy={busy}
                onToggle={() => void act(() => onToggle(r.name, true))}
                onDelete={() => void act(() => onDelete(r.name))}
              />
            ))}
          </ul>
        </section>
      )}

      {data.problems.length > 0 && (
        <ul className="space-y-1">
          {data.problems.map((p) => (
            <li key={p.path} className="break-words text-xs text-amber-400">
              {p.message}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-zinc-500">
        Your routines are markdown files in{" "}
        <span className="break-all font-mono">{data.userDir}</span>. A file with the same name as a
        shipped one replaces it. Press Reload files after editing one.
      </p>
    </div>
  );
}
