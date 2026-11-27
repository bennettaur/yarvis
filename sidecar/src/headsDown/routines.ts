import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
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
import { hasInvisibleChars } from "../web/extract.ts";
import emailDrafts from "./routines/email-drafts.md" with { type: "text" };
import generationReflection from "./routines/generation-reflection.md" with { type: "text" };
import meetingAlarms from "./routines/meeting-alarms.md" with { type: "text" };
import meetingNotes from "./routines/meeting-notes.md" with { type: "text" };
import meetingTimes from "./routines/meeting-times.md" with { type: "text" };
import messagePeople from "./routines/message-people.md" with { type: "text" };
import offerHelp from "./routines/offer-help.md" with { type: "text" };
import reviewPrep from "./routines/review-prep.md" with { type: "text" };
import reviewReflection from "./routines/review-reflection.md" with { type: "text" };
import slackWatcher from "./routines/slack-watcher.md" with { type: "text" };

/**
 * Routines: recurring or one-off jobs a heads-down pass takes on beside the work streams,
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
  /** What it does during night shift. */
  nightShift: NightShiftMode;
  /** Ad hoc work the user wants done when a pass has room. Offered until a pass reports it done, then its file is deleted. */
  once: boolean;
  source: RoutineSource;
  /** Where it was read from: a shipped path, or the user's file. */
  path: string;
  /**
   * The user's file's mtime. A `once` routine is due until a pass that started
   * after this reports it done, so a name reused for a new one-off isn't held
   * back by the old one's history. Null for a shipped routine.
   */
  writtenAt: Date | null;
}

/** A routine's settings: each value is text or a list of text. */
export type RoutineConfig = Record<string, string | string[]>;

/**
 * `run` keeps the routine's cadence at night, `slow` stretches it by
 * `NIGHT_SLOW_FACTOR`, and `skip` holds it until night shift ends.
 */
export type NightShiftMode = (typeof NIGHT_SHIFT_MODES)[number];

export const NIGHT_SHIFT_MODES = ["run", "slow", "skip"] as const;

/** How much longer a `nightShift: slow` routine waits between runs at night. */
export const NIGHT_SLOW_FACTOR = 4;

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

/** The routine that takes over reading Slack from a pass's Messages step when it is on. */
export const SLACK_WATCHER = "slack-watcher";

const BUILTIN_FILES: { path: string; content: string }[] = [
  { path: "routines/generation-reflection.md", content: generationReflection },
  { path: "routines/meeting-alarms.md", content: meetingAlarms },
  { path: "routines/meeting-notes.md", content: meetingNotes },
  { path: "routines/meeting-times.md", content: meetingTimes },
  { path: "routines/email-drafts.md", content: emailDrafts },
  { path: "routines/message-people.md", content: messagePeople },
  { path: "routines/offer-help.md", content: offerHelp },
  { path: "routines/slack-watcher.md", content: slackWatcher },
  { path: "routines/review-prep.md", content: reviewPrep },
  { path: "routines/review-reflection.md", content: reviewReflection },
];

/** `~/.yarvis/routines`, overridable so tests and a second instance can point elsewhere. */
export function routinesDir(): string {
  return process.env.YARVIS_ROUTINES_DIR ?? join(homedir(), ".yarvis", "routines");
}

/** A name is a filename and what `finish_pass` reports back, so it stays to the shape of both. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const KNOWN_KEYS = ["name", "description", "every", "workingHours", "enabled", "once"] as const;

/**
 * How long a routine a pass was given but didn't finish waits before it is
 * given again, at most. Without it a routine that keeps failing would be given
 * to every pass and take a slot from the routines that work.
 */
const RETRY_AFTER_MINUTES = 60;

/** A one-off has no cadence of its own; this only sets how long an unfinished one waits to be retried. */
const ONCE_EVERY_MINUTES = RETRY_AFTER_MINUTES;

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

