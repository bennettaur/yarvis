import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_FILE_BYTES,
  readWorktreeFile,
  resolveInWorktree,
  WorktreeFileError,
  writeWorktreeFile,
} from "./files.ts";

// realpath-ed up front: on macOS the temp root is reached through a symlink,
// and the resolver answers with the real path.
const root = realpathSync(mkdtempSync(join(tmpdir(), "yarvis-files-")));
const worktree = join(root, "worktree");
const outside = join(root, "outside");

beforeEach(() => {
  rmSync(worktree, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  mkdirSync(join(worktree, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const statusOf = (fn: () => unknown): number | string => {
  try {
    fn();
  } catch (e) {
    return e instanceof WorktreeFileError ? e.status : String(e);
  }
  return "did not throw";
};

describe("resolveInWorktree", () => {
  it("resolves a path inside the worktree", () => {
    writeFileSync(join(worktree, "src", "a.ts"), "x");
    expect(resolveInWorktree(worktree, "src/a.ts")).toBe(join(worktree, "src", "a.ts"));
  });

  it("refuses an absolute path", () => {
    expect(statusOf(() => resolveInWorktree(worktree, "/etc/passwd"))).toBe(400);
  });

  it("refuses a traversal segment", () => {
    expect(statusOf(() => resolveInWorktree(worktree, "src/../../outside/secret"))).toBe(400);
  });

  it("refuses a path with control characters", () => {
    expect(statusOf(() => resolveInWorktree(worktree, "src/a\u0000.ts"))).toBe(400);
  });

  it("refuses the worktree's own .git, which is a regular file it could rewrite", () => {
    // `git worktree add` writes a `.git` file holding `gitdir: …`; repointing it
    // makes the next git command run hooks and config we don't control.
    writeFileSync(join(worktree, ".git"), "gitdir: /real/gitdir\n");
    expect(statusOf(() => resolveInWorktree(worktree, ".git"))).toBe(400);
    expect(statusOf(() => resolveInWorktree(worktree, ".git/hooks/pre-commit"))).toBe(400);
  });

  it("refuses a symlink that lands on .git", () => {
    // Checking the caller's string would pass this: the input names `evil`.
    writeFileSync(join(worktree, ".git"), "gitdir: /real/gitdir\n");
    symlinkSync(join(worktree, ".git"), join(worktree, "evil"));
    expect(statusOf(() => resolveInWorktree(worktree, "evil"))).toBe(400);
  });

  it("refuses .git however it is cased", () => {
    // The app runs on macOS, where the filesystem is case-insensitive and
    // `.GIT` opens the same file.
    writeFileSync(join(worktree, ".git"), "gitdir: /real/gitdir\n");
    expect(statusOf(() => resolveInWorktree(worktree, ".GIT"))).toBe(400);
  });

  it("refuses a nested .git, as a submodule's is", () => {
    mkdirSync(join(worktree, "vendor", "lib"), { recursive: true });
    writeFileSync(join(worktree, "vendor", "lib", ".git"), "gitdir: /real/gitdir\n");
    expect(statusOf(() => resolveInWorktree(worktree, "vendor/lib/.git"))).toBe(400);
  });

  it("refuses a symlink pointing out of the worktree", () => {
    writeFileSync(join(outside, "secret"), "shh");
    symlinkSync(join(outside, "secret"), join(worktree, "escape"));
    expect(statusOf(() => resolveInWorktree(worktree, "escape"))).toBe(400);
  });
});

describe("readWorktreeFile", () => {
  it("returns the file's text and a hash", () => {
    writeFileSync(join(worktree, "src", "a.ts"), "const a = 1;\n");
    const file = readWorktreeFile(worktree, "src/a.ts");
    expect(file.content).toBe("const a = 1;\n");
    expect(file.unreadable).toBeNull();
    expect(file.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(file.size).toBe(13);
  });

  it("describes a binary file rather than returning its bytes", () => {
    writeFileSync(join(worktree, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const file = readWorktreeFile(worktree, "logo.png");
    expect(file.unreadable).toBe("binary");
    expect(file.content).toBeNull();
  });

  it("describes a file past the size cap rather than reading it", () => {
    writeFileSync(join(worktree, "big.txt"), "a".repeat(MAX_FILE_BYTES + 1));
    const file = readWorktreeFile(worktree, "big.txt");
    expect(file.unreadable).toBe("too-large");
    expect(file.content).toBeNull();
  });

  it("describes a file that is not valid UTF-8 rather than decoding it lossily", () => {
    // Latin-1 "café": decoding would turn 0xE9 into U+FFFD, and a save would
    // write that replacement back over it.
    writeFileSync(join(worktree, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const file = readWorktreeFile(worktree, "latin1.txt");
    expect(file.unreadable).toBe("encoding");
    expect(file.content).toBeNull();
  });

  it("404s on a missing file", () => {
    expect(statusOf(() => readWorktreeFile(worktree, "src/missing.ts"))).toBe(404);
  });

  it("400s on a directory", () => {
    expect(statusOf(() => readWorktreeFile(worktree, "src"))).toBe(400);
  });
});

describe("writeWorktreeFile", () => {
  it("writes the file when the hash still matches", () => {
    const path = join(worktree, "src", "a.ts");
    writeFileSync(path, "old\n");
    const before = readWorktreeFile(worktree, "src/a.ts");

    const result = writeWorktreeFile(worktree, "src/a.ts", "new\n", before.hash ?? "");

    expect(readFileSync(path, "utf8")).toBe("new\n");
    expect(result.hash).toBe(readWorktreeFile(worktree, "src/a.ts").hash ?? "");
    expect(result.size).toBe(4);
  });

  it("409s when the file changed on disk since it was read", () => {
    writeFileSync(join(worktree, "src", "a.ts"), "old\n");
    const before = readWorktreeFile(worktree, "src/a.ts");
    writeFileSync(join(worktree, "src", "a.ts"), "someone else\n");

    expect(
      statusOf(() => writeWorktreeFile(worktree, "src/a.ts", "mine\n", before.hash ?? "")),
    ).toBe(409);
    expect(readFileSync(join(worktree, "src", "a.ts"), "utf8")).toBe("someone else\n");
  });

  it("refuses a file hard-linked to one outside the worktree", () => {
    // realpath cannot see a second link: there is one inode, and its path inside
    // the worktree is genuine. Writing in place would land on the outside file.
    writeFileSync(join(outside, "secret"), "shh\n");
    linkSync(join(outside, "secret"), join(worktree, "linked"));
    const before = readWorktreeFile(worktree, "linked");

    expect(statusOf(() => writeWorktreeFile(worktree, "linked", "mine\n", before.hash ?? ""))).toBe(
      400,
    );
    expect(readFileSync(join(outside, "secret"), "utf8")).toBe("shh\n");
  });

  it("refuses content past the byte cap and leaves the file alone", () => {
    writeFileSync(join(worktree, "src", "a.ts"), "old\n");
    const before = readWorktreeFile(worktree, "src/a.ts");

    const oversized = "a".repeat(MAX_FILE_BYTES + 1);
    expect(
      statusOf(() => writeWorktreeFile(worktree, "src/a.ts", oversized, before.hash ?? "")),
    ).toBe(400);
    expect(readFileSync(join(worktree, "src", "a.ts"), "utf8")).toBe("old\n");
  });

  it("404s rather than creating a file that isn't there", () => {
    expect(statusOf(() => writeWorktreeFile(worktree, "src/new.ts", "x", ""))).toBe(404);
  });

  it("refuses a write that escapes the worktree", () => {
    writeFileSync(join(outside, "secret"), "shh");
    expect(statusOf(() => writeWorktreeFile(worktree, "../outside/secret", "x", ""))).toBe(400);
    expect(readFileSync(join(outside, "secret"), "utf8")).toBe("shh");
  });
});
