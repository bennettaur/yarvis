import { useEffect, useId, useRef, useState } from "react";
import { Icon, type IconName } from "./icons";
import { NAV_ITEMS, type Tab } from "./nav";
import { formatChord } from "./shortcuts";
import { tabShortcutDigit } from "./useTabShortcuts";

function RailButton({
  label,
  icon,
  active,
  onClick,
  badge = false,
  badgeHint,
  shortcutKey = null,
  showHint = false,
  tourId,
  panelOpen,
  panelId,
}: {
  label: string;
  icon: IconName;
  active: boolean;
  onClick: () => void;
  /** Shows an attention dot over the icon (e.g. Omni Chat needs the user). */
  badge?: boolean;
  /** Appended to the title while {@link badge} shows, so the dot explains itself. */
  badgeHint?: string;
  /** The key this button answers to with Cmd held, if it has one. */
  shortcutKey?: string | null;
  /** Label the button with {@link shortcutKey} — the user is holding Cmd. */
  showHint?: boolean;
  /** Rendered as `data-tour`, which the app tour uses to find and highlight this button. */
  tourId?: string;
  /** Set when the button shows and hides a panel (`panelId`), to report whether it is open. */
  panelOpen?: boolean;
  panelId?: string;
}) {
  const lit = active || panelOpen === true;
  const chord = shortcutKey ? formatChord(["Mod", shortcutKey]) : null;
  const baseTitle = chord ? `${label} (${chord})` : label;
  const hinted = badge && badgeHint ? `${label} — ${badgeHint}` : label;

  return (
    <button
      type="button"
      title={badge && badgeHint ? `${baseTitle} — ${badgeHint}` : baseTitle}
      aria-label={hinted}
      aria-current={active ? "page" : undefined}
      aria-expanded={panelOpen}
      aria-controls={panelOpen ? panelId : undefined}
      data-tour={tourId}
      onClick={onClick}
      className={`relative flex h-10 w-10 items-center justify-center transition-colors ${
        lit ? "text-indigo-400" : "text-zinc-500 hover:text-zinc-200"
      }`}
    >
      {active && (
        <span className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 bg-indigo-400" />
      )}
      <Icon name={icon} className="h-5 w-5" />
      {badge && (
        <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber-400 ring-2 ring-zinc-950" />
      )}
      {showHint && shortcutKey && (
        <span className="absolute -bottom-0.5 right-0 rounded bg-zinc-800 px-1 font-mono text-[9px] font-semibold leading-4 text-zinc-300 ring-1 ring-zinc-700">
          {shortcutKey}
        </span>
      )}
    </button>
  );
}

/**
 * The Help button and the panel it opens: the setup guide, the app tour, and
 * the assistant for "where is X?" questions. Closes on a pick, Esc, or a click
 * outside. A plain disclosure rather than an ARIA menu, which would promise
 * arrow-key navigation this doesn't have.
 */
function HelpMenu({
  onOpenSetupGuide,
  onStartTour,
  onAskYarvis,
}: {
  onOpenSetupGuide: () => void;
  onStartTour: () => void;
  onAskYarvis: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  const items = [
    { label: "Setup guide", hint: "Database, secrets and providers", action: onOpenSetupGuide },
    { label: "Tour the app", hint: "What each page is for", action: onStartTour },
    { label: "Ask Yarvis", hint: "“Where do I add a GitHub token?”", action: onAskYarvis },
  ];

  return (
    <div ref={containerRef} className="relative">
      <RailButton
        label="Help"
        icon="help"
        active={false}
        onClick={() => setOpen((o) => !o)}
        tourId="help"
        panelOpen={open}
        panelId={panelId}
      />
      {open && (
        <div
          id={panelId}
          className="absolute bottom-0 left-full z-40 ml-2 w-60 rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={pick(item.action)}
              className="block w-full px-3 py-2 text-left hover:bg-zinc-800"
            >
              <div className="text-sm text-zinc-200">{item.label}</div>
              <div className="text-xs text-zinc-500">{item.hint}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Slim left icon rail. Primary views at the top, settings pinned to the bottom. */
export default function NavRail({
  tab,
  onTabChange,
  onOpenOmniChat,
  onOpenClipboard,
  onOpenShortcuts,
  onOpenSetupGuide,
  onStartTour,
  attentionPending,
  showHints = false,
}: {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  onOpenOmniChat: () => void;
  onOpenClipboard: () => void;
  onOpenShortcuts: () => void;
  onOpenSetupGuide: () => void;
  onStartTour: () => void;
  /** When true, the Omni Chat launcher shows an attention dot. */
  attentionPending: boolean;
  /** Labels each button with the key that reaches it (the modifier is held). */
  showHints?: boolean;
}) {
  const top = NAV_ITEMS.filter((i) => !i.pinBottom);
  const bottom = NAV_ITEMS.filter((i) => i.pinBottom);

  return (
    <nav className="flex h-full w-14 flex-col items-center gap-1 border-r border-zinc-800 bg-zinc-950 py-3">
      {top.map((item) => (
        <RailButton
          key={item.id}
          label={item.label}
          icon={item.icon}
          active={tab === item.id}
          onClick={() => onTabChange(item.id)}
          shortcutKey={tabShortcutDigit(item.id)}
          showHint={showHints}
          tourId={item.id}
        />
      ))}
      <div className="mt-auto flex flex-col gap-1">
        <RailButton
          label="Clipboard"
          icon="clipboard"
          active={false}
          onClick={onOpenClipboard}
          tourId="clipboard"
        />
        <RailButton
          label="Keyboard shortcuts"
          icon="shortcuts"
          active={false}
          onClick={onOpenShortcuts}
          shortcutKey="/"
          showHint={showHints}
          tourId="shortcuts"
        />
        <RailButton
          label="Omni Chat"
          icon="omnichat"
          active={false}
          onClick={onOpenOmniChat}
          badge={attentionPending}
          badgeHint="something needs your attention"
          tourId="omnichat"
        />
        {bottom.map((item) => (
          <RailButton
            key={item.id}
            label={item.label}
            icon={item.icon}
            active={tab === item.id}
            onClick={() => onTabChange(item.id)}
            tourId={item.id}
          />
        ))}
        <HelpMenu
          onOpenSetupGuide={onOpenSetupGuide}
          onStartTour={onStartTour}
          onAskYarvis={onOpenOmniChat}
        />
      </div>
    </nav>
  );
}
