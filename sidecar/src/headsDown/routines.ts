import { homedir } from "node:os";
import { join } from "node:path";
import {
  asBoolean,
  asList,
  asRequiredString,
  assertKnownKeys,
  FrontmatterError,
  parseDocument,
  readMarkdownDir,
} from "../agents/frontmatter.ts";
import type { RegistryTool } from "../agentTools/store.ts";
import meetingAlarms from "./routines/meeting-alarms.md" with { type: "text" };
import meetingNotes from "./routines/meeting-notes.md" with { type: "text" };
import reviewPrep from "./routines/review-prep.md" with { type: "text" };

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
  /**
   * Tools the routine wants ready, as written in the file: a bare tool name or
   * a registry id. They are mounted for the pass; calling one still goes through
   * the pass's approval rules.
   */
  tools: string[];
  /** The file's `config:` map, handed to the pass as data beside the body. */
  config: RoutineConfig;
  source: RoutineSource;
}

/** A routine's settings: each value is text or a list of text. */
export type RoutineConfig = Record<string, string | string[]>;

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
  { path: "routines/review-prep.md", content: reviewPrep },
];

/** `~/.yarvis/routines`, overridable so tests and a second instance can point elsewhere. */
export function routinesDir(): string {
  return process.env.YARVIS_ROUTINES_DIR ?? join(homedir(), ".yarvis", "routines");
}

/** A name is a filename and what `finish_pass` reports back, so it stays to the shape of both. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const KNOWN_KEYS = ["name", "description", "every", "workingHours", "enabled"] as const;

/** Keys that hand the pass more than the body: tools to mount and settings to read. */
const PASS_INPUT_KEYS = ["tools", "config"] as const;

/** A routine is a few steps of a pass, not a toolbox. */
const MAX_TOOLS = 20;

/** A tool is a bare name or a registry id such as `mcp:<server id>:<tool>`. */
const TOOL_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;

const CONFIG_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const MAX_CONFIG_KEYS = 20;

/** The config goes into the pass prompt beside the body, so it is held to a similar size. */
const MAX_CONFIG_CHARS = 2000;

/**
 * The shortest cadence a file may ask for. Passes can be as little as 5 minutes
 * apart, and a routine due on nearly every pass would take a slot from every
 * other one.
 */
const MIN_EVERY_MINUTES = 15;

/**
 * The longest cadence a file may ask for. A pass only looks this far back for
 * when each routine was last done, so the history it reads stays bounded.
 */
export const MAX_EVERY_MINUTES = 30 * 24 * 60;

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
  assertKnownKeys(path, data, [...KNOWN_KEYS, ...PASS_INPUT_KEYS]);

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
  if (everyMinutes > MAX_EVERY_MINUTES) {
    throw new FrontmatterError(
      path,
      `'every' cannot be longer than ${MAX_EVERY_MINUTES / (24 * 60)}d`,
      1,
    );
  }

  return {
    name,
    description,
    prompt: body,
    everyMinutes,
    workingHoursOnly: asBoolean(path, data, "workingHours") ?? false,
    enabled: asBoolean(path, data, "enabled") ?? true,
    tools: parseTools(path, data),
    config: parseConfig(path, data.config),
    source,
  };
}

function parseTools(path: string, data: Record<string, unknown>): string[] {
  const tools = [...new Set(asList(path, data, "tools") ?? [])];
  if (tools.length > MAX_TOOLS) {
    throw new FrontmatterError(path, `'tools' can name at most ${MAX_TOOLS} tools`, 1);
  }
  const bad = tools.filter((tool) => !TOOL_PATTERN.test(tool));
  if (bad.length) {
    throw new FrontmatterError(
      path,
      `'tools' must be tool names or ids, with no spaces: ${bad.join(", ")}`,
      1,
    );
  }
  return tools;
}

