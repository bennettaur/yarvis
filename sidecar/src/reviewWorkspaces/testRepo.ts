/**
 * Builds a real git "remote" for review-workspace tests: a bare repo served
 * over `file://` with partial-clone filtering on, holding a base branch and a
 * pull request exposed the way providers expose them (`refs/pull/<n>/head`, and
 * Azure's `refs/pull/<n>/merge`). Test-only.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Runs git for fixture setup, with an identity and no signing. Throws on failure. */
export function sh(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function write(root: string, path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

export interface TestRemote {
  /** Scratch folder everything lives under. */
  root: string;
  /** The working repo commits are made in. */
  work: string;
  /** The bare repo, as a `file://` URL. */
  url: string;
  bare: string;
  /** Moves `refs/pull/1/head` on by one commit touching `path`. */
  pushToPr(path: string, content: string): string;
}

/**
 * main: README.md, src/a.ts, src/old.ts, docs/gone.md
 * PR #1 (branch `feature`): modifies src/a.ts, renames src/old.ts → src/new.ts,
 * deletes docs/gone.md, adds image.bin (binary), latin1.txt (not UTF-8), big.txt
 * and huge.txt (one byte over the file cap).
 * main then moves on (adds later.md) so the merge-base is not main's tip.
 * PR #2 is the same branch exposed only as an Azure-style merge ref.
 */
export function createTestRemote(): TestRemote {
  const root = mkdtempSync(join(tmpdir(), "yarvis-review-remote-"));
  const work = join(root, "work");
  const bare = join(root, "remote.git");
  mkdirSync(work);
  sh(work, "init", "-q");
  write(work, "README.md", "# Test\n");
  write(work, "src/a.ts", "export const a = 1;\n");
  write(work, "src/old.ts", "line one\nline two\nline three\nline four\nline five\n");
  write(work, "docs/gone.md", "bye\n");
  sh(work, "add", "-A");
  sh(work, "commit", "-q", "-m", "base");

  sh(work, "checkout", "-q", "-b", "feature");
  write(work, "src/a.ts", "export const a = 2;\nexport const b = 3;\n");
  sh(work, "mv", "src/old.ts", "src/new.ts");
  sh(work, "rm", "-q", "docs/gone.md");
  write(work, "image.bin", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 255]));
  write(work, "big.txt", "x".repeat(5000));
  // One byte over the 2 MB file cap, so a diff of it is refused as too large.
  write(work, "huge.txt", `${"y".repeat(99)}\n`.repeat(20_000) + "z");
  // Latin-1 "café": no NUL, but not UTF-8 either.
  write(work, "latin1.txt", new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  sh(work, "add", "-A");
  sh(work, "commit", "-q", "-m", "feature work");

  sh(work, "checkout", "-q", "main");
  write(work, "later.md", "after the branch\n");
  sh(work, "add", "-A");
  sh(work, "commit", "-q", "-m", "main moves on");

  // The Azure-style merge preview: first parent main, second parent the PR head.
  sh(work, "checkout", "-q", "-b", "merge-preview", "main");
  sh(work, "merge", "-q", "--no-ff", "--no-edit", "feature");
  sh(work, "checkout", "-q", "main");

  sh(root, "clone", "-q", "--bare", work, bare);
  sh(bare, "config", "uploadpack.allowFilter", "true");
  sh(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
  sh(bare, "update-ref", "refs/pull/1/head", sh(work, "rev-parse", "feature").trim());
  sh(bare, "update-ref", "refs/pull/2/merge", sh(work, "rev-parse", "merge-preview").trim());
  // A fork's PR: the branch isn't in the remote, only the pull ref is.
  sh(bare, "branch", "-D", "feature");
  sh(bare, "branch", "-D", "merge-preview");

  return {
    root,
    work,
    bare,
    url: `file://${bare}`,
    pushToPr(path, content) {
      sh(work, "checkout", "-q", "feature");
      write(work, path, content);
      sh(work, "add", "-A");
      sh(work, "commit", "-q", "-m", `update ${path}`);
      const sha = sh(work, "rev-parse", "HEAD").trim();
      sh(work, "checkout", "-q", "main");
      sh(work, "push", "-q", bare, "feature:refs/pull/1/head", "--force");
      return sha;
    },
  };
}
