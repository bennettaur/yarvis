import NavRail from "./NavRail";
import { type Tab, tabLabel } from "./nav";
import TopBar from "./TopBar";

/**
 * Full-viewport desktop shell: a slim left icon rail, a thin top bar, and a
 * full-bleed content region that owns its own scroll. Replaces the old
 * centered, max-width card column.
 */
export default function AppShell({
  tab,
  onTabChange,
  children,
}: {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <NavRail tab={tab} onTabChange={onTabChange} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={tabLabel(tab)} />
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
