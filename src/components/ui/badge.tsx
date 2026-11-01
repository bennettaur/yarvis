import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

/** shadcn/ui's badge (new-york-v4) in its secondary style, the only one used here. */
function Badge({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="badge"
      className={cn(
        "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent bg-secondary px-2 py-0.5 text-xs font-medium whitespace-nowrap text-secondary-foreground [&>svg]:pointer-events-none [&>svg]:size-3",
        className,
      )}
      {...props}
    />
  );
}

export { Badge };
