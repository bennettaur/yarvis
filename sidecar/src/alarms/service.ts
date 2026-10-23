import { and, asc, desc, eq, inArray, lte, min } from "drizzle-orm";
import { hasCoreChannel, releaseAlarm } from "../core/controlClient.ts";
import type { Db } from "../db/client.ts";
import { type AlarmRow, alarms } from "../db/schema.ts";
import { publish } from "./hub.ts";

/**
 * Alarm state. The sidecar owns the list and decides when an alarm is due
 * (`scheduler.ts`); the Rust core rings it and takes over the window.
 */

/** An alarm as the app and the core see it, with the fire time in epoch ms. */
export interface Alarm {
  id: string;
  label: string;
  fireAtMs: number;
  sound: boolean;
  meetLink: string | null;
  status: AlarmRow["status"];
  source: AlarmRow["source"];
}

export function toAlarm(row: AlarmRow): Alarm {
  return {
    id: row.id,
    label: row.label,
    fireAtMs: row.fireAt.getTime(),
    sound: row.sound,
    meetLink: row.meetLink,
    status: row.status,
    source: row.source,
  };
}

/**
 * A meeting alarm's label and lead time. `src/lib/calendarAlarms.ts` uses the
 * same ones, so the calendar shows an alarm an agent set as already set.
 */
export const MEETING_LABEL_PREFIX = "Meeting: ";
export const MEETING_LEAD_MINUTES = 1;
/** How far apart two fire times can be and still be the same meeting's alarm. */
const MEETING_FIRE_TOLERANCE_MS = 90_000;

/** The list is a history too; past this many, only the newest show. */
const MAX_LISTED = 500;

/** Every alarm, newest `MAX_LISTED`, in creation order. */
export async function listAlarms(db: Db): Promise<AlarmRow[]> {
  const rows = await db.select().from(alarms).orderBy(desc(alarms.createdAt)).limit(MAX_LISTED);
  return rows.reverse();
}

/** Alarms still to ring or ringing now, soonest first. */
export async function listPendingAlarms(db: Db): Promise<AlarmRow[]> {
  return db
    .select()
    .from(alarms)
    .where(inArray(alarms.status, ["scheduled", "fired"]))
    .orderBy(asc(alarms.fireAt));
}

export async function getAlarm(db: Db, id: string): Promise<AlarmRow | null> {
  const [row] = await db.select().from(alarms).where(eq(alarms.id, id));
  return row ?? null;
}

export interface NewAlarm {
  label: string;
  fireAt: Date;
  sound?: boolean;
  meetLink?: string | null;
  source: AlarmRow["source"];
}

export async function createAlarm(db: Db, input: NewAlarm): Promise<AlarmRow> {
  const [row] = await db
    .insert(alarms)
    .values({
      label: input.label,
      fireAt: input.fireAt,
      sound: input.sound ?? true,
      meetLink: input.meetLink ?? null,
      source: input.source,
    })
    .returning();
  publish({ type: "changed" });
  return row!;
}

export function meetingAlarmLabel(title: string): string {
  return `${MEETING_LABEL_PREFIX}${title}`;
}

/** When a meeting starting at `start` should ring. */
export function meetingFireAt(start: Date): Date {
  return new Date(start.getTime() - MEETING_LEAD_MINUTES * 60_000);
}

/** A scheduled alarm already set for this meeting, matched the way the calendar matches it. */
export async function findMeetingAlarm(
  db: Db,
  label: string,
  fireAt: Date,
): Promise<AlarmRow | null> {
  const rows = await db
    .select()
    .from(alarms)
    .where(and(eq(alarms.status, "scheduled"), eq(alarms.label, label)));
  return (
    rows.find((r) => Math.abs(r.fireAt.getTime() - fireAt.getTime()) < MEETING_FIRE_TOLERANCE_MS) ??
    null
  );
}

/**
 * Moves an alarm to `status`, or back to scheduled at `fireAt` for a snooze,
 * and stops it ringing on the core if it was. Null when there is no such alarm.
 */
async function settle(
  db: Db,
  id: string,
  change: { status: AlarmRow["status"]; fireAt?: Date },
): Promise<AlarmRow | null> {
  const before = await getAlarm(db, id);
  if (!before) return null;
  const [row] = await db
    .update(alarms)
    .set({ ...change, updatedAt: new Date() })
    .where(eq(alarms.id, id))
    .returning();
  // The webview releases a ringing alarm itself too, so a sidecar that can't
  // reach the core only leaves this one to it.
  if (before.status === "fired" && hasCoreChannel()) {
    await releaseAlarm(id).catch((e) =>
      console.error("[alarms] releasing on the core failed:", e instanceof Error ? e.message : e),
    );
  }
  publish({ type: "changed" });
  return row ?? null;
}

export function acknowledgeAlarm(db: Db, id: string): Promise<AlarmRow | null> {
  return settle(db, id, { status: "acknowledged" });
}

export function cancelAlarm(db: Db, id: string): Promise<AlarmRow | null> {
  return settle(db, id, { status: "cancelled" });
}

export function snoozeAlarm(db: Db, id: string, minutes: number): Promise<AlarmRow | null> {
  return settle(db, id, {
    status: "scheduled",
    fireAt: new Date(Date.now() + minutes * 60_000),
  });
}

/**
 * Marks every scheduled alarm due by `now` as fired and returns them. One
 * update, so two sidecars sharing a database can't both ring the same alarm.
 */
export async function claimDueAlarms(db: Db, now: Date): Promise<AlarmRow[]> {
  return db
    .update(alarms)
    .set({ status: "fired", updatedAt: now })
    .where(and(eq(alarms.status, "scheduled"), lte(alarms.fireAt, now)))
    .returning();
}

/** When the next scheduled alarm is due, or null when none is. */
export async function nextDueAt(db: Db): Promise<Date | null> {
  const [row] = await db
    .select({ at: min(alarms.fireAt) })
    .from(alarms)
    .where(eq(alarms.status, "scheduled"));
  return row?.at ?? null;
}
