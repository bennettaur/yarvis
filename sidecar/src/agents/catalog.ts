import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { builtinToolMetadata } from "../chat/builtinTools.ts";
import activityConsolidator from "./definitions/activity-consolidator.md" with { type: "text" };
import planner from "./definitions/planner.md" with { type: "text" };
import projectManager from "./definitions/project-manager.md" with { type: "text" };
import sessionSummarizer from "./definitions/session-summarizer.md" with { type: "text" };
import workScout from "./definitions/work-scout.md" with { type: "text" };
import { asBoolean, asInteger, asList, FrontmatterError, parseDocument } from "./frontmatter.ts";

/**
 * The catalogue of specialists the orchestrator can delegate to.
 *
 * A specialist is a markdown file: YAML frontmatter for the configuration
 * (tools, model, step budget) and the body as its system prompt. The ones this
 * repo ships are imported as text, so they are reviewable in git and travel
 * inside the compiled sidecar binary; anything in `~/.yarvis/agents/*.md` is
 * loaded beside them and, on a name collision, wins.
 *
 * That precedence is the point. Files rather than rows mean a shipped prompt
 * improves with the app while a definition the user wrote stays theirs — no
 * seed-once rule, and nothing to reset. It also means adding a specialist is
 * writing a file, which is what "let the agent reach for a specialist it needs"
 * requires.
 *
 * Deliberately *not* read: anything inside a workspace or repo. A definition
 * carries a system prompt and a tool list, so a checked-out repo that could
 * contribute one would be a repo that can hand the agent instructions and the
 * means to act on them.
 */

/** Where a definition came from, which is also its precedence. */
export type SpecialistSource = "builtin" | "user";

export interface SpecialistDefinition {
  name: string;
  description: string;
  /** The file body: this specialist's system prompt. */
  prompt: string;
  /** Bare built-in tool names, as written in the file. */
  tools: string[];
  /** Tools it may use without the user approving the call; a subset of `tools`. */
  unattended: string[];
  provider: string | null;
  model: string | null;
  maxSteps: number;
  enabled: boolean;
  source: SpecialistSource;
  /** Absolute path for a user definition; the repo-relative name for a shipped one. */
  path: string;
}

/** A file that could not be read as a definition, surfaced rather than skipped. */
export interface SpecialistProblem {
  path: string;
  message: string;
}

export interface SpecialistCatalog {
  specialists: SpecialistDefinition[];
  problems: SpecialistProblem[];
  /** Directory user definitions are read from, so the UI can name it. */
  userDir: string;
}

const DEFAULT_MAX_STEPS = 8;

/** Upper bound on a step budget a file may ask for. */
const MAX_STEPS_CEILING = 30;

/** The definitions this repo ships, embedded at build time. */
const BUILTIN_FILES: { path: string; content: string }[] = [
  { path: "definitions/work-scout.md", content: workScout },
  { path: "definitions/project-manager.md", content: projectManager },
  { path: "definitions/activity-consolidator.md", content: activityConsolidator },
  { path: "definitions/session-summarizer.md", content: sessionSummarizer },
  { path: "definitions/planner.md", content: planner },
];

/** `~/.yarvis/agents`, overridable so tests and a second instance can point elsewhere. */
export function agentsDir(): string {
  return process.env.YARVIS_AGENTS_DIR ?? join(homedir(), ".yarvis", "agents");
}

/** A name is a filename and an identifier, so it stays to the shape of both. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Turns one file into a definition. Tool names are checked against the built-in
 * set here rather than at call time: a typo in a file should be a problem the
 * user is shown, not a specialist that quietly runs with nine of its ten tools.
 */
export function parseSpecialist(
  path: string,
  content: string,
  source: SpecialistSource,
  knownTools: ReadonlySet<string>,
): SpecialistDefinition {
  const doc = parseDocument(path, content);
  const name = doc.values.name?.trim() ?? "";
  if (!NAME_PATTERN.test(name)) {
    throw new FrontmatterError(
      path,
      1,
      "'name' is required and must be lowercase letters, digits and hyphens",
    );
  }
  const description = doc.values.description?.trim() ?? "";
  if (!description) {
    throw new FrontmatterError(path, 1, "'description' is required — it is how the agent chooses");
  }
  if (!doc.body.trim()) {
    throw new FrontmatterError(path, 1, "the body is the system prompt and cannot be empty");
  }

  const tools = asList(doc, "tools") ?? [];
  const unknown = tools.filter((tool) => !knownTools.has(tool));
  if (unknown.length) {
    throw new FrontmatterError(path, 1, `unknown tool(s): ${unknown.join(", ")}`);
  }
  const unattended = asList(doc, "unattended") ?? [];
  const ungranted = unattended.filter((tool) => !tools.includes(tool));
  if (ungranted.length) {
    throw new FrontmatterError(
      path,
      1,
      `'unattended' names tool(s) missing from 'tools': ${ungranted.join(", ")}`,
    );
  }

  // `model: anthropic/claude-sonnet-5` — one field, because a provider without a
  // model (or the reverse) can't resolve, so they are never usefully separate.
  const modelRef = doc.values.model?.trim();
  let provider: string | null = null;
  let model: string | null = null;
  if (modelRef) {
    const slash = modelRef.indexOf("/");
    if (slash <= 0 || slash === modelRef.length - 1) {
      throw new FrontmatterError(path, 1, "'model' must be written as <provider>/<model>");
    }
    provider = modelRef.slice(0, slash);
    model = modelRef.slice(slash + 1);
  }

  const maxSteps = asInteger(doc, "maxSteps", path) ?? DEFAULT_MAX_STEPS;
  if (maxSteps > MAX_STEPS_CEILING) {
    throw new FrontmatterError(path, 1, `'maxSteps' cannot exceed ${MAX_STEPS_CEILING}`);
  }

  return {
    name,
    description,
    prompt: doc.body,
    tools,
    unattended,
    provider,
    model,
    maxSteps,
    enabled: asBoolean(doc, "enabled", path) ?? true,
    source,
    path,
  };
}

