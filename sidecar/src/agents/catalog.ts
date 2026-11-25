import { homedir } from "node:os";
import { join } from "node:path";
import { builtinToolMetadata } from "../chat/builtinTools.ts";
import { COMPLEXITY_TIERS, type ComplexityTier, isComplexityTier } from "../llm/complexity.ts";
import { CHOICE_PATTERN, MAX_INSTRUCTIONS_CHARS } from "./decisionLimits.ts";
import activityConsolidator from "./definitions/activity-consolidator.md" with { type: "text" };
import complexityRouter from "./definitions/complexity-router.md" with { type: "text" };
import mergeReviewer from "./definitions/merge-reviewer.md" with { type: "text" };
import planner from "./definitions/planner.md" with { type: "text" };
import projectManager from "./definitions/project-manager.md" with { type: "text" };
import reviewScout from "./definitions/review-scout.md" with { type: "text" };
import sessionSummarizer from "./definitions/session-summarizer.md" with { type: "text" };
import specialistPicker from "./definitions/specialist-picker.md" with { type: "text" };
import workScout from "./definitions/work-scout.md" with { type: "text" };
import workspaceRecap from "./definitions/workspace-recap.md" with { type: "text" };
import yarvisGuide from "./definitions/yarvis-guide.md" with { type: "text" };
import {
  asBoolean,
  asInteger,
  asList,
  asRequiredString,
  asString,
  assertKnownKeys,
  FrontmatterError,
  parseDocument,
  readMarkdownDir,
} from "./frontmatter.ts";

/**
 * The catalogue of specialists the orchestrator can delegate to.
 *
 * A specialist is a markdown file: YAML frontmatter for the configuration
 * (tools, model, step budget) and the body as its system prompt. The ones this
 * repo ships are imported as text, so they are reviewable in git and travel
 * inside the compiled sidecar binary; anything in `~/.yarvis/agents/*.md` is
 * loaded beside them and, on a name collision, wins. A user file can instead
 * `extends:` a shipped one, adding tools and instructions to it.
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

/**
 * `task`: a delegated run with tools that answers in text.
 * `decision`: one call to the decision model that picks one of a set of
 * options (`agents/decide.ts`). It has no tools and no model of its own.
 */
export type SpecialistKind = "task" | "decision";

export interface SpecialistDefinition {
  name: string;
  description: string;
  kind: SpecialistKind;
  /** The file body: this specialist's system prompt. */
  prompt: string;
  /** A decision specialist's fixed options, for one whose caller doesn't supply them. */
  choices: string[];
  /** Bare built-in tool names, as written in the file. */
  tools: string[];
  /** Tools it may use without the user approving the call; a subset of `tools`. */
  unattended: string[];
  provider: string | null;
  model: string | null;
  /** A complexity tier to resolve its model from, in place of a literal `model:`. */
  complexityTier: ComplexityTier | null;
  maxSteps: number;
  enabled: boolean;
  source: SpecialistSource;
  /** Absolute path for a user definition; the repo-relative name for a shipped one. */
  path: string;
  /**
   * For a user file that extends a built-in: the built-in's name. The definition
   * is the built-in with this file's tools added and its body appended.
   */
  extends: string | null;
  /** The tools an extending file added to the built-in's. */
  addedTools: string[];
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
  { path: "definitions/review-scout.md", content: reviewScout },
  { path: "definitions/project-manager.md", content: projectManager },
  { path: "definitions/activity-consolidator.md", content: activityConsolidator },
  { path: "definitions/session-summarizer.md", content: sessionSummarizer },
  { path: "definitions/workspace-recap.md", content: workspaceRecap },
  { path: "definitions/planner.md", content: planner },
  { path: "definitions/yarvis-guide.md", content: yarvisGuide },
  { path: "definitions/merge-reviewer.md", content: mergeReviewer },
  { path: "definitions/complexity-router.md", content: complexityRouter },
  { path: "definitions/specialist-picker.md", content: specialistPicker },
];

/** `~/.yarvis/agents`, overridable so tests and a second instance can point elsewhere. */
export function agentsDir(): string {
  return process.env.YARVIS_AGENTS_DIR ?? join(homedir(), ".yarvis", "agents");
}

