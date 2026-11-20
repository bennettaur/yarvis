import { SendIcon, XIcon } from "lucide-react";
import { Button } from "./ui/button";

/**
 * Messages typed while a reply was running, waiting their turn above the
 * composer. They go out on their own when the reply finishes. After a failed
 * or stopped turn they wait instead, so `held` offers to send the next one.
 */
export default function QueuedMessages({
  queued,
  held,
  onRemove,
  onSendNext,
}: {
  queued: string[];
  /** True when nothing is running and the queue is waiting on the user. */
  held: boolean;
  onRemove: (index: number) => void;
  onSendNext: () => void;
}) {
  if (queued.length === 0) return null;
  return (
    <section aria-label="Queued messages" className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {held ? "Queued — waiting until you send them" : "Queued — sends when the reply finishes"}
        </span>
        {held && (
          <Button variant="outline" size="xs" onClick={onSendNext}>
            <SendIcon />
            Send next
          </Button>
        )}
      </div>
      <ul className="flex flex-col gap-1">
        {queued.map((text, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: rows hold no state, and identical messages can both be queued
            key={i}
            className="flex items-start gap-2 rounded-md border border-dashed border-border px-2 py-1 text-sm text-muted-foreground"
          >
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{text}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Remove queued message"
              title="Remove from the queue"
              onClick={() => onRemove(i)}
            >
              <XIcon />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
