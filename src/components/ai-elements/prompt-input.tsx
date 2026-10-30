/**
 * The layout parts of AI Elements' prompt input (https://elements.ai-sdk.dev):
 * a bordered box with the textarea on top and a toolbar below it. The upstream
 * component also owns the input state, attachments and a command menu; here
 * `ChatComposer` owns the state, and the chat has no attachments yet.
 */
import { CornerDownLeftIcon, SquareIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Loader } from "./loader";

export type PromptInputProps = HTMLAttributes<HTMLDivElement>;

export const PromptInput = ({ className, ...props }: PromptInputProps) => (
  <div
    className={cn(
      "w-full overflow-hidden rounded-xl border border-input bg-card shadow-sm transition-colors focus-within:border-ring",
      className,
    )}
    {...props}
  />
);

export type PromptInputTextareaProps = ComponentProps<"textarea">;

export const PromptInputTextarea = ({ className, ...props }: PromptInputTextareaProps) => (
  <textarea
    className={cn(
      "block w-full resize-none overflow-y-auto border-0 bg-transparent px-3 pt-3 pb-1 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50",
      className,
    )}
    {...props}
  />
);

export type PromptInputFooterProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputFooter = ({ className, ...props }: PromptInputFooterProps) => (
  <div className={cn("flex items-center justify-between gap-2 p-2", className)} {...props} />
);

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTools = ({ className, ...props }: PromptInputToolsProps) => (
  <div className={cn("flex min-w-0 flex-wrap items-center gap-1", className)} {...props} />
);

export type PromptInputSelectProps = ComponentProps<"select">;

/** A native select dressed as a toolbar button, for pickers such as provider and model. */
export const PromptInputSelect = ({ className, ...props }: PromptInputSelectProps) => (
  <select
    className={cn(
      "h-7 max-w-48 truncate rounded-md border-0 bg-transparent px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
      className,
    )}
    {...props}
  />
);

/** Where the turn is: idle, sent and waiting for the first token, or replying. */
export type PromptInputStatus = "ready" | "submitted" | "streaming";

export type PromptInputSubmitProps = ComponentProps<typeof Button> & {
  status?: PromptInputStatus;
};

export const PromptInputSubmit = ({
  className,
  status = "ready",
  children,
  size = "sm",
  ...props
}: PromptInputSubmitProps) => {
  let icon = <CornerDownLeftIcon className="size-4" />;
  if (status === "submitted") icon = <Loader size={14} />;
  else if (status === "streaming") icon = <SquareIcon className="size-3.5" />;
  return (
    <Button className={cn("gap-1.5", className)} size={size} type="button" {...props}>
      {icon}
      {children}
    </Button>
  );
};
