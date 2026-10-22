/**
 * The mutants a planning run proposes, and the sidecar's own checks and edits
 * that apply them. The planner only ever proposes: an edit reaches the copy
 * once it is shown to touch one changed source file, inside the lines the PR
 * changed, at the place the planner named, and nothing else.
 *
 * The sidecar writes these files unsandboxed, after the PR's tests have had
 * the run of the copy, so every write is made as if the file might have been
 * swapped for a link: the path must have no symlink anywhere in it, the file
 * must be the one recorded (same device and inode, one link), and the new
 * content goes into a freshly created file (`O_CREAT|O_EXCL|O_NOFOLLOW`)
 * rather than through whatever is at the path. Anything unexpected fails
 * closed.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  futimesSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { MAX_FILE_BYTES } from "../workspaces/files.ts";
import { assertSafeRepoPath } from "./git.ts";

const short = (max: number) => z.string().max(max);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const path = z.string().min(1).max(500);
const line = z.number().int().positive();

export const MAX_PLANNED_MUTANTS = 40;

/** Positive controls are reported under ids with this prefix, so mutants may not use it. */
export const CONTROL_ID_PREFIX = "control-";

const editSchema = {
  path,
  line,
  /** Text that occurs exactly once within a few lines of `line`. */
  oldText: z.string().min(1).max(2_000),
  newText: short(2_000),
  /** What the change does, in a few words: "loosen the discount threshold". */
  description: short(300),
  testCommandId: id.nullable(),
};

export const mutationPlanSchema = z
  .object({
    /** One per group of test files; each runs once unmodified as a baseline. */
    testCommands: z
      .array(
        z.object({
          id,
          argv: z.array(z.string().min(1).max(300)).min(1).max(40),
          testFiles: z.array(path).max(50),
        }),
      )
      .max(10),
    /**
     * One blatant mutant per test command, which its tests must kill: proof
     * that they run the copy's code. A command whose control survives scores
     * nothing.
     */
    positiveControls: z.array(z.object(editSchema)).max(10),
    mutants: z
      .array(
        z.object({
          id,
          ...editSchema,
          /** The specific test and assertion expected to catch it. */
          rationale: short(1_000),
          testFiles: z.array(path).max(20),
          /** Rare: behaves the same as the original for every input. Skipped, not scored. */
          likelyEquivalent: z.boolean(),
        }),
      )
      .max(MAX_PLANNED_MUTANTS),
    notes: short(2_000),
  })
  .superRefine((plan, ctx) => {
    const duplicates = (ids: string[]) => ids.filter((value, i) => ids.indexOf(value) !== i);
    for (const dup of duplicates(plan.testCommands.map((c) => c.id))) {
      ctx.addIssue({ code: "custom", message: `test command id ${dup} is used twice` });
    }
    for (const dup of duplicates(plan.mutants.map((m) => m.id))) {
      ctx.addIssue({ code: "custom", message: `mutant id ${dup} is used twice` });
    }
    for (const mutant of plan.mutants) {
      if (mutant.id.startsWith(CONTROL_ID_PREFIX)) {
        ctx.addIssue({ code: "custom", message: `mutant id ${mutant.id} is reserved` });
      }
    }
  });

export type MutationPlan = z.infer<typeof mutationPlanSchema>;
export type PlannedEdit = Pick<MutationPlan["mutants"][number], keyof typeof editSchema>;

/** How far from the named line, or from the PR's changed lines, an edit may start. */
const LINE_SLACK = 3;

const TEST_PATH = [
  /(^|\/)(tests?|__tests__|__mocks__|specs?|testdata|fixtures?)\//i,
  /\.(test|spec)\.[^/]+$/i,
  /_test\.(go|py|rb|exs?)$/i,
  /_spec\.rb$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /(^|\/)conftest\.py$/i,
  // Test setup that every test loads.
  /(^|\/)(jest|vitest|karma|mocha)\.setup\.[^/]+$/i,
  /(^|\/)setup-?tests?\.[^/]+$/i,
  /(^|\/)test-?setup\.[^/]+$/i,
];

