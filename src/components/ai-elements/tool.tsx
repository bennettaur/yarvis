/**
 * AI Elements' tool call card (https://elements.ai-sdk.dev), keyed on the
 * sidecar's `ToolActivity` status instead of the AI SDK's `ToolUIPart` state,
 * since the frontend never sees the SDK's message parts.
 */
import {
  BanIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ClockIcon,
  type LucideIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps } from "react";
import type { ToolActivity } from "../../lib/chat";
import { cn } from "../../lib/cn";
import { Badge } from "../ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";

export type ToolStatus = ToolActivity["status"];

/** Each outcome has its own icon and word, so a row reads without relying on colour. */
const STATUS_DISPLAY: Record<ToolStatus, { label: string; Icon: LucideIcon; iconClass: string }> = {
  pending: { label: "Running", Icon: ClockIcon, iconClass: "animate-pulse text-zinc-400" },
  ok: { label: "Completed", Icon: CheckCircleIcon, iconClass: "text-emerald-400" },
  error: { label: "Error", Icon: XCircleIcon, iconClass: "text-red-400" },
  denied: { label: "Denied", Icon: BanIcon, iconClass: "text-amber-400" },
};

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group/tool w-full rounded-md border border-border bg-card/60", className)}
    {...props}
  />
);

export type ToolHeaderProps = {
  name: string;
  status: ToolStatus;
  /** The MCP server the tool came from, if it isn't a built-in. */
  server?: string;
  durationMs?: number;
  /** False when there is nothing to expand, so the header isn't a dead toggle. */
  expandable?: boolean;
  className?: string;
};

export const ToolHeader = ({
  className,
  name,
  status,
  server,
  durationMs,
  expandable = true,
}: ToolHeaderProps) => {
  const { label, Icon, iconClass } = STATUS_DISPLAY[status];
  return (
    <CollapsibleTrigger
      disabled={!expandable}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-left text-xs disabled:cursor-default",
        className,
      )}
    >
      <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="font-mono text-zinc-200">{name}</span>
      {server && <span className="text-muted-foreground">on {server}</span>}
      <Badge className="gap-1" variant="secondary">
        <Icon className={iconClass} />
        {label}
      </Badge>
      <span className="ml-auto flex items-center gap-2 text-muted-foreground">
        {durationMs !== undefined && <span>{formatDuration(durationMs)}</span>}
        {expandable && (
          <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]/tool:rotate-180" />
        )}
      </span>
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn("space-y-3 border-t border-border p-3 text-xs", className)}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: unknown;
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-1", className)} {...props}>
    <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Arguments</h4>
    <pre className="max-h-40 overflow-auto rounded-md bg-background/70 p-2 break-all whitespace-pre-wrap text-zinc-300">
      {JSON.stringify(input, null, 2)}
    </pre>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: string;
  isError?: boolean;
};

export const ToolOutput = ({ className, output, isError = false, ...props }: ToolOutputProps) => (
  <div className={cn("space-y-1", className)} {...props}>
    <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {isError ? "Error" : "Result"}
    </h4>
    <pre
      className={cn(
        "max-h-40 overflow-auto rounded-md p-2 break-all whitespace-pre-wrap",
        isError ? "bg-destructive/10 text-red-300" : "bg-background/70 text-zinc-300",
      )}
    >
      {output}
    </pre>
  </div>
);

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
