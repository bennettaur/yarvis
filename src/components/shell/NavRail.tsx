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
  shortcutKey = null,
  showHint = false,
}: {
  label: string;
  icon: IconName;
  active: boolean;
  onClick: () => void;
  /** Shows an attention dot over the icon (e.g. Omni Chat needs the user). */
  badge?: boolean;
  /** The key this button answers to with Cmd held, if it has one. */
  shortcutKey?: string | null;
  /** Label the button with {@link shortcutKey} — the user is holding Cmd. */
  showHint?: boolean;
}) {
  const chord = shortcutKey ? formatChord(["Mod", shortcutKey]) : null;

  return (
    <button
      type="button"
      title={chord ? `${label} (${chord})` : label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={`relative flex h-10 w-10 items-center justify-center transition-colors ${
        active ? "text-indigo-400" : "text-zinc-500 hover:text-zinc-200"
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

/** Slim left icon rail. Primary views at the top, settings pinned to the bottom. */
export default function NavRail({
  tab,
  onTabChange,
  onOpenOmniChat,
  onOpenClipboard,
  onOpenShortcuts,
  attentionPending,
  showHints = false,
}: {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  onOpenOmniChat: () => void;
  onOpenClipboard: () => void;
  onOpenShortcuts: () => void;
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
        />
      ))}
      <div className="mt-auto flex flex-col gap-1">
        <RailButton label="Clipboard" icon="clipboard" active={false} onClick={onOpenClipboard} />
        <RailButton
          label="Keyboard shortcuts"
          icon="shortcuts"
          active={false}
          onClick={onOpenShortcuts}
          shortcutKey="/"
          showHint={showHints}
        />
        <RailButton
          label="Omni Chat"
          icon="omnichat"
          active={false}
          onClick={onOpenOmniChat}
          badge={attentionPending}
        />
        {bottom.map((item) => (
          <RailButton
            key={item.id}
            label={item.label}
            icon={item.icon}
            active={tab === item.id}
            onClick={() => onTabChange(item.id)}
          />
        ))}
      </div>
    </nav>
  );
}
