import { useEffect, useState } from "react";
import { getHealth } from "../../lib/api";
import { useAttentionGroups, useAttentionItems } from "../../lib/attentionStore";
import { Icon } from "./icons";

type Health = "checking" | "ok" | "down";

/**
 * Thin top bar: current view title on the left; a persistent attention indicator
 * and live sidecar status on the right. The indicator shows the pending count and
 * opens the attention panel. While anything is pending, an amber band sweeps
 * across the bar and the bell rings every few seconds (see `index.css`).
 */
export default function TopBar({
  title,
  onOpenAttention,
}: {
  title: string;
  onOpenAttention: () => void;
}) {
  const [health, setHealth] = useState<Health>("checking");
  // Counts origins, not items, so the badge matches the grouped rows in the panel.
  const count = useAttentionGroups().length;
  // Keyed on the newest item so a fresh arrival restarts the sweep right away
  // instead of waiting for the next cycle.
  const newestSeq = useAttentionItems()[0]?.seq;

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

  const sidecarHint =
    health === "checking"
      ? "Checking whether the sidecar is running"
      : health === "ok"
        ? "The sidecar (the local backend service) is running"
        : "The sidecar (the local backend service) is not responding";

  const dotColor =
    health === "checking" ? "bg-zinc-500" : health === "ok" ? "bg-emerald-500" : "bg-red-500";

  return (
    <header className="relative isolate flex h-12 shrink-0 items-center justify-between overflow-hidden border-b border-zinc-800 px-5">
      {count > 0 && (
        <span
          key={newestSeq}
          aria-hidden="true"
          data-testid="attention-sweep"
          className="yarvis-attention-sweep pointer-events-none absolute inset-0 -z-10"
        />
      )}
      <h1 className="text-sm font-medium tracking-tight text-zinc-200">{title}</h1>
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={onOpenAttention}
          title={count > 0 ? `${count} needing attention` : "Attention"}
          aria-label={count > 0 ? `Attention: ${count} pending` : "Attention"}
          className="relative flex h-7 w-7 items-center justify-center text-zinc-400 transition-colors hover:text-zinc-100"
        >
          <Icon
            key={newestSeq}
            name="bell"
            className={`h-4.5 w-4.5 ${count > 0 ? "yarvis-bell-ring" : ""}`}
          />
          {count > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-semibold leading-none text-zinc-950">
              {count > 9 ? "9+" : count}
            </span>
          )}
        </button>
        <div className="flex items-center gap-2 text-xs text-zinc-500" title={sidecarHint}>
          <span className={`inline-block h-2 w-2 rounded-full ${dotColor}`} />
          sidecar
        </div>
      </div>
    </header>
  );
}