/** A name is a filename and an identifier, so it stays to the shape of both. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Every key a definition may set. Checked because YAML cannot: `tool:` instead of
 * `tools:` would otherwise load a specialist with no tools and no complaint.
 */
const KNOWN_KEYS = [
  "name",
  "description",
  "kind",
  "choices",
  "tools",
  "unattended",
  "model",
  "complexity",
  "maxSteps",
  "enabled",
  "extends",
] as const;

/**
 * What a file that extends a built-in may set. It adds to the built-in and
 * can switch it off; anything else (the model, the step budget, an
 * `unattended` grant) changes what the built-in is, and takes a file that
 * replaces it whole.
 */
const EXTENSION_KEYS = ["extends", "name", "tools", "enabled"] as const;

/**
 * Keys that configure a delegated run. A decision specialist rejects them
 * rather than ignoring them, so a file that sets one isn't read as having tools
 * or a model it will never get.
 */
const TASK_ONLY_KEYS = ["tools", "unattended", "model", "complexity", "maxSteps"] as const;

/**
 * Turns one file into a definition. Tool names and keys are checked here rather
 * than at call time: a typo in a file should be a problem the user is shown, not
 * a specialist that quietly runs with nine of its ten tools.
 */
export function parseSpecialist(
  path: string,
  content: string,
  source: SpecialistSource,
  knownTools: ReadonlySet<string>,
): SpecialistDefinition {
  const { data, body } = parseDocument(path, content);
  assertKnownKeys(path, data, KNOWN_KEYS);
  // A user's extending file is routed to parseExtension, so only a shipped file gets here with it.
  if (data.extends !== undefined) {
    throw new FrontmatterError(path, "a shipped definition can't use 'extends'", 1);
  }

  const name = asRequiredString(path, data, "name");
  if (!NAME_PATTERN.test(name)) {
    throw new FrontmatterError(
      path,
      "'name' must be lowercase letters, digits and hyphens — it is a filename and a handle",
      1,
    );
  }
  const description = asRequiredString(path, data, "description");
  if (!body.trim()) {
    throw new FrontmatterError(path, "the body is the system prompt and cannot be empty", 1);
  }

  const kind = asString(path, data, "kind") ?? "task";
  if (kind !== "task" && kind !== "decision") {
    throw new FrontmatterError(path, "'kind' must be task or decision", 1);
  }
  if (kind === "decision") {
    if (body.length > MAX_INSTRUCTIONS_CHARS) {
      throw new FrontmatterError(
        path,
        `a decision specialist's prompt cannot exceed ${MAX_INSTRUCTIONS_CHARS} characters, so it fits a small decision model's context`,
        1,
      );
    }
    const taskKeys = TASK_ONLY_KEYS.filter((key) => data[key] !== undefined);
    if (taskKeys.length) {
      throw new FrontmatterError(
        path,
        `a decision specialist runs on the decision model with no tools, so it cannot set: ${taskKeys.join(", ")}`,
        1,
      );
    }
  }
  const choices = asList(path, data, "choices") ?? [];
  if (choices.length && kind !== "decision") {
    throw new FrontmatterError(path, "'choices' is only for a decision specialist", 1);
  }
  const badChoices = choices.filter((choice) => !CHOICE_PATTERN.test(choice));
  if (badChoices.length) {
    throw new FrontmatterError(
      path,
      `choice(s) must be letters, digits, '_', '.' or '-': ${badChoices.join(", ")}`,
      1,
    );
  }

  const tools = asList(path, data, "tools") ?? [];
  const unknown = tools.filter((tool) => !knownTools.has(tool));
  if (unknown.length) {
    throw new FrontmatterError(path, `unknown tool(s): ${unknown.join(", ")}`, 1);
  }
  const unattended = asList(path, data, "unattended") ?? [];
  const ungranted = unattended.filter((tool) => !tools.includes(tool));
  if (ungranted.length) {
    throw new FrontmatterError(
      path,
      `'unattended' names tool(s) missing from 'tools': ${ungranted.join(", ")}`,
      1,
    );
  }

  // `model: anthropic/claude-sonnet-5` — one field, because a provider without a
  // model (or the reverse) can't resolve, so they are never usefully separate.
  const modelRef = asString(path, data, "model");
  let provider: string | null = null;
  let model: string | null = null;
  if (modelRef) {
    const slash = modelRef.indexOf("/");
    if (slash <= 0 || slash === modelRef.length - 1) {
      throw new FrontmatterError(path, "'model' must be written as <provider>/<model>", 1);
    }
    provider = modelRef.slice(0, slash);
    model = modelRef.slice(slash + 1);
  }

  // `complexity: low|medium|max` picks its model from the configured tier
  // instead of a literal one, so a shipped definition can stay cheap (or get
  // more capable) as the user's tier settings change rather than as a release.
  // Mutually exclusive with `model:` — a file setting both would leave which one
  // wins to resolve time rather than to a reader of the file.
  const complexityRef = asString(path, data, "complexity");
  let complexityTier: ComplexityTier | null = null;
  if (complexityRef) {
    if (modelRef) {
      throw new FrontmatterError(path, "'complexity' and 'model' cannot both be set", 1);
    }
    if (!isComplexityTier(complexityRef)) {
      throw new FrontmatterError(
        path,
        `'complexity' must be one of: ${COMPLEXITY_TIERS.join(", ")}`,
        1,
      );
    }
    complexityTier = complexityRef;
  }

  const maxSteps = asInteger(path, data, "maxSteps") ?? DEFAULT_MAX_STEPS;
  if (maxSteps > MAX_STEPS_CEILING) {
    throw new FrontmatterError(path, `'maxSteps' cannot exceed ${MAX_STEPS_CEILING}`, 1);
  }

  return {
    name,
    description,
    kind,
    prompt: body,
    choices,
    tools,
    unattended,
    provider,
    model,
    complexityTier,
    maxSteps,
    enabled: asBoolean(path, data, "enabled") ?? true,
    source,
    path,
    extends: null,
    addedTools: [],
  };
}

