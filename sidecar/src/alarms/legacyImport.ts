import { readFile, rename } from "node:fs/promises";
import type { Config } from "../config.ts";
import { type Db, getDb } from "../db/client.ts";
import { type AlarmRow, alarms } from "../db/schema.ts";
import { redactSecrets } from "../llm/errors.ts";

/**
 * One-time copy of the alarms the Rust core kept in its own `alarms.json`
 * before the sidecar owned them. The core passes the file's path as
 * `YARVIS_LEGACY_ALARMS_PATH`. Once copied, the file is renamed rather than
 * deleted, so nothing is lost if the copy turns out wrong.
 */

const STATUSES: ReadonlySet<string> = new Set(["scheduled", "fired", "acknowledged", "cancelled"]);

/** The route's own limit on a label. */
const MAX_LABEL_CHARS = 300;

interface LegacyAlarm {
  label: string;
  fireAtMs: number;
  sound?: boolean;
  meetLink?: string | null;
  status: AlarmRow["status"];
}

function isLegacyAlarm(value: unknown): value is LegacyAlarm {
  const v = value as Partial<LegacyAlarm> | null;
  return (
    typeof v?.label === "string" &&
    typeof v.fireAtMs === "number" &&
    Number.isFinite(v.fireAtMs) &&
    typeof v.status === "string" &&
    STATUSES.has(v.status) &&
    (v.sound === undefined || typeof v.sound === "boolean") &&
    (v.meetLink === undefined ||
      v.meetLink === null ||
      (typeof v.meetLink === "string" && /^https?:\/\//i.test(v.meetLink)))
  );
}

/** Imports the file at `path` if there is one, and returns how many alarms it held. */
export async function importLegacyAlarms(db: Db, path: string): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return 0;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("[alarms] the old alarms.json doesn't parse; leaving it in place");
    return 0;
  }
  const legacy = Array.isArray(parsed) ? parsed.filter(isLegacyAlarm) : [];
  // The rename happens inside the transaction, so a rename that fails rolls the
  // copy back, and the next start can't copy the same alarms twice.
  await db.transaction(async (tx) => {
    if (legacy.length > 0) {
      // Stamped a millisecond apart, ending now: the list shows creation order,
      // which the file kept as array order.
      const base = Date.now() - legacy.length;
      await tx.insert(alarms).values(
        legacy.map((a, i) => ({
          label: a.label.slice(0, MAX_LABEL_CHARS),
          fireAt: new Date(a.fireAtMs),
          sound: a.sound ?? true,
          meetLink: a.meetLink ?? null,
          status: a.status,
          source: "app" as const,
          createdAt: new Date(base + i),
        })),
      );
    }
    await rename(path, `${path}.imported`);
  });
  return legacy.length;
}

/**
 * Runs the import at startup when the core passed a path. Every instance had
 * its own alarms.json, so each copies its own, background workers or not.
 */
export async function importLegacyAlarmsOnStart(config: Config): Promise<void> {
  const path = process.env.YARVIS_LEGACY_ALARMS_PATH;
  if (!path || !config.databaseUrl) return;
  try {
    const count = await importLegacyAlarms(getDb(config.databaseUrl).db, path);
    if (count > 0) console.log(`[sidecar] imported ${count} alarms from alarms.json`);
  } catch (e) {
    console.error("[sidecar] alarm import failed:", redactSecrets(String(e)));
  }
}
