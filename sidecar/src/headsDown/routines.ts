import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  asBoolean,
  asRequiredString,
  assertKnownKeys,
  FrontmatterError,
  parseDocument,
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
 * collision, so a user can turn a shipped one off by writing a file with its
 * name and `enabled: false`. Files rather than rows so a routine can be shared
 * by copying a file.
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
  /** Absolute path for a user routine; the repo-relative name for a shipped one. */
  path: string;
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
 * The shortest cadence a file may ask for. Passes are at least minutes apart
 * anyway, and a routine that asked to run every pass would take a slot from
 * every other one.
 */
const MIN_EVERY_MINUTES = 15;

const DURATION_UNITS: Record<string, number> = { m: 1, h: 60, d: 24 * 60 };

/** `30m`, `3h` or `1d`, in minutes. */
export function parseEvery(value: string): number | null {
  const match = /^(\d+)\s*([mhd])$/.exec(value.trim().toLowerCase());
  if (!match) return null;
  return Number(match[1]) * DURATION_UNITS[match[2]!]!;
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
    path,
  };
}

type UserFile = { path: string; content: string } | { path: string; error: string };

async function readUserFiles(dir: string): Promise<UserFile[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }
  const files: UserFile[] = [];
  for (const name of names.sort()) {
    const path = join(dir, name);
    try {
      files.push({ path, content: await readFile(path, "utf8") });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EISDIR") continue;
      files.push({ path, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return files;
}

/** Loads every routine. A user file replaces a shipped one of the same name outright. */
export async function loadRoutines(): Promise<RoutineCatalog> {
  const problems: RoutineProblem[] = [];
  const byName = new Map<string, Routine>();

  const add = (path: string, content: string, source: RoutineSource) => {
    try {
      const routine = parseRoutine(path, content, source);
      byName.set(routine.name, routine);
    } catch (e) {
      problems.push({ path, message: e instanceof Error ? e.message : String(e) });
    }
  };

  for (const file of BUILTIN_FILES) add(file.path, file.content, "builtin");
  const dir = routinesDir();
  for (const file of await readUserFiles(dir)) {
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

export interface DueInput {
  routines: Routine[];
  /** When each routine was last done, by name. A routine missing from it never has been. */
  lastDone: ReadonlyMap<string, Date>;
  now: Date;
  withinWorkingHours: boolean;
  /** The most routines one pass takes on. */
  limit: number;
}

/**
 * The routines a pass should take on: enabled, allowed at this hour, and at
 * least their cadence since they were last done. When more are due than the
 * limit, the most overdue go first, measured against their own cadence, so a
 * daily routine a few hours late doesn't lose to one that runs every hour.
 * The rest stay due and get the next pass.
 */
export function dueRoutines(input: DueInput): Routine[] {
  const overdue = (routine: Routine): number => {
    const last = input.lastDone.get(routine.name);
    if (!last) return Number.POSITIVE_INFINITY;
    return (input.now.getTime() - last.getTime()) / 60_000 / routine.everyMinutes;
  };
  return input.routines
    .filter((r) => r.enabled && (input.withinWorkingHours || !r.workingHoursOnly))
    .map((routine) => ({ routine, overdue: overdue(routine) }))
    .filter(({ overdue }) => overdue >= 1)
    .sort((a, b) => b.overdue - a.overdue || a.routine.name.localeCompare(b.routine.name))
    .slice(0, Math.max(0, input.limit))
    .map(({ routine }) => routine);
}
