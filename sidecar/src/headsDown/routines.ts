import { homedir } from "node:os";
import { join } from "node:path";
import {
  asBoolean,
  asRequiredString,
  assertKnownKeys,
  FrontmatterError,
  parseDocument,
  readMarkdownDir,
} from "../agents/frontmatter.ts";
import meetingAlarms from "./routines/meeting-alarms.md" with { type: "text" };
import meetingNotes from "./routines/meeting-notes.md" with { type: "text" };

/**
 * Routines: recurring jobs a heads-down pass takes on beside the work streams,
 * such as setting alarms for the day's meetings.
 *
 * A routine is a markdown file, like a specialist: frontmatter for how often it
 * runs, the body for what the pass is told to do. The shipped ones are embedded
 * at build time; `~/.yarvis/routines/*.md` loads beside them and wins on a name
 * collision. The user's file replaces the shipped one whole, so turning one off
 * takes a complete routine with `enabled: false`. Files rather than rows so a
 * routine can be shared by copying a file.
 *
 * Never read from a workspace or a repo: the body goes into an unattended
 * pass's prompt as the user's own words, so a repo that could contribute one
 * could hand the loop instructions.
 */

export type RoutineSource = "builtin" | "user";

export interface Routine {
  name: string;
  description: string;
  /** The file body: what the pass is told to do. */
  prompt: string;
  /** The least time between two runs, in minutes. */
  everyMinutes: number;
  /** Only offered within the user's working hours. */
  workingHoursOnly: boolean;
  enabled: boolean;
  source: RoutineSource;
}

export interface RoutineProblem {
  path: string;
  message: string;
}

export interface RoutineCatalog {
  routines: Routine[];
  problems: RoutineProblem[];
  /** Directory user routines are read from, so the UI can name it. */
  userDir: string;
}

const BUILTIN_FILES: { path: string; content: string }[] = [
  { path: "routines/meeting-alarms.md", content: meetingAlarms },
  { path: "routines/meeting-notes.md", content: meetingNotes },
];

/** `~/.yarvis/routines`, overridable so tests and a second instance can point elsewhere. */
export function routinesDir(): string {
  return process.env.YARVIS_ROUTINES_DIR ?? join(homedir(), ".yarvis", "routines");
}

/** A name is a filename and what `finish_pass` reports back, so it stays to the shape of both. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const KNOWN_KEYS = ["name", "description", "every", "workingHours", "enabled"] as const;

/**
 * The shortest cadence a file may ask for. Passes can be as little as 5 minutes
 * apart, and a routine due on nearly every pass would take a slot from every
 * other one.
 */
const MIN_EVERY_MINUTES = 15;

/** A due routine's whole body goes into the pass prompt, so a routine stays to about a page. */
const MAX_BODY_CHARS = 4000;

const DURATION_UNITS: Record<string, number> = { m: 1, h: 60, d: 24 * 60 };

/** `30m`, `3h` or `1d`, in minutes. */
export function parseEvery(value: string): number | null {
  const match = /^(\d+)\s*([mhd])$/.exec(value.trim().toLowerCase());
  const unit = match?.[2] ? DURATION_UNITS[match[2]] : undefined;
  return match && unit ? Number(match[1]) * unit : null;
}

export function parseRoutine(path: string, content: string, source: RoutineSource): Routine {
  const { data, body } = parseDocument(path, content);
  assertKnownKeys(path, data, KNOWN_KEYS);

  const name = asRequiredString(path, data, "name");
  if (!NAME_PATTERN.test(name)) {
    throw new FrontmatterError(path, "'name' must be lowercase letters, digits and hyphens", 1);
  }
  const description = asRequiredString(path, data, "description");
  if (!body.trim()) {
    throw new FrontmatterError(
      path,
      "the body is what the pass is told to do and cannot be empty",
      1,
    );
  }
  if (body.length > MAX_BODY_CHARS) {
    throw new FrontmatterError(
      path,
      `the body cannot be longer than ${MAX_BODY_CHARS} characters`,
      1,
    );
  }
  const everyMinutes = parseEvery(asRequiredString(path, data, "every"));
  if (everyMinutes === null) {
    throw new FrontmatterError(path, "'every' must be a duration such as 30m, 3h or 1d", 1);
  }
  if (everyMinutes < MIN_EVERY_MINUTES) {
    throw new FrontmatterError(path, `'every' cannot be shorter than ${MIN_EVERY_MINUTES}m`, 1);
  }

  return {
    name,
    description,
    prompt: body,
    everyMinutes,
    workingHoursOnly: asBoolean(path, data, "workingHours") ?? false,
    enabled: asBoolean(path, data, "enabled") ?? true,
    source,
  };
}

