import { raiseAttention, resolveRaisedAttention } from "../attention/raise.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { SHIP_STAGES, type ShipStage, type WorkStream, type WorkStreamShip } from "../db/schema.ts";
import { prSourceFor } from "../pr/source.ts";
import type { PlaybookKey, RepoPlaybooks } from "../workspaces/playbooks.ts";
import { listRepos } from "../workspaces/service.ts";
import { type UpdateStreamInput, updateStream } from "./service.ts";

/**
 * Ship streams: a work stream that carries one GitHub PR from CI to
 * production through fixed stages. The stage, and how each stage ended, are
 * recorded here so the Heads down page can show them. A pass reports the
 * current stage done or failed and the next stage is decided in code, so it
 * can't report stages out of order. Whether a stage really passed is the
 * pass's word, except the merge, which is checked against GitHub. Merging,
 * deploying and reverting still go through the pass's approval rules
 * (`headsDown/policy.ts`); nothing here runs them.
 */

/** The playbook prompt each stage follows. A stage with one is skipped when the prompt is empty. */
const STAGE_PLAYBOOK: Partial<Record<ShipStage, PlaybookKey>> = {
  staging_test: "testStaging",
  deploy: "deploy",
  monitor_deploy: "monitorDeploy",
  monitor_production: "monitorProduction",
  test_production: "testProduction",
};

/** Stages after the merge: what goes wrong here is live, so a failure proposes a revert. */
export const AFTER_MERGE_STAGES: readonly ShipStage[] = [
  "deploy",
  "monitor_deploy",
  "monitor_production",
  "test_production",
];

/** Stages a pass checks on a cadence rather than finishing in one go. */
const MONITOR_STAGES: ReadonlySet<ShipStage> = new Set(["monitor_deploy", "monitor_production"]);

/** Mirrored by `SHIP_STAGE_LABEL` in src/components/headsDown/StreamList.tsx. */
const SHIP_STAGE_LABEL: Record<ShipStage, string> = {
  ci: "CI",
  reviewer: "Reviewer",
  feedback: "Review feedback",
  staging_test: "Staging test",
  merge: "Merge",
  deploy: "Deploy",
  monitor_deploy: "Watch deploy",
  monitor_production: "Watch production",
  test_production: "Production test",
  done: "Done",
};

/** The next step a stage means, as the stream's next action. App-written, so it is safe to show. */
const STAGE_NEXT: Record<ShipStage, string> = {
  ci: "Get CI green",
  reviewer: "Request a review",
  feedback: "Get the review feedback addressed",
  staging_test: "Test the change in staging",
  merge: "Merge the PR",
  deploy: "Run the deploy steps",
  monitor_deploy: "Watch the deploy until it finishes",
  monitor_production: "Watch production",
  test_production: "Test the change in production",
  done: "Shipped",
};

/** Kept so a stream row stays small; the oldest lines go first. */
const MAX_SHIP_LOG_ENTRIES = 50;
export const MAX_SHIP_LOG_CHARS = 1000;

const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const PR_REF = /^([\w-]+)\/([\w.-]+)#(\d+)$/;

/** A GitHub PR from `owner/repo#N` or its URL; null for anything else. */
export function parseShipPr(input: string): { repo: string; number: number; url: string } | null {
  const text = input.trim();
  const match = PR_URL.exec(text) ?? PR_REF.exec(text);
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const repo = `${match[1]}/${match[2]}`;
  return { repo, number, url: `https://github.com/${repo}/pull/${number}` };
}

export function initialShip(pr: { repo: string; number: number; url: string }): WorkStreamShip {
  return { ...pr, stage: "ci", stages: {}, log: [] };
}

export function shipNextAction(stage: ShipStage): string {
  return STAGE_NEXT[stage];
}

/** The attention item a failed stage raises, one per stream and stage. */
export function shipAttentionKey(streamId: string, stage: ShipStage): string {
  return `ship:${streamId}:${stage}`;
}

/**
 * The repo's playbook, or null when no registered repo matches: then nothing
 * is known about which steps the user wants, so no stage is skipped for them.
 */
async function playbookFor(db: Db, repo: string): Promise<RepoPlaybooks | null> {
  const wanted = repo.toLowerCase();
  const match = (await listRepos(db)).find((r) => `${r.owner}/${r.repo}`.toLowerCase() === wanted);
  return match ? match.playbooks : null;
}