/** A user file that adds to a built-in specialist rather than replacing it. */
export interface SpecialistExtension {
  path: string;
  /** The built-in it adds to. */
  base: string;
  tools: string[];
  /** Appended to the built-in's prompt. Empty when the file only adds tools. */
  prompt: string;
  enabled: boolean | undefined;
}

/** Whether a file's frontmatter extends a built-in, read before choosing how to parse it. */
export function isExtension(path: string, content: string): boolean {
  return parseDocument(path, content).data.extends !== undefined;
}

export function parseExtension(
  path: string,
  content: string,
  knownTools: ReadonlySet<string>,
): SpecialistExtension {
  const { data, body } = parseDocument(path, content);
  assertKnownKeys(path, data, EXTENSION_KEYS);
  const base = asRequiredString(path, data, "extends");
  // The result keeps the built-in's name, so a `name:` here can only repeat it.
  const name = asString(path, data, "name");
  if (name !== undefined && name !== base) {
    throw new FrontmatterError(
      path,
      `a file that extends '${base}' keeps its name, so 'name' must be '${base}' or left out`,
      1,
    );
  }
  const tools = asList(path, data, "tools") ?? [];
  const unknown = tools.filter((tool) => !knownTools.has(tool));
  if (unknown.length) {
    throw new FrontmatterError(path, `unknown tool(s): ${unknown.join(", ")}`, 1);
  }
  const enabled = asBoolean(path, data, "enabled");
  if (!tools.length && !body.trim() && enabled === undefined) {
    throw new FrontmatterError(path, `extends '${base}' but adds no tools or instructions`, 1);
  }
  return { path, base, tools, prompt: body, enabled };
}

/**
 * The built-in with the extension's tools added and its body appended. Only a
 * built-in can be extended, so there is never a chain to follow. It must be a
 * task specialist: a decision specialist has no tools and a prompt sized for a
 * small decision model.
 */
