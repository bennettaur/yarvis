import { afterAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreGitState, snapshotGitState } from "./setupGuard.ts";
import { sh } from "./testRepo.ts";

describe("setup guard", () => {
  const root = mkdtempSync(join(tmpdir(), "yarvis-setup-guard-"));
  const clone = join(root, "clone");
  const worktree = join(root, "wt");
  const outside = join(root, "outside.txt");

  mkdirSync(clone);
  sh(clone, "init", "-q");
  writeFileSync(join(clone, "a.txt"), "a\n");
  sh(clone, "add", "-A");
  sh(clone, "commit", "-q", "-m", "init");
  sh(clone, "worktree", "add", "-q", "--detach", worktree);
  writeFileSync(outside, "untouched\n");

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("puts back config, hooks, info and the worktree's .git file that a script changed", () => {
    const config = join(clone, ".git", "config");
    const gitFile = join(worktree, ".git");
    const configBefore = readFileSync(config, "utf8");
    const gitFileBefore = readFileSync(gitFile, "utf8");
    const snapshot = snapshotGitState(clone, worktree);

    // What a hostile postinstall might do.
    writeFileSync(
      config,
      `${configBefore}[include]\n\tpath = /tmp/evil\n[core]\n\tfsmonitor = evil\n`,
    );
    writeFileSync(join(clone, ".git", "hooks", "post-checkout"), "#!/bin/sh\nevil\n");
    mkdirSync(join(clone, ".git", "info"), { recursive: true });
    writeFileSync(join(clone, ".git", "info", "attributes"), "* filter=evil\n");
    writeFileSync(join(clone, ".git", "config.worktree"), "[core]\n\tsshCommand = evil\n");
    writeFileSync(gitFile, "gitdir: /tmp/elsewhere\n");

    const restored = restoreGitState(snapshot);
    expect(restored.length).toBeGreaterThanOrEqual(4);
    expect(readFileSync(config, "utf8")).toBe(configBefore);
    expect(readFileSync(gitFile, "utf8")).toBe(gitFileBefore);
    expect(existsSync(join(clone, ".git", "hooks", "post-checkout"))).toBe(false);
    expect(existsSync(join(clone, ".git", "config.worktree"))).toBe(false);
    expect(existsSync(join(clone, ".git", "info", "attributes"))).toBe(false);
    // The repo still works after the restore.
    expect(sh(worktree, "rev-parse", "HEAD").trim()).toBe(sh(clone, "rev-parse", "HEAD").trim());
  });

  it("replaces a config swapped for a symlink without writing through it", () => {
    const config = join(clone, ".git", "config");
    const before = readFileSync(config, "utf8");
    const snapshot = snapshotGitState(clone, worktree);
    rmSync(config);
    symlinkSync(outside, config);

    expect(restoreGitState(snapshot)).toContain(config);
    expect(readFileSync(config, "utf8")).toBe(before);
    expect(readFileSync(outside, "utf8")).toBe("untouched\n");
  });

  it("reports nothing when nothing changed", () => {
    expect(restoreGitState(snapshotGitState(clone, worktree))).toEqual([]);
  });
});
