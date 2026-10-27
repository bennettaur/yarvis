import type { PrColor } from "./tabs/types";

/**
 * The colours that tell a workspace's PRs apart: on the PR's group in the left
 * nav, on its tabs' left edge and dot, and before its tab titles. Indigo is
 * left out because it is the app's accent, so a PR never looks like the
 * selection. Classes are written out in full because Tailwind only keeps the
 * ones it can find in the source.
 */
export const PR_COLORS: PrColor[] = [
  { name: "sky", bg: "bg-sky-400", border: "border-sky-400", text: "text-sky-300" },
  { name: "amber", bg: "bg-amber-400", border: "border-amber-400", text: "text-amber-300" },
  { name: "emerald", bg: "bg-emerald-400", border: "border-emerald-400", text: "text-emerald-300" },
  { name: "rose", bg: "bg-rose-400", border: "border-rose-400", text: "text-rose-300" },
  { name: "violet", bg: "bg-violet-400", border: "border-violet-400", text: "text-violet-300" },
  { name: "lime", bg: "bg-lime-400", border: "border-lime-400", text: "text-lime-300" },
  { name: "orange", bg: "bg-orange-400", border: "border-orange-400", text: "text-orange-300" },
  { name: "teal", bg: "bg-teal-400", border: "border-teal-400", text: "text-teal-300" },
];

/**
 * A PR's colour from its stable `colorIndex`. Past the palette it wraps, which
 * only a workspace holding more PRs than there are colours ever sees.
 */
export function prColor(colorIndex: number): PrColor {
  const n = PR_COLORS.length;
  return PR_COLORS[((Math.trunc(colorIndex) % n) + n) % n]!;
}