/** The first stage from `index` on that has work to do, and the playbook stages passed over. */
function firstStageToRun(
  index: number,
  playbook: RepoPlaybooks | null,
): { stage: ShipStage; autoSkipped: ShipStage[] } {
  const autoSkipped: ShipStage[] = [];
  for (const stage of SHIP_STAGES.slice(index)) {
    const playbookKey = STAGE_PLAYBOOK[stage];
    if (stage === "done" || !playbookKey || !playbook || playbook[playbookKey]) {
      return { stage, autoSkipped };
    }
    autoSkipped.push(stage);
  }
  return { stage: "done", autoSkipped };
}

/** Whether the PR is merged, read live from GitHub, or why it couldn't be read. */
export type MergedCheck = (pr: {
  repo: string;
  number: number;
}) => Promise<{ merged: boolean } | { error: string }>;

/** Reads the PR from GitHub with the user's token. GitHub's GraphQL state is OPEN, CLOSED or MERGED. */
export function githubMergedCheck(config: Pick<Config, "secrets" | "endpoints">): MergedCheck {
  return async ({ repo, number }) => {
    const [owner = "", name = ""] = repo.split("/");
    const source = prSourceFor(config, { provider: "github", owner, repo: name, number });
    if ("error" in source) return { error: source.error };
    return { merged: (await source.detail()).state.toUpperCase() === "MERGED" };
  };
}

export interface ShipUpdateInput {
  /** The stage the pass believes is current, so a stale read can't finish the wrong one. */
  stage: ShipStage;
  outcome?: "done" | "skipped" | "failed";
  /** What ran and what was seen, appended to the ship log. */
  log?: string;
  waitingOn?: string | null;
}

export interface ShipSettings {
  monitorWindowMinutes: number;
  checkEveryMinutes: number;
}

export interface ShipUpdateOptions {
  now?: Date;
  /** Leaves a stream the user paused untouched. */
  unlessPaused?: boolean;
  /** Absent, the merge stage can't be left, since nothing can confirm the merge. */
  checkMerged?: MergedCheck;
}

export type ShipUpdateResult =
  | { error: string }
  | {
      stage: ShipStage;
      /** Stages passed over because the playbook has no step for them. */
      autoSkipped: ShipStage[];
      monitorUntil?: string;
      nextCheckAt?: string;
      note?: string;
    };

