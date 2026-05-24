import { useState } from "react";
import ChatPanel from "./components/ChatPanel";
import Dashboard from "./components/Dashboard";
import PrsPanel from "./components/PrsPanel";
import SessionsPanel from "./components/SessionsPanel";
import TasksPanel from "./components/TasksPanel";

type Tab = "chat" | "tasks" | "prs" | "sessions" | "dashboard";

const TABS: Tab[] = ["chat", "tasks", "prs", "sessions", "dashboard"];

export default function App() {
  const [tab, setTab] = useState<Tab>("chat");

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
        {tab === "sessions" && <SessionsPanel />}
        {tab === "dashboard" && <Dashboard />}
      </div>
    </main>
  );
}
