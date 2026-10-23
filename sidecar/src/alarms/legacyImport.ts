import { readFile, rename } from "node:fs/promises";
import type { Db } from "../db/client.ts";
import { type AlarmRow, alarms } from "../db/schema.ts";

/**
 * One-time copy of the alarms the Rust core kept in its own `alarms.json`
 * before the sidecar owned them. The core passes the file's path as
 * `YARVIS_LEGACY_ALARMS_PATH`. Once copied, the file is renamed rather than
 * deleted, so nothing is lost if the copy turns out wrong.
 */

const STATUSES: ReadonlySet<string> = new Set(["scheduled", "fired", "acknowledged", "cancelled"]);

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
    STATUSES.has(v.status)
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
  if (legacy.length > 0) {
    // The list is shown in creation order, which the file kept as array order.
    const base = Date.now() - legacy.length;
    await db.insert(alarms).values(
      legacy.map((a, i) => ({
        label: a.label,
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
  return legacy.length;
}
