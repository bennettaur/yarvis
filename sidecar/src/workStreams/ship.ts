import { raiseAttention, resolveRaisedAttention } from "../attention/raise.ts";
import type { Db } from "../db/client.ts";
import { SHIP_STAGES, type ShipStage, type WorkStream, type WorkStreamShip } from "../db/schema.ts";
import type { PlaybookKey, RepoPlaybooks } from "../workspaces/playbooks.ts";
import { listRepos } from "../workspaces/service.ts";
import { type UpdateStreamInput, updateStream } from "./service.ts";

/**
 * Ship streams: a work stream that carries one GitHub PR from CI to
 * production through fixed stages. The stage, and how each stage ended, are
 * recorded here so the Heads down page can show them and a pass can't jump
 * ahead: a pass reports the current stage done or failed, and the next stage
 * is decided in code. Merging, deploying and reverting still go through the
 * pass's approval rules (`headsDown/policy.ts`); nothing here runs them.
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
const AFTER_MERGE: ReadonlySet<ShipStage> = new Set([
  "deploy",
  "monitor_deploy",
  "monitor_production",
  "test_production",
]);

/** Stages a pass checks on a cadence rather than finishing in one go. */
const MONITOR_STAGES: ReadonlySet<ShipStage> = new Set(["monitor_deploy", "monitor_production"]);

export const SHIP_STAGE_LABEL: Record<ShipStage, string> = {
  ci: "CI",
  reviewer: "Reviewer",
  feedback: "Review feedback",
  staging_test: "Staging test",
  merge: "Merge",
  deploy: "Deploy",
  monitor_deploy: "Deploy monitoring",
  monitor_production: "Production monitoring",
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
export const MAX_SHIP_LOG_ENTRIES = 50;
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

export function newShip(pr: { repo: string; number: number; url: string }): WorkStreamShip {
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

export type ShipUpdateResult =
  | { error: string }
  | {
      stage: ShipStage;
      /** Stages passed over because the playbook has no step for them. */
      skipped: ShipStage[];
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
 * only adds to the log. Production monitoring can't finish before its window
 * ends. `unlessPaused` leaves a stream the user paused untouched.
 */
export async function updateShipStage(
  db: Db,
  stream: WorkStream,
  input: ShipUpdateInput,
  settings: ShipSettings,
  { now = new Date(), unlessPaused = false }: { now?: Date; unlessPaused?: boolean } = {},
): Promise<ShipUpdateResult> {
  const ship = stream.ship;
  if (!ship) return { error: "this work stream isn't shipping a PR" };
  if (ship.stage === "done") return { error: "this PR has already shipped" };
  if (input.stage !== ship.stage) {
    return { error: `the stream is at stage ${ship.stage}, not ${input.stage}` };
  }
  const stage = ship.stage;
  const label = `${ship.repo}#${ship.number}`;
  let next: WorkStreamShip = {
    ...ship,
    log: input.log ? appendLog(ship, stage, input.log, now) : ship.log,
  };
  const patch: UpdateStreamInput = {};
  if (input.waitingOn !== undefined) patch.waitingOn = input.waitingOn;
  const result: Exclude<ShipUpdateResult, { error: string }> = { stage, skipped: [] };
  let attention: "raise" | "resolve" | null = null;

  if (input.outcome === "skipped") {
    const key = STAGE_PLAYBOOK[stage];
    if (!key) {
      return { error: `${stage} can't be skipped; mark it done with a log saying why` };
    }
    const playbook = await playbookFor(db, ship.repo);
    if (playbook?.[key]) {
      return { error: `the playbook has a ${key} step for this repo; follow it` };
    }
  }

  if (input.outcome === "failed") {
    next.stages = {
      ...ship.stages,
      [stage]: { status: "failed", at: now.toISOString(), note: input.log },
    };
    patch.status = "waiting-on-user";
    patch.waitingOn ??= `You: ${SHIP_STAGE_LABEL[stage].toLowerCase()} failed on ${label}`;
    attention = "raise";
    if (AFTER_MERGE.has(stage)) {
      result.note =
        "Propose a revert: read the playbook's revert step with get_repo_playbook and make the revert call it describes. It always waits for the user's approval, so move on after making it. With no revert step, ask the user with ask_user.";
    }
  } else if (input.outcome === "done" || input.outcome === "skipped") {
    if (
      input.outcome === "done" &&
      stage === "monitor_production" &&
      ship.monitorUntil &&
      now < new Date(ship.monitorUntil)
    ) {
      return {
        error: `keep watching production until ${ship.monitorUntil}; log what you see in the meantime`,
      };
    }
    if (ship.stages[stage]?.status === "failed") attention = "resolve";
    const stages = {
      ...ship.stages,
      [stage]: { status: input.outcome, at: now.toISOString(), note: input.log },
    };
    const playbook = await playbookFor(db, ship.repo);
    let index = SHIP_STAGES.indexOf(stage) + 1;
    for (; index < SHIP_STAGES.length - 1; index++) {
      const key = STAGE_PLAYBOOK[SHIP_STAGES[index]!];
      if (!key || !playbook || playbook[key]) break;
      stages[SHIP_STAGES[index]!] = {
        status: "skipped",
        at: now.toISOString(),
        note: "No playbook step for this stage.",
      };
      result.skipped.push(SHIP_STAGES[index]!);
    }
    const nextStage = SHIP_STAGES[index]!;
    next = { ...next, stage: nextStage, stages };
    result.stage = nextStage;
    patch.nextAction = shipNextAction(nextStage);
    if (input.waitingOn === undefined) patch.waitingOn = null;
    if (nextStage === "done") {
      patch.status = "done";
    } else {
      patch.status = "active";
      if (nextStage === "monitor_production") {
        next.monitorStartedAt = now.toISOString();
        next.monitorUntil = minutesFrom(now, settings.monitorWindowMinutes).toISOString();
        result.monitorUntil = next.monitorUntil;
      }
    }
  }

  // A monitored stage is looked at again on the cadence, not on every pass.
  if (MONITOR_STAGES.has(next.stage) && input.outcome !== "failed") {
    const nextCheck = minutesFrom(now, settings.checkEveryMinutes);
    patch.wakeAt = nextCheck;
    result.nextCheckAt = nextCheck.toISOString();
  } else if (input.outcome === "done" || input.outcome === "skipped") {
    patch.wakeAt = null;
  }

  const updated = await updateStream(db, stream.id, { ...patch, ship: next }, { unlessPaused });
  if (!updated) return { error: "the stream was paused or removed" };

  const key = shipAttentionKey(stream.id, stage);
  if (attention === "raise") {
    await raiseAttention(db, {
      category: "build",
      kind: "action",
      title: `${SHIP_STAGE_LABEL[stage]} failed on ${label}`,
      body: input.log ?? null,
      navTarget: { type: "heads-down" },
      dedupeKey: key,
    });
  } else if (attention === "resolve") {
    await resolveRaisedAttention(db, key);
  }
  return result;
}
