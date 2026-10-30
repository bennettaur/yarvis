/**
 * AI Elements' reasoning disclosure (https://elements.ai-sdk.dev). Open while
 * the reasoning streams in, then folds itself a second after it stops, once.
 * The text shows as written rather than as markdown: it is the model thinking
 * aloud, and half-finished markdown mid-stream renders worse than plain text.
 */
import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import {
  type ComponentProps,
  createContext,
  memo,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";

type ReasoningContextValue = {
  isStreaming: boolean;
  isOpen: boolean;
  duration: number | undefined;
};

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

function useReasoning(): ReasoningContextValue {
  const context = useContext(ReasoningContext);
  if (!context) throw new Error("Reasoning components must be used within Reasoning");
  return context;
}

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  /** Seconds spent reasoning, when the caller knows it; otherwise measured while streaming. */
  duration?: number;
};

const AUTO_CLOSE_DELAY_MS = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen = true,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }: ReasoningProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    });
    const [duration, setDuration] = useControllableState<number | undefined>({
      prop: durationProp,
      defaultProp: undefined,
    });
    // Read once: a caller that derives `defaultOpen` from the live state flips
    // it to false the moment streaming stops, which would cancel the fold.
    const [opensWhileStreaming] = useState(defaultOpen);
    const [hasAutoClosed, setHasAutoClosed] = useState(false);
    const startTime = useRef<number | null>(null);

    useEffect(() => {
      if (isStreaming) {
        startTime.current ??= Date.now();
      } else if (startTime.current !== null) {
        setDuration(Math.ceil((Date.now() - startTime.current) / 1000));
        startTime.current = null;
      }
    }, [isStreaming, setDuration]);

    useEffect(() => {
      if (opensWhileStreaming && !isStreaming && isOpen && !hasAutoClosed) {
        const timer = setTimeout(() => {
          setIsOpen(false);
          setHasAutoClosed(true);
        }, AUTO_CLOSE_DELAY_MS);
        return () => clearTimeout(timer);
      }
    }, [isStreaming, isOpen, opensWhileStreaming, setIsOpen, hasAutoClosed]);

    return (
      <ReasoningContext.Provider value={{ isStreaming, isOpen, duration }}>
        <Collapsible className={className} onOpenChange={setIsOpen} open={isOpen} {...props}>
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  },
);

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
};

/** A reloaded turn has no timing, so it gets a label that doesn't claim one. */
const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number): ReactNode => {
  if (isStreaming) return <span className="animate-pulse">Thinking…</span>;
  if (duration === undefined) return <span>Thought about it</span>;
  return <span>Thought for {duration === 1 ? "1 second" : `${duration} seconds`}</span>;
};

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage = defaultGetThinkingMessage,
    ...props
  }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen, duration } = useReasoning();
    return (
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground",
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="size-3.5" />
            {getThinkingMessage(isStreaming, duration)}
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", isOpen ? "rotate-180" : "rotate-0")}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  },
);

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent> & {
  children: string;
};

export const ReasoningContent = memo(({ className, children, ...props }: ReasoningContentProps) => (
  <CollapsibleContent
    className={cn("mt-2 border-l-2 border-border pl-3 text-xs text-muted-foreground", className)}
    {...props}
  >
    <pre className="max-h-64 overflow-auto font-sans whitespace-pre-wrap">{children}</pre>
  </CollapsibleContent>
));

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
