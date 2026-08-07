import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import AlarmOverlay from "./components/AlarmOverlay";
import AlarmsPanel from "./components/AlarmsPanel";
import AttentionAutoClear from "./components/attention/AttentionAutoClear";
import AttentionPanel from "./components/attention/AttentionPanel";
import ChatPanel from "./components/ChatPanel";
import CalendarView from "./components/calendar/CalendarView";
import ClipboardPalette from "./components/clipboard/ClipboardPalette";
import Dashboard from "./components/Dashboard";
import IssuesPanel from "./components/IssuesPanel";
import MemoryPanel from "./components/MemoryPanel";
import OmniView from "./components/omni/OmniView";
import OmniChat from "./components/omnichat/OmniChat";
import PrsPanel from "./components/PrsPanel";
import SessionsPanel from "./components/SessionsPanel";
import SettingsPanel from "./components/SettingsPanel";
import AppShell from "./components/shell/AppShell";
import { type Tab, tabLabel } from "./components/shell/nav";
import {
  attentionSurfaceOf,
  TERMINAL_SURFACE_KEY,
} from "./components/shell/terminalTabs/sessionIds";
import TerminalTabs from "./components/shell/terminalTabs/TerminalTabs";
import { useTabShortcuts } from "./components/shell/useTabShortcuts";
import TasksPanel from "./components/TasksPanel";
import WorkspacesPanel from "./components/WorkspacesPanel";
import { refreshAlarms, useAlarmTakeoverQueue, useRingingAlarms } from "./lib/alarmStore";
import type { AttentionItem } from "./lib/attention";
import { markAttention } from "./lib/attentionStore";
import { onClipboardSummon } from "./lib/clipboard";
import type { IssueSummary } from "./lib/issues/types";
import {
  type NewWorkspaceRequest,
  type OpenWorkspaceRequest,
  useNewWorkspaceListener,
  useOpenPrListener,
  useOpenWorkspaceListener,
} from "./lib/nav";
import { notify } from "./lib/notify";
import { onOmniChatSummon } from "./lib/omniChat";
import { useOmniChatContext } from "./lib/omniChatContext";
import type { PrSummary } from "./lib/pr/types";
import { useTelegramSecurityAlerts } from "./lib/useTelegramSecurityAlerts";
import { getWip, type WipItem } from "./lib/wip";

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const saved = localStorage.getItem("yarvis.activeTab") as Tab | null;
    return saved ?? "chat";
  });
  // Alarms are shown one at a time, oldest first; the store drops each one as
  // it's acknowledged, snoozed, or cancelled, so the next takes over the screen.
  const alarmQueue = useAlarmTakeoverQueue();
  const ringingAlarms = useRingingAlarms();
  const activeAlarm = alarmQueue[0] ?? null;

  useEffect(() => {
    localStorage.setItem("yarvis.activeTab", tab);
  }, [tab]);
  const [omniChatOpen, setOmniChatOpen] = useState(false);
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [attention, setAttention] = useState<string | null>(null);
  const [attentionPanelOpen, setAttentionPanelOpen] = useState(false);
  const [wip, setWip] = useState<WipItem[]>([]);
  const [wipLoading, setWipLoading] = useState(false);
  // A PR another view (workspaces, omni) has asked us to open. PrsPanel reads
  // this on mount/change, selects the PR, and we clear it. One-shot, not
  // persisted — refreshing the app drops it.
  const [requestedPr, setRequestedPr] = useState<PrSummary | null>(null);
  // A workspace another view (Issues "Start work") has asked us to open, with an
  // optional Claude prompt to launch. WorkspacesPanel consumes and clears it.
  const [requestedWorkspace, setRequestedWorkspace] = useState<OpenWorkspaceRequest | null>(null);
  // A request to open the New Workspace form pre-filled (Tasks "Create workspace" /
  // "Start work"). WorkspacesPanel consumes and clears it.
  const [requestedNewWorkspace, setRequestedNewWorkspace] = useState<NewWorkspaceRequest | null>(
    null,
  );
  // An issue the attention/WIP panel asked us to open. IssuesPanel consumes it.
  const [requestedIssue, setRequestedIssue] = useState<IssueSummary | null>(null);
  // A PTY session on the standalone Terminal tab that an attention item asked us
  // to bring into view. The terminal surface consumes and clears it.
  const [requestedTerminalSession, setRequestedTerminalSession] = useState<string | null>(null);

  useTabShortcuts(tab, setTab);

  const handleOpenPr = useCallback((pr: PrSummary) => {
    setRequestedPr(pr);
    setTab("prs");
  }, []);
  useOpenPrListener(handleOpenPr);

  const handleOpenWorkspace = useCallback((request: OpenWorkspaceRequest) => {
    setRequestedWorkspace(request);
    setTab("workspaces");
  }, []);
  useOpenWorkspaceListener(handleOpenWorkspace);

  const handleNewWorkspace = useCallback((request: NewWorkspaceRequest) => {
    setRequestedNewWorkspace(request);
    setTab("workspaces");
  }, []);
  useNewWorkspaceListener(handleNewWorkspace);

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

  // Opening the panel refreshes the work-in-progress roll-up (the attention
  // items are already live via the store's SSE subscription).
  const openAttentionPanel = useCallback(() => {
    setAttentionPanelOpen(true);
    setWipLoading(true);
    getWip()
      .then(setWip)
      .catch((e) => {
        console.error("[wip] failed to load the work-in-progress list:", e);
        setWip([]);
      })
      .finally(() => setWipLoading(false));
  }, []);

  // Routes a nav target to the right tab/overlay, selecting the exact item where
  // the destination supports it. `title` (when known) seeds the detail view's
  // header until it re-fetches. Shared by both panel streams.
  const navigateTo = useCallback(
    (target: WipItem["navTarget"], title?: string) => {
      if (!target) return;
      void invoke("focus_main_window").catch((e) => {
        console.error("[app] focus_main_window failed:", e);
      });
      setAttentionPanelOpen(false);
      switch (target.type) {
        case "workspace-claude":
        case "workspace":
          setRequestedWorkspace({ id: target.workspaceId });
          setTab("workspaces");
          break;
        case "terminal": {
          // Route by the surface that owns the session, not by the workspace:
          // a Claude run started in the standalone Terminal tab picks up a
          // workspace's hook config and so carries a workspaceId it doesn't
          // live in. Only these two surfaces are reachable — the workspaces
          // view and the Terminal tab — so anything else falls back to the
          // workspace, which at least lands the user nearby.
          const surface = attentionSurfaceOf(target.sessionKey);
          if (surface === "terminal") {
            setRequestedTerminalSession(target.sessionKey);
            setTab("terminal");
          } else if (target.workspaceId) {
            setRequestedWorkspace({ id: target.workspaceId, focusSessionKey: target.sessionKey });
            setTab("workspaces");
          }
          break;
        }
        case "chat":
          openOmniChat();
          break;
        case "pr":
        case "azure-pr":
          // The detail view fetches from `ref`; the rest is a minimal seed.
          setRequestedPr({
            ref:
              target.type === "pr"
                ? {
                    provider: "github",
                    owner: target.owner,
                    repo: target.repo,
                    number: target.number,
                  }
                : {
                    provider: "azure",
                    org: target.org,
                    project: target.project,
                    repo: target.repo,
                    prId: target.prId,
                  },
            title: title ?? "",
            url: "",
            author: "",
            draft: false,
            state: "open",
            createdAt: "",
            updatedAt: "",
          });
          setTab("prs");
          break;
        case "issue":
          // The detail view re-fetches from (provider, sourceKey, externalId).
          setRequestedIssue({
            provider: target.provider === "jira" ? "jira" : "github",
            sourceKey: target.sourceKey,
            sourceLabel: target.sourceKey,
            externalId: target.externalId,
            displayId: `#${target.externalId}`,
            title: title ?? "",
            url:
              target.provider === "github"
                ? `https://github.com/${target.sourceKey}/issues/${target.externalId}`
                : "",
            state: "open",
            author: "",
            assignees: [],
            labels: [],
            createdAt: "",
            updatedAt: "",
            commentCount: 0,
          });
          setTab("issues");
          break;
        case "task":
          setTab("tasks");
          break;
      }
    },
    [openOmniChat],
  );

  const openAttentionItem = useCallback(
    (item: AttentionItem) => {
      void markAttention(item.id, "read");
      navigateTo(item.navTarget, item.title);
    },
    [navigateTo],
  );

  const openWipItem = useCallback(
    (item: WipItem) => navigateTo(item.navTarget, item.title),
    [navigateTo],
  );

  // The agent flagged it needs the user. If they aren't already looking at the
  // overlay, raise a badge + an OS notification.
  const handleAttention = useCallback((reason: string) => {
    if (openRef.current) return;
    setAttention(reason);
    void notify("Yarvis", reason);
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    onOmniChatSummon(() => openOmniChat()).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, [openOmniChat]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    onClipboardSummon(() => setClipboardOpen(true)).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, []);

  return (
    <>
      <AppShell
        tab={tab}
        onTabChange={setTab}
        onOpenOmniChat={openOmniChat}
        onOpenClipboard={() => setClipboardOpen(true)}
        onOpenAttention={openAttentionPanel}
        attentionPending={attention !== null || ringingAlarms.length > 0}
      >
        {/* Chat and Omni fill the region and manage their own layout; page-like
            views scroll as a padded document. */}
        {tab === "chat" ? (
          <ChatPanel />
        ) : tab === "omni" ? (
          <OmniView />
        ) : tab === "terminal" ? (
          <TerminalTabs
            storageKey={TERMINAL_SURFACE_KEY}
            focusSessionKey={requestedTerminalSession}
            onFocusSessionHandled={() => setRequestedTerminalSession(null)}
          />
        ) : tab === "workspaces" ? (
          <WorkspacesPanel
            requested={requestedWorkspace}
            onRequestConsumed={() => setRequestedWorkspace(null)}
            requestedNew={requestedNewWorkspace}
            onNewRequestConsumed={() => setRequestedNewWorkspace(null)}
          />
        ) : tab === "prs" ? (
          // PRs owns its scroll so the PR detail view can pin a static header
          // at the top and let only the body scroll under it (rather than
          // sharing the catch-all p-6 wrapper's scroll, which leaves a gap
          // above a `sticky` header).
          <PrsPanel requestedPr={requestedPr} onRequestConsumed={() => setRequestedPr(null)} />
        ) : tab === "issues" ? (
          // Issues owns its scroll so the issue detail view can pin a header and
          // scroll only its body, matching the PRs tab.
          <IssuesPanel
            requested={requestedIssue}
            onRequestConsumed={() => setRequestedIssue(null)}
          />
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

      <ClipboardPalette open={clipboardOpen} onClose={() => setClipboardOpen(false)} />

      <AttentionPanel
        open={attentionPanelOpen}
        onClose={() => setAttentionPanelOpen(false)}
        onOpenAttention={openAttentionItem}
        wip={wip}
        wipLoading={wipLoading}
        onOpenWip={openWipItem}
        onOpenAlarms={() => {
          setTab("alarms");
          setAttentionPanelOpen(false);
        }}
      />

      <AttentionAutoClear />

      {activeAlarm && (
        // Keyed so advancing to the next alarm remounts the overlay and its
        // "overdue by" timer restarts against that alarm's own fire time.
        <AlarmOverlay
          key={activeAlarm.id}
          alarm={activeAlarm}
          remaining={alarmQueue.length - 1}
          onDone={() => void refreshAlarms()}
        />
      )}
    </>
  );
}