/** Loads every routine. A user file replaces a shipped one of the same name outright. */
export async function loadRoutines(): Promise<RoutineCatalog> {
  const problems: RoutineProblem[] = [];
  const byName = new Map<string, Routine>();

  const add = (path: string, content: string, source: RoutineSource) => {
    try {
      const routine = parseRoutine(path, content, source);
      // Two of the user's own files can't both win, so the second is reported, not loaded.
      if (source === "user" && byName.get(routine.name)?.source === "user") {
        throw new Error(`${path}: another file already defines '${routine.name}'`);
      }
      byName.set(routine.name, routine);
    } catch (e) {
      problems.push({ path, message: e instanceof Error ? e.message : String(e) });
    }
  };

  for (const file of BUILTIN_FILES) add(file.path, file.content, "builtin");
  const dir = routinesDir();
  for (const file of await readMarkdownDir(dir)) {
    if ("error" in file) problems.push({ path: file.path, message: file.error });
    else add(file.path, file.content, "user");
  }

  return {
    routines: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    problems,
    userDir: dir,
  };
}

let cached: Promise<RoutineCatalog> | null = null;

export function routineCatalog(): Promise<RoutineCatalog> {
  if (!cached) cached = loadRoutines();
  return cached;
}

/** Drops the cache, for after a user edits a file. */
export function reloadRoutines(): Promise<RoutineCatalog> {
  cached = loadRoutines();
  return cached;
}

/**
 * How long a routine a pass was given but didn't finish waits before it is
 * given again, at most. Without it a routine that keeps failing would be given
 * to every pass and take a slot from the routines that work.
 */
const RETRY_AFTER_MINUTES = 60;

export interface DueInput {
  routines: Routine[];
  /** When the last pass to report each routine done started, by name. Missing means never done. */
  lastDone: ReadonlyMap<string, Date>;
  /** When the last pass given each routine started, done or not, by name. */
  lastOffered: ReadonlyMap<string, Date>;
  now: Date;
  withinWorkingHours: boolean;
  /** The most routines one pass takes on. */
  limit: number;
}

/**
 * The routines a pass should take on: enabled, allowed at this hour, and at
 * least their cadence since they were last done. When more are due than the
 * limit, the most overdue go first, counted in cadences missed rather than
 * minutes: an hourly routine last done 2 hours ago is 2 cadences overdue and
 * goes before a daily one last done 26 hours ago (about 1.08), even though the
 * daily one has waited longer. One never done goes first of all. The rest stay
 * due and get the next pass. One a pass was given and didn't finish waits its
 * cadence or an hour, whichever is shorter, before it is given again.
 */
export function dueRoutines(input: DueInput): Routine[] {
  const minutesSince = (at: Date) => (input.now.getTime() - at.getTime()) / 60_000;
  const cadencesSinceDone = (routine: Routine): number => {
    const last = input.lastDone.get(routine.name);
    return last ? minutesSince(last) / routine.everyMinutes : Number.POSITIVE_INFINITY;
  };
  const waitingToRetry = (routine: Routine): boolean => {
    const offered = input.lastOffered.get(routine.name);
    const done = input.lastDone.get(routine.name);
    if (!offered || (done && done >= offered)) return false;
    return minutesSince(offered) < Math.min(routine.everyMinutes, RETRY_AFTER_MINUTES);
  };
  return input.routines
    .filter((r) => r.enabled && (input.withinWorkingHours || !r.workingHoursOnly))
    .filter((r) => !waitingToRetry(r))
    .map((routine) => ({ routine, overdue: cadencesSinceDone(routine) }))
    .filter(({ overdue }) => overdue >= 1)
    .sort((a, b) => b.overdue - a.overdue || a.routine.name.localeCompare(b.routine.name))
    .slice(0, input.limit)
    .map(({ routine }) => routine);
}
