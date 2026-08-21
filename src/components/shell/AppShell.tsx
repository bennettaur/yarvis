import { useEffect, useRef, useState } from "react";
import { useFind } from "../../lib/find/useFind";
import FindBar from "../find/FindBar";
import NavRail from "./NavRail";
import { type Tab, tabLabel } from "./nav";
import ShortcutsOverlay from "./ShortcutsOverlay";
import { isCheatSheetShortcut } from "./shortcuts";
import TopBar from "./TopBar";
import { useShortcutHints } from "./useShortcutHints";

/**
 * Full-viewport desktop shell: a slim left icon rail, a thin top bar, and a
 * full-bleed content region that owns its own scroll. Replaces the old
 * centered, max-width card column.
 *
 * The shell also hosts find-on-page (Cmd+F), scoped to the content region so a
 * search runs over the view the user is looking at rather than the nav chrome,
 * and the keyboard cheat sheet (Cmd+/), which every view can be reached from.
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
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const showHints = useShortcutHints();

  // Capture phase, like the other window-level shortcuts, so the Terminal's
  // xterm doesn't swallow the combo first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isCheatSheetShortcut(e)) return;
      e.preventDefault();
      setShortcutsOpen((open) => !open);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <NavRail
        tab={tab}
        onTabChange={onTabChange}
        onOpenOmniChat={onOpenOmniChat}
        onOpenClipboard={onOpenClipboard}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        attentionPending={attentionPending}
        showHints={showHints}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={tabLabel(tab)} onOpenAttention={onOpenAttention} />
        <main ref={contentRef} className="min-h-0 flex-1 overflow-hidden">
          {children}
        </main>
      </div>
      <FindBar find={find} />
      <ShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
