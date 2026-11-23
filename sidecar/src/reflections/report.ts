import { z } from "zod";
import { createArtifact, listArtifacts, updateArtifact } from "../artifacts/service.ts";
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

/**
 * One line of plain text. The model writes it after reading other people's
 * comments, so a newline (a heading of its own), a link or an image can't get
 * into the rendered report.
 */
const boundedText = (max: number) =>
  z
    .string()
    .transform((v) => v.replace(/\s+/g, " ").trim())
    .pipe(
      z
        .string()
        .min(1)
        .max(max)
        .refine((v) => !/https?:\/\/|\]\(|!\[/i.test(v), "links aren't allowed"),
    );

export const reflectionReportSchema = z.object({
  summary: boundedText(1500).describe("What the week showed, in a few sentences"),
  suggestions: z
    .array(
      z.object({
        target: z.enum(SUGGESTION_TARGETS),
        change: boundedText(800).describe("The concrete edit: what to add, remove or reword"),
        evidence: boundedText(800).describe(
          "The PRs and comments that show it, as owner/repo#number",
        ),
      }),
    )
    .max(15),
  noise: z
    .array(
      z.object({
        flag: boundedText(300).describe("The kind of flag verification raised"),
        evidence: boundedText(500).describe("How often and on which PRs it went unanswered"),
      }),
    )
    .max(10)
    .optional()
    .describe("Review reflection only: flags the user ignored, likely noise"),
});

export type ReflectionReport = z.infer<typeof reflectionReportSchema>;

const HEADINGS: Record<ReflectionKind, { title: string; source: string }> = {
  review: {
    title: "Review reflection",
    source: "what verification missed in your reviews",
  },
  generation: {
    title: "Generation reflection",
    source: "what reviewers caught in your merged PRs",
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
    "These suggestions were written by a model from other people's comments, so check each against the PRs before applying it. Nothing has been changed. To apply them, ask Yarvis to open a workspace on the repo and make these edits; you review the diff before anything is pushed.",
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
  const title = `${HEADINGS[kind].title}: week of ${week}`;
  const content = renderReflection(kind, report, week);
  // One report per kind and week, so a second save replaces the first.
  const existing = (await listArtifacts(db, { titleContains: title })).find(
    (a) => a.title === title && a.createdBy === "heads-down",
  );
  const artifact =
    (existing &&
      (await updateArtifact(db, existing.id, {
        content,
        writer: "heads-down",
        untrusted: true,
      }))) ||
    (await createArtifact(db, { title, content, writer: "heads-down", untrusted: true }));
  const count = report.suggestions.length;
  await raiseAttention(db, {
    category: "general",
    kind: "message",
    title: `${HEADINGS[kind].title} is ready`,
    body: `${count} suggested ${count === 1 ? "change" : "changes"} from ${HEADINGS[kind].source}. Open the report; to apply them, ask for a workspace.`,
    navTarget: { type: "artifact", id: artifact.id },
    dedupeKey: `reflection:${kind}:${week}`,
  });
  return { artifactId: artifact.id, suggestions: count };
}

/** Targets only the generation reflection proposes: they are about code the user wrote, not about reviews. */
const GENERATION_ONLY_TARGETS: readonly string[] = ["repo AGENTS.md", "Claude instructions"];

/** Why a report doesn't fit its kind, or null. */
export function kindProblem(kind: ReflectionKind, report: ReflectionReport): string | null {
  if (kind === "review") {
    if (report.suggestions.some((s) => GENERATION_ONLY_TARGETS.includes(s.target))) {
      return "a review reflection suggests changes to verification, not to AGENTS.md or instructions";
    }
    return null;
  }
  return report.noise?.length ? "noise belongs to the review reflection" : null;
}