/** Reads the user's directory, treating an absent one as simply empty. */
async function readUserFiles(dir: string): Promise<{ path: string; content: string }[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }
  const files: { path: string; content: string }[] = [];
  for (const name of names.sort()) {
    const path = join(dir, name);
    try {
      // Skip anything that isn't a plain file, so a directory named `x.md`
      // doesn't surface as a read error.
      if (!(await stat(path)).isFile()) continue;
      files.push({ path, content: await readFile(path, "utf8") });
    } catch (e) {
      files.push({ path, content: `` });
      void e;
    }
  }
  return files;
}

/**
 * Loads every definition. A user file with the same name as a shipped one
 * replaces it outright rather than merging: a half-overridden prompt would be
 * neither what the app ships nor what the user wrote.
 */
export async function loadCatalog(): Promise<SpecialistCatalog> {
  const knownTools = new Set(Object.keys(builtinToolMetadata()));
  const problems: SpecialistProblem[] = [];
  const byName = new Map<string, SpecialistDefinition>();

  const add = (path: string, content: string, source: SpecialistSource) => {
    try {
      const definition = parseSpecialist(path, content, source, knownTools);
      byName.set(definition.name, definition);
    } catch (e) {
      problems.push({ path, message: e instanceof Error ? e.message : String(e) });
    }
  };

  for (const file of BUILTIN_FILES) add(file.path, file.content, "builtin");
  const dir = agentsDir();
  for (const file of await readUserFiles(dir)) add(file.path, file.content, "user");

  return {
    specialists: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    problems,
    userDir: dir,
  };
}

/** Cached catalogue, so a delegation doesn't re-read the directory every turn. */
let cached: Promise<SpecialistCatalog> | null = null;

export function catalog(): Promise<SpecialistCatalog> {
  if (!cached) cached = loadCatalog();
  return cached;
}

/** Drops the cache, for after a user edits a file. */
export function reloadCatalog(): Promise<SpecialistCatalog> {
  cached = loadCatalog();
  return cached;
}

export async function listSpecialists(
  options: { enabledOnly?: boolean } = {},
): Promise<SpecialistDefinition[]> {
  const { specialists } = await catalog();
  return options.enabledOnly ? specialists.filter((s) => s.enabled) : specialists;
}

/** Resolves a name the way the user would write it, case-insensitively. */
export async function findSpecialist(name: string): Promise<SpecialistDefinition | null> {
  const wanted = name.trim().toLowerCase();
  const { specialists } = await catalog();
  return specialists.find((s) => s.name.toLowerCase() === wanted) ?? null;
}

export interface SpecialistMatch {
  specialist: SpecialistDefinition;
  score: number;
}

/**
 * Ranks specialists against a description of the work, over name and description
 * only — the index the orchestrator chooses from.
 *
 * Lexical rather than embedded, unlike the tool registry: there are a handful of
 * specialists, not hundreds, so the whole list fits in one tool result and a
 * round-trip to an embedding provider would cost more than it buys. If this grows
 * past a screenful, the tool registry's semantic search is the pattern to follow.
 */
export async function searchSpecialists(query: string, limit = 5): Promise<SpecialistMatch[]> {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2);
  const candidates = await listSpecialists({ enabledOnly: true });
  if (terms.length === 0) return candidates.map((specialist) => ({ specialist, score: 0 }));

  return candidates
    .map((specialist) => {
      const haystack = `${specialist.name} ${specialist.description}`.toLowerCase();
      const hits = terms.filter((term) => haystack.includes(term)).length;
      // A name match is the strongest signal available: it is what the user says
      // out loud ("ask the planner").
      const nameHits = terms.filter((term) => specialist.name.toLowerCase().includes(term)).length;
      return { specialist, score: hits / terms.length + nameHits };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