function minutesFrom(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

function appendLog(ship: WorkStreamShip, stage: ShipStage, text: string, now: Date) {
  const entry = { at: now.toISOString(), stage, text: text.slice(0, MAX_SHIP_LOG_CHARS) };
  return [...ship.log, entry].slice(-MAX_SHIP_LOG_ENTRIES);
}

/**
 * Records progress on a ship stream's current stage. `done` moves to the next
 * stage, passing over playbook stages the user left empty; `failed` keeps the
 * stage, puts the stream on the user and raises an attention item; no outcome
 * only adds to the log. The merge stage is left only once GitHub shows the PR
 * merged, and production monitoring only once its window ends.
 */
export async function updateShipStage(
  db: Db,
  stream: WorkStream,
  input: ShipUpdateInput,
  settings: ShipSettings,
  { now = new Date(), unlessPaused = false, checkMerged }: ShipUpdateOptions = {},
): Promise<ShipUpdateResult> {
  const ship = stream.ship;
  if (!ship) return { error: "this work stream isn't shipping a PR" };
  if (ship.stage === "done") return { error: "this PR has already shipped" };
  // Only the user reopens a closed stream; reporting a stage would bring it back.
  if (stream.status === "done" || stream.status === "dropped") {
    return { error: "this work stream is closed" };
  }
  if (input.stage !== ship.stage) {
    return { error: `the stream is at stage ${ship.stage}, not ${input.stage}` };
  }
  const stage = ship.stage;
  const afterMerge = AFTER_MERGE_STAGES.includes(stage);
  const finishing = input.outcome === "done" || input.outcome === "skipped";
  let updatedShip: WorkStreamShip = {
    ...ship,
    log: input.log ? appendLog(ship, stage, input.log, now) : ship.log,
  };
  const patch: UpdateStreamInput = {};
  if (input.waitingOn !== undefined) patch.waitingOn = input.waitingOn;
  const result: Exclude<ShipUpdateResult, { error: string }> = { stage, autoSkipped: [] };
  let attention: "raise" | "resolve" | null = null;
  const playbook = finishing ? await playbookFor(db, ship.repo) : null;

  if (input.outcome === "skipped") {
    const playbookKey = STAGE_PLAYBOOK[stage];
    if (!playbookKey) {
      return { error: `${stage} can't be skipped; mark it done with a log saying why` };
    }
    if (playbook?.[playbookKey]) {
      return { error: `the playbook has a ${playbookKey} step for this repo; follow it` };
    }
  }
  if (
    finishing &&
    stage === "monitor_production" &&
    ship.monitorUntil &&
    now < new Date(ship.monitorUntil)
  ) {
    return {
      error: `keep watching production until ${ship.monitorUntil}; log what you see in the meantime`,
    };
  }
  if (finishing && stage === "merge") {
    const checked = checkMerged
      ? await checkMerged(ship).catch((e: unknown) => ({
          error: e instanceof Error ? e.message : String(e),
        }))
      : { error: "no way to read the PR" };
    if ("error" in checked) {
      return {
        error: `couldn't confirm the PR is merged (${checked.error.slice(0, 200)}); try again later or ask the user`,
      };
    }
    if (!checked.merged) return { error: "the PR isn't merged yet" };
  }

  if (input.outcome === "failed") {
    updatedShip.stages = {
      ...ship.stages,
      [stage]: { status: "failed", at: now.toISOString(), note: input.log },
    };
    patch.status = "waiting-on-user";
    // A failure always names the user, even when the pass sent an empty waitingOn.
    patch.waitingOn ??= `You: ${SHIP_STAGE_LABEL[stage].toLowerCase()} failed on ${ship.repo}#${ship.number}`;
    attention = "raise";
    if (afterMerge) {
      result.note =
        "Propose a revert: read the playbook's revert step with get_repo_playbook and make the revert call it describes, as an instruction to the PR's workspace or a revert tool. A revert waits for the user's approval; if the call runs straight away instead, say so in finish_pass's notes. With no revert step, ask the user with ask_user.";
    }
  } else if (finishing && input.outcome) {
    // After the merge a failure was a production alarm, so its alert stays for the user to clear.
    if (ship.stages[stage]?.status === "failed" && !afterMerge) attention = "resolve";
    const stages = {
      ...ship.stages,
      [stage]: { status: input.outcome, at: now.toISOString(), note: input.log },
    };
    const next = firstStageToRun(SHIP_STAGES.indexOf(stage) + 1, playbook);
    for (const skipped of next.autoSkipped) {
      stages[skipped] = {
        status: "skipped",
        at: now.toISOString(),
        note: "No playbook step for this stage.",
      };
    }
    updatedShip = { ...updatedShip, stage: next.stage, stages };
    result.stage = next.stage;
    result.autoSkipped = next.autoSkipped;
    patch.nextAction = shipNextAction(next.stage);
    if (input.waitingOn === undefined) patch.waitingOn = null;
    patch.status = next.stage === "done" ? "done" : "active";
    if (next.stage === "monitor_production") {
      updatedShip.monitorStartedAt = now.toISOString();
      updatedShip.monitorUntil = minutesFrom(now, settings.monitorWindowMinutes).toISOString();
      result.monitorUntil = updatedShip.monitorUntil;
    }
  }

  // A monitored stage is looked at again on the cadence, not on every pass.
  if (MONITOR_STAGES.has(updatedShip.stage) && input.outcome !== "failed") {
    const nextCheck = minutesFrom(now, settings.checkEveryMinutes);
    patch.wakeAt = nextCheck;
    result.nextCheckAt = nextCheck.toISOString();
  } else if (finishing) {
    patch.wakeAt = null;
  }

  const updated = await updateStream(
    db,
    stream.id,
    { ...patch, ship: updatedShip },
    { unlessPaused, expectedShip: ship },
  );
  if (!updated) {
    return { error: "the stream changed since you read it, or was paused; read it again" };
  }

  const attentionKey = shipAttentionKey(stream.id, stage);
  if (attention === "raise") {
    // The title is fixed text: the repo name came from a model and could say anything.
    await raiseAttention(db, {
      category: "build",
      kind: "action",
      title: `Ship stage failed: ${SHIP_STAGE_LABEL[stage]}`,
      body: `${ship.repo}#${ship.number}${input.log ? `\n\nHeads down reported: ${input.log}` : ""}`,
      navTarget: { type: "heads-down" },
      dedupeKey: attentionKey,
    });
  } else if (attention === "resolve") {
    await resolveRaisedAttention(db, attentionKey);
  }
  return result;
}
