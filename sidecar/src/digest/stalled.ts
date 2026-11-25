import { desc, eq } from "drizzle-orm";
import { raiseAttention, raisedSessionKey, resolveRaisedAttention } from "../attention/raise.ts";
import type { Db } from "../db/client.ts";
import {
  ATTENTION_CATEGORIES,
  type AttentionCategory,
  attentionItems,
  type StallReminder,
  stallReminders,
} from "../db/schema.ts";
import { getHeadsDownConfig, isWithinWorkingHours } from "../headsDown/config.ts";
import type { JobDefinition } from "../jobs/scheduler.ts";
import { readSection } from "../settings/store.ts";
import { type DanglingItem, type DanglingKind, findDanglingWork } from "./service.ts";

/**
 * Reminders about work the user started and left: a review they opened and
 * never commented on or signed off, a prepared review they never opened, a
 * heads-down question nobody answered. What counts as left comes from
 * `findDanglingWork`, which marks the items that can stall with when they
 * started waiting; this only decides when to remind.
 *
 * A reminder goes out once an item has waited its category's threshold, and
 * only in working hours. The next waits three times as long as the gap before
 * it, and there are at most three. Dismissing a reminder stops them for that
 * item; "not doing this" to the assistant records a dismissal, which drops the
 * item from the dangling work altogether.
 */

export interface StalledWorkConfig {
  enabled: boolean;
  /** Hours an item waits before its first reminder, by attention category. */
  thresholdHours: Record<AttentionCategory, number>;
}

export const DEFAULT_STALLED_WORK_CONFIG: StalledWorkConfig = {
  enabled: true,
  thresholdHours: { review: 24, build: 48, slack: 8, general: 24 },
};

const SETTINGS_KEY = "stalledWork";

/** A hand-edited threshold below an hour would remind about work the user is still doing. */
const MIN_THRESHOLD_HOURS = 1;
const MAX_THRESHOLD_HOURS = 24 * 30;

export async function getStalledWorkConfig(): Promise<StalledWorkConfig> {
  const stored = await readSection<Partial<StalledWorkConfig>>(SETTINGS_KEY).catch(() => undefined);
  const thresholds = { ...DEFAULT_STALLED_WORK_CONFIG.thresholdHours };
  for (const category of ATTENTION_CATEGORIES) {
    const raw = stored?.thresholdHours?.[category];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      thresholds[category] = Math.min(MAX_THRESHOLD_HOURS, Math.max(MIN_THRESHOLD_HOURS, raw));
    }
  }
  return {
    enabled:
      typeof stored?.enabled === "boolean" ? stored.enabled : DEFAULT_STALLED_WORK_CONFIG.enabled,
    thresholdHours: thresholds,
  };
}

/** How much longer each reminder waits than the gap before it. */
const BACKOFF_FACTOR = 3;
const MAX_REMINDERS = 3;

const HOUR_MS = 60 * 60 * 1000;

const stalledAttentionKey = (itemKey: string) => `stalled:${itemKey}`;

/** The kinds whose items come from GitHub, and vanish when it can't be read. */
const PROVIDER_KINDS: DanglingKind[] = ["review-in-progress", "review-requested", "my-pr"];

const TITLES: Partial<Record<DanglingKind, string>> = {
  "review-in-progress": "A review you started is unfinished",
  // A requested review stalls only once the user has opened it.
  "review-requested": "A review you started is unfinished",
  "review-ready": "A prepared review is waiting on you",
  question: "Heads down is still waiting on you",
};

export interface StalledDeps {
  findWork(): ReturnType<typeof findDanglingWork>;
  config?: () => Promise<StalledWorkConfig>;
  now?: () => Date;
}

interface StalledResult {
  reminded: string[];
  /** Items the user stopped reminders for by dismissing one. */
  stopped: string[];
  /** Rows dropped because their item is no longer dangling. */
  cleared: number;
}