const CONFIG_PATH = [
  /(^|\/)package(-lock)?\.json$/i,
  /(^|\/)(yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|poetry\.lock|uv\.lock|mix\.(exs|lock))$/i,
  /(^|\/)(pyproject\.toml|setup\.(py|cfg)|tox\.ini|pytest\.ini|Makefile|Dockerfile)$/i,
  /(^|\/)tsconfig[^/]*\.json$/i,
  /(^|\/)[^/]+\.config\.[cm]?[jt]s$/i,
  /(^|\/)\.[^/]+$/, // dotfiles: .babelrc, .env, .eslintrc …
  /(^|\/)\.[^/]+\//, // anything under a dot folder: .github/, .vscode/ …
  /\.(json|ya?ml|toml|ini|lock|csproj|sln)$/i,
  // Code that runs at import or build time rather than being tested.
  /(^|\/)__init__\.py$/i,
  /(^|\/)build\.rs$/i,
  /\.d\.[cm]?ts$/i,
];

/** Docs, generated output and third-party code: no test of the PR's covers them. */
const NOT_SOURCE_PATH = [
  /\.(md|mdx|rst|txt|adoc)$/i,
  /(^|\/)(vendor|node_modules|third_party|dist|build)\//i,
  /\.(generated|gen)\.[^/]+$/i,
  /\.pb\.go$/i,
  /_pb2(_grpc)?\.py$/i,
  /\.min\.[cm]?js$/i,
];

/** Test files, configuration, docs and generated code are never mutated. */
export function isTestOrConfigPath(path: string): boolean {
  return [...TEST_PATH, ...CONFIG_PATH, ...NOT_SOURCE_PATH].some((re) => re.test(path));
}

type LineRange = [start: number, end: number];

/** Who a file is, as the sidecar last left it. */
interface FileIdentity {
  dev: number;
  ino: number;
}

export interface ValidEdit {
  /** The file inside the copy; no symlink anywhere on the way. */
  file: string;
  original: Buffer;
  mutated: Buffer;
  mode: number;
  /** Updated on every write the sidecar makes. */
  identity: FileIdentity;
  /** The last mtime written, so each write moves it on. */
  mtime: number;
}

function lineAt(text: string, index: number): number {
  let count = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) count++;
  return count;
}

export class RevertError extends Error {
  constructor(file: string, why: string) {
    super(`could not restore ${file} after a mutant (${why}); stopping`);
    this.name = "RevertError";
  }
}

/**
 * Throws unless `file` is still a regular file with one link, the one
 * `identity` names, reached through no symlink.
 */
function assertSameFile(edit: Pick<ValidEdit, "file" | "identity">): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(edit.file);
  } catch {
    throw new RevertError(edit.file, "it was removed");
  }
  if (!stat.isFile()) throw new RevertError(edit.file, "it was replaced by something else");
  if (stat.nlink !== 1) throw new RevertError(edit.file, "it was hard-linked");
  if (stat.dev !== edit.identity.dev || stat.ino !== edit.identity.ino) {
    throw new RevertError(edit.file, "it was replaced");
  }
  let folder: string;
  try {
    folder = realpathSync(dirname(edit.file));
  } catch {
    throw new RevertError(edit.file, "its folder was removed");
  }
  if (folder !== dirname(edit.file)) {
    throw new RevertError(edit.file, "its folder was replaced by a link");
  }
}

