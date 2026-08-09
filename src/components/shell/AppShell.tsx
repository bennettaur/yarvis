import { useRef } from "react";
import { useFind } from "../../lib/find/useFind";
import FindBar from "../find/FindBar";
import NavRail from "./NavRail";
import { type Tab, tabLabel } from "./nav";
import TopBar from "./TopBar";

/**
 * Full-viewport desktop shell: a slim left icon rail, a thin top bar, and a
 * full-bleed content region that owns its own scroll. Replaces the old
 * centered, max-width card column.
 *
 * The shell also hosts find-on-page (Cmd+F), scoped to the content region so a
 * search runs over the view the user is looking at rather than the nav chrome.
 */
export default function AppShell({
  tab,
  onTabChange,
  onOpenOmniChat,
  onOpenClipboard,
  onOpenAttention,
  attentionPending,
  children,
}: {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  onOpenOmniChat: () => void;
  onOpenClipboard: () => void;
  onOpenAttention: () => void;
  attentionPending: boolean;
  children: React.ReactNode;
}) {
  const contentRef = useRef<HTMLElement>(null);
  const find = useFind(contentRef);

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <NavRail
        tab={tab}
        onTabChange={onTabChange}
        onOpenOmniChat={onOpenOmniChat}
        onOpenClipboard={onOpenClipboard}
        attentionPending={attentionPending}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={tabLabel(tab)} onOpenAttention={onOpenAttention} />
        <main ref={contentRef} className="min-h-0 flex-1 overflow-hidden">
          {children}
        </main>
      </div>
      <FindBar find={find} />
    </div>
  );
}
