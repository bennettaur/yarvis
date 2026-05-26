import { useEffect, useState } from "react";
import { getHealth } from "../../lib/api";

type Health = "checking" | "ok" | "down";

/** Thin top bar: current view title on the left, live sidecar status on the right. */
export default function TopBar({ title }: { title: string }) {
  const [health, setHealth] = useState<Health>("checking");

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
    health === "checking"
      ? "bg-zinc-500"
      : health === "ok"
        ? "bg-emerald-500"
        : "bg-red-500";

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800 px-5">
      <h1 className="text-sm font-medium tracking-tight text-zinc-200">{title}</h1>
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <span className={`inline-block h-2 w-2 rounded-full ${dotColor}`} />
        sidecar
      </div>
    </header>
  );
}
