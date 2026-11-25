/**
 * Which checks review prep runs, from the PR's size. A small PR is quicker to
 * read than to wait for a dozen checks on, so it gets only the summary, risk
 * and malicious-intent checks, plus the repo's own. A big one also gets the flow diagram and the Story walkthrough, so
 * they are ready when the user opens it. Everything else runs the repo's
 * default checks.
 */

import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { describeError } from "../llm/errors.ts";
import { type GuideKickoff, kickOffGuide } from "../pr/guideRun.ts";
import { getGuide } from "../pr/guides.ts";
import type { PrRef } from "../pr/types.ts";
import { CHECKOUT_WAIT_MS, type KickoffDeps } from "../reviewWorkspaces/kickoff.ts";
import { PATCH_LIMITS } from "../reviewWorkspaces/patchFiles.ts";
import {
  type BulkClass,
  getReviewPr,
  resumeIfStalled,
  reviewDiffFacts,
} from "../reviewWorkspaces/service.ts";
import {
  isRepoSection,
  normalizeSections,
  type ReportSection,
  repoVerificationSettings,
} from "../reviewWorkspaces/verification.ts";
import { readSection } from "../settings/store.ts";

export type PrepTier = "small" | "normal" | "big";

/** The size thresholds, at `reviewPrep.sizeTiers` in `~/.yarvis/settings.json`. */
export interface SizeTierThresholds {
  /** At or under both, a PR is small. */
  smallMaxLines: number;
  smallMaxFiles: number;
  /** At or over either, a PR is big. */
  bigMinLines: number;
  bigMinFiles: number;
}

export const DEFAULT_SIZE_TIERS: SizeTierThresholds = {
  smallMaxLines: 20,
  smallMaxFiles: 2,
  bigMinLines: 500,
  bigMinFiles: 10,
};

/**
 * What a small PR runs: what it does, how risky it is, and the
 * malicious-intent check, since a backdoor or a CI change fits in a few lines.
 */
export const SMALL_SECTIONS: readonly ReportSection[] = ["summary", "risk", "malice"];

/** A count a hand-edited setting may hold; anything else falls back to the default. */
function settingCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : fallback;
}

export async function getSizeTierConfig(): Promise<SizeTierThresholds> {
  const stored = await readSection<{
    sizeTiers?: Partial<Record<keyof SizeTierThresholds, unknown>>;
  }>("reviewPrep").catch(() => undefined);
  const raw = stored?.sizeTiers ?? {};
  return {
    smallMaxLines: settingCount(raw.smallMaxLines, DEFAULT_SIZE_TIERS.smallMaxLines),
    smallMaxFiles: settingCount(raw.smallMaxFiles, DEFAULT_SIZE_TIERS.smallMaxFiles),
    bigMinLines: settingCount(raw.bigMinLines, DEFAULT_SIZE_TIERS.bigMinLines),
    bigMinFiles: settingCount(raw.bigMinFiles, DEFAULT_SIZE_TIERS.bigMinFiles),
  };
}

/** A file in a `__snapshots__` folder, or a `.snap` file anywhere. */
const SNAPSHOT_DIR = /(^|\/)__snapshots__\//;
const SNAPSHOT_FILE = /\.snap$/;
/** Drizzle's migration metadata: a journal and one schema snapshot per migration. */
const MIGRATION_META = /(^|\/)meta\/(_journal\.json|\d+_snapshot\.json)$/;

/**
 * Whether a file is generated rather than written: lockfiles and what
 * `bulkKind` already skims, test snapshots, and migration metadata.
 */
export function isGenerated(path: string, bulk?: BulkClass): boolean {
  return (
    !!bulk?.skim || SNAPSHOT_DIR.test(path) || SNAPSHOT_FILE.test(path) || MIGRATION_META.test(path)
  );
}

export interface PrepSize {
  files: number;
  changedLines: number;
  /** Changed files with no text diff, which count no lines however big they are. */
  binary: number;
}

interface SizedFile {
  path: string;
  binary: boolean;
  additions: number;
  deletions: number;
}

/** The PR's size with generated files left out, and with every file in. */
export function measure(
  files: readonly SizedFile[],
  bulk: ReadonlyMap<string, BulkClass>,
): { counted: PrepSize; total: PrepSize } {
  const sum = (list: readonly SizedFile[]): PrepSize => ({
    files: list.length,
    changedLines: list.reduce((n, f) => n + (f.binary ? 0 : f.additions + f.deletions), 0),
    binary: list.filter((f) => f.binary).length,
  });
  return {
    counted: sum(files.filter((f) => !isGenerated(f.path, bulk.get(f.path)))),
    total: sum(files),
  };
}

/**
 * Big goes by the written files alone, so a lockfile's churn doesn't make a
 * PR big. Small goes by every file: generated files don't count toward size,
 * but a PR can't hide its change in a file named like one to skip the checks.
 * A binary change is never small, since its size isn't in the line count.
 */
export function pickTier(
  size: { counted: PrepSize; total: PrepSize },
  thresholds: SizeTierThresholds,
): PrepTier {
  const { counted, total } = size;
  if (counted.changedLines >= thresholds.bigMinLines || counted.files >= thresholds.bigMinFiles) {
    return "big";
  }
  if (
    total.binary === 0 &&
    total.changedLines <= thresholds.smallMaxLines &&
    total.files <= thresholds.smallMaxFiles
  ) {
    return "small";
  }
  return "normal";
}