export function applyExtension(
  base: SpecialistDefinition,
  extension: SpecialistExtension,
): SpecialistDefinition {
  if (base.kind !== "task") {
    throw new FrontmatterError(
      extension.path,
      `'${base.name}' is a decision specialist, which can't be extended; replace it with a file of the same name`,
      1,
    );
  }
  // Tools added beside a grant that writes outward with nobody approving each
  // call would run in that same unattended run. Replacing the file makes the
  // user restate the grant next to the tools, so that is the way to change one.
  if (base.unattended.length) {
    throw new FrontmatterError(
      extension.path,
      `'${base.name}' acts unattended (${base.unattended.join(", ")}), so it can't be extended; replace it with a file of the same name`,
      1,
    );
  }
  const addedTools = extension.tools.filter((tool) => !base.tools.includes(tool));
  return {
    ...base,
    prompt: extension.prompt.trim() ? `${base.prompt}\n\n${extension.prompt}` : base.prompt,
    tools: [...base.tools, ...addedTools],
    enabled: extension.enabled ?? base.enabled,
    source: "user",
    path: extension.path,
    extends: base.name,
    addedTools,
  };
}

/**
 * Loads every definition. A user file with the same name as a shipped one
 * replaces it outright rather than merging: a half-overridden prompt would be
 * neither what the app ships nor what the user wrote. A file that wants to add
 * to a shipped one says so with `extends:`, which only adds tools and appends
 * to the prompt, so what it changes is all in that one file.
 */
export async function loadCatalog(): Promise<SpecialistCatalog> {
  const knownTools = new Set(Object.keys(builtinToolMetadata()));
  const problems: SpecialistProblem[] = [];
  const byName = new Map<string, SpecialistDefinition>();

  const add = (path: string, content: string, source: SpecialistSource) => {
    try {
      const definition = parseSpecialist(path, content, source, knownTools);
      // Two of the user's own files can't both win, so the second is reported, not loaded.
      if (source === "user" && byName.get(definition.name)?.source === "user") {
        throw new Error(`${path}: another file already defines '${definition.name}'`);
      }
      byName.set(definition.name, definition);
    } catch (e) {
      problems.push({ path, message: e instanceof Error ? e.message : String(e) });
    }
  };

  for (const file of BUILTIN_FILES) add(file.path, file.content, "builtin");
  const builtinNames = new Set(byName.keys());
  const dir = agentsDir();
  const extensions: SpecialistExtension[] = [];
  for (const file of await readMarkdownDir(dir)) {
    if ("error" in file) {
      problems.push({ path: file.path, message: file.error });
      continue;
    }
    let extension: SpecialistExtension | null = null;
    try {
      if (isExtension(file.path, file.content)) {
        extension = parseExtension(file.path, file.content, knownTools);
      }
    } catch (e) {
      problems.push({ path: file.path, message: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (extension) extensions.push(extension);
    else add(file.path, file.content, "user");
  }

  // After every replacement has loaded, so an extension can tell whether its
  // built-in is still the one in the catalogue whatever the file order.
  for (const extension of extensions) {
    try {
      const base = byName.get(extension.base);
      // Not shipped at all, which also covers extending a user's own specialist.
      if (!base || !builtinNames.has(extension.base)) {
        throw new FrontmatterError(
          extension.path,
          `extends '${extension.base}', which isn't a built-in specialist`,
        );
      }
      if (base.extends) {
        throw new FrontmatterError(
          extension.path,
          `another file already extends '${extension.base}' (${base.path})`,
        );
      }
      if (base.source !== "builtin") {
        throw new FrontmatterError(
          extension.path,
          `extends '${extension.base}', but ${base.path} replaces it. Extend the built-in or replace it, not both`,
        );
      }
      byName.set(base.name, applyExtension(base, extension));
    } catch (e) {
      problems.push({ path: extension.path, message: e instanceof Error ? e.message : String(e) });
    }
  }

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
  options: { enabledOnly?: boolean; kind?: SpecialistKind } = {},
): Promise<SpecialistDefinition[]> {
  const { specialists } = await catalog();
  return specialists.filter(
    (s) => (!options.enabledOnly || s.enabled) && (!options.kind || s.kind === options.kind),
  );
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
  const candidates = await listSpecialists({ enabledOnly: true, kind: "task" });
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