export function parseRoutine(
  path: string,
  content: string,
  source: RoutineSource,
  writtenAt: Date | null = null,
): Routine {
  const { data, body } = parseDocument(path, content);
  assertKnownKeys(path, data, [...KNOWN_KEYS, ...PASS_INPUT_KEYS, "nightShift"]);
  const once = asBoolean(path, data, "once") ?? false;
  // A one-off is finished by deleting its file, which a shipped routine doesn't have.
  if (once && source === "builtin") {
    throw new FrontmatterError(path, "a shipped routine can't be a one-off", 1);
  }

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
  const everyMinutes =
    once && data.every === undefined
      ? ONCE_EVERY_MINUTES
      : parseEvery(asRequiredString(path, data, "every"));
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
    nightShift: parseNightShift(path, data),
    once,
    source,
    path,
    writtenAt,
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

function parseNightShift(path: string, data: Record<string, unknown>): NightShiftMode {
  const value = data.nightShift;
  if (value === undefined) return "run";
  if (!NIGHT_SHIFT_MODES.includes(value as NightShiftMode)) {
    throw new FrontmatterError(path, "'nightShift' must be run, slow or skip", 1);
  }
  return value as NightShiftMode;
}

/** Loads every routine. A user file replaces a shipped one of the same name outright. */
export async function loadRoutines(): Promise<RoutineCatalog> {
  const problems: RoutineProblem[] = [];
  const byName = new Map<string, Routine>();

  const add = (path: string, content: string, source: RoutineSource, writtenAt: Date | null) => {
    try {
      const routine = parseRoutine(path, content, source, writtenAt);
      // Two of the user's own files can't both win, so the second is reported, not loaded.
      if (source === "user" && byName.get(routine.name)?.source === "user") {
        throw new Error(`${path}: another file already defines '${routine.name}'`);
      }
      byName.set(routine.name, routine);
    } catch (e) {
      problems.push({ path, message: e instanceof Error ? e.message : String(e) });
    }
  };

  for (const file of BUILTIN_FILES) add(file.path, file.content, "builtin", null);
  const dir = routinesDir();
  for (const file of await readMarkdownDir(dir)) {
    if ("error" in file) problems.push({ path: file.path, message: file.error });
    else add(file.path, file.content, "user", file.modifiedAt);
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

export interface NewRoutine {
  name: string;
  description: string;
  /** Required unless `once` is set. */
  every?: string;
  workingHours?: boolean;
  nightShift?: NightShiftMode;
  tools?: string[];
  config?: RoutineConfig;
  once?: boolean;
  body: string;
}

/** A routine's `every`, as the files and the tools that write them accept it. */
export const EVERY_PATTERN = /^\d+[mhd]$/;

/** The file a `NewRoutine` is written as. Keys left at their default are left out. */
function routineFileContent(input: NewRoutine): string {
  const frontmatter: Record<string, unknown> = {
    name: input.name,
    description: input.description,
  };
  if (input.every) frontmatter.every = input.every;
  if (input.once) frontmatter.once = true;
  if (input.workingHours) frontmatter.workingHours = true;
  if (input.nightShift && input.nightShift !== "run") frontmatter.nightShift = input.nightShift;
  if (input.tools?.length) frontmatter.tools = input.tools;
  if (input.config && Object.keys(input.config).length) frontmatter.config = input.config;
  return `---\n${stringifyYaml(frontmatter)}---\n\n${input.body.trim()}\n`;
}

/**
 * The user's routines folder, created if missing. A symlinked folder is
 * refused: the loader skips one, so a file written through it would never load.
 */
async function ensureRoutinesDir(): Promise<{ dir: string } | { error: string }> {
  const dir = routinesDir();
  await mkdir(dir, { recursive: true });
  if ((await lstat(dir)).isSymbolicLink()) return { error: `${dir} is a symlink` };
  return { dir };
}

/** Writes a new file, failing if anything is already at `path`, symlinks included. */
async function createFile(path: string, content: string): Promise<{ error: string } | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return { error: `${path} already exists` };
    throw e;
  }
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  return null;
}

/**
 * Replaces a file whole: written beside it under a name the loader skips, then
 * renamed over it, so a pass loading mid-write never reads half a routine.
 */
async function replaceFile(path: string, content: string): Promise<{ error: string } | null> {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const failed = await createFile(temp, content);
  if (failed) return failed;
  try {
    await rename(temp, path);
  } catch (e) {
    await unlink(temp).catch(() => {});
    throw e;
  }
  return null;
}

/**
 * Writes a routine to `~/.yarvis/routines/<name>.md` and reloads the
 * catalogue, so the next pass can be given it.
 *
 * Without `replace`, a name already in use, shipped or the user's, is refused:
 * a pass's proposal is approved as a new routine, not a change to one the user
 * has. With it, the user's own file of that name is rewritten, and a shipped
 * routine gets a file of the user's that replaces it.
 */
export async function writeRoutineFile(
  input: NewRoutine,
  { replace = false }: { replace?: boolean } = {},
): Promise<{ path: string } | { error: string }> {
  // A routine is read by every pass unfenced; invisible text would reach them unseen.
  const configValues = Object.values(input.config ?? {}).flat();
  if ([input.description, input.body, ...configValues].some(hasInvisibleChars)) {
    return { error: "the description, body or config contains invisible characters" };
  }
  const folder = await ensureRoutinesDir();
  if ("error" in folder) return folder;
  const existing = (await routineCatalog()).routines.find((r) => r.name === input.name);
  if (existing && !replace) return { error: `a routine named '${input.name}' already exists` };
  const rewritesUserFile = existing?.source === "user";
  const path = rewritesUserFile ? existing.path : join(folder.dir, `${input.name}.md`);
  // Replacing keeps a routine that is off, off: turning it on is its own approval.
  const content =
    existing && !existing.enabled
      ? withEnabledLine(routineFileContent(input), false)
      : routineFileContent(input);
  try {
    const parsed = parseRoutine(path, content, "user");
    // What was approved has to be what passes read. A value whose text the file
    // format could misread, such as a `---` line in a config value ending the
    // frontmatter early, would otherwise move into the unfenced body.
    const config = Object.fromEntries(
      Object.entries(input.config ?? {}).map(([k, v]) => [
        k,
        Array.isArray(v) ? v.map((item) => item.trim()) : v.trim(),
      ]),
    );
    if (
      parsed.prompt !== input.body.trim() ||
      parsed.description !== input.description.trim() ||
      JSON.stringify(parsed.config) !== JSON.stringify(config)
    ) {
      return {
        error: "the routine wouldn't read back as written; keep each config value on one line",
      };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const failed = rewritesUserFile
    ? await replaceFile(path, content)
    : await createFile(path, content);
  if (failed) return failed;
  await reloadRoutines();
  return { path };
}

/** Far past any real routine, the same cap the loader reads with. */
const MAX_ROUTINE_FILE_BYTES = 256 * 1024;

/** Reads the user's file without following a link swapped in since it loaded. */
async function readUserFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_ROUTINE_FILE_BYTES) {
      throw new Error(`${path}: not a routine file this can rewrite`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * The file text with its `enabled` line set: dropped to turn it on (on is the
 * default), `enabled: false` to turn it off. Only that line changes, so the
 * user's comments, quoting and layout survive.
 */
export function withEnabledLine(content: string, enabled: boolean): string {
  const lines = content
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .split("\n");
  const closing = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (lines[0]?.trim() !== "---" || closing === -1) return content;
  const frontmatter = lines.slice(1, closing).filter((line) => !/^enabled\s*:/.test(line));
  if (!enabled) frontmatter.push("enabled: false");
  return ["---", ...frontmatter, ...lines.slice(closing)].join("\n");
}

/**
 * Turns a routine on or off. The user's own file has its `enabled` line
 * rewritten and nothing else. A shipped routine is copied into the user's
 * folder with the line set, since a user file replaces the shipped one whole.
 */
export async function setRoutineEnabled(
  name: string,
  enabled: boolean,
): Promise<{ path: string } | { error: string }> {
  const routine = (await routineCatalog()).routines.find((r) => r.name === name);
  if (!routine) return { error: `no routine named '${name}'` };
  const isUserFile = routine.source === "user";
  const source = isUserFile
    ? await readUserFile(routine.path)
    : BUILTIN_FILES.find((file) => file.path === routine.path)?.content;
  if (source === undefined) return { error: `no shipped file for '${name}'` };
  const content = withEnabledLine(source, enabled);
  try {
    parseRoutine(routine.path, content, "user");
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const folder = await ensureRoutinesDir();
  if ("error" in folder) return folder;
  const path = isUserFile ? routine.path : join(folder.dir, `${name}.md`);
  const failed = isUserFile ? await replaceFile(path, content) : await createFile(path, content);
  if (failed) return failed;
  await reloadRoutines();
  return { path };
}

/**
 * Deletes the user's own routine file. A file that replaced a shipped routine
 * leaves the shipped one in its place. Shipped routines can only be turned off.
 */
export async function deleteRoutineFile(
  name: string,
): Promise<{ deleted: true } | { error: string }> {
  const routine = (await routineCatalog()).routines.find((r) => r.name === name);
  if (!routine) return { error: `no routine named '${name}'` };
  if (routine.source !== "user") return { error: "a shipped routine can only be turned off" };
  // Already gone, say removed by hand since the last reload: that is what was asked for.
  await unlink(routine.path).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
  });
  await reloadRoutines();
  return { deleted: true };
}

/**
 * Deletes the files of one-off routines a pass reported done. One rewritten
 * after the pass started is kept, since the pass did the old version. A file
 * that can't be deleted is only logged: `dueRoutines` already holds a one-off
 * back once a pass that started after it was written has done it.
 */
export async function removeFinishedOnceRoutines(
  done: readonly string[],
  passStartedAt: Date,
): Promise<string[]> {
  if (!done.length) return [];
  const finished = (await routineCatalog()).routines.filter(
    (r) =>
      r.once &&
      r.source === "user" &&
      done.includes(r.name) &&
      r.writtenAt !== null &&
      r.writtenAt <= passStartedAt,
  );
  const removed: string[] = [];
  for (const routine of finished) {
    try {
      // The catalogue may predate an edit made by hand during the pass, so the file itself decides.
      if ((await lstat(routine.path)).mtime > passStartedAt) continue;
      await unlink(routine.path);
      removed.push(routine.name);
    } catch (e) {
      console.error(`[heads-down] couldn't remove finished one-off routine ${routine.path}:`, e);
    }
  }
  if (removed.length) await reloadRoutines();
  return removed;
}

export interface DueInput {
  routines: Routine[];
  /** When the last pass to report each routine done started, by name. Missing means not done in the last 30 days. */
  lastDone: ReadonlyMap<string, Date>;
  /** When the last pass given each routine started, done or not, by name. */
  lastOffered: ReadonlyMap<string, Date>;
  now: Date;
  withinWorkingHours: boolean;
  /** Whether it is night shift now; each routine's `nightShift` decides what that means for it. */
  duringNightShift?: boolean;
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
 * cadence or an hour, whichever is shorter, before it is given again. A one-off
 * is due until a pass that started after its file was written reports it done.
 */
export function dueRoutines(input: DueInput): Routine[] {
  const timing = routineTiming(input);
  return input.routines
    .filter((r) => holdReason(r, input, timing) === null)
    .map((routine) => ({ routine, overdue: timing.cadencesSinceDone(routine) }))
    .filter(({ overdue }) => overdue >= 1)
    .sort((a, b) => b.overdue - a.overdue || a.routine.name.localeCompare(b.routine.name))
    .slice(0, input.limit)
    .map(({ routine }) => routine);
}

/** The clock arithmetic `dueRoutines` and `routineSchedules` share. */
function routineTiming(input: DueInput) {
  const minutesSince = (at: Date) => (input.now.getTime() - at.getTime()) / 60_000;
  const cadence = (routine: Routine): number =>
    input.duringNightShift && routine.nightShift === "slow"
      ? routine.everyMinutes * NIGHT_SLOW_FACTOR
      : routine.everyMinutes;
  /** Done by a pass that started after a one-off's file was written: finished, whatever the clock says. */
  const onceFinished = (routine: Routine): boolean => {
    const last = input.lastDone.get(routine.name);
    return Boolean(last && routine.writtenAt && last >= routine.writtenAt);
  };
  const cadencesSinceDone = (routine: Routine): number => {
    if (routine.once) return onceFinished(routine) ? 0 : Number.POSITIVE_INFINITY;
    const last = input.lastDone.get(routine.name);
    return last ? minutesSince(last) / cadence(routine) : Number.POSITIVE_INFINITY;
  };
  /** When a routine a pass was given but didn't finish may be given again, or null when it isn't waiting. */
  const retryAt = (routine: Routine): Date | null => {
    const offered = input.lastOffered.get(routine.name);
    const done = input.lastDone.get(routine.name);
    if (!offered || (done && done >= offered)) return null;
    const wait = Math.min(routine.everyMinutes, RETRY_AFTER_MINUTES);
    return minutesSince(offered) < wait ? new Date(offered.getTime() + wait * 60_000) : null;
  };
  return { cadence, onceFinished, cadencesSinceDone, retryAt };
}

/**
 * Why a routine can't be given to a pass right now, whether or not it is due:
 * turned off, or held by working hours, night shift or a retry wait.
 */
export type RoutineHold = "off" | "working-hours" | "night-shift" | "retry";

function holdReason(
  routine: Routine,
  input: DueInput,
  timing: ReturnType<typeof routineTiming>,
): RoutineHold | null {
  if (!routine.enabled) return "off";
  if (!input.withinWorkingHours && routine.workingHoursOnly) return "working-hours";
  if (input.duringNightShift && routine.nightShift === "skip") return "night-shift";
  if (timing.retryAt(routine)) return "retry";
  return null;
}

export interface RoutineSchedule {
  /** Whether the next pass, if it started now, would be given it. */
  nextPass: boolean;
  /** Due now but past the per-pass limit, so it waits for a later pass. */
  queued: boolean;
  /**
   * When it next comes due by its cadence, or when a failed one may be retried.
   * Now or earlier when it is already due. Null when it never will again: off,
   * or a one-off already done.
   */
  dueAt: Date | null;
  heldBy: RoutineHold | null;
}

/**
 * Where each routine stands, for the Heads down page: whether the next pass
 * would take it, and if not, why and when. Uses the same rules as `dueRoutines`.
 */
export function routineSchedules(input: DueInput): Map<string, RoutineSchedule> {
  const timing = routineTiming(input);
  const nextPass = new Set(dueRoutines(input).map((r) => r.name));
  const schedules = new Map<string, RoutineSchedule>();
  for (const routine of input.routines) {
    const hold = holdReason(routine, input, timing);
    const due = timing.cadencesSinceDone(routine) >= 1;
    const last = input.lastDone.get(routine.name);
    let dueAt: Date | null;
    if (!routine.enabled || (routine.once && timing.onceFinished(routine))) dueAt = null;
    else if (hold === "retry") dueAt = timing.retryAt(routine);
    else if (routine.once || !last) dueAt = input.now;
    else dueAt = new Date(last.getTime() + timing.cadence(routine) * 60_000);
    schedules.set(routine.name, {
      nextPass: nextPass.has(routine.name),
      queued: hold === null && due && !nextPass.has(routine.name),
      dueAt,
      heldBy: hold,
    });
  }
  return schedules;
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