/**
 * The sections a tier runs, given the repo's defaults. A small PR still runs
 * the repo's own checks the user turned on for it.
 */
export function tierSections(
  tier: PrepTier,
  repoDefaults: readonly ReportSection[],
): ReportSection[] {
  if (tier === "small") {
    return normalizeSections([...SMALL_SECTIONS, ...repoDefaults.filter(isRepoSection)]);
  }
  if (tier === "big") return normalizeSections([...repoDefaults, "flow"]);
  return [...repoDefaults];
}

export interface TierChoice {
  tier: PrepTier;
  sections: ReportSection[];
  /** The size the tier was picked from, generated files left out; null when it couldn't be read. */
  size: PrepSize | null;
}

export interface PrepTierDeps {
  sizeTiers?: () => Promise<SizeTierThresholds>;
  /** Starts the Story walkthrough; tests swap it out. */
  kickOffStory?: (ref: PrRef) => Promise<GuideKickoff>;
  pollMs?: number;
  waitMs?: number;
}

const POLL_MS = 2000;

/**
 * Waits for the PR's commits to be known (which comes before its checkout),
 * then picks its tier. A PR that can't be sized is treated as normal, so it
 * gets the repo's default checks rather than fewer.
 */
export async function choosePrepTier(
  db: Db,
  config: Config,
  where: { workspaceId: string; prId: string },
  kickoff: KickoffDeps,
  deps: PrepTierDeps = {},
): Promise<TierChoice> {
  const pr = await getReviewPr(db, where.workspaceId, where.prId);
  const repo = await (kickoff.verification.repoSettings ?? repoVerificationSettings)(db, pr.ref);
  const normal: TierChoice = {
    tier: "normal",
    sections: tierSections("normal", repo.defaultSections),
    size: null,
  };
  const deadline = Date.now() + (deps.waitMs ?? CHECKOUT_WAIT_MS);
  // A prep requeued after a restart finds its clone stopped; nothing else restarts it.
  await resumeIfStalled(db, config, pr, kickoff.review);
  let current = pr;
  while (current.status !== "ready") {
    if (current.status === "error" || current.worktreeStatus === "error") return normal;
    if (Date.now() > deadline) return normal;
    await Bun.sleep(deps.pollMs ?? POLL_MS);
    current = await getReviewPr(db, where.workspaceId, where.prId);
  }
  try {
    const { files, bulk } = await reviewDiffFacts(
      db,
      config,
      where.workspaceId,
      where.prId,
      kickoff.review,
      PATCH_LIMITS.maxPatchBytes,
    );
    const size = measure(files, bulk);
    const tier = pickTier(size, await (deps.sizeTiers ?? getSizeTierConfig)());
    return { tier, sections: tierSections(tier, repo.defaultSections), size: size.counted };
  } catch (e) {
    console.error("[review-prep] could not size the PR:", describeError(e));
    return normal;
  }
}

/**
 * Starts writing a big PR's Story walkthrough beside its checks, without a
 * bell item of its own: the prep's item says how it went. A PR that already
 * has one keeps it, with the reader's place in it.
 */
export async function startStory(
  db: Db,
  config: Config,
  ref: PrRef,
  deps: PrepTierDeps = {},
): Promise<GuideKickoff> {
  try {
    const started = await (
      deps.kickOffStory ?? ((r) => kickOffGuide(db, config, r, { quiet: true }))
    )(ref);
    if (started.status === "error") {
      console.error("[review-prep] could not start the Story walkthrough:", started.error);
    }
    return started;
  } catch (e) {
    console.error("[review-prep] could not start the Story walkthrough:", describeError(e));
    return { status: "error", error: describeError(e) };
  }
}

/** What the prep's item says about the Story walkthrough, once the checks have ended. */
export async function storyNote(db: Db, ref: PrRef, story: GuideKickoff): Promise<string> {
  if (story.status === "error") {
    return "The Story walkthrough couldn't start; see Settings → Diagnostics.";
  }
  // A guide written for an earlier commit is kept, with the reader's place in it.
  if (story.status === "exists" && story.stale) {
    return "Its Story walkthrough is from an earlier commit; regenerate it from the PR.";
  }
  return (await getGuide(db, ref))
    ? "The Story walkthrough is ready."
    : "The Story walkthrough is still being written.";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The attention item's line saying which tier ran, and what that changed. */
export function tierLine(choice: TierChoice, story: string | null): string {
  const size = choice.size
    ? `${plural(choice.size.changedLines, "changed line", "changed lines")} in ${plural(choice.size.files, "file", "files")}, generated files left out`
    : "size unknown";
  switch (choice.tier) {
    case "small":
      return `Small PR (${size}): only the summary, risk, malicious-intent and the repo's own checks ran, since reading it is quicker.`;
    case "big":
      return `Big PR (${size}): the flow diagram ran too.${story ? ` ${story}` : ""}`;
    default:
      return `Normal PR (${size}): the repo's default checks ran.`;
  }
}
