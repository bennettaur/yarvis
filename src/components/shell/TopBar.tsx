import { useEffect, useState } from "react";
import { getHealth } from "../../lib/api";
import { useAttentionItems } from "../../lib/attentionStore";
import { Icon } from "./icons";

type Health = "checking" | "ok" | "down";

/**
 * Thin top bar: current view title on the left; a persistent attention indicator
 * and live sidecar status on the right. The indicator shows the pending count and
 * opens the attention panel.
 */
export default function TopBar({
  title,
  onOpenAttention,
}: {
  title: string;
  onOpenAttention: () => void;
}) {
  const [health, setHealth] = useState<Health>("checking");
  const pending = useAttentionItems();

  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        await getHealth();
        if (!cancelled) setHealth("ok");
      } catch {
        if (!cancelled) setHealth("down");
      }
    };
    void probe();
    const timer = setInterval(() => void probe(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const dotColor =
    health === "checking" ? "bg-zinc-500" : health === "ok" ? "bg-emerald-500" : "bg-red-500";

  const count = pending.length;

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800 px-5">
      <h1 className="text-sm font-medium tracking-tight text-zinc-200">{title}</h1>
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={onOpenAttention}
          title={count > 0 ? `${count} needing attention` : "Attention"}
          aria-label={count > 0 ? `Attention: ${count} pending` : "Attention"}
          className="relative flex h-7 w-7 items-center justify-center text-zinc-400 transition-colors hover:text-zinc-100"
        >
          <Icon name="bell" className="h-4.5 w-4.5" />
          {count > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-semibold leading-none text-zinc-950">
              {count > 9 ? "9+" : count}
            </span>
          )}
        </button>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className={`inline-block h-2 w-2 rounded-full ${dotColor}`} />
          sidecar
        </div>
      </div>
    </header>
  );
}
