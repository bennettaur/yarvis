/**
 * The mutants a planning run proposes, and the sidecar's own checks and edits
 * that apply them. The planner only ever proposes: an edit reaches the copy
 * once it is shown to touch one changed source file, at the place the planner
 * named, and nothing else — and it is undone by writing back the file's
 * original bytes, checked by hash.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { MAX_FILE_BYTES } from "../workspaces/files.ts";
import { assertSafeRepoPath } from "./git.ts";

const short = (max: number) => z.string().max(max);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const path = z.string().min(1).max(500);
const line = z.number().int().positive();

export const MAX_PLANNED_MUTANTS = 40;

const editSchema = {
  path,
  line,
  /** Text that occurs exactly once within a few lines of `line`. */
  oldText: z.string().min(1).max(2_000),
  newText: short(2_000),
  description: short(300),
  testCommandId: id.nullable(),
};

export const mutationPlanSchema = z.object({
  /** One per group of test files; the baseline runs once per command. */
  testCommands: z
    .array(
      z.object({
        id,
        argv: z.array(z.string().min(1).max(300)).min(1).max(40),
        testFiles: z.array(path).max(50),
      }),
    )
    .max(10),
  /** A blatant mutant the tests must kill, proving they exercise the copy's code. */
  positiveControl: z.object(editSchema).nullable(),
  mutants: z
    .array(
      z.object({
        id,
        ...editSchema,
        /** Why this mutant is worth running. */
        rationale: short(1_000),
        testFiles: z.array(path).max(20),
        /** Behaves the same as the original; skipped and not scored. */
        likelyEquivalent: z.boolean(),
      }),
    )
    .max(MAX_PLANNED_MUTANTS),
  notes: short(2_000),
});

export type MutationPlan = z.infer<typeof mutationPlanSchema>;
export type PlannedEdit = Pick<MutationPlan["mutants"][number], keyof typeof editSchema>;

/** How far from the named line the edit may start. */
const LINE_SLACK = 3;

const TEST_PATH = [
  /(^|\/)(tests?|__tests__|__mocks__|specs?|testdata|fixtures?)\//i,
  /\.(test|spec)\.[^/]+$/i,
  /_test\.(go|py|rb|exs?)$/i,
  /_spec\.rb$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /(^|\/)conftest\.py$/i,
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
];

/** Test files and configuration are never mutated: the point is to test the tests. */
export function isTestOrConfigPath(path: string): boolean {
  return TEST_PATH.some((re) => re.test(path)) || CONFIG_PATH.some((re) => re.test(path));
}

export interface ValidEdit {
  /** The file's realpath, inside the copy. */
  file: string;
  original: Buffer;
  mutated: Buffer;
}

function lineAt(text: string, index: number): number {
  let count = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) count++;
  return count;
}

/**
 * Checks a proposed edit against the copy and the PR, and builds the mutated
 * file. Returns why it was refused instead when it doesn't hold up.
 */
export function prepareEdit(
  edit: PlannedEdit,
  context: { copyRoot: string; changedPaths: ReadonlySet<string> },
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
    return { refused: `${edit.path} is a test or configuration file` };
  }
  if (edit.oldText === edit.newText) return { refused: "the edit changes nothing" };

  let file: string;
  try {
    const root = realpathSync(context.copyRoot);
    file = realpathSync(join(root, edit.path));
    const inside = relative(root, file);
    if (inside.startsWith("..") || isAbsolute(inside) || inside.split(/[\\/]/).includes(".git")) {
      return { refused: `${edit.path} resolves outside the copy` };
    }
    const stat = lstatSync(file);
    if (!stat.isFile()) return { refused: `${edit.path} is not a regular file` };
    if (stat.size > MAX_FILE_BYTES) return { refused: `${edit.path} is too large` };
  } catch {
    return { refused: `${edit.path} does not exist in the copy` };
  }

  const original = readFileSync(file);
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
  return { file, original, mutated };
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export class RevertError extends Error {
  constructor(file: string) {
    super(`could not restore ${file} after a mutant; stopping`);
    this.name = "RevertError";
  }
}

/**
 * Applies an edit for the length of `run`, then writes the original bytes
 * back and checks them by hash — whether `run` finished or threw. A file that
 * doesn't come back is a `RevertError`, since every later result would be
 * measured against the wrong code.
 */
export async function withEdit<T>(edit: ValidEdit, run: () => Promise<T>): Promise<T> {
  const expected = sha256(edit.original);
  if (sha256(readFileSync(edit.file)) !== expected) throw new RevertError(edit.file);
  writeFileSync(edit.file, edit.mutated);
  try {
    return await run();
  } finally {
    writeFileSync(edit.file, edit.original);
    if (sha256(readFileSync(edit.file)) !== expected) {
      // biome-ignore lint/correctness/noUnsafeFinally: a failed restore must win over the result.
      throw new RevertError(edit.file);
    }
  }
}
