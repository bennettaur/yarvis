import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import AlarmOverlay from "./components/AlarmOverlay";
import AlarmsPanel from "./components/AlarmsPanel";
import ChatPanel from "./components/ChatPanel";
import Dashboard from "./components/Dashboard";
import PrsPanel from "./components/PrsPanel";
import SessionsPanel from "./components/SessionsPanel";
import TasksPanel from "./components/TasksPanel";
import { onAlarmFired, type Alarm } from "./lib/alarms";

type Tab = "chat" | "tasks" | "prs" | "alarms" | "sessions" | "dashboard";

const TABS: Tab[] = ["chat", "tasks", "prs", "alarms", "sessions", "dashboard"];

export default function App() {
  const [tab, setTab] = useState<Tab>("chat");
  const [activeAlarm, setActiveAlarm] = useState<Alarm | null>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    onAlarmFired((alarm) => setActiveAlarm(alarm)).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, []);

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-3xl px-8 py-8">
        <header className="mb-8 flex items-center gap-6">
          <h1 className="text-2xl font-semibold tracking-tight">Yarvis</h1>
          <nav className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-md px-3 py-1.5 text-sm capitalize ${
                  tab === t
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {t}
              </button>
            ))}
          </nav>
        </header>

        {tab === "chat" && <ChatPanel />}
        {tab === "tasks" && <TasksPanel />}
        {tab === "prs" && <PrsPanel />}
        {tab === "alarms" && <AlarmsPanel />}
        {tab === "sessions" && <SessionsPanel />}
        {tab === "dashboard" && <Dashboard />}
      </div>

      {activeAlarm && (
        <AlarmOverlay alarm={activeAlarm} onDone={() => setActiveAlarm(null)} />
      )}
    </main>
  );
}
