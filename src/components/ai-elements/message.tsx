/**
 * AI Elements' message parts (https://elements.ai-sdk.dev). Replies render
 * through the app's own `Markdown` rather than Streamdown, because `Markdown`
 * is what turns PR and `yarvis://` links into in-app navigation and refuses to
 * load remote images. The branch and attachment parts are left out: a thread
 * here has neither.
 */
import { type ComponentProps, type HTMLAttributes, memo } from "react";
import { cn } from "../../lib/cn";
import Markdown from "../Markdown";
import { Button } from "../ui/button";

export type MessageRole = "user" | "assistant";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: MessageRole;
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto items-end" : "is-assistant",
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      "flex w-fit max-w-full min-w-0 flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:w-full group-[.is-assistant]:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({ className, children, ...props }: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  /** Shown on hover and read by screen readers. */
  tooltip?: string;
  /** The accessible name, when it should differ from the tooltip. */
  label?: string;
};

/** An icon button under a message. The tooltip is the native `title`, not a popover. */
export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => (
  <Button size={size} type="button" variant={variant} title={tooltip} {...props}>
    {children}
    <span className="sr-only">{label || tooltip}</span>
  </Button>
);

export type MessageResponseProps = {
  children: string;
  className?: string;
};

/**
 * Memoized on the text because the thread re-renders on every streamed token:
 * without it, each finished reply would be re-parsed per token.
 */
export const MessageResponse = memo(
  ({ className, children }: MessageResponseProps) => (
    <Markdown
      className={cn("[&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
      allowAppLinks
    >
      {children}
    </Markdown>
  ),
  (prev, next) => prev.children === next.children && prev.className === next.className,
);

MessageResponse.displayName = "MessageResponse";
