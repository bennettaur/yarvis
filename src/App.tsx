import type { UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import AlarmOverlay from "./components/AlarmOverlay";
import AlarmsPanel from "./components/AlarmsPanel";
import ChatPanel from "./components/ChatPanel";
import CalendarView from "./components/calendar/CalendarView";
import Dashboard from "./components/Dashboard";
import MemoryPanel from "./components/MemoryPanel";
import OmniView from "./components/omni/OmniView";
import OmniChat from "./components/omnichat/OmniChat";
import PrsPanel from "./components/PrsPanel";
import SessionsPanel from "./components/SessionsPanel";
import SettingsPanel from "./components/SettingsPanel";
import AppShell from "./components/shell/AppShell";
import { type Tab, tabLabel } from "./components/shell/nav";
import TerminalTabs from "./components/shell/terminalTabs/TerminalTabs";
import { useTabShortcuts } from "./components/shell/useTabShortcuts";
import TasksPanel from "./components/TasksPanel";
import WorkspacesPanel from "./components/WorkspacesPanel";
import { type Alarm, onAlarmFired } from "./lib/alarms";
import { useOpenPrListener } from "./lib/nav";
import { notify } from "./lib/notify";
import { onOmniChatSummon } from "./lib/omniChat";
import { useOmniChatContext } from "./lib/omniChatContext";
import type { PrSummary } from "./lib/pr/types";
import { useTelegramSecurityAlerts } from "./lib/useTelegramSecurityAlerts";

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const saved = localStorage.getItem("yarvis.activeTab") as Tab | null;
    return saved ?? "chat";
  });
  const [activeAlarm, setActiveAlarm] = useState<Alarm | null>(null);

  useEffect(() => {
    localStorage.setItem("yarvis.activeTab", tab);
  }, [tab]);
  const [omniChatOpen, setOmniChatOpen] = useState(false);
  const [attention, setAttention] = useState<string | null>(null);
  // A PR another view (workspaces, omni) has asked us to open. PrsPanel reads
  // this on mount/change, selects the PR, and we clear it. One-shot, not
  // persisted — refreshing the app drops it.
  const [requestedPr, setRequestedPr] = useState<PrSummary | null>(null);

  useTabShortcuts(tab, setTab);

  const handleOpenPr = useCallback((pr: PrSummary) => {
    setRequestedPr(pr);
    setTab("prs");
  }, []);
  useOpenPrListener(handleOpenPr);

  // Surface Telegram unlock/failed/lockout activity as OS notifications, app-wide.
  useTelegramSecurityAlerts();

  // Baseline context: every view contributes at least its tab name, so Omni
  // Chat always knows roughly where the user is even before a view is wired up.
  useOmniChatContext(
    "tab",
    () => ({ source: "tab", summary: `Viewing the ${tabLabel(tab)} tab` }),
    [tab],
  );

  // Read the latest open state from event handlers without re-subscribing.
  const openRef = useRef(omniChatOpen);
  useEffect(() => {
    openRef.current = omniChatOpen;
  }, [omniChatOpen]);

  const openOmniChat = useCallback(() => {
    setAttention(null);
    setOmniChatOpen(true);
  }, []);

  // The agent flagged it needs the user. If they aren't already looking at the
  // overlay, raise a badge + an OS notification.
  const handleAttention = useCallback((reason: string) => {
    if (openRef.current) return;
    setAttention(reason);
    void notify("Yarvis", reason);
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    onAlarmFired((alarm) => setActiveAlarm(alarm)).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    onOmniChatSummon(() => openOmniChat()).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, [openOmniChat]);

  return (
    <>
      <AppShell
        tab={tab}
        onTabChange={setTab}
        onOpenOmniChat={openOmniChat}
        attentionPending={attention !== null}
      >
        {/* Chat and Omni fill the region and manage their own layout; page-like
            views scroll as a padded document. */}
        {tab === "chat" ? (
          <ChatPanel />
        ) : tab === "omni" ? (
          <OmniView />
        ) : tab === "terminal" ? (
          <TerminalTabs storageKey="tab:terminal" />
        ) : tab === "workspaces" ? (
          <WorkspacesPanel />
        ) : tab === "prs" ? (
          // PRs owns its scroll so the PR detail view can pin a static header
          // at the top and let only the body scroll under it (rather than
          // sharing the catch-all p-6 wrapper's scroll, which leaves a gap
          // above a `sticky` header).
          <PrsPanel requestedPr={requestedPr} onRequestConsumed={() => setRequestedPr(null)} />
        ) : (
          <div className="h-full overflow-y-auto p-6">
            {tab === "tasks" && <TasksPanel />}
            {tab === "memory" && <MemoryPanel />}
            {tab === "calendar" && <CalendarView />}
            {tab === "alarms" && <AlarmsPanel />}
            {tab === "sessions" && <SessionsPanel />}
            {tab === "dashboard" && <Dashboard />}
            {tab === "settings" && <SettingsPanel />}
          </div>
        )}
      </AppShell>

      <OmniChat
        open={omniChatOpen}
        onClose={() => setOmniChatOpen(false)}
        onAttention={handleAttention}
      />

      {activeAlarm && <AlarmOverlay alarm={activeAlarm} onDone={() => setActiveAlarm(null)} />}
    </>
  );
}