/** Text, numbers and true/false all become text: `channel: 123` is a name, not arithmetic. */
function scalarToText(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function parseConfigValue(path: string, key: string, raw: unknown): string | string[] {
  if (Array.isArray(raw)) {
    return raw.map((item, i) => {
      const text = scalarToText(item);
      if (text === null) {
        throw new FrontmatterError(path, `'config.${key}' item ${i + 1} must be text`, 1);
      }
      return text;
    });
  }
  const text = scalarToText(raw);
  if (text === null) {
    throw new FrontmatterError(path, `'config.${key}' must be text or a list of text`, 1);
  }
  return text;
}

/**
 * `config:` is a flat map of settings the body refers to, such as the Slack
 * channels to watch. A nested map is refused: the pass reads these as values,
 * and a structure deep enough to need nesting belongs in the body.
 */
function parseConfig(path: string, value: unknown): RoutineConfig {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FrontmatterError(path, "'config' must be a map of names to values", 1);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_CONFIG_KEYS) {
    throw new FrontmatterError(path, `'config' can have at most ${MAX_CONFIG_KEYS} keys`, 1);
  }
  const config: RoutineConfig = {};
  for (const [key, raw] of entries) {
    if (!CONFIG_KEY_PATTERN.test(key)) {
      throw new FrontmatterError(
        path,
        `'config' key '${key}' must start with a letter and use letters, digits, '_' or '-'`,
        1,
      );
    }
    config[key] = parseConfigValue(path, key, raw);
  }
  if (JSON.stringify(config).length > MAX_CONFIG_CHARS) {
    throw new FrontmatterError(
      path,
      `'config' cannot be longer than ${MAX_CONFIG_CHARS} characters`,
      1,
    );
  }
  return config;
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
  /** When the last pass to report each routine done started, by name. Missing means not done in the last 30 days. */
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
 * daily one has waited longer. One not done in the last 30 days goes first of
 * all. The rest stay due and get the next pass. One a pass was given and didn't finish waits its
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

/** A registry row, as much of it as matching a routine's tools needs. */
export type ToolRow = Pick<RegistryTool, "id" | "name" | "policy">;

/** One entry of a routine's `tools:`, and the registry tools it matched. */
export interface RoutineToolMatch {
  tool: string;
  matchedIds: string[];
  /** Why nothing matched, or null when something did. */
  problem: string | null;
}

export interface RoutineTools {
  /** Registry ids to mount for the pass, across every routine given to it. */
  ids: string[];
  byRoutine: Map<string, RoutineToolMatch[]>;
}

function toolProblem(
  found: readonly ToolRow[],
  usable: readonly ToolRow[],
  refused: ReadonlySet<string>,
): string | null {
  if (!found.length) return "no tool by that name is installed";
  if (!usable.length) return "turned off in the Tool manager";
  if (usable.length > 1) {
    return `${usable.length} tools have that name; name one by its id: ${usable.map((row) => row.id).join(", ")}`;
  }
  if (usable[0] && refused.has(usable[0].id)) return "not available in heads-down mode";
  return null;
}

/**
 * Matches each routine's `tools:` against the tool registry. A registry id
 * matches itself; a bare name matches the one tool of that name. A name two
 * tools share (two MCP servers, or a server shadowing a built-in) mounts
 * neither, since an unattended pass would have to guess which one the file
 * meant. A disabled tool isn't mounted, the same rule `mount_tools` follows,
 * so a routine gets no tool a pass couldn't mount on its own. `refused` holds
 * the registry ids a pass may never call, reported rather than mounted.
 */
export function resolveRoutineTools(
  routines: readonly Routine[],
  registry: readonly ToolRow[],
  refused: ReadonlySet<string> = new Set(),
): RoutineTools {
  const ids = new Set<string>();
  const byRoutine: RoutineTools["byRoutine"] = new Map();
  for (const routine of routines) {
    const matches = routine.tools.map((tool): RoutineToolMatch => {
      const found = registry.filter((row) => row.id === tool || row.name === tool);
      const usable = found.filter((row) => row.policy !== "disabled");
      const problem = toolProblem(found, usable, refused);
      const matchedIds = problem ? [] : usable.map((row) => row.id);
      for (const id of matchedIds) ids.add(id);
      return { tool, matchedIds, problem };
    });
    if (matches.length) byRoutine.set(routine.name, matches);
  }
  return { ids: [...ids], byRoutine };
}
