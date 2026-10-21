import type { ReactNode } from "react";
import { Icon } from "../../../src/components/shell/icons";
import NavRail from "../../../src/components/shell/NavRail";
import { type Tab, tabLabel } from "../../../src/components/shell/nav";
import { noop } from "../lib/style";
import { APP_HEIGHT, APP_WIDTH } from "../lib/timing";

/** Height of the macOS title bar above the shell. */
export const TITLE_BAR = 30;

/**
 * The app's `TopBar`, drawn from its markup: the real one polls the sidecar's
 * health and reads the attention store, neither of which exists here.
 */
function TopBar({ title, attention }: { title: string; attention: number }) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800 px-5">
      <h1 className="text-sm font-medium tracking-tight text-zinc-200">{title}</h1>
      <div className="flex items-center gap-4">
        <span className="relative flex h-7 w-7 items-center justify-center text-zinc-400">
          <Icon name="bell" className="h-4.5 w-4.5" />
          {attention > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-semibold leading-none text-zinc-950">
              {attention > 9 ? "9+" : attention}
            </span>
          )}
        </span>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
          sidecar
        </div>
      </div>
    </header>
  );
}

/**
 * A macOS window holding the Yarvis shell: the real nav rail, the top bar, and
 * whatever view the scene puts in the content region. `overlay` sits above the
 * whole shell, for Omni Chat and the alarm takeover.
 */
export function AppWindow({
  tab,
  attention = 0,
  children,
  overlay,
}: {
  tab: Tab;
  attention?: number;
  children: ReactNode;
  overlay?: ReactNode;
}) {
  return (
    <div
      className="text-zinc-100"
      style={{
        width: APP_WIDTH,
        height: APP_HEIGHT,
        borderRadius: 12,
        overflow: "hidden",
        position: "relative",
        background: "#09090b",
        boxShadow:
          "0 0 0 1px rgba(255,255,255,.08), 0 40px 120px rgba(0,0,0,.7), 0 0 80px rgba(99,102,241,.15)",
      }}
    >
      <div
        className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3"
        style={{ height: TITLE_BAR }}
      >
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        <span className="flex-1 text-center text-xs text-zinc-500">Yarvis</span>
        <span className="w-12" />
      </div>
      <div className="flex bg-zinc-950" style={{ height: APP_HEIGHT - TITLE_BAR }}>
        <NavRail
          tab={tab}
          onTabChange={noop}
          onOpenOmniChat={noop}
          onOpenClipboard={noop}
          onOpenShortcuts={noop}
          onOpenSetupGuide={noop}
          onStartTour={noop}
          attentionPending={attention > 0}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar title={tabLabel(tab)} attention={attention} />
          <main className="relative min-h-0 flex-1 overflow-hidden">{children}</main>
        </div>
      </div>
      {overlay}
    </div>
  );
}