/** Reads the file through a descriptor that refuses a symlink, checking it is the recorded one. */
function readSameFile(edit: Pick<ValidEdit, "file" | "identity">): Buffer {
  const fd = openSync(edit.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (stat.dev !== edit.identity.dev || stat.ino !== edit.identity.ino || stat.nlink !== 1) {
      throw new RevertError(edit.file, "it changed while being read");
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Replaces the file's content: removes it and creates a new one in its place,
 * exclusively and without following a link, then records the new file's
 * identity. Its mtime always moves forward, so a test runner's cache keyed on
 * mtime and size can't mistake the mutant for the original or the reverse.
 */
function replaceFile(edit: ValidEdit, bytes: Buffer): void {
  assertSameFile(edit);
  unlinkSync(edit.file);
  const fd = openSync(
    edit.file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    edit.mode,
  );
  try {
    writeSync(fd, bytes);
    edit.mtime = Math.max(Math.floor(Date.now() / 1000), edit.mtime + 1);
    futimesSync(fd, edit.mtime, edit.mtime);
    const stat = fstatSync(fd);
    edit.identity = { dev: stat.dev, ino: stat.ino };
  } finally {
    closeSync(fd);
  }
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/**
 * Checks a proposed edit against the copy and the PR, and builds the mutated
 * file. Returns why it was refused instead when it doesn't hold up.
 */
export function prepareEdit(
  edit: PlannedEdit,
  context: {
    copyRoot: string;
    changedPaths: ReadonlySet<string>;
    /** The head-side lines each file changed; a file with none listed isn't range-checked. */
    changedRanges?: ReadonlyMap<string, LineRange[]>;
  },
): ValidEdit | { refused: string } {
  try {
    assertSafeRepoPath(edit.path);
  } catch (e) {
    return { refused: e instanceof Error ? e.message : String(e) };
  }
  if (!context.changedPaths.has(edit.path)) {
    return { refused: `${edit.path} is not a file this pull request changes` };
  }
  if (isTestOrConfigPath(edit.path)) {
    return { refused: `${edit.path} is a test, configuration, documentation or generated file` };
  }
  if (edit.oldText === edit.newText) return { refused: "the edit changes nothing" };
  const ranges = context.changedRanges?.get(edit.path);
  if (
    ranges &&
    ranges.length > 0 &&
    !ranges.some(([start, end]) => edit.line >= start - LINE_SLACK && edit.line <= end + LINE_SLACK)
  ) {
    return { refused: `line ${edit.line} is outside the lines this pull request changed` };
  }

  let file: string;
  let stat: ReturnType<typeof lstatSync>;
  try {
    const root = realpathSync(context.copyRoot);
    file = join(root, edit.path);
    // Equal only when no part of the path is a symlink.
    if (realpathSync(file) !== file) return { refused: `${edit.path} goes through a link` };
    stat = lstatSync(file);
  } catch {
    return { refused: `${edit.path} does not exist in the copy` };
  }
  if (!stat.isFile()) return { refused: `${edit.path} is not a regular file` };
  if (stat.nlink !== 1) return { refused: `${edit.path} has other hard links` };
  if (stat.size > MAX_FILE_BYTES) return { refused: `${edit.path} is too large` };
  const identity = { dev: stat.dev, ino: stat.ino };

  const original = readSameFile({ file, identity });
  const text = original.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(original)) return { refused: `${edit.path} is not UTF-8` };
  const near: number[] = [];
  for (let at = text.indexOf(edit.oldText); at !== -1; at = text.indexOf(edit.oldText, at + 1)) {
    if (Math.abs(lineAt(text, at) - edit.line) <= LINE_SLACK) near.push(at);
  }
  if (near.length !== 1) {
    return {
      refused:
        near.length === 0
          ? `the text to replace isn't near line ${edit.line}`
          : `the text to replace occurs ${near.length} times near line ${edit.line}`,
    };
  }
  const at = near[0] as number;
  const mutated = Buffer.from(
    text.slice(0, at) + edit.newText + text.slice(at + edit.oldText.length),
    "utf8",
  );
  return {
    file,
    original,
    mutated,
    mode: stat.mode & 0o7777,
    identity,
    mtime: Math.floor(stat.mtimeMs / 1000),
  };
}

/**
 * Applies an edit for the length of `run`, then puts the original bytes back
 * and checks them by hash — whether `run` finished or threw. `beforeRevert`
 * runs first, to make sure nothing the tests started is still at work in the
 * copy. A file that can't be restored exactly is a `RevertError`: every later
 * result would be measured against the wrong code.
 */
export async function withEdit<T>(
  edit: ValidEdit,
  run: () => Promise<T>,
  beforeRevert: () => Promise<void> = async () => {},
): Promise<T> {
  const expected = sha256(edit.original);
  if (sha256(readSameFile(edit)) !== expected) {
    throw new RevertError(edit.file, "it changed before the mutant was applied");
  }
  replaceFile(edit, edit.mutated);
  try {
    return await run();
  } finally {
    await beforeRevert();
    replaceFile(edit, edit.original);
    if (sha256(readSameFile(edit)) !== expected) {
      // biome-ignore lint/correctness/noUnsafeFinally: a failed restore must win over the result.
      throw new RevertError(edit.file, "its content didn't match after restoring");
    }
  }
}
