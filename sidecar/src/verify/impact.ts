/**
 * Scores how far a pull request's mistakes could spread, from a list of its
 * changes that a reviewing agent classifies. The agent judges each change's
 * kind, reach and evidence; the band comes from the table here, so the same
 * classification always scores the same and the numbers can be tuned in one
 * place. Both verification reports use it: `/verify-pr`'s (`scripts/verify/
 * report.ts`), where the band can raise the verdict, and the PR workspace's
 * (`reviewWorkspaces/verification.ts`).
 *
 * This is separate from the risk tier in `scripts/verify/tier.ts`, which asks
 * whether a safeguard needs a person to check it. This asks how likely the PR
 * is to break something, and how much would break.
 */

/**
 * What a change does, from least to most likely to break something. A change
 * where any existing input can now behave differently is `logic`, whatever
 * else it looks like.
 */
export const CHANGE_KINDS = [
  "passive",
  "reorganization",
  "addition",
  "removal",
  "interface",
  "logic",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** How much code depends on the changed thing, by its own users, not its file's. */
export const REACHES = ["leaf", "local", "shared", "core"] as const;
export type Reach = (typeof REACHES)[number];

/**
 * Whether tests or analysis show the change does what it should. What counts
 * as proof depends on the kind: unchanged behaviour for a reorganization,
 * every caller updated and tested for an interface, tests that fail without
 * the change for logic.
 */
export const EVIDENCE = ["proven", "partial", "unproven"] as const;
export type Evidence = (typeof EVIDENCE)[number];

export type ImpactBand = 1 | 2 | 3 | 4 | 5;

export const BAND_LABELS: Record<ImpactBand, string> = {
  1: "minimal",
  2: "low",
  3: "moderate",
  4: "high",
  5: "very high",
};

export interface ClassifiedChange {
  kind: ChangeKind;
  reach: Reach;
  evidence: Evidence;
  /** Touches secrets, permissions, what an agent may do, or deletes or migrates data. */
  sensitive?: boolean;
  /** How many like changes this entry stands for, so twelve small additions can be one entry. */
  count?: number;
}

/** The band for each kind, by reach: leaf, local, shared, core. */
const BAND_TABLE: Record<ChangeKind, readonly [ImpactBand, ImpactBand, ImpactBand, ImpactBand]> = {
  passive: [1, 1, 1, 1],
  reorganization: [1, 1, 2, 2],
  addition: [1, 2, 2, 3],
  removal: [1, 2, 3, 3],
  interface: [2, 2, 3, 4],
  logic: [2, 3, 4, 4],
};

const clampBand = (band: number): ImpactBand => Math.min(5, Math.max(1, band)) as ImpactBand;

/**
 * One change's band: the table, then at most one step for evidence and one for
 * sensitive ground. A passive change or a proven reorganization behaves as
 * before, so neither moves, wherever it is.
 */
export function changeBand(change: ClassifiedChange): ImpactBand {
  // A move nobody showed to be a move might change behaviour, so it scores as one that does.
  if (change.kind === "reorganization" && change.evidence !== "proven") {
    return changeBand({ ...change, kind: "logic" });
  }
  let band: number = BAND_TABLE[change.kind][REACHES.indexOf(change.reach)];
  if (change.kind === "passive" || change.kind === "reorganization") return clampBand(band);

  if (change.evidence === "unproven") {
    band += 1;
  } else if (change.evidence === "proven" && change.kind !== "interface" && band > 2) {
    // Tests lower a band only down to 2, since a tested logic change is still riskier than one
    // that changes nothing. Never for an interface: they don't show callers elsewhere still work.
    band -= 1;
  }

  if (change.sensitive) band += 1;
  return clampBand(band);
}

/**
 * Each band's share of the chance that a PR breaks something. Shipping many
 * changes at once adds those chances up, and makes a bad deploy harder to
 * trace and revert than the same changes merged one at a time. Passive
 * changes add nothing, so a sweeping rename stays minimal.
 */
const LOAD_WEIGHT: Record<ImpactBand, number> = { 1: 0, 2: 1, 3: 2, 4: 4, 5: 4 };

/**
 * Loads at which the volume of change raises the PR's band, highest first,
 * since `scoreImpact` takes the first one reached. Two high-band changes make
 * a load of 8, which is how touching several core pieces becomes very high.
 * These are first guesses, to tune against reverts.
 */
const VOLUME_STEPS: readonly { load: number; raise: number }[] = [
  { load: 16, raise: 2 },
  { load: 8, raise: 1 },
];

/**
 * Volume alone raises a PR no further than this. Very high needs at least
 * one change that is high on its own, so a pile of small changes reaches the
 * agent reviewer but not a person.
 */
const VOLUME_ONLY_CEILING: ImpactBand = 4;

/** At and above this band a change is listed for a reviewer's attention. */
export const ATTENTION_BAND: ImpactBand = 4;

export interface Impact<T extends ClassifiedChange> {
  /** The PR's band: its highest change band, raised by volume. */
  band: ImpactBand;
  /** The highest band any one change has. */
  highestChangeBand: ImpactBand;
  load: number;
  /** How many bands volume added. Non-zero means splitting the PR would lower it. */
  raisedByVolume: number;
  /** Every change with its band, highest first. */
  changes: (T & { band: ImpactBand })[];
  /** Changes at or above {@link ATTENTION_BAND}, highest first. */
  attention: (T & { band: ImpactBand })[];
  /** How many changes of each kind, counting `count`, for the one-line summary. */
  counts: Record<ChangeKind, number>;
}

/** Scores a PR's changes, or `null` when there are none to score. */
export function scoreImpact<T extends ClassifiedChange>(changes: readonly T[]): Impact<T> | null {
  if (changes.length === 0) return null;
  const scored = changes
    .map((change) => ({ ...change, band: changeBand(change) }))
    .sort((a, b) => b.band - a.band);
  const top = scored[0].band;
  const counts = Object.fromEntries(CHANGE_KINDS.map((kind) => [kind, 0])) as Record<
    ChangeKind,
    number
  >;
  let load = 0;
  for (const change of scored) {
    const count = Math.max(1, change.count ?? 1);
    counts[change.kind] += count;
    load += LOAD_WEIGHT[change.band] * count;
  }
  const raise = VOLUME_STEPS.find((step) => load >= step.load)?.raise ?? 0;
  const ceiling = top >= ATTENTION_BAND ? 5 : VOLUME_ONLY_CEILING;
  const band = clampBand(Math.min(ceiling, top + raise));
  return {
    band,
    highestChangeBand: top,
    load,
    raisedByVolume: band - top,
    changes: scored,
    attention: scored.filter((change) => change.band >= ATTENTION_BAND),
    counts,
  };
}

const KIND_NAMES: Record<ChangeKind, [one: string, many: string]> = {
  passive: ["passive", "passive"],
  reorganization: ["reorganization", "reorganizations"],
  addition: ["addition", "additions"],
  removal: ["removal", "removals"],
  interface: ["interface change", "interface changes"],
  logic: ["logic change", "logic changes"],
};

/** "6 passive, 2 reorganizations, 1 addition": the kinds in a PR, for a summary line. */
export function describeCounts(counts: Record<ChangeKind, number>): string {
  return CHANGE_KINDS.filter((kind) => counts[kind] > 0)
    .map((kind) => `${counts[kind]} ${KIND_NAMES[kind][counts[kind] === 1 ? 0 : 1]}`)
    .join(", ");
}
