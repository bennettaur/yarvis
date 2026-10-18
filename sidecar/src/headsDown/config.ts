import { readSection, withSection } from "../settings/store.ts";

/**
 * Heads-down settings, stored under the `headsDown` key in
 * `~/.yarvis/settings.json`. Per machine, like the rest of that file, which is
 * the point for working hours: a day-job laptop keeps office hours and a
 * contracting one may tag people at any time.
 */

export interface WorkingHours {
  /** Days of the week it applies to, 0 = Sunday. */
  days: number[];
  /** Start and end as local "HH:MM". An end at or before the start runs past midnight. */
  start: string;
  end: string;
}

export interface HeadsDownConfig {
  /** The shortest and longest the loop sleeps between passes, in minutes. */
  minSleepMinutes: number;
  maxSleepMinutes: number;
  /**
   * The least it sleeps when there is little to do: outside working hours,
   * when every stream is waiting, or when the user hasn't replied for a while.
   */
  idleSleepMinutes: number;
  /**
   * When the user works, and so when it is fine to tag someone in a message.
   * Null means any time.
   */
  workingHours: WorkingHours | null;
  /** How long without a reply before the user counts as away, in minutes. */
  userAwayAfterMinutes: number;
  /**
   * MCP tools a pass may call without asking, by registry id
   * (`mcp:<server>:<tool>`). Auto-approval set in the Tool Manager was given
   * for chats the user is watching, so it doesn't carry over.
   */
  unattendedMcpTools: string[];
  /** The model passes run on. Null uses the default chat model. */
  provider: string | null;
  model: string | null;
}

export const DEFAULT_HEADS_DOWN_CONFIG: HeadsDownConfig = {
  minSleepMinutes: 5,
  maxSleepMinutes: 120,
  idleSleepMinutes: 60,
  workingHours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
  userAwayAfterMinutes: 120,
  unattendedMcpTools: [],
  provider: null,
  model: null,
};

const SETTINGS_KEY = "headsDown";

export async function getHeadsDownConfig(): Promise<HeadsDownConfig> {
  const stored = await readSection<Partial<HeadsDownConfig>>(SETTINGS_KEY);
  return { ...DEFAULT_HEADS_DOWN_CONFIG, ...stored };
}

export async function saveHeadsDownConfig(input: HeadsDownConfig): Promise<HeadsDownConfig> {
  return withSection<HeadsDownConfig, HeadsDownConfig>(SETTINGS_KEY, () => ({
    next: input,
    result: input,
  }));
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Whether `now` falls in working hours, in the machine's local time. A shift
 * that runs past midnight belongs to the day it started on.
 */
export function isWithinWorkingHours(now: Date, hours: WorkingHours | null): boolean {
  if (!hours) return true;
  const minute = now.getHours() * 60 + now.getMinutes();
  const start = minutesOf(hours.start);
  const end = minutesOf(hours.end);
  if (start < end) return hours.days.includes(now.getDay()) && minute >= start && minute < end;
  // Overnight: the evening part is on the start day, the morning part on the next.
  const yesterday = (now.getDay() + 6) % 7;
  return (
    (hours.days.includes(now.getDay()) && minute >= start) ||
    (hours.days.includes(yesterday) && minute < end)
  );
}

export interface SleepInput {
  /** What the pass asked for, in minutes, if anything. */
  requestedMinutes: number | null;
  withinWorkingHours: boolean;
  /** Open streams that are awake now. */
  openStreams: number;
  /** No open stream can be pushed right now: each waits on the user or someone else. */
  allWaiting: boolean;
  userAway: boolean;
}

/**
 * How long to sleep after a pass: what the agent asked for, kept within the
 * configured bounds, and at least the idle sleep when there is little it can
 * do. A message from the user still wakes the loop early.
 */
export function chooseSleep(
  input: SleepInput,
  config: HeadsDownConfig,
): { minutes: number; reason: string } {
  const quiet: string[] = [];
  if (!input.withinWorkingHours) quiet.push("outside working hours");
  if (input.openStreams === 0) quiet.push("nothing to push");
  else if (input.allWaiting) quiet.push("every stream is waiting");
  if (input.userAway) quiet.push("no reply from you lately");

  const floor =
    quiet.length > 0
      ? Math.max(config.minSleepMinutes, config.idleSleepMinutes)
      : config.minSleepMinutes;
  const requested = input.requestedMinutes ?? floor;
  const minutes = Math.round(Math.min(config.maxSleepMinutes, Math.max(floor, requested)));
  const reason = quiet.length > 0 ? quiet.join(", ") : "work to push";
  return { minutes, reason };
}
