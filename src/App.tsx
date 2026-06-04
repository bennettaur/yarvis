import type { UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import AlarmOverlay from "./components/AlarmOverlay";
import AlarmsPanel from "./components/AlarmsPanel";
import ChatPanel from "./components/ChatPanel";
import CalendarView from "./components/calendar/CalendarView";
import Dashboard from "./components/Dashboard";
import MemoryPanel from "./components/MemoryPanel";
import OmniView from "./components/omni/OmniView";
import PrsPanel from "./components/PrsPanel";
import SessionsPanel from "./components/SessionsPanel";
import SettingsPanel from "./components/SettingsPanel";
import AppShell from "./components/shell/AppShell";
import type { Tab } from "./components/shell/nav";
import TasksPanel from "./components/TasksPanel";
import TerminalPanel from "./components/TerminalPanel";
import { type Alarm, onAlarmFired } from "./lib/alarms";

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
    <>
      <AppShell tab={tab} onTabChange={setTab}>
        {/* Chat and Omni fill the region and manage their own layout; page-like
            views scroll as a padded document. */}
        {tab === "chat" ? (
          <ChatPanel />
        ) : tab === "omni" ? (
          <OmniView />
        ) : tab === "terminal" ? (
          <TerminalPanel sessionId="tab:terminal" />
        ) : (
          <div className="h-full overflow-y-auto p-6">
            {tab === "tasks" && <TasksPanel />}
            {tab === "prs" && <PrsPanel />}
            {tab === "memory" && <MemoryPanel />}
            {tab === "calendar" && <CalendarView />}
            {tab === "alarms" && <AlarmsPanel />}
            {tab === "sessions" && <SessionsPanel />}
            {tab === "dashboard" && <Dashboard />}
            {tab === "settings" && <SettingsPanel />}
          </div>
        )}
      </AppShell>

      {activeAlarm && <AlarmOverlay alarm={activeAlarm} onDone={() => setActiveAlarm(null)} />}
    </>
  );
}
