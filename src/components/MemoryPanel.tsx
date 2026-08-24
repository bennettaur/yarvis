import { useState } from "react";
import EventsTab from "./memory/EventsTab";
import MemoryLibrary from "./memory/MemoryLibrary";
import ProjectsTab from "./memory/ProjectsTab";
import TodosTab from "./memory/TodosTab";

/**
 * The memory screen: four views of what the assistant knows and is doing.
 *
 * They sit together because they are one loop rather than four features — raw
 * events are consolidated into memories, projects say what the work is for, and
 * the assistant's todos are what it has taken on off the back of both. Seeing
 * them side by side is what makes it possible to tell "it never recorded that"
 * from "it recorded it and hasn't summarized it yet".
 */

const TABS = [
  { key: "memories", label: "Memories" },
  { key: "events", label: "Activity" },
  { key: "todos", label: "Agent todos" },
  { key: "projects", label: "Projects" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function MemoryPanel() {
  const [tab, setTab] = useState<TabKey>("memories");

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-zinc-800">
        {TABS.map(({ key, label }) => (
          <button
            type="button"
            key={key}
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
              tab === key
                ? "border-indigo-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "memories" && <MemoryLibrary />}
      {tab === "events" && <EventsTab />}
      {tab === "todos" && <TodosTab />}
      {tab === "projects" && <ProjectsTab />}
    </div>
  );
}
