import { useCurrentFrame } from "remotion";
import { AppScene } from "../components/AppScene";
import { Em } from "../components/Caption";
import { closeUp, framed, swingIn } from "../components/shots";
import { enter, pop, sec } from "../lib/timing";

// Copied from ProjectsTab's `PRIORITY_COLOR`, which isn't exported.
const PRIORITY_COLOR = {
  urgent: "bg-red-900 text-red-200",
  high: "bg-amber-900 text-amber-200",
  medium: "bg-zinc-700 text-zinc-300",
  low: "bg-zinc-800 text-zinc-500",
} as const;

const ITEMS = [
  {
    priority: "urgent",
    key: "PROJ-412",
    title: "Ledger backfill",
    note: "Needs a dry-run flag before it ships.",
  },
  {
    priority: "urgent",
    key: "PROJ-415",
    title: "Webhook retries",
    note: "CI red on the retry spec.",
  },
  { priority: "low", key: "PROJ-420", title: "CSV export", note: "Nice to have this week." },
] as const;

const TABS = ["Memories", "Activity", "Agent todos", "Projects"];

/** The Memory tab's Projects view, from `ProjectsTab`'s markup, with tracked tickets landing. */
function ProjectsView() {
  const frame = useCurrentFrame();
  return (
    <div className="h-full overflow-hidden p-6">
      <div className="space-y-4">
        <div className="flex gap-1 border-b border-zinc-800">
          {TABS.map((t) => (
            <span
              key={t}
              className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
                t === "Projects"
                  ? "border-indigo-500 text-zinc-100"
                  : "border-transparent text-zinc-500"
              }`}
            >
              {t}
            </span>
          ))}
        </div>
        <div className="space-y-3">
          <p className="text-sm text-zinc-500">
            Tell the assistant about a project in chat and it appears here, with the tickets and
            priorities it is tracking.
          </p>
          <div className="flex flex-wrap gap-2">
            <span className="rounded-md border border-indigo-500 bg-zinc-800 px-2 py-1 text-sm text-zinc-100">
              Billing migration
              <span className="ml-2 rounded bg-indigo-900 px-1 text-[10px] text-indigo-200">
                active
              </span>
            </span>
            <span className="rounded-md border border-zinc-700 px-2 py-1 text-sm text-zinc-400">
              Auth hardening
              <span className="ml-2 rounded bg-amber-900 px-1 text-[10px] text-amber-200">
                paused
              </span>
            </span>
          </div>
          <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium text-zinc-200">Billing migration</h3>
                <span className="ml-auto rounded-md border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs">
                  active ▾
                </span>
              </div>
              <p className="mt-1 text-sm text-zinc-400">
                Move invoicing onto the new ledger service.
              </p>
              <p className="mt-1 text-sm text-indigo-300" style={enter(frame, 20)}>
                Focus: ship the billing migration this week
              </p>
            </div>
            <div>
              <h4 className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
                Tracked tickets
              </h4>
              <ul className="space-y-1">
                {ITEMS.map((item, i) => {
                  const at = 34 + i * 14;
                  return (
                    <li
                      key={item.key}
                      className="flex items-start gap-2 text-sm"
                      style={enter(frame, at)}
                    >
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs ${PRIORITY_COLOR[item.priority]}`}
                        style={{ transform: `scale(${pop(frame, at)})` }}
                      >
                        {item.priority}
                      </span>
                      <div className="min-w-0 flex-1">
                        <span className="text-zinc-200">
                          {item.key} · {item.title}
                        </span>
                        <p className="text-xs text-zinc-500">{item.note}</p>
                      </div>
                      <span className="text-xs text-zinc-500">Done</span>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div style={enter(frame, 90)}>
              <h4 className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
                Your open tasks
              </h4>
              <ul className="space-y-0.5">
                <li className="text-sm text-zinc-300">
                  Fix flaky checkout test
                  <span className="ml-2 text-xs text-zinc-600">weekly · 2026-10-09</span>
                </li>
                <li className="text-sm text-zinc-300">
                  Review Sam's auth PR
                  <span className="ml-2 text-xs text-zinc-600">daily · 2026-10-07</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export const projectsFrames = () => sec(8);

/** Where Monday's message went: a project with its tickets at the priorities given. */
export function Projects() {
  return (
    <AppScene
      tab="memory"
      shots={[...swingIn(), closeUp(28, 560, 420, 1.35), framed(150)]}
      caption={{
        kicker: "Memory · projects",
        title: "Everything you said is visible and editable",
        pointsAt: 40,
        pointStep: 36,
        points: [
          <>
            Projects under <Em>Memory → Projects</Em>
          </>,
          <>
            Your plan on the <Em>Tasks</Em> tab
          </>,
          <>
            The assistant's promises under <Em>Agent todos</Em>
          </>,
        ],
      }}
    >
      <ProjectsView />
    </AppScene>
  );
}