export async function runStalledWorkReminders(db: Db, deps: StalledDeps): Promise<StalledResult> {
  const now = deps.now?.() ?? new Date();
  const config = await (deps.config ?? getStalledWorkConfig)();
  const result: StalledResult = { reminded: [], stopped: [], cleared: 0 };
  const rows = new Map((await db.select().from(stallReminders)).map((r) => [r.itemKey, r]));

  for (const row of rows.values()) {
    if (!row.stoppedAt && row.count > 0 && (await reminderDismissed(db, row))) {
      await db
        .update(stallReminders)
        .set({ stoppedAt: now })
        .where(eq(stallReminders.itemKey, row.itemKey));
      row.stoppedAt = now;
      result.stopped.push(row.itemKey);
    }
  }

  const work = await deps.findWork();
  const candidates = work.items.filter(
    (item): item is DanglingItem & { waitingSince: string } => !!item.waitingSince,
  );
  // A row goes only with its item: one still dangling but no longer counted as
  // waiting (its last look fell out of the lookback) keeps its count and stop.
  const present = new Set(work.items.map((item) => item.key));
  const providerDown = work.unavailable.some((source) => source.startsWith("github"));

  for (const row of rows.values()) {
    if (present.has(row.itemKey)) continue;
    if (providerDown && PROVIDER_KINDS.includes(row.kind as DanglingKind)) continue;
    await db.delete(stallReminders).where(eq(stallReminders.itemKey, row.itemKey));
    await resolveRaisedAttention(db, stalledAttentionKey(row.itemKey));
    result.cleared++;
  }

  for (const item of candidates) {
    const waitingSince = new Date(item.waitingSince);
    if (Number.isNaN(waitingSince.getTime())) continue;
    let row = rows.get(item.key);
    if (row?.stoppedAt) continue;
    const cameBack = row !== undefined && waitingSince > row.waitingSince;
    if (row && cameBack) {
      // The earlier reminder is moot, and the count starts over.
      await resolveRaisedAttention(db, stalledAttentionKey(item.key));
      row = { ...row, kind: item.kind, waitingSince, count: 0, lastRemindedAt: null };
    }
    const count = row?.count ?? 0;
    if (count >= MAX_REMINDERS) continue;
    const threshold = config.thresholdHours[item.category ?? "general"] * HOUR_MS;
    const dueAt =
      count === 0 || !row?.lastRemindedAt
        ? waitingSince.getTime() + threshold
        : row.lastRemindedAt.getTime() + threshold * BACKOFF_FACTOR ** count;
    if (now.getTime() < dueAt) {
      if (row && cameBack) await saveRow(db, row);
      continue;
    }
    await raiseAttention(db, {
      category: item.category ?? "general",
      kind: "action",
      title: TITLES[item.kind] ?? "Work waiting on you",
      body: `${item.title}\n${asSentence(item.reason)} Waiting for ${duration(now.getTime() - waitingSince.getTime())}.`,
      dedupeKey: stalledAttentionKey(item.key),
      navTarget: item.navTarget ?? null,
    });
    await saveRow(db, {
      itemKey: item.key,
      kind: item.kind,
      waitingSince,
      count: count + 1,
      lastRemindedAt: now,
      stoppedAt: null,
    });
    result.reminded.push(item.key);
  }
  return result;
}

async function saveRow(db: Db, row: StallReminder): Promise<void> {
  await db
    .insert(stallReminders)
    .values(row)
    .onConflictDoUpdate({ target: stallReminders.itemKey, set: row });
}

/** Whether the user dismissed the latest reminder raised for the row's item. */
async function reminderDismissed(db: Db, row: StallReminder): Promise<boolean> {
  const [latest] = await db
    .select({ status: attentionItems.status })
    .from(attentionItems)
    .where(
      eq(attentionItems.sessionKey, raisedSessionKey("system", stalledAttentionKey(row.itemKey))),
    )
    .orderBy(desc(attentionItems.createdAt))
    .limit(1);
  return latest?.status === "dismissed";
}

function asSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const capitalized = trimmed[0]?.toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

/** A wait in the largest whole unit: "3 days", "5 hours". */
export function duration(ms: number): string {
  const hours = Math.floor(ms / HOUR_MS);
  if (hours >= 48) return `${Math.floor(hours / 24)} days`;
  if (hours >= 24) return "1 day";
  if (hours >= 2) return `${hours} hours`;
  if (hours === 1) return "1 hour";
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export const stalledWorkJob: JobDefinition = {
  name: "stalled-work",
  description:
    "Every 30 minutes in working hours, remind you about reviews you started and left, prepared reviews you haven't opened, and heads-down questions waiting on you.",
  schedule: { kind: "interval", everyMs: 30 * 60 * 1000 },
  run: async ({ db, config, now }) => {
    const [stalled, headsDown] = await Promise.all([getStalledWorkConfig(), getHeadsDownConfig()]);
    if (!stalled.enabled) return { skipped: true, detail: "turned off" };
    if (!isWithinWorkingHours(now, headsDown.workingHours)) {
      return { skipped: true, detail: "outside working hours" };
    }
    const result = await runStalledWorkReminders(db, {
      findWork: () => findDanglingWork(db, config),
      config: async () => stalled,
      now: () => now,
    });
    return {
      skipped: result.reminded.length + result.stopped.length + result.cleared === 0,
      detail: `reminded ${result.reminded.length}, stopped ${result.stopped.length}, cleared ${result.cleared}`,
    };
  },
};
