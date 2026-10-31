/**
 * AI Elements' loader (https://elements.ai-sdk.dev): a spinning set of spokes,
 * sized by default to sit inline with a line of text. The app's one spinner.
 */
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

const SPOKES: { d: string; opacity?: number }[] = [
  { d: "M8 0V4" },
  { d: "M8 16V12", opacity: 0.5 },
  { d: "M3.29773 1.52783L5.64887 4.7639", opacity: 0.9 },
  { d: "M12.7023 1.52783L10.3511 4.7639", opacity: 0.1 },
  { d: "M12.7023 14.472L10.3511 11.236", opacity: 0.4 },
  { d: "M3.29773 14.472L5.64887 11.236", opacity: 0.6 },
  { d: "M15.6085 5.52783L11.8043 6.7639", opacity: 0.2 },
  { d: "M0.391602 10.472L4.19583 9.23598", opacity: 0.7 },
  { d: "M15.6085 10.4722L11.8043 9.2361", opacity: 0.3 },
  { d: "M0.391602 5.52783L4.19583 6.7639", opacity: 0.8 },
];

export type LoaderProps = HTMLAttributes<HTMLSpanElement> & {
  size?: number;
};

export const Loader = ({ className, size = 14, ...props }: LoaderProps) => (
  <span
    className={cn("inline-flex animate-spin items-center justify-center", className)}
    {...props}
  >
    <svg aria-hidden="true" height={size} width={size} viewBox="0 0 16 16" strokeLinejoin="round">
      {SPOKES.map(({ d, opacity }) => (
        <path key={d} d={d} opacity={opacity} stroke="currentColor" strokeWidth="1.5" />
      ))}
    </svg>
  </span>
);
