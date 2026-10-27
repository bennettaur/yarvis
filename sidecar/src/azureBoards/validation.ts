import { z } from "zod";

/**
 * Input rules shared by the Azure Boards routes, the agent's Boards tools and
 * the per-repo tracker setting, which all hand these values to the same client.
 */

// Work item ids are positive integers. The cap keeps a long digit string from
// turning into an imprecise number.
export const workItemId = z.coerce.number().int().positive().max(2_147_483_647);

// Azure project names can't contain `/`, `\` or control characters, and `..`
// would traverse once interpolated into an API path. The name also lands in
// the agent's brief, so a newline must not get through.
export const projectName = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (s) =>
      ![...s].some((ch) => ch < " " || ch === "\x7f" || ch === "/" || ch === "\\") &&
      !s.includes(".."),
    "invalid project",
  );

// An area path uses `\` between levels ("Project\Team"), so only control
// characters are refused. It is sent as a field value, never in a URL path.
export const areaPath = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((s) => ![...s].some((ch) => ch < " " || ch === "\x7f"), "invalid area path");

// Azure stores tags as one `;`-separated string, so a `;` would split a tag.
export const tagList = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(400)
      .refine((t) => !t.includes(";"), "tags can't contain ;"),
  )
  .max(50);
