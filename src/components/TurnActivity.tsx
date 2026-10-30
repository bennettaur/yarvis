import { ChevronRightIcon } from "lucide-react";
import { useId, useState } from "react";
import type { ToolActivity } from "../lib/chat";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "./ai-elements/reasoning";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "./ai-elements/tool";

/**
 * What the assistant did during a turn: the tools it called, how each ended,
 * and — when the provider returns it — the reasoning behind them. A turn that
 * spends its time in tools has nothing else to show until the reply arrives,
 * which is indistinguishable from a hung app.
 *
 * Each row is collapsed to a line; the arguments and the result are one click
 * away, because the interesting question ("what did it actually ask for?") is
 * occasional.
 */
export default function TurnActivity({
  activity,
  thinking,
  running,
  collapsed = false,
}: {
  activity: ToolActivity[];
  /** Reasoning streamed for this turn, if any. */
  thinking?: string;
  /** True while the turn is still in flight, so an unsettled row reads as busy. */
  running?: boolean;
  /**
   * Fold the rows under a one-line summary. The in-flight turn stays open so
   * calls can pop in as they happen, then folds once the reply text starts;
   * finished turns are folded from the start. The user can reopen either.
   */
  collapsed?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  if (activity.length === 0 && !thinking) return null;

  // Reasoning stops reading as live once the reply text has started.
  const reasoningLive = Boolean(running) && !collapsed;
  const rows = (
    <div className={`space-y-1.5 ${collapsed ? "pt-1.5" : ""}`}>
      {thinking && (
        <Reasoning isStreaming={reasoningLive} defaultOpen={reasoningLive}>
          <ReasoningTrigger />
          <ReasoningContent>{thinking}</ReasoningContent>
        </Reasoning>
      )}
      {activity.map((entry) => (
        <ToolRow key={entry.id} entry={entry} />
      ))}
    </div>
  );
  const showRows = !collapsed || expanded;

  return (
    <div className="mb-2">
      {collapsed && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="flex items-center gap-2 py-0.5 text-xs text-zinc-500 hover:text-zinc-300"
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={`size-3.5 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          <span>{summarize(activity, Boolean(thinking))}</span>
        </button>
      )}
      {/* Animating grid rows lets the height go to and from auto. The rows stay
          mounted while folded so the fold can animate, hence `inert`. */}
      <div
        id={panelId}
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none ${
          showRows ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
        inert={!showRows}
      >
        <div className="min-h-0 overflow-hidden">{rows}</div>
      </div>
    </div>
  );
}

function summarize(activity: ToolActivity[], hasThinking: boolean): string {
  if (activity.length === 0) return "Thought about it";
  const count = `${activity.length} tool call${activity.length === 1 ? "" : "s"}`;
  const failed = activity.filter((a) => a.status === "error" || a.status === "denied").length;
  return `${hasThinking ? "Thought, " : "Used "}${count}${failed > 0 ? ` · ${failed} failed` : ""}`;
}

function ToolRow({ entry }: { entry: ToolActivity }) {
  const hasDetail = entry.args !== undefined || entry.result !== undefined;
  return (
    <Tool>
      <ToolHeader
        title={entry.name}
        status={entry.status}
        server={entry.server}
        durationMs={entry.durationMs}
        expandable={hasDetail}
      />
      {hasDetail && (
        <ToolContent>
          {entry.args !== undefined && <ToolInput input={entry.args} />}
          {entry.result !== undefined && (
            <ToolOutput output={entry.result} isError={entry.status === "error"} />
          )}
        </ToolContent>
      )}
    </Tool>
  );
}
