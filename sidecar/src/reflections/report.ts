import { z } from "zod";
import { createArtifact } from "../artifacts/service.ts";
import { raiseAttention } from "../attention/raise.ts";
import type { Db } from "../db/client.ts";

/**
 * The one report both weekly reflections end in. The model hands in structured
 * suggestions and the app renders them, so the two reflections read the same
 * and the title, the heading and the next step are never model text.
 */

export const REFLECTION_KINDS = ["review", "generation"] as const;
export type ReflectionKind = (typeof REFLECTION_KINDS)[number];

/** What a suggestion would change. Each names a place the user keeps or ships instructions. */
export const SUGGESTION_TARGETS = [
  "verify-pr skill",
  "reviewer agents",
  "review-scout prompt",
  "verification layer",
  "repo AGENTS.md",
  "Claude instructions",
] as const;

const text = (max: number) => z.string().trim().min(1).max(max);

export const reflectionReportSchema = z.object({
  summary: text(1500).describe("What the week showed, in a few sentences"),
  suggestions: z
    .array(
      z.object({
        target: z.enum(SUGGESTION_TARGETS),
        change: text(800).describe("The concrete edit: what to add, remove or reword"),
        evidence: text(800).describe("The PRs and comments that show it, as owner/repo#number"),
      }),
    )
    .max(15),
  noise: z
    .array(
      z.object({
        flag: text(300).describe("The kind of flag verification raised"),
        evidence: text(500).describe("How often and on which PRs it went unanswered"),
      }),
    )
    .max(10)
    .optional()
    .describe("Review reflection only: flags the user ignored, likely noise"),
});

export type ReflectionReport = z.infer<typeof reflectionReportSchema>;

const HEADINGS: Record<ReflectionKind, { title: string; item: string }> = {
  review: {
    title: "Review reflection",
    item: "what verification missed in your reviews",
  },
  generation: {
    title: "Generation reflection",
    item: "what reviewers caught in your merged PRs",
  },
};

/** Monday of the week `now` falls in, as YYYY-MM-DD, so a rerun that week updates the same report. */
export function weekStart(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function renderReflection(
  kind: ReflectionKind,
  report: ReflectionReport,
  week: string,
): string {
  const lines = [`# ${HEADINGS[kind].title}: week of ${week}`, "", report.summary, ""];
  lines.push("## Suggested changes", "");
  if (report.suggestions.length === 0) lines.push("None this week.", "");
  report.suggestions.forEach((s, i) => {
    lines.push(`${i + 1}. **${s.target}**: ${s.change}`, `   Evidence: ${s.evidence}`, "");
  });
  if (report.noise?.length) {
    lines.push("## Likely noise", "");
    for (const n of report.noise) lines.push(`- ${n.flag}. ${n.evidence}`);
    lines.push("");
  }
  lines.push(
    "## Applying these",
    "",
    "Nothing has been changed. To apply them, ask Yarvis to open a workspace on the repo and make these edits; you review the diff before anything is pushed.",
  );
  return lines.join("\n");
}

/**
 * Stores the report as an artifact and raises the one attention item that
 * links to it. Saving twice in a week updates the same item.
 */
export async function saveReflection(
  db: Db,
  kind: ReflectionKind,
  report: ReflectionReport,
  now: Date,
): Promise<{ artifactId: string; suggestions: number }> {
  const week = weekStart(now);
  const artifact = await createArtifact(db, {
    title: `${HEADINGS[kind].title}: week of ${week}`,
    content: renderReflection(kind, report, week),
    writer: "heads-down",
    untrusted: true,
  });
  const count = report.suggestions.length;
  await raiseAttention(db, {
    category: "general",
    kind: "message",
    title: `${HEADINGS[kind].title} is ready`,
    body: `${count} suggested ${count === 1 ? "change" : "changes"} from ${HEADINGS[kind].item}. Open the report; to apply them, ask for a workspace.`,
    navTarget: { type: "artifact", id: artifact.id },
    dedupeKey: `reflection:${kind}:${week}`,
  });
  return { artifactId: artifact.id, suggestions: count };
}
