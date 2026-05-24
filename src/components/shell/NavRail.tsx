import { Icon, type IconName } from "./icons";
import { NAV_ITEMS, type Tab } from "./nav";

function RailButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: IconName;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      title={label}
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
    </button>
  );
}

/** Slim left icon rail. Primary views at the top, settings pinned to the bottom. */
export default function NavRail({
  tab,
  onTabChange,
}: {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
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
        />
      ))}
      <div className="mt-auto flex flex-col gap-1">
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
